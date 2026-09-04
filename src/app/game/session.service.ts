import { Injectable, computed, effect, inject, isDevMode, signal } from '@angular/core';
import { BOARD_H, BOARD_W, Coord, GameService, Intent, PlayerId } from './game.service';
import { GdAdsService } from './gd-ads.service';
import {
  LobbyRegistryService,
  Seat,
  SessionRecord,
  SessionRole,
  WireMove,
  isPartyPresent,
  roundId,
  roundOf,
  seatNo,
  toAction,
} from './lobby-registry.service';

/**
 * Rule 7: game sessions. The host claims a random free "Battle{n}" (random, not
 * sequential, so an outsider can't guess a low number and wander into a running
 * game), shares it, and the other player opens it. Everything after that goes
 * through the session's log in Firebase — see `lobby-registry.service.ts` for
 * why the game no longer runs peer-to-peer, and for what the database now
 * refuses to take a client's word for.
 *
 * The shape of a session is deliberately simple, because the hard parts moved
 * to a server that is always there:
 *
 *  - **There is nobody to find.** Player 2 does not dial player 1 and does not
 *    wait for them to be awake; they take the empty seat on the link and are
 *    in the game immediately.
 *  - **A move is a write, not a message.** `act()` commits the move, appends it
 *    to the log, and both devices apply what the log says, in the order the
 *    database put it in.
 *  - **Leaving is not losing.** The board is on the server, so `resumeSession()`
 *    replays the log — and reads this device's own ship back out of the secret
 *    only it can read — and puts the player back exactly where they were.
 *  - **Neither device is trusted with the other's ship.** A tap is played in
 *    two steps: commit the square, then log the entry with the answer the
 *    database checks (`hit`, `ram`). That is why `act()` is asynchronous now,
 *    and why the board shows a beat of "in flight" before a shot lands.
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
   * A tap is in flight: it has been committed and we are waiting for the
   * database to say what it found. Short — one or two round trips — but the
   * board stops taking taps while it lasts, so nothing is played twice.
   */
  readonly busy = signal(false);
  /**
   * The database refused something. It means one of the two devices is not
   * playing by the rules (or the connection died mid-move), and it is worth
   * saying so rather than leaving a player tapping a board that won't answer.
   */
  readonly problem = signal<string | null>(null);
  /**
   * Is the opponent currently on the link? true = present, false = they closed
   * the app / left, null = unknown (not tracking, or we've not seen them yet).
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
  /** The session's creation stamp — the first half of every round id. */
  private createdAt = 0;
  /** The round being played; entries from any other one are not ours to apply. */
  private round = '';

  /**
   * Every log entry this device has already applied, by key: the backlog it
   * replayed, and its own moves, which it applies the moment they are played so
   * the board answers under the finger. Firebase hands a local write straight
   * back through the same subscription, so without this each of them would
   * arrive twice.
   */
  private applied = new Set<string>();
  private movesUnsub: (() => void) | null = null;

  /**
   * Where this device's own ship has stood, by round and epoch. Written as we
   * play and fetched back from the secret on a replay — the log does not carry
   * it, because the whole point is that nobody else's device can.
   */
  private ships = new Map<string, Map<number, Coord>>();

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
  /** One reveal per round, at the end of it (see `revealAtEnd`). */
  private revealed = '';

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

    // Rule 6/11's aftermath: once the round is over there is nothing left to
    // protect, so each device shows where its own ship ended up — otherwise a
    // player who burned down to 0% on a move (rule 6.3) would leave a wreck
    // nobody can draw. The database checks the square against the secret, so
    // even this last word cannot be a lie.
    effect(() => {
      const over = this.game.phase() === 'gameover';
      const playing = this.state() === 'playing';
      if (over && playing && this.mode === 'online') void this.revealAtEnd();
    });

    // Computer opponent: whenever the game waits on player 1 (unplaced ship,
    // or its turn to fire/move), queue one random action after a short
    // "thinking" pause. Signals are read up front so the effect always
    // re-arms on the next state change.
    effect(() => {
      const phase = this.game.phase();
      const turn = this.game.currentPlayer();
      const botPlaced = this.game.players()[1].placed;
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

  /**
   * Rule 11 / rule 6.2, decided on this device — which is where the computer
   * opponent's ship lives anyway. Online this same question is the one thing a
   * client is never allowed to answer for itself.
   */
  private strikes(target: PlayerId, c: Coord): boolean {
    const ship = this.game.players()[target].ship;
    return !!ship && ship.x === c.x && ship.y === c.y;
  }

  /** One random-but-legal computer action for whatever the game waits on. */
  private botAct(): void {
    if (this.mode !== 'bot' || this.state() !== 'playing') return;
    const rnd = (n: number) => Math.floor(Math.random() * n);
    switch (this.game.phase()) {
      case 'placement': {
        if (this.game.players()[1].placed) return;
        const c = { x: rnd(BOARD_W), y: rnd(BOARD_H) };
        this.game.apply({ kind: 'place', player: 1, c, ram: this.strikes(0, c) });
        break;
      }
      case 'fire': {
        if (this.game.currentPlayer() !== 1) return;
        const from = this.game.players()[1].ship;
        // Rule 5.2-5.4 narrow down where the ship provably can be; shoot
        // randomly within that set instead of anywhere still unbombed.
        const candidates = this.game
          .possibleShipSquares(0)
          .filter((c) => !from || c.x !== from.x || c.y !== from.y);
        if (!from || !candidates.length) return;
        const to = candidates[rnd(candidates.length)];
        this.game.apply({ kind: 'fire', player: 1, from, to, hit: this.strikes(0, to) });
        if (this.game.phase() === 'move' && !this.game.legalMoves(1).length) {
          this.game.apply({ kind: 'stay', player: 1 });
        }
        break;
      }
      case 'move': {
        if (this.game.currentPlayer() !== 1) return;
        const moves = this.game.legalMoves(1);
        if (!moves.length) return;
        const c = moves[rnd(moves.length)];
        this.game.apply({ kind: 'move', player: 1, c, ram: this.strikes(0, c) });
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
   * wake: the seat is taken on the record and the game starts.
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

    const me = await this.clientId();
    // Player 1 opening their own invite link (to check it, or because it is
    // the only copy of the number they have) takes their own seat back rather
    // than trying to join themselves.
    const mine = await this.registry.reclaimSeat(n, me);
    if (this.state() !== 'joining') return; // player backed out while we asked
    if (mine) {
      await this.enter(n, mine);
      return;
    }
    const seat = await this.registry.takeJoinerSeat(n, me);
    if (!seat) {
      this.fail('Couldn’t find that game. Check the id and try again.');
      return;
    }
    if (this.state() !== 'joining') return;
    await this.enter(n, seat);
  }

  /**
   * Rule 9: go back to the game this device is in. Called on any load without
   * a `?join=` param, so closing the app — or the OS killing it, or the phone
   * dying — is no longer the end of a round: the seat is still ours on the
   * record, the board is rebuilt by replaying the log, and our own ship comes
   * back out of the secret the database has been holding for us.
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
    const seat = await this.registry.reclaimSeat(n, await this.clientId());
    if (!seat) {
      this.forgetSession();
      if (this.state() === 'joining') this.toLobby();
      return false;
    }
    if (this.state() !== 'joining') return false; // player moved on while we asked
    await this.enter(n, seat);
    return true;
  }

  /**
   * Join the session's log and play. A host whose link nobody has opened waits
   * on the lobby screen instead — but they are already watching the record, so
   * the moment player 2 takes the seat they are in.
   */
  private async enter(n: number, seat: Seat): Promise<void> {
    this.gameNumber = n;
    this.createdAt = seat.createdAt;
    this.gameId.set(`${n}`);
    this.myRole = seat.role;
    this.myPlayer.set(seatNo(seat.role));
    this.rememberSession(n);
    this.registry.startPresence(n, seat.role);
    this.watchRecord(n);
    this.waitingForHost.set(false);
    // A host whose link nobody has opened waits on the lobby screen with the
    // number to share; everyone else is in the game.
    this.state.set(seat.role === 'host' && !seat.joined ? 'hosting' : 'playing');
    await this.replay(n, seatNo(seat.role));
  }

  /**
   * Rebuild the board from the log, then follow it. The rounds a session has
   * been through are read off the log itself (each `reset` opens the next one),
   * and this device's own squares are fetched for each of them before anything
   * is applied — without them it could replay the game but not find its own
   * ship at the end of it.
   */
  private async replay(n: number, seat: PlayerId): Promise<void> {
    this.movesUnsub?.();
    this.game.resetScores();
    this.game.reset();
    this.applied.clear();
    this.ships.clear();
    this.round = roundId(this.createdAt);
    this.revealed = '';
    // The board is not the board yet: hold taps until the log has been read
    // back, or a first tap could place a ship the replay is about to place.
    this.busy.set(true);
    try {
      await this.rebuild(n, seat);
    } finally {
      this.busy.set(false);
    }
  }

  private async rebuild(n: number, seat: PlayerId): Promise<void> {
    const backlog = await this.registry.backlog(n);
    if (this.gameNumber !== n) return; // left again while we were reading

    const rounds = [
      this.round,
      ...backlog
        .filter(([, raw]) => raw?.k === 'reset')
        .map(([key]) => roundId(this.createdAt, key)),
    ];
    for (const r of rounds) this.ships.set(r, await this.registry.ownShips(n, r, seat));
    if (this.gameNumber !== n) return;

    for (const [key, raw] of backlog) {
      this.applied.add(key);
      this.applyEntry(raw, key);
    }
    this.movesUnsub = this.registry.follow(n, this.applied, (raw, key) =>
      this.applyEntry(raw, key),
    );
  }

  /**
   * One entry off the log. Entries from a round we are no longer playing are
   * not ours to apply; a `reset` is what moves us on to the next one, and its
   * own key names it.
   */
  private applyEntry(raw: WireMove, key: string): void {
    if (roundOf(raw) !== this.round) return;
    const me = this.myPlayer();
    const round = this.round;
    const action = toAction(raw, (p, epoch) =>
      p === me ? (this.ships.get(round)?.get(epoch) ?? null) : null,
    );
    if (!action) return;
    if (action.kind === 'reset') {
      this.round = roundId(this.createdAt, key);
      // Not `set`: on a replay the squares for this round have already been
      // fetched, and clearing them here would lose our own ship in every round
      // after the first.
      if (!this.ships.has(this.round)) this.ships.set(this.round, new Map());
      this.revealed = '';
    }
    this.game.apply(action);
  }

  /**
   * Play a tap on the united board (rule 2.3). Online this is two writes: the
   * square is committed first, and only then is the entry logged with the
   * answer — `hit` or `ram` — which the database checks against a position
   * this device is not allowed to see. Against the computer, the same actions
   * are settled here, since both ships are on this device anyway.
   */
  async act(c: Coord): Promise<void> {
    if (this.state() !== 'playing' || this.busy()) return;
    const me = this.myPlayer();
    const intent = this.game.intent(me, c);
    if (!intent) return;
    if (this.mode === 'bot') {
      this.actLocally(intent, me, c);
      return;
    }
    const n = this.gameNumber;
    if (n === null) return;
    this.busy.set(true);
    try {
      await this.actOnline(intent, me, c, n, this.round);
      this.problem.set(null);
    } catch {
      this.problem.set('That move was refused — the game is out of step.');
    } finally {
      this.busy.set(false);
    }
  }

  /** The computer game: no database, so this device settles its own answers. */
  private actLocally(intent: Intent, me: PlayerId, c: Coord): void {
    const foe: PlayerId = me === 0 ? 1 : 0;
    switch (intent) {
      case 'place':
        this.game.apply({ kind: 'place', player: me, c, ram: this.strikes(foe, c) });
        break;
      case 'move':
        this.game.apply({ kind: 'move', player: me, c, ram: this.strikes(foe, c) });
        break;
      case 'fire': {
        const from = this.game.players()[me].ship;
        if (!from) return;
        this.game.apply({ kind: 'fire', player: me, from, to: c, hit: this.strikes(foe, c) });
        if (this.game.phase() === 'move' && !this.game.legalMoves(me).length) {
          this.game.apply({ kind: 'stay', player: me });
        }
        break;
      }
    }
  }

  private async actOnline(
    intent: Intent,
    me: PlayerId,
    c: Coord,
    n: number,
    round: string,
  ): Promise<void> {
    const foe: PlayerId = me === 0 ? 1 : 0;
    const mine = this.game.players()[me];
    // Claim the key before writing: Firebase hands a device its own writes back
    // the instant they are made, and a guess that is about to be rejected must
    // never be mistaken for a move that happened.
    const key = this.own(this.registry.newKey(n));
    switch (intent) {
      case 'place': {
        // The square that ended up committed, which is the one asked for
        // unless a dropped connection already spoke for this epoch.
        const at = await this.registry.place(n, round, me, c, key);
        this.rememberShip(round, 0, at.c);
        this.game.apply({ kind: 'place', player: me, c: at.c, ram: at.ram });
        break;
      }
      case 'fire': {
        const from = mine.ship;
        if (!from) return;
        const hit = await this.registry.fire(
          n,
          round,
          me,
          mine.epoch,
          this.game.players()[foe].epoch,
          from,
          c,
          key,
        );
        this.game.apply({ kind: 'fire', player: me, from, to: c, hit });
        // Rule 5.4: boxed in with nowhere to sail, so the turn passes instead.
        // The database only takes this from a ship that really is stuck.
        if (this.game.phase() === 'move' && !this.game.legalMoves(me).length) {
          await this.registry.stay(n, round, me, mine.epoch, this.own(this.registry.newKey(n)));
          this.game.apply({ kind: 'stay', player: me });
        }
        break;
      }
      case 'move': {
        const epoch = mine.epoch + 1;
        const at = await this.registry.move(
          n,
          round,
          me,
          epoch,
          this.game.players()[foe].epoch,
          c,
          key,
        );
        this.rememberShip(round, epoch, at.c);
        this.game.apply({ kind: 'move', player: me, c: at.c, ram: at.ram });
        break;
      }
    }
  }

  /** Ours: this device plays it itself, so the log's echo is dropped. */
  private own(key: string): string {
    this.applied.add(key);
    return key;
  }

  private rememberShip(round: string, epoch: number, c: Coord): void {
    const byEpoch = this.ships.get(round) ?? new Map<number, Coord>();
    byEpoch.set(epoch, c);
    this.ships.set(round, byEpoch);
  }

  /** Rule 6/11's aftermath: show this device's own square, once, per round. */
  private async revealAtEnd(): Promise<void> {
    const n = this.gameNumber;
    const round = this.round;
    const me = this.myPlayer();
    const mine = this.game.players()[me];
    if (n === null || this.revealed === round || !mine.placed) return;
    this.revealed = round;
    const c = this.ships.get(round)?.get(mine.epoch);
    if (!c) return;
    try {
      await this.registry.reveal(n, round, me, mine.epoch, c, this.own(this.registry.newKey(n)));
      this.game.apply({ kind: 'reveal', player: me, c });
    } catch {
      // nothing to do: the wreck simply isn't drawn on the other board
    }
  }

  /** Rematch, keeping the score (rule 8). */
  async playAgain(): Promise<void> {
    if (this.state() !== 'playing') return;
    // The round is over and the next has not begun: the one point in the game
    // where an ad interrupts nothing. Outside the GD portal this is a no-op.
    this.ads.showAd();
    if (this.mode !== 'online' || this.gameNumber === null) {
      this.game.reset();
      return;
    }
    try {
      const key = this.own(this.registry.newKey(this.gameNumber));
      await this.registry.rematch(this.gameNumber, this.round, this.myPlayer(), key);
      this.round = roundId(this.createdAt, key);
      this.ships.set(this.round, new Map());
      this.revealed = '';
      this.game.reset();
      this.problem.set(null);
    } catch {
      this.problem.set('Couldn’t start the next round — check your connection.');
    }
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
    this.applied.clear();
    this.ships.clear();
    this.gameNumber = null;
    this.myRole = null;
    this.busy.set(false);
    this.problem.set(null);
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
    const me = await this.clientId();
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      if (this.state() !== 'hosting') return; // user backed out mid-await
      const n = MIN_GAME_ID + Math.floor(Math.random() * (MAX_GAME_ID - MIN_GAME_ID + 1));
      if (await this.registry.claim(n, me)) {
        const seat = await this.registry.reclaimSeat(n, me);
        if (seat && this.state() === 'hosting') await this.enter(n, seat);
        return;
      }
    }
    this.fail('Couldn’t start a game right now — please try again.');
  }

  /**
   * This device's identity, which is what holds a seat on a link (rule 9) —
   * and, since the database started refereeing, what authorises every move
   * played in that seat's name. It is an anonymous Firebase account rather
   * than something we generate: a value this app made up would be a value the
   * console could edit.
   */
  private clientId(): Promise<string> {
    return this.registry.uid();
  }

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
   * than on a timer that was frozen with the tab, and re-take the wake lock
   * the browser dropped.
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
