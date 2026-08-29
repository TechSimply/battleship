import { Injectable, effect, inject, isDevMode, signal } from '@angular/core';
import Peer, { DataConnection } from 'peerjs';
import { BOARD_H, BOARD_W, GameAction, GameService, GameSnapshot, PlayerId } from './game.service';
import {
  LobbyRegistryService,
  SessionRecord,
  SessionRole,
  isPartyPresent,
} from './lobby-registry.service';

/**
 * Rule 7: game sessions. The host claims a random free "Battle{n}" id on the
 * PeerJS broker (random, not sequential, so an outsider can't guess a low
 * number and wander into a running game), shares it, and the joiner connects
 * to it. After that, every game action is applied
 * locally and mirrored to the opponent over the WebRTC data channel.
 *
 * A dropped connection (network blip, phone backgrounded for a moment) does
 * NOT end the game: both sides enter 'reconnecting' for a grace period — the
 * joiner redials the host's stable Battle{n} id, the host re-accepts — and a
 * sync handshake replays whatever actions each side missed, so the
 * deterministic engines land back in the same state. Only a deliberate Leave
 * (which sends 'bye') or an expired grace period ends the session.
 *
 * Because a phone freezes a backgrounded tab's broker socket, returning to the
 * foreground triggers an immediate broker re-register (so Battle{n} is
 * reclaimed at once), and a screen wake lock is held for the duration of a live
 * game to make the OS less eager to suspend the host while it waits.
 */

/** Peer-id namespace so we never collide with unrelated PeerJS apps. */
const PEER_PREFIX = 'techsimply-battleship-battle-';
/**
 * Battle ids are random within this range rather than sequential, so an
 * outsider can't guess a low number and stumble into a running game.
 */
const MIN_GAME_ID = 1000;
const MAX_GAME_ID = 9999;
/** Give up after this many random collisions (the id space is ~9000 wide). */
const MAX_CLAIM_ATTEMPTS = 50;
/** How long a dropped game keeps trying to resume before giving up. */
const RECONNECT_GRACE_MS = 45_000;
/** How often the joiner redials the host while resuming. */
const REDIAL_INTERVAL_MS = 4_000;
/** Remembers our number+role so a reload/return reclaims the same seat (rule 9). */
const STORAGE_KEY = 'battleship:session';

export type SessionState =
  | 'lobby' // choosing New Game / Join The Game (rule 7.1)
  | 'hosting' // game id claimed, waiting for player 2
  | 'joining' // connecting to a host
  | 'playing' // both devices connected
  | 'reconnecting' // connection dropped; trying to resume the same game
  | 'disconnected' // opponent left / connection lost for good
  | 'error';

/** Everything that travels the wire: game actions plus session control. */
type WireMessage =
  | { kind: 'action'; seq: number; action: GameAction } // a game action, numbered per sender
  | { kind: 'sync'; applied: number } // resume: highest seq of yours I've applied
  | { kind: 'bye' }; // deliberate leave — don't wait for a resume

/** Minimal shape of the Screen Wake Lock API (not in every TS DOM lib). */
interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}
type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
};

/**
 * The guard that makes reconnect replay safe: a numbered action is applied only
 * when it is the very next one in sequence. A duplicate (a seq already applied)
 * or an out-of-order gap is skipped, so a move can never land twice and drift
 * the two devices' boards apart.
 */
export function actionInOrder(seq: number, appliedSeq: number): boolean {
  return seq === appliedSeq + 1;
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

  readonly state = signal<SessionState>('lobby');
  /** Shareable id shown to players — the plain number, e.g. "1" (rule 7.2). */
  readonly gameId = signal<string | null>(null);
  /** 0 = host (fires first), 1 = joiner. */
  readonly myPlayer = signal<PlayerId>(0);
  readonly errorMsg = signal<string | null>(null);
  /**
   * Is the opponent currently on the link? true = present, false = they closed
   * the app / left, null = unknown (not tracking, or we've not seen them yet).
   * Driven by Firebase presence so a closed app is noticed in seconds.
   */
  readonly opponentPresent = signal<boolean | null>(null);

  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  /** The n of Battle{n} — the host's stable peer id, used to redial. */
  private gameNumber: number | null = null;

  // Resume / idempotency bookkeeping: every action I originated this session
  // (its 1-based index in this log is its sequence number), and the highest
  // sequence number of the opponent's actions I've applied. On resume each side
  // reports how far it got and the other resends the tail. Numbering is what
  // makes that replay safe: an action already applied is dropped on arrival, so
  // a move can never land twice and drift the two boards out of sync.
  private sentLog: GameAction[] = [];
  private appliedSeq = 0;

  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private redialTimer: ReturnType<typeof setTimeout> | null = null;
  private reregisterTimer: ReturnType<typeof setTimeout> | null = null;
  /** One dial attempt at a time — parallel dials would race each other. */
  private dialInFlight = false;

  /** 'p2p' = real opponent over PeerJS; 'bot' = local random computer. */
  private mode: 'p2p' | 'bot' = 'p2p';
  private botTimer: ReturnType<typeof setTimeout> | null = null;

  // Opponent-presence watch (Firebase): a live subscription plus a slow re-check
  // so a heartbeat that simply stops (no clean disconnect) is still caught. We
  // latch `opponentSeen` so a not-yet-arrived opponent doesn't read as "left".
  private presenceUnsub: (() => void) | null = null;
  private presenceRecheck: ReturnType<typeof setInterval> | null = null;
  private lastRecord: SessionRecord | null = null;
  private opponentRole: SessionRole | null = null;
  private opponentSeen = false;

  /** Held while a game is live so the OS keeps the tab awake (best-effort). */
  private wakeLock: WakeLockSentinelLike | null = null;

  constructor() {
    if (isDevMode()) {
      // Test hook: sever the live data channel as if the network dropped.
      (globalThis as { __battleshipDrop?: () => void }).__battleshipDrop = () =>
        this.conn?.close();
    }

    // Mobile tabs freeze their broker socket when backgrounded — exactly what
    // happens when the host switches to a messaging app to send the invite,
    // which drops Battle{n} off the broker. The moment we're visible again,
    // force an immediate re-register (rather than waiting out the throttled
    // retry timer) and re-take the wake lock the browser dropped on hide.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => this.onVisible());
    }

    // Keep the screen (and thus this tab) alive while a game is live so a host
    // waiting for an opponent isn't suspended by the OS. Released as soon as we
    // fall back to the lobby / a dead session.
    effect(() => {
      const s = this.state();
      if (this.mode !== 'bot' && (s === 'hosting' || s === 'playing' || s === 'reconnecting')) {
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

  /** Rule 7.2: claim a random free Battle{n} id, then wait for player 2. */
  newGame(): void {
    this.errorMsg.set(null);
    this.state.set('hosting');
    void this.claimGameId();
  }

  /**
   * Rule 7.3 without the typing: a link that lands the opponent straight in
   * the joining flow. document.baseURI honours the deployed <base href>.
   */
  inviteLink(): string | null {
    return this.gameNumber === null ? null : `${document.baseURI}?join=${this.gameNumber}`;
  }

  /**
   * Rule 7.3: player 2 joins with the id player 1 shared. `patient` joins
   * (invite links) keep retrying for a while: the host's phone often
   * backgrounds its tab while sending the link, which drops Battle{n} off
   * the broker until the host returns to the game and re-registers.
   */
  join(idText: string, opts?: { patient?: boolean }): void {
    const n = parseGameId(idText);
    if (n === null) {
      this.errorMsg.set('That doesn’t look like a game number — enter just the number, e.g. "1"');
      return;
    }
    this.errorMsg.set(null);
    this.state.set('joining');
    this.gameNumber = n;
    this.gameId.set(`${n}`);
    const deadline = Date.now() + (opts?.patient ? 45_000 : 12_000);

    // While we're still retrying, peer-unavailable just means the host isn't
    // registered right now — not a fatal error.
    const peer = this.createPeer(
      new Peer(),
      (err) =>
        err.type === 'peer-unavailable' && this.state() === 'joining' && Date.now() < deadline,
    );
    peer.on('open', () => {
      if (this.state() !== 'joining') return; // broker reconnects re-emit 'open'
      this.dialHost(peer, n, deadline);
    });
  }

  /** One join attempt; reschedules itself until `deadline`, then fails. */
  private dialHost(peer: Peer, n: number, deadline: number): void {
    if (this.state() !== 'joining') return;
    const retry = () => {
      if (this.state() !== 'joining') return;
      if (Date.now() >= deadline) {
        this.fail(`Couldn’t find game ${n}. Check the id and try again.`);
      } else {
        setTimeout(() => this.dialHost(peer, n, deadline), 3_000);
      }
    };
    const conn = peer.connect(PEER_PREFIX + n, { reliable: true });
    const giveUp = setTimeout(() => {
      conn.close();
      retry();
    }, 8_000);
    conn.on('open', () => {
      clearTimeout(giveUp);
      this.attachConnection(conn, 1, false);
    });
    conn.on('error', () => {
      clearTimeout(giveUp);
      retry();
    });
  }

  /** Forward a local tap; applies it and mirrors it to the opponent. */
  act(board: PlayerId, c: { x: number; y: number }): void {
    if (this.state() !== 'playing') return;
    const action = this.game.tryLocal(this.myPlayer(), board, c);
    if (action && this.mode === 'p2p') this.sendAction(action);
  }

  /** Rematch on both devices, keeping the connection. */
  playAgain(): void {
    if (this.state() !== 'playing') return;
    this.game.reset();
    if (this.mode === 'p2p') this.sendAction({ kind: 'reset' });
  }

  /** Number a locally-originated action (1-based) and mirror it to the opponent. */
  private sendAction(action: GameAction): void {
    this.sentLog.push(action);
    const seq = this.sentLog.length;
    this.conn?.send({ kind: 'action', seq, action } satisfies WireMessage);
    this.persist(); // keep the saved game current for a reload mid-turn
  }

  /** Tear everything down and return to the lobby (rule 7.1). */
  leave(): void {
    try {
      this.conn?.send({ kind: 'bye' } satisfies WireMessage);
    } catch {
      // connection already gone — nothing to say goodbye to
    }
    // Rule 9: pressing Leave terminates the link permanently. Do this before we
    // null gameNumber below. (Bot/never-hosted sessions just stop presence.)
    if (this.mode === 'p2p' && this.gameNumber !== null) void this.registry.terminate(this.gameNumber);
    else this.registry.stopPresence();
    this.stopWatchingOpponent();
    this.clearSession();
    this.clearResumeTimers();
    this.stopReregisterLoop();
    this.mode = 'p2p';
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
    this.conn?.close({ flush: true }); // let the 'bye' drain before closing
    this.peer?.destroy();
    this.conn = null;
    this.peer = null;
    this.gameNumber = null;
    this.sentLog = [];
    this.appliedSeq = 0;
    this.game.reset();
    this.game.resetScores();
    this.gameId.set(null);
    this.errorMsg.set(null);
    this.state.set('lobby');
  }

  /**
   * Rule 9: reserve a random free Battle{n} in Firebase (the durable registry
   * that outlives this tab), then host the PeerJS peer on exactly that number.
   * Because the reservation persists, the link stays claimable for its TTL even
   * if we close the app, and we can reclaim the same number on return. If
   * Firebase is unreachable we degrade to a PeerJS-only claim so play still
   * works — just without durable links.
   */
  private async claimGameId(): Promise<void> {
    try {
      for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
        if (this.state() !== 'hosting') return; // user backed out mid-await
        const n = MIN_GAME_ID + Math.floor(Math.random() * (MAX_GAME_ID - MIN_GAME_ID + 1));
        if (await this.registry.claim(n)) {
          if (this.state() === 'hosting') this.hostWithId(n);
          return;
        }
      }
      this.fail('Couldn’t start a game right now — please try again.');
    } catch {
      this.claimGameIdFallback(0); // Firebase down — host without durable links
    }
  }

  /**
   * Host on a specific reserved number. On the rare PeerJS `unavailable-id` the
   * broker is still holding that id from a just-closed session — it frees within
   * a minute, so we keep our reserved number and retry it rather than grabbing a
   * different one (this is also the path a reload takes to reclaim its seat).
   */
  private hostWithId(n: number, attempt = 0): void {
    // 'hosting' for a fresh New Game, 'reconnecting' when re-registering our id
    // after a reload to resume an in-progress game (tryResume).
    const active = () => this.state() === 'hosting' || this.state() === 'reconnecting';
    if (!active()) return;
    const peer = this.createPeer(new Peer(PEER_PREFIX + n), (err) => {
      if (err.type === 'unavailable-id') {
        peer.destroy();
        if (!active()) return true;
        if (attempt < 30) setTimeout(() => this.hostWithId(n, attempt + 1), 2_000);
        else this.fail('Couldn’t start a game right now — please try again.');
        return true;
      }
      return false;
    });

    peer.on('open', () => {
      this.gameNumber = n;
      this.gameId.set(`${n}`);
      // Keep the link alive and reclaimable while we wait for player 2.
      this.registry.startPresence(n, 'host');
      this.persist();
    });

    this.wireHostConnections(peer);
  }

  /** PeerJS-only claim (Firebase unreachable): random id, no durable registry. */
  private claimGameIdFallback(attempt: number): void {
    if (attempt >= MAX_CLAIM_ATTEMPTS) {
      this.fail('Couldn’t start a game right now — please try again.');
      return;
    }
    const n = MIN_GAME_ID + Math.floor(Math.random() * (MAX_GAME_ID - MIN_GAME_ID + 1));
    const peer = this.createPeer(new Peer(PEER_PREFIX + n), (err) => {
      if (err.type === 'unavailable-id') {
        peer.destroy();
        if (this.state() === 'hosting') this.claimGameIdFallback(attempt + 1);
        return true;
      }
      return false;
    });
    peer.on('open', () => {
      this.gameNumber = n;
      this.gameId.set(`${n}`);
    });
    this.wireHostConnections(peer);
  }

  /** The host's `connection` handler — accepts player 2 and resume dials. */
  private wireHostConnections(peer: Peer): void {
    // Registered once, outside 'open' — broker reconnects re-emit 'open' and
    // must not stack duplicate connection handlers.
    peer.on('connection', (conn) => {
      const resume = (conn.metadata as { resume?: boolean } | undefined)?.resume === true;
      conn.on('open', () => {
        const gameUnderway = this.sentLog.length > 0 || this.appliedSeq > 0;
        if (this.state() === 'hosting' && !this.conn) {
          this.attachConnection(conn, 0, false);
        } else if (resume && (this.state() === 'reconnecting' || this.state() === 'playing')) {
          // Our opponent redialling after a drop — maybe before we even
          // noticed it; swap the connection in and resync.
          this.attachConnection(conn, 0, true);
        } else if (
          !gameUnderway &&
          (this.state() === 'playing' || this.state() === 'reconnecting')
        ) {
          // No game action has crossed the wire yet, so the connection we're
          // holding is a stale/ghost dial (see onLost): an invite-link join
          // whose first attempt the joiner already abandoned, delivered to us
          // late by the broker after we re-registered. Let this fresh join
          // replace it rather than refusing it as a full game.
          this.attachConnection(conn, 0, false);
        } else {
          conn.close(); // game is full
        }
      });
    });
  }

  private attachConnection(conn: DataConnection, me: PlayerId, resume: boolean): void {
    this.clearResumeTimers();
    const old = this.conn;
    this.conn = conn; // before old.close() so its events read as superseded
    old?.close();
    this.myPlayer.set(me);
    if (!resume) {
      this.sentLog = [];
      this.appliedSeq = 0;
      this.game.resetScores(); // fresh session — score starts 0–0 (rule 8)
      this.game.reset();
    }
    this.state.set('playing');

    // Rule 9: remember our seat so a reload/return reclaims the same number and
    // player role, keep our presence heartbeating, and (host side) mark the link
    // occupied now that player 2 has arrived.
    if (this.mode === 'p2p' && this.gameNumber !== null) {
      const role: SessionRole = me === 0 ? 'host' : 'joiner';
      this.registry.startPresence(this.gameNumber, role);
      this.persist();
      if (me === 0 && !resume) void this.registry.markJoined(this.gameNumber);
      this.watchOpponent(this.gameNumber, role);
    }

    conn.on('data', (data) => this.onMessage(data as WireMessage));
    conn.on('close', () => this.onLost(conn));
    conn.on('error', () => this.onLost(conn));

    // Resume handshake: tell the opponent how far we got; it resends the rest.
    if (resume) conn.send({ kind: 'sync', applied: this.appliedSeq } satisfies WireMessage);
  }

  private onMessage(msg: WireMessage): void {
    switch (msg.kind) {
      case 'sync':
        // Opponent came back and told us the highest sequence number of ours it
        // has applied; resend everything after that. Over-sending is harmless —
        // anything it already has is dropped as a duplicate on arrival.
        for (let i = msg.applied; i < this.sentLog.length; i++) {
          this.conn?.send({ kind: 'action', seq: i + 1, action: this.sentLog[i] } satisfies WireMessage);
        }
        break;
      case 'bye':
        this.finalizeDisconnect();
        break;
      case 'action':
        // Apply strictly in order and exactly once. A duplicate (a seq we've
        // already applied) or an out-of-order gap is ignored — the resync
        // resends the right tail in order — so a reconnect's replay can never
        // double-apply a move and drift the two boards apart.
        if (actionInOrder(msg.seq, this.appliedSeq)) {
          this.appliedSeq = msg.seq;
          this.game.apply(msg.action);
          this.persist(); // save the opponent's move so a reload keeps it
        }
        break;
    }
  }

  /** Create a peer with shared error handling; `handled` may intercept errors. */
  private createPeer(peer: Peer, handled?: (err: { type: string }) => boolean): Peer {
    this.peer?.destroy();
    this.peer = peer;
    peer.on('error', (err: Error & { type: string }) => {
      if (handled?.(err)) return;
      if (this.state() === 'reconnecting') return; // the redial loop is in charge
      if (err.type === 'peer-unavailable') {
        this.fail(`Couldn’t find that game. Check the id and try again.`);
      } else if (this.state() === 'hosting' || this.state() === 'joining') {
        this.fail('Connection problem — check your internet and try again.');
      }
    });
    // Broker socket dropped (backgrounded tab, network blip): re-register so
    // the Battle{n} id stays claimed / the joiner can still signal.
    peer.on('disconnected', () => this.keepRegistered(peer));
    return peer;
  }

  /**
   * Retry broker re-registration until it sticks. A single reconnect() is not
   * enough: if the network is still down when it runs, PeerJS gives up
   * silently and the Battle{n} id would stay lost even once we're back online.
   */
  private keepRegistered(peer: Peer): void {
    if (this.reregisterTimer) return; // a retry loop is already running
    const tick = () => {
      this.reregisterTimer = null;
      if (peer.destroyed || peer !== this.peer || !peer.disconnected) return;
      peer.reconnect();
      this.reregisterTimer = setTimeout(tick, 3_000);
    };
    this.reregisterTimer = setTimeout(tick, 1_000);
  }

  /**
   * Tab came back to the foreground. If our signalling peer's broker socket
   * dropped while we were away, reconnect it immediately so Battle{n} is
   * reclaimed at once instead of after the throttled retry tick — then re-take
   * the wake lock the browser released when we were hidden.
   */
  private onVisible(): void {
    if (document.visibilityState !== 'visible') return;
    const peer = this.peer;
    if (peer && !peer.destroyed && peer.disconnected) {
      try {
        peer.reconnect();
      } catch {
        // already mid-reconnect — the keepRegistered loop covers us
      }
      this.keepRegistered(peer);
    }
    const s = this.state();
    if (this.mode !== 'bot' && (s === 'hosting' || s === 'playing' || s === 'reconnecting')) {
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

  /** The data channel died while playing — start the resume window. */
  private onLost(conn: DataConnection): void {
    if (conn !== this.conn) return; // an old connection we already replaced
    if (this.state() !== 'playing') return;
    this.conn = null;

    // If not a single game action ever crossed this connection, it never
    // really carried a game. That is exactly the invite-link ghost: the
    // joiner's first dial times out while the host's tab is still backgrounded
    // and is abandoned, but the broker can hand that stale offer to the host
    // once it re-registers, opening a one-sided connection the joiner has
    // already moved on from. Burning the reconnect grace on it would strand the
    // host in 'disconnected' while the joiner's real retry gets refused as a
    // full game. So the host just resumes waiting for player 2 (nothing was
    // played, so nothing is lost); the joiner, with nothing to resume, redials.
    if (this.myPlayer() === 0 && this.sentLog.length === 0 && this.appliedSeq === 0) {
      this.state.set('hosting');
      return;
    }

    this.state.set('reconnecting');
    this.graceTimer = setTimeout(() => this.finalizeDisconnect(), RECONNECT_GRACE_MS);
    // The host keeps listening on its stable id; the joiner does the dialling.
    if (this.myPlayer() === 1) this.redial();
  }

  /** Joiner side: dial the host's Battle{n} id until it answers or grace ends. */
  private redial(): void {
    if (this.state() !== 'reconnecting' || this.gameNumber === null) return;
    if (this.dialInFlight) return;

    const attempt = (peer: Peer) => {
      if (this.state() !== 'reconnecting' || this.dialInFlight) return;
      this.dialInFlight = true;
      const conn = peer.connect(PEER_PREFIX + this.gameNumber, {
        reliable: true,
        metadata: { resume: true },
      });
      const giveUp = setTimeout(() => {
        this.dialInFlight = false;
        conn.close();
        this.scheduleRedial();
      }, REDIAL_INTERVAL_MS);
      conn.on('open', () => {
        clearTimeout(giveUp);
        this.dialInFlight = false;
        if (this.state() === 'reconnecting') this.attachConnection(conn, 1, true);
        else conn.close();
      });
      conn.on('error', () => {
        clearTimeout(giveUp);
        this.dialInFlight = false;
        this.scheduleRedial();
      });
    };

    const peer = this.peer;
    if (peer && !peer.destroyed && peer.open && !peer.disconnected) {
      attempt(peer);
    } else {
      // Our signalling peer died with the network — start a fresh one. It may
      // never open (broker still unreachable), so also keep the retry loop
      // ticking; each tick lands here again until one fresh peer gets through.
      const fresh = this.createPeer(new Peer());
      fresh.on('open', () => attempt(fresh));
      this.scheduleRedial();
    }
  }

  private scheduleRedial(): void {
    if (this.state() !== 'reconnecting') return;
    if (this.redialTimer) clearTimeout(this.redialTimer);
    this.redialTimer = setTimeout(() => this.redial(), REDIAL_INTERVAL_MS);
  }

  /** Resume failed or the opponent left on purpose — the session is over. */
  private finalizeDisconnect(): void {
    this.clearResumeTimers();
    this.registry.stopPresence(); // we're no longer on the link
    this.stopWatchingOpponent();
    this.conn = null;
    this.state.set('disconnected');
  }

  private clearResumeTimers(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.redialTimer) clearTimeout(this.redialTimer);
    this.graceTimer = null;
    this.redialTimer = null;
    this.dialInFlight = false;
  }

  private stopReregisterLoop(): void {
    if (this.reregisterTimer) clearTimeout(this.reregisterTimer);
    this.reregisterTimer = null;
  }

  private fail(msg: string): void {
    this.clearResumeTimers();
    this.stopReregisterLoop();
    this.registry.stopPresence();
    this.stopWatchingOpponent();
    this.errorMsg.set(msg);
    this.peer?.destroy();
    this.peer = null;
    this.conn = null;
    this.gameNumber = null;
    this.gameId.set(null);
    this.state.set('error');
  }

  /**
   * Rule 9: on launch, if this device owned a link that is still live, step
   * straight back into it as the same player number — the host re-hosts its
   * reserved id, a joiner redials it. Returns true if a resume was started, so
   * the caller can skip the fresh-start lobby. A dead/terminated/expired link is
   * forgotten. Reads nothing over the network when there's no saved seat, so it
   * stays inert in tests.
   */
  async tryResume(): Promise<boolean> {
    const saved = this.readSession();
    if (!saved) return false;
    let alive = false;
    try {
      alive = await this.registry.reclaim(saved.n, saved.role);
    } catch {
      alive = false;
    }
    if (!alive) {
      this.clearSession();
      return false;
    }
    this.errorMsg.set(null);
    this.gameNumber = saved.n;
    this.gameId.set(`${saved.n}`);
    this.myPlayer.set(saved.role === 'host' ? 0 : 1);

    // Restore the exact game we left (reload wipes memory) so we don't come back
    // to a blank board that then desyncs the other device; the reconnect's
    // seq-resync reconciles anything that happened while we were away.
    if (saved.game) {
      this.game.restore(saved.game);
      this.sentLog = saved.sentLog ?? [];
      this.appliedSeq = saved.appliedSeq ?? 0;
    }

    // Rejoin through the reconnect path (never the fresh-start path) so neither
    // side resets: the host re-registers its id and waits for the other to
    // resume-dial; a joiner resume-dials the host. Both land in attachConnection
    // with resume=true.
    this.state.set('reconnecting');
    this.registry.startPresence(saved.n, saved.role);
    this.watchOpponent(saved.n, saved.role);
    if (saved.role === 'host') {
      this.hostWithId(saved.n);
    } else {
      this.redial();
    }
    return true;
  }

  /** Persist the live game so a reload/return resumes the exact same board. */
  private persist(): void {
    if (this.mode !== 'p2p' || this.gameNumber === null) return;
    const role: SessionRole = this.myPlayer() === 0 ? 'host' : 'joiner';
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          n: this.gameNumber,
          role,
          appliedSeq: this.appliedSeq,
          sentLog: this.sentLog,
          game: this.game.snapshot(),
        }),
      );
    } catch {
      // private-mode / storage-full — resume-on-return just won't be available
    }
  }

  private clearSession(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // nothing we can do; a stale entry is harmless (reclaim re-validates it)
    }
  }

  private readSession(): {
    n: number;
    role: SessionRole;
    appliedSeq?: number;
    sentLog?: GameAction[];
    game?: GameSnapshot;
  } | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw) as {
        n?: unknown;
        role?: unknown;
        appliedSeq?: number;
        sentLog?: GameAction[];
        game?: GameSnapshot;
      };
      if (typeof v.n === 'number' && (v.role === 'host' || v.role === 'joiner')) {
        return { n: v.n, role: v.role, appliedSeq: v.appliedSeq, sentLog: v.sentLog, game: v.game };
      }
    } catch {
      // malformed — treat as no saved session
    }
    return null;
  }

  /**
   * Watch the opponent's Firebase presence so we can tell the player the moment
   * the other side closes the app / leaves the link (rule 9), rather than
   * waiting out the PeerJS reconnect grace. `myRole` is our own seat; we watch
   * the other one.
   */
  private watchOpponent(n: number, myRole: SessionRole): void {
    this.stopWatchingOpponent();
    this.opponentRole = myRole === 'host' ? 'joiner' : 'host';
    this.opponentSeen = false;
    this.opponentPresent.set(null);
    this.presenceUnsub = this.registry.observe(n, (rec) => {
      this.lastRecord = rec;
      this.evaluateOpponentPresence();
    });
    // A heartbeat that just stops (no clean disconnect event) is caught by
    // re-evaluating the last record against the advancing clock.
    this.presenceRecheck = setInterval(() => this.evaluateOpponentPresence(), 15_000);
  }

  private evaluateOpponentPresence(): void {
    if (!this.opponentRole) return;
    const present = isPartyPresent(this.lastRecord, this.opponentRole, this.registry.serverNow());
    if (present) this.opponentSeen = true;
    // Stay `null` until we've actually seen them once, so an opponent who hasn't
    // finished connecting yet doesn't momentarily read as "left".
    this.opponentPresent.set(this.opponentSeen ? present : null);
  }

  private stopWatchingOpponent(): void {
    this.presenceUnsub?.();
    this.presenceUnsub = null;
    if (this.presenceRecheck) clearInterval(this.presenceRecheck);
    this.presenceRecheck = null;
    this.lastRecord = null;
    this.opponentRole = null;
    this.opponentSeen = false;
    this.opponentPresent.set(null);
  }
}
