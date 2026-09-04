import { Injectable, computed, effect, inject, isDevMode, signal } from '@angular/core';
import { BOARD_H, BOARD_W, GameAction, GameService, PlayerId } from './game.service';
import { GdAdsService } from './gd-ads.service';
import {
  LobbyRegistryService,
  Seat,
  SessionRecord,
  SessionRole,
  isPartyPresent,
} from './lobby-registry.service';

/**
 * Rule 7: game sessions. The host claims a random free "Battle{n}" (random, not
 * sequential, so an outsider can't guess a low number and wander into a running
 * game), shares it, and the other player opens it. Everything after that goes
 * through the session's move log in Firebase — see `lobby-registry.service.ts`
 * for why the game no longer runs peer-to-peer.
 *
 * The shape of a session is deliberately simple now, because the hard parts
 * moved to a server that is always there:
 *
 *  - **There is nobody to find.** Player 2 does not dial player 1 and does not
 *    wait for them to be awake; they take the empty seat on the link and are
 *    in the game immediately. They can place their ship while player 1 is
 *    still in a messaging app. That single change deletes the entire class of
 *    bug this file used to be full of — knocking, ghost pairings, ids the
 *    broker was still holding, sockets that die without saying so.
 *  - **A move is a write, not a message.** `act()` appends to the log and both
 *    devices apply what the log says, in the order the database put it in.
 *    Neither device has to be reachable from the other, or even awake.
 *  - **Leaving is not losing.** Closing the app, a flat battery or a tunnel no
 *    longer ends the round: the board is on the server, so `resumeSession()`
 *    replays the log and puts the player back exactly where they were, in the
 *    seat the record says is theirs (rule 9). Only the Leave button, which
 *    terminates the link, ends a game.
 *
 * What is left here is the lobby state machine, presence (so a player can be
 * told their opponent has closed the app), and the local computer opponent.
 */

/**
 * Battle ids are random within this range rather than sequential, so an
 * outsider can't guess a low number and stumble into a running game.
 */
const MIN_GAME_ID = 1000;
const MAX_GAME_ID = 9999;
/** Give up after this many random collisions (the id space is ~9000 wide). */
const MAX_CLAIM_ATTEMPTS = 50;
/** Where this device remembers the game it is in, so a relaunch can return. */
const SESSION_KEY = 'battleship.session';
/** …and its own identity, which is what a seat on a link is held by. */
const CLIENT_KEY = 'battleship.clientId';
/**
 * Ignore a remembered session older than the longest life rule 9.2 gives a
 * link. Beyond that the record is gone and there is nothing to return to.
 */
const SESSION_TTL_MS = 3 * 60 * 60_000;
/** How often a player waiting on the lobby screen re-reads the link. */
const RECHECK_MS = 15_000;

export type SessionState =
  | 'lobby' // choosing New Game / Join The Game (rule 7.1)
  | 'hosting' // game id claimed, waiting for player 2
  | 'joining' // opening someone's link
  | 'playing' // in the game
  | 'disconnected' // the link was ended — the game is over
  | 'error';

/** Minimal shape of the Screen Wake Lock API (not in every TS DOM lib). */
interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}
type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
};

/**
 * The game this device was last in, or null if there isn't one worth
 * returning to: nothing stored, storage full of something else, or a session
 * so old that rule 9.2 has certainly expired it. Pure so the "is this still
 * worth going back to" decision is testable without a browser.
 */
export function parseSession(raw: string | null, now: number): number | null {
  if (!raw) return null;
  try {
    const { n, at } = JSON.parse(raw) as { n?: unknown; at?: unknown };
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_GAME_ID) return null;
    if (typeof at !== 'number' || !(now - at <= SESSION_TTL_MS)) return null;
    return n;
  } catch {
    return null; // not ours / not JSON
  }
}

/** "Battle3", "battle 3" or plain "3" → 3; null when unparseable. */
export function parseGameId(input: string): number | null {
  const m = input.trim().match(/^(?:battle\s*)?(\d{1,4})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= MAX_GAME_ID ? n : null;
}

@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly game = inject(GameService);
  private readonly registry = inject(LobbyRegistryService);
  private readonly ads = inject(GdAdsService);

  readonly state = signal<SessionState>('lobby');
  /** Shareable id shown to players — the plain number, e.g. "1385" (rule 7.2). */
  readonly gameId = signal<string | null>(null);
  /** 0 = host (fires first), 1 = joiner. */
  readonly myPlayer = signal<PlayerId>(0);
  readonly errorMsg = signal<string | null>(null);
  /**
   * Is the opponent currently on the link? true = present, false = they closed
   * the app / left, null = unknown (not tracking, or we've not seen them yet).
   * Driven by Firebase presence. It is now only ever a *hint* — a player who
   * has stepped away is still in the game, and their board is waiting for them.
   */
  readonly opponentPresent = signal<boolean | null>(null);
  /**
   * Opening a link. Kept for the lobby, which shows the number while the read
   * is in flight; it is a moment now, not a wait for someone to wake up.
   */
  readonly waitingForHost = signal(false);
  /**
   * Hosting, and player 2 is on the link. The hosting screen says so, and the
   * moment they take the seat the host goes into the game.
   */
  readonly joinerWaiting = computed(
    () => this.state() === 'hosting' && this.opponentPresent() === true,
  );

  /** The n of Battle{n}. */
  private gameNumber: number | null = null;

  /** Moves this device wrote, so its own echo off the log is not applied twice. */
  private ownMoves = new Set<string>();
  private movesUnsub: (() => void) | null = null;

  /** 'online' = a real opponent through the registry; 'bot' = local computer. */
  private mode: 'online' | 'bot' = 'online';
  private botTimer: ReturnType<typeof setTimeout> | null = null;

  // Session-record watch (Firebase): a live subscription plus a slow re-check
  // so a heartbeat that simply stops (no clean disconnect) is still caught. We
  // latch `opponentSeen` so a not-yet-arrived opponent doesn't read as "left".
  private recordUnsub: (() => void) | null = null;
  private recheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastRecord: SessionRecord | null = null;
  /** Have we heard from the database at all? Until then, silence is not news. */
  private recordSeen = false;
  private myRole: SessionRole | null = null;
  private opponentSeen = false;

  /** Held while a game is live so the OS keeps the tab awake (best-effort). */
  private wakeLock: WakeLockSentinelLike | null = null;

  constructor() {
    if (isDevMode()) {
      // Test hook: leave the game as if the app had been closed, without
      // terminating the link — the case resuming exists for.
      (globalThis as { __battleshipDrop?: () => void }).__battleshipDrop = () => this.detach();
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => this.onVisible());
    }

    // Keep the screen (and thus this tab) alive while a game is live.
    effect(() => {
      const s = this.state();
      if (this.mode !== 'bot' && (s === 'hosting' || s === 'playing')) {
        void this.acquireWakeLock();
      } else {
        this.releaseWakeLock();
      }
    });

    // Computer opponent: whenever the game waits on player 1 (unplaced ship,
    // or its turn to fire/move), queue one random action after a short
    // "thinking" pause. Signals are read up front so the effect always
    // re-arms on the next state change.
    effect(() => {
      const phase = this.game.phase();
      const turn = this.game.currentPlayer();
      const botPlaced = this.game.players()[1].ship !== null;
      const playing = this.state() === 'playing';
      if (this.mode !== 'bot' || !playing || this.botTimer) return;
      const due =
        (phase === 'placement' && !botPlaced) ||
        ((phase === 'fire' || phase === 'move') && turn === 1);
      if (!due) return;
      this.botTimer = setTimeout(
        () => {
          this.botTimer = null;
          this.botAct();
        },
        phase === 'placement' ? 700 : 900 + Math.random() * 700,
      );
    });
  }

  /** Single-device mode: the opponent is a local computer playing randomly. */
  playComputer(): void {
    this.leave(); // drop any half-open session first
    this.mode = 'bot';
    this.myPlayer.set(0);
    this.gameId.set('Computer');
    this.state.set('playing');
    this.registry.bump('botGames');
  }

  /** One random-but-legal computer action for whatever the game waits on. */
  private botAct(): void {
    if (this.mode !== 'bot' || this.state() !== 'playing') return;
    const rnd = (n: number) => Math.floor(Math.random() * n);
    switch (this.game.phase()) {
      case 'placement':
        if (!this.game.players()[1].ship) {
          this.game.apply({ kind: 'place', player: 1, c: { x: rnd(BOARD_W), y: rnd(BOARD_H) } });
        }
        break;
      case 'fire': {
        if (this.game.currentPlayer() !== 1) return;
        // Rule 5.2-5.4 narrow down where the ship provably can be; shoot
        // randomly within that set instead of anywhere still unbombed.
        const candidates = this.game.possibleShipSquares(0);
        if (candidates.length) {
          this.game.apply({ kind: 'fire', player: 1, c: candidates[rnd(candidates.length)] });
        }
        break;
      }
      case 'move': {
        if (this.game.currentPlayer() !== 1) return;
        const moves = this.game.legalMoves(1);
        if (moves.length) {
          this.game.apply({ kind: 'move', player: 1, c: moves[rnd(moves.length)] });
        }
        break;
      }
    }
  }

  /** Rule 7.2: claim a random free Battle{n}, then wait for player 2. */
  newGame(): void {
    this.leave();
    this.errorMsg.set(null);
    this.state.set('hosting');
    void this.claimGameId();
  }

  /**
   * Rule 7.3 without the typing: a link that lands the opponent straight in
   * the game. document.baseURI honours the deployed <base href>.
   */
  inviteLink(): string | null {
    return this.gameNumber === null ? null : `${document.baseURI}?join=${this.gameNumber}`;
  }

  /**
   * Rule 7.3: player 2 opens the link player 1 shared. There is nobody to
   * wake: the seat is taken on the record and the game starts. If player 1 is
   * still in the messaging app they sent the invite from, player 2 can place
   * their ship and wait for them inside the game.
   */
  async join(idText: string): Promise<void> {
    const n = parseGameId(idText);
    if (n === null) {
      this.errorMsg.set('That doesn’t look like a game number — enter just the number, e.g. "1"');
      return;
    }
    // Already in this one — an invite link tapped a second time, say. Leaving
    // and rejoining would terminate the very game it opens.
    const live: SessionState[] = ['hosting', 'playing'];
    if (this.gameNumber === n && live.includes(this.state())) return;
    this.leave();
    this.errorMsg.set(null);
    this.state.set('joining');
    this.waitingForHost.set(true);
    this.gameId.set(`${n}`);

    // Player 1 opening their own invite link (to check it, or because it is
    // the only copy of the number they have) takes their own seat back rather
    // than trying to join themselves.
    const mine = await this.registry.reclaimSeat(n, this.clientId());
    if (this.state() !== 'joining') return; // player backed out while we asked
    if (mine) {
      this.enter(n, mine);
      return;
    }
    if (!(await this.registry.takeJoinerSeat(n, this.clientId()))) {
      this.fail('Couldn’t find that game. Check the id and try again.');
      return;
    }
    if (this.state() !== 'joining') return;
    this.enter(n, { role: 'joiner', joined: true });
  }

  /**
   * Rule 9: go back to the game this device is in. Called on any load without
   * a `?join=` param, so closing the app — or the OS killing it, or the phone
   * dying — is no longer the end of a round: the seat is still ours on the
   * record and the board is rebuilt by replaying the log.
   *
   * Returns whether we are back in, so a caller can fall back to the lobby.
   */
  async resumeSession(): Promise<boolean> {
    const n = this.rememberedSession();
    const busy: SessionState[] = ['hosting', 'joining', 'playing'];
    if (n === null || this.mode !== 'online' || busy.includes(this.state())) return false;
    // Show the number straight away: this runs on a cold boot, and a blank
    // second on a screen the player is staring at reads as a hang.
    this.errorMsg.set(null);
    this.state.set('joining');
    this.gameId.set(`${n}`);
    const seat = await this.registry.reclaimSeat(n, this.clientId());
    if (!seat) {
      this.forgetSession();
      if (this.state() === 'joining') this.toLobby();
      return false;
    }
    if (this.state() !== 'joining') return false; // player moved on while we asked
    this.enter(n, seat);
    return true;
  }

  /**
   * Join the session's log and play. A host whose link nobody has opened waits
   * on the lobby screen instead — but they are already watching the record, so
   * the moment player 2 takes the seat they are in.
   */
  private enter(n: number, seat: Seat): void {
    this.gameNumber = n;
    this.gameId.set(`${n}`);
    this.myRole = seat.role;
    this.myPlayer.set(seat.role === 'host' ? 0 : 1);
    this.rememberSession(n);
    this.registry.startPresence(n, seat.role);
    this.watchRecord(n);
    this.waitingForHost.set(false);
    // A host whose link nobody has opened waits on the lobby screen with the
    // number to share; everyone else is in the game.
    this.state.set(seat.role === 'host' && !seat.joined ? 'hosting' : 'playing');
    this.watchMoves(n);
  }

  /**
   * Replay the log, then follow it. Applying our own writes only once matters
   * because the acting device applies a move immediately (so a tap feels
   * instant) and then sees it come back off the database like any other.
   */
  private watchMoves(n: number): void {
    this.movesUnsub?.();
    this.game.resetScores();
    this.game.reset();
    this.ownMoves.clear();
    this.movesUnsub = this.registry.watchMoves(n, (action, key) => {
      if (this.ownMoves.delete(key)) return; // already applied, locally
      this.game.apply(action);
    });
  }

  /** Forward a local tap on the united board (rule 2.3); applies and logs it. */
  act(c: { x: number; y: number }): void {
    if (this.state() !== 'playing') return;
    const action = this.game.tryLocal(this.myPlayer(), c);
    if (action) this.send(action);
  }

  /** Rematch, keeping the score (rule 8). */
  playAgain(): void {
    if (this.state() !== 'playing') return;
    // The round is over and the next has not begun: the one point in the game
    // where an ad interrupts nothing. Outside the GD portal this is a no-op.
    this.ads.showAd();
    this.game.reset();
    this.send({ kind: 'reset' });
  }

  /** Append a locally-applied action to the log for the other device. */
  private send(action: GameAction): void {
    if (this.mode !== 'online' || this.gameNumber === null) return;
    const key = this.registry.sendMove(this.gameNumber, action);
    if (key) this.ownMoves.add(key);
  }

  /**
   * Rule 9: Leave ends the link for both players, permanently. It is the only
   * thing that does — everything else (closing the app, losing signal) is a
   * pause now, and the game is waiting when either of them comes back.
   */
  leave(): void {
    const n = this.gameNumber;
    const held: SessionState[] = ['hosting', 'playing', 'disconnected'];
    if (this.mode === 'online' && n !== null && held.includes(this.state())) {
      void this.registry.terminate(n);
    } else {
      this.registry.stopPresence();
    }
    this.forgetSession();
    this.detach();
    this.mode = 'online';
    this.game.reset();
    this.game.resetScores();
    this.toLobby();
  }

  /** Let go of the session without ending it — the app closing, in effect. */
  private detach(): void {
    this.movesUnsub?.();
    this.movesUnsub = null;
    this.stopWatchingRecord();
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
    this.ownMoves.clear();
    this.gameNumber = null;
    this.myRole = null;
  }

  private toLobby(): void {
    this.gameId.set(null);
    this.errorMsg.set(null);
    this.waitingForHost.set(false);
    this.state.set('lobby');
  }

  /**
   * Rule 9: reserve a random free Battle{n}. The reservation is the game — it
   * outlives this tab, so the link stays good for its window whatever happens
   * to the app, and the same seat is ours when we come back.
   */
  private async claimGameId(): Promise<void> {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      if (this.state() !== 'hosting') return; // user backed out mid-await
      const n = MIN_GAME_ID + Math.floor(Math.random() * (MAX_GAME_ID - MIN_GAME_ID + 1));
      if (await this.registry.claim(n, this.clientId())) {
        if (this.state() === 'hosting') this.enter(n, { role: 'host', joined: false });
        return;
      }
    }
    this.fail('Couldn’t start a game right now — please try again.');
  }

  /** This device's identity, which is what holds a seat on a link (rule 9). */
  private clientId(): string {
    try {
      let id = localStorage.getItem(CLIENT_KEY);
      if (!id) {
        id = `d${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        localStorage.setItem(CLIENT_KEY, id);
      }
      return id;
    } catch {
      // Storage blocked (private mode): a per-run identity still holds the seat
      // for as long as the app stays open, we just cannot come back to it.
      return (this.volatileId ??= `d${Math.random().toString(36).slice(2)}`);
    }
  }
  private volatileId: string | null = null;

  private rememberedSession(): number | null {
    try {
      return parseSession(localStorage.getItem(SESSION_KEY), Date.now());
    } catch {
      return null; // storage blocked (private mode) — nothing remembered
    }
  }

  private rememberSession(n: number): void {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ n, at: Date.now() }));
    } catch {
      // storage blocked / full — we simply lose the ability to come back
    }
  }

  private forgetSession(): void {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // nothing to forget
    }
  }

  /**
   * Watch the session record: it says when player 2 arrives (so a waiting host
   * goes straight into the game), whether the opponent is on the link right
   * now, and whether the link has been ended.
   */
  private watchRecord(n: number): void {
    this.stopWatchingRecord();
    this.opponentSeen = false;
    this.recordSeen = false;
    this.opponentPresent.set(null);
    this.recordUnsub = this.registry.observe(n, (rec) => {
      this.lastRecord = rec;
      this.recordSeen = true;
      this.evaluateRecord();
    });
    // A heartbeat that just stops (no clean disconnect event) is caught by
    // re-evaluating the last record against the advancing clock.
    this.recheckTimer = setInterval(() => this.evaluateRecord(), RECHECK_MS);
  }

  private evaluateRecord(): void {
    if (!this.myRole || !this.recordSeen) return;
    const rec = this.lastRecord;

    // The other player pressed Leave: rule 9 says the link is gone, and with
    // it the game. This is the only way a round ends without being played out.
    if (rec === null || rec.terminated) {
      this.forgetSession();
      this.registry.stopPresence();
      this.detach();
      this.state.set('disconnected');
      return;
    }

    // Player 2 has taken the seat — the host's wait is over.
    if (this.state() === 'hosting' && rec.joined) this.state.set('playing');

    const theirs: SessionRole = this.myRole === 'host' ? 'joiner' : 'host';
    const present = isPartyPresent(rec, theirs, this.registry.serverNow());
    if (present) this.opponentSeen = true;
    // Stay `null` until we've actually seen them once, so an opponent who
    // hasn't arrived yet doesn't momentarily read as "left".
    this.opponentPresent.set(this.opponentSeen ? present : null);
  }

  private stopWatchingRecord(): void {
    this.recordUnsub?.();
    this.recordUnsub = null;
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    this.recheckTimer = null;
    this.lastRecord = null;
    this.recordSeen = false;
    this.opponentSeen = false;
    this.opponentPresent.set(null);
  }

  /**
   * Tab came back to the foreground. Firebase reconnects its own socket, so
   * there is nothing to repair here — just beat our presence at once rather
   * than on a timer that was frozen with the tab, so the other player stops
   * being told we are away, and re-take the wake lock the browser dropped.
   */
  private onVisible(): void {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    const s = this.state();
    if (this.mode === 'online' && this.gameNumber !== null && this.myRole) {
      if (s === 'hosting' || s === 'playing') {
        this.registry.startPresence(this.gameNumber, this.myRole);
      }
    }
    if (this.mode !== 'bot' && (s === 'hosting' || s === 'playing')) {
      void this.acquireWakeLock();
    }
  }

  /** Best-effort screen wake lock; unsupported browsers just no-op. */
  private async acquireWakeLock(): Promise<void> {
    if (this.wakeLock) return;
    try {
      const wl = await (navigator as WakeLockNavigator).wakeLock?.request('screen');
      if (!wl) return;
      this.wakeLock = wl;
      // The browser drops the lock whenever the tab hides; reflect that so the
      // next foreground (onVisible) re-acquires instead of thinking we hold it.
      wl.addEventListener('release', () => {
        if (this.wakeLock === wl) this.wakeLock = null;
      });
    } catch {
      // denied or unsupported — nothing we can do, and nothing lost
    }
  }

  private releaseWakeLock(): void {
    const wl = this.wakeLock;
    this.wakeLock = null;
    wl?.release().catch(() => {});
  }

  private fail(msg: string): void {
    this.registry.stopPresence();
    this.forgetSession();
    this.detach();
    this.errorMsg.set(msg);
    this.gameId.set(null);
    this.waitingForHost.set(false);
    this.state.set('error');
  }
}
