import { Injectable, effect, inject, isDevMode, signal } from '@angular/core';
import Peer, { DataConnection } from 'peerjs';
import { BOARD_H, BOARD_W, GameAction, GameService, PlayerId } from './game.service';
import { GdAdsService } from './gd-ads.service';
import { LobbyRegistryService, SessionRecord, SessionRole, isPartyPresent } from './lobby-registry.service';

/**
 * Rule 7: game sessions. The host claims a random free "Battle{n}" id on the
 * PeerJS broker (random, not sequential, so an outsider can't guess a low
 * number and wander into a running game), shares it, and the joiner connects
 * to it. After that, every game action is applied
 * locally and mirrored to the opponent over the WebRTC data channel.
 *
 * A game lives only as long as both devices stay connected. Losing the data
 * channel — closing the tab, quitting the PWA, a network drop — ends the
 * session: both sides go to 'disconnected' and start a new game. There is
 * deliberately no resume. The state lives only in the two browsers, so a
 * reconnect had to rebuild it by replaying moves, and any gap there desynced
 * the boards (players seeing different bombed squares, or a win only one side
 * saw) — far worse than simply ending the round. Restoring resume properly
 * means persisting the authoritative game server-side, not replaying deltas.
 *
 * Because a phone freezes a backgrounded tab's broker socket, returning to the
 * foreground triggers an immediate broker re-register (so Battle{n} is
 * reclaimed at once while waiting for player 2), and a screen wake lock is held
 * for the duration of a live game to make the OS less eager to suspend the tab.
 *
 * Getting back on the broker is a *session*-level job, not a peer-level one.
 * PeerJS reconnects the peer it has when it can, but it also aborts and
 * discards peers (a socket that never carried an id, an id the broker is still
 * holding from the socket that just died), and every replacement arrives with
 * no history. Judging a replacement on its own history is what used to greet a
 * host — who had claimed a number, shared the link and stepped out for ten
 * seconds — with "Connection problem — check your internet". So the fact that
 * matters, `brokerSeen`, is kept on the session: once we have held a number,
 * broker trouble is ridden out (reconnect, or rebuild the peer on the same
 * reserved number) rather than reported, and the error screen is reached only
 * with the app on screen and the retries genuinely spent.
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
/** Safety net for a handshake that stalls; a live host answers in well under this. */
const DIAL_TIMEOUT_MS = 5_000;
/** Nobody is hosting that game any more — and it cannot be resumed. */
const GAME_OVER_MSG = 'Game over — opponent left.';
/**
 * Broker errors that mean "the signalling link is having a moment", not "this
 * device is offline". PeerJS raises one of these whenever its socket to the
 * broker goes away — which is exactly what a phone does to a backgrounded tab,
 * i.e. every time the host leaves the app to send the invite — and
 * `server-error` whenever the broker's HTTP side is momentarily unreachable,
 * which is what a just-unfrozen webview sees while its network comes back.
 */
const RECOVERABLE_ERRORS = new Set([
  'network',
  'socket-closed',
  'socket-error',
  'disconnected',
  'server-error',
]);
/**
 * How many times we rebuild the signalling peer from scratch before telling the
 * player their connection is the problem — on a first connection, where there
 * is nothing to lose and they are waiting on us, and once we have actually held
 * a number on the broker, where an invite link is already out and giving up
 * would strand it. Only ever counted down while the app is on screen (see
 * `rebuildPeer`).
 */
const MAX_FIRST_REBUILDS = 4;
const MAX_RECLAIM_REBUILDS = 20;
/** Backoff between rebuilds: this times the attempt number, capped. */
const PEER_REBUILD_MS = 1_000;
const MAX_REBUILD_BACKOFF = 4;
/** How long the broker may hold a just-dropped id before we stop waiting for it. */
const MAX_ID_RETRIES = 30;
/** Retry cadence while the broker still holds our id from the socket that just died. */
const ID_RETRY_MS = 2_000;
/** Cadence of the broker re-registration loop. */
const REREGISTER_MS = 3_000;

/** What a PeerJS error means for the session. */
export type PeerErrorAction =
  | 'recover' // transient broker trouble — re-register / rebuild, keep the game
  | 'not-found' // that game id isn't on the broker
  | 'fail' // unrecoverable — show the error screen
  | 'ignore'; // nothing to do in this state

/**
 * Classify a PeerJS error. Split out from the handler so the one case that
 * kept ending games on its own — the host backgrounding the app to send the
 * invite, which drops the broker socket — is covered by a unit test.
 *
 * `recoverable` says whether this session still has a way back: either it has
 * already been on the broker (so the id is ours and worth reclaiming) or it
 * still has rebuild attempts left. It is deliberately a fact about the
 * *session*, not about one `Peer` object — PeerJS hands us a brand-new peer
 * every time it aborts, and judging that fresh peer on its own history is what
 * dumped a host who had been happily waiting on a claimed number into
 * "Connection problem — check your internet".
 */
export function peerErrorAction(
  type: string,
  recoverable: boolean,
  state: SessionState,
): PeerErrorAction {
  if (type === 'peer-unavailable') return 'not-found';
  if (recoverable && RECOVERABLE_ERRORS.has(type)) return 'recover';
  return state === 'hosting' || state === 'joining' ? 'fail' : 'ignore';
}

export type SessionState =
  | 'lobby' // choosing New Game / Join The Game (rule 7.1)
  | 'hosting' // game id claimed, waiting for player 2
  | 'joining' // connecting to a host
  | 'playing' // both devices connected
  | 'disconnected' // opponent left / connection lost — the game is over
  | 'error';

/** Everything that travels the wire: game actions plus session control. */
type WireMessage =
  | { kind: 'action'; seq: number; action: GameAction } // a game action, numbered per sender
  | { kind: 'bye' }; // deliberate leave

/** Minimal shape of the Screen Wake Lock API (not in every TS DOM lib). */
interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}
type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
};

/**
 * Actions are numbered per sender and applied only in strict order. The channel
 * is reliable and ordered, so this should always hold — it is a cheap guard that
 * a stray or repeated delivery can never apply a move twice and silently drift
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
  private readonly ads = inject(GdAdsService);

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
  /** The n of Battle{n} — the host's peer id. */
  private gameNumber: number | null = null;

  // Ordering bookkeeping: how many actions I've originated (the next one's
  // sequence number) and the highest sequence number of the opponent's I've
  // applied, so an action can only ever be applied once, in order.
  private sentSeq = 0;
  private appliedSeq = 0;

  private reregisterTimer: ReturnType<typeof setTimeout> | null = null;
  /** Armed while we are waiting to build a fresh signalling peer. */
  private peerRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Has *this session* ever been on the broker? Once it has, our Battle{n} is a
   * real reservation and every broker hiccup is worth riding out, however many
   * `Peer` objects PeerJS burns through getting back to it.
   */
  private brokerSeen = false;
  /** Consecutive peer rebuilds since we were last on the broker. */
  private peerRebuilds = 0;

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

  /** Rule 7.2: claim a random free Battle{n} id, then wait for player 2. */
  newGame(): void {
    this.errorMsg.set(null);
    this.resetRecovery();
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
   * Rule 7.3: player 2 joins with the id player 1 shared. Exactly one attempt —
   * a host who is there answers in well under a second, and if they are not the
   * broker says so just as fast. A dropped game cannot be resumed, so there is
   * nothing to wait for: we say the game is over instead of retrying.
   */
  join(idText: string): void {
    const n = parseGameId(idText);
    if (n === null) {
      this.errorMsg.set('That doesn’t look like a game number — enter just the number, e.g. "1"');
      return;
    }
    this.errorMsg.set(null);
    this.resetRecovery();
    this.state.set('joining');
    this.gameNumber = n;
    this.gameId.set(`${n}`);
    this.connectToBroker(n);
  }

  /**
   * The joiner's signalling peer. Split out from `join()` so a broker that is
   * simply not answering yet (a webview whose network has not woken up with it)
   * can be retried on a fresh peer without restarting the join flow.
   */
  private connectToBroker(n: number): void {
    // No such peer on the broker = nobody is hosting that game any more.
    const peer = this.createPeer(new Peer(), (err) => {
      if (err.type === 'peer-unavailable' && this.state() === 'joining') {
        this.fail(GAME_OVER_MSG);
        return true;
      }
      return false;
    });
    peer.on('open', () => {
      if (this.state() !== 'joining') return; // broker reconnects re-emit 'open'
      this.dialHost(peer, n);
    });
  }

  /** The single join attempt: anything but a connection means there is no game. */
  private dialHost(peer: Peer, n: number): void {
    if (this.state() !== 'joining') return;
    const conn = peer.connect(PEER_PREFIX + n, { reliable: true });
    const giveUp = setTimeout(() => {
      conn.close();
      this.fail(GAME_OVER_MSG);
    }, DIAL_TIMEOUT_MS);
    conn.on('open', () => {
      clearTimeout(giveUp);
      this.attachConnection(conn, 1);
    });
    conn.on('error', () => {
      clearTimeout(giveUp);
      this.fail(GAME_OVER_MSG);
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
    // The round is over and the next has not begun: the one point in the game
    // where an ad interrupts nothing. Outside the GD portal this is a no-op.
    this.ads.showAd();
    this.game.reset();
    if (this.mode === 'p2p') this.sendAction({ kind: 'reset' });
  }

  /** Number a locally-originated action (1-based) and mirror it to the opponent. */
  private sendAction(action: GameAction): void {
    const seq = ++this.sentSeq;
    this.conn?.send({ kind: 'action', seq, action } satisfies WireMessage);
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
    this.resetRecovery();
    this.mode = 'p2p';
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
    this.conn?.close({ flush: true }); // let the 'bye' drain before closing
    this.peer?.destroy();
    this.conn = null;
    this.peer = null;
    this.gameNumber = null;
    this.sentSeq = 0;
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
   * different one.
   */
  private hostWithId(n: number, attempt = 0): void {
    if (this.state() !== 'hosting') return;
    this.gameNumber = n; // ours from here on, so a rebuild knows what to reclaim
    const peer = this.createPeer(new Peer(PEER_PREFIX + n), (err) => {
      if (err.type === 'unavailable-id') {
        peer.destroy();
        if (this.state() !== 'hosting') return true;
        // Typically our own just-dropped socket, still being held by the
        // broker: the number is reserved for us in Firebase, so wait it out
        // rather than moving the invite link the player has already sent.
        if (attempt < MAX_ID_RETRIES) {
          this.scheduleRetry(() => this.hostWithId(n, attempt + 1), ID_RETRY_MS);
        } else {
          this.fail('Couldn’t start a game right now — please try again.');
        }
        return true;
      }
      return false;
    });

    peer.on('open', () => {
      this.gameNumber = n;
      this.gameId.set(`${n}`);
      // Hold the reservation while we wait for player 2.
      this.registry.startPresence(n, 'host');
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

  /** The host's `connection` handler — accepts player 2, refuses the rest. */
  private wireHostConnections(peer: Peer): void {
    // Registered once, outside 'open' — broker reconnects re-emit 'open' and
    // must not stack duplicate connection handlers.
    peer.on('connection', (conn) => {
      conn.on('open', () => {
        if (this.state() === 'hosting' && !this.conn) {
          this.attachConnection(conn, 0);
        } else {
          conn.close(); // game is full, or already over
        }
      });
    });
  }

  private attachConnection(conn: DataConnection, me: PlayerId): void {
    const old = this.conn;
    this.conn = conn; // before old.close() so its events read as superseded
    old?.close();
    this.myPlayer.set(me);
    this.sentSeq = 0;
    this.appliedSeq = 0;
    this.game.resetScores(); // fresh session — score starts 0–0 (rule 8)
    this.game.reset();
    this.state.set('playing');

    // Rule 9: hold our presence on the link, and (host side) mark it occupied
    // now that player 2 has arrived.
    if (this.mode === 'p2p' && this.gameNumber !== null) {
      const role: SessionRole = me === 0 ? 'host' : 'joiner';
      this.registry.startPresence(this.gameNumber, role);
      if (me === 0) void this.registry.markJoined(this.gameNumber);
      this.watchOpponent(this.gameNumber, role);
    }

    conn.on('data', (data) => this.onMessage(data as WireMessage));
    conn.on('close', () => this.onLost(conn));
    conn.on('error', () => this.onLost(conn));
  }

  private onMessage(msg: WireMessage): void {
    switch (msg.kind) {
      case 'bye':
        this.finalizeDisconnect();
        break;
      case 'action':
        // Apply strictly in order and exactly once, so a stray or repeated
        // delivery can never double-apply a move and drift the boards apart.
        if (actionInOrder(msg.seq, this.appliedSeq)) {
          this.appliedSeq = msg.seq;
          this.game.apply(msg.action);
        }
        break;
    }
  }

  /** Create a peer with shared error handling; `handled` may intercept errors. */
  private createPeer(peer: Peer, handled?: (err: { type: string }) => boolean): Peer {
    this.peer?.destroy();
    this.peer = peer;
    // Reaching the broker is what makes everything after it recoverable, and it
    // is recorded on the session rather than on this peer object: PeerJS aborts
    // and replaces peers freely, and a replacement has no history of its own.
    // Registered here, before any caller's own 'open' handler, so it is already
    // true by the time an error lands.
    peer.on('open', () => {
      this.brokerSeen = true;
      this.peerRebuilds = 0;
    });
    peer.on('error', (err: Error & { type: string }) => {
      if (handled?.(err)) return;
      switch (peerErrorAction(err.type, this.canRecover(), this.state())) {
        case 'not-found':
          this.fail(`Couldn’t find that game. Check the id and try again.`);
          break;
        case 'recover':
          // The host stepping out to send the invite drops the broker socket,
          // and PeerJS reports that loss as an error before it reports the
          // disconnect. Failing here tore the game down over a routine,
          // recoverable blip. Get back on the broker instead and keep the id:
          // nothing has been played yet, and the link is already shared.
          this.keepRegistered(peer);
          break;
        case 'fail':
          this.fail('Connection problem — check your internet and try again.');
          break;
      }
    });
    // Broker socket dropped (backgrounded tab, network blip): re-register so
    // the Battle{n} id stays claimed / the joiner can still signal.
    peer.on('disconnected', () => this.keepRegistered(peer));
    return peer;
  }

  /** Is there still a way back to the broker worth trying quietly? */
  private canRecover(): boolean {
    return this.brokerSeen || this.peerRebuilds < MAX_FIRST_REBUILDS;
  }

  /**
   * Get back on the broker and keep trying until it sticks. A single
   * reconnect() is not enough: if the network is still down when it runs,
   * PeerJS gives up silently and the Battle{n} id would stay lost even once
   * we're back online. And PeerJS may have destroyed the peer outright (it
   * aborts on a socket that never carried an id), in which case there is
   * nothing to reconnect and the peer has to be built again from scratch.
   */
  private keepRegistered(peer: Peer): void {
    if (this.reregisterTimer) return; // a retry loop is already running
    const tick = () => {
      this.reregisterTimer = null;
      if (peer !== this.peer) return; // superseded by a newer peer
      if (!this.needsBroker()) return;
      if (peer.destroyed) {
        this.rebuildPeer();
        return;
      }
      if (!peer.disconnected) return; // back on the broker
      try {
        peer.reconnect();
      } catch {
        this.rebuildPeer(); // PeerJS refuses: only a fresh peer will do
        return;
      }
      this.reregisterTimer = setTimeout(tick, REREGISTER_MS);
    };
    this.reregisterTimer = setTimeout(tick, 1_000);
  }

  /** States in which losing the broker is worth chasing. */
  private needsBroker(): boolean {
    const s = this.state();
    return this.mode === 'p2p' && (s === 'hosting' || s === 'joining' || s === 'playing');
  }

  /**
   * PeerJS destroyed the signalling peer under us. While we are still setting a
   * game up that is recoverable: the Battle{n} reservation lives in Firebase,
   * not in the peer object, so we simply claim the same number again — and the
   * invite link the player has already sent keeps pointing at this device.
   *
   * Bounded, so a genuinely offline phone is still told. The budget is only
   * ever spent with the app on screen: a backgrounded tab burning through its
   * retries and greeting the player with an error screen is the very bug this
   * exists to stop.
   */
  private rebuildPeer(): void {
    const s = this.state();
    if (s !== 'hosting' && s !== 'joining') return; // mid-game: the data channel rules
    if (this.peerRetryTimer) return; // one already on its way
    const budget = this.brokerSeen ? MAX_RECLAIM_REBUILDS : MAX_FIRST_REBUILDS;
    if (this.peerRebuilds >= budget && !this.hidden()) {
      this.fail('Connection problem — check your internet and try again.');
      return;
    }
    this.peerRebuilds++;
    this.scheduleRetry(() => {
      if (this.state() === 'hosting') {
        if (this.gameNumber !== null) this.hostWithId(this.gameNumber);
        else void this.claimGameId();
      } else if (this.state() === 'joining' && this.gameNumber !== null) {
        this.connectToBroker(this.gameNumber);
      }
    }, PEER_REBUILD_MS * Math.min(this.peerRebuilds, MAX_REBUILD_BACKOFF));
  }

  /** One pending peer rebuild at a time, whoever asked for it. */
  private scheduleRetry(run: () => void, delay: number): void {
    if (this.peerRetryTimer) return;
    this.peerRetryTimer = setTimeout(() => {
      this.peerRetryTimer = null;
      run();
    }, delay);
  }

  private hidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState !== 'visible';
  }

  /**
   * Tab came back to the foreground. Timers are frozen while a phone holds the
   * app in the background, so whatever the retry loop was going to do, it has
   * not done it yet — do it now, immediately, so Battle{n} is reclaimed by the
   * time the player looks at the screen. Then re-take the wake lock the browser
   * released when we were hidden.
   */
  private onVisible(): void {
    if (document.visibilityState !== 'visible') return;
    const s = this.state();
    if (this.needsBroker()) {
      // A fresh foreground is a fresh chance: the player is watching now, and
      // attempts made against a frozen network while they were away should not
      // count towards giving up on them.
      this.peerRebuilds = 0;
      const peer = this.peer;
      if (!peer || peer.destroyed) {
        this.rebuildPeer();
      } else if (peer.disconnected) {
        try {
          peer.reconnect();
        } catch {
          // already mid-reconnect — the keepRegistered loop covers us
        }
        this.keepRegistered(peer);
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

  /** The data channel died while playing — start the resume window. */
  /** The data channel died — the game is over (no resume; see the file header). */
  private onLost(conn: DataConnection): void {
    if (conn !== this.conn) return; // an old connection we already replaced
    if (this.state() !== 'playing') return;
    this.conn = null;

    // If not a single game action ever crossed this connection, it never really
    // carried a game. That is the invite-link ghost: the joiner's first dial
    // times out while the host tab is backgrounded and is abandoned, but the
    // broker can still hand that stale offer to the host, opening a one-sided
    // connection the joiner has already moved on from. Ending the session on it
    // would refuse the joiner's real retry as a full game, so the host simply
    // goes back to waiting for player 2 — nothing was played, nothing is lost.
    if (this.myPlayer() === 0 && this.sentSeq === 0 && this.appliedSeq === 0) {
      this.state.set('hosting');
      return;
    }

    this.finalizeDisconnect();
  }

  /** The opponent left or the connection died — the session is over. */
  private finalizeDisconnect(): void {
    this.registry.stopPresence(); // we are no longer on the link
    this.stopWatchingOpponent();
    this.conn = null;
    this.state.set('disconnected');
  }

  private stopReregisterLoop(): void {
    if (this.reregisterTimer) clearTimeout(this.reregisterTimer);
    this.reregisterTimer = null;
    if (this.peerRetryTimer) clearTimeout(this.peerRetryTimer);
    this.peerRetryTimer = null;
  }

  /** A new game starts with a clean recovery slate. */
  private resetRecovery(): void {
    this.stopReregisterLoop();
    this.brokerSeen = false;
    this.peerRebuilds = 0;
  }

  private fail(msg: string): void {
    this.resetRecovery();
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
