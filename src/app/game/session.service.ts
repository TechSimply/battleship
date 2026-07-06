import { Injectable, inject, isDevMode, signal } from '@angular/core';
import Peer, { DataConnection } from 'peerjs';
import { GameAction, GameService, PlayerId } from './game.service';

/**
 * Rule 7: game sessions. The host claims the lowest free "Battle{n}" id on
 * the PeerJS broker (so ids grow with concurrently running games), shares it,
 * and the joiner connects to it. After that, every game action is applied
 * locally and mirrored to the opponent over the WebRTC data channel.
 *
 * A dropped connection (network blip, phone backgrounded for a moment) does
 * NOT end the game: both sides enter 'reconnecting' for a grace period — the
 * joiner redials the host's stable Battle{n} id, the host re-accepts — and a
 * sync handshake replays whatever actions each side missed, so the
 * deterministic engines land back in the same state. Only a deliberate Leave
 * (which sends 'bye') or an expired grace period ends the session.
 */

/** Peer-id namespace so we never collide with unrelated PeerJS apps. */
const PEER_PREFIX = 'techsimply-battleship-battle-';
const MAX_GAMES = 100;
/** How long a dropped game keeps trying to resume before giving up. */
const RECONNECT_GRACE_MS = 45_000;
/** How often the joiner redials the host while resuming. */
const REDIAL_INTERVAL_MS = 4_000;

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
  | GameAction
  | { kind: 'sync'; received: number } // resume: how many of your actions I have
  | { kind: 'bye' }; // deliberate leave — don't wait for a resume

/** "Battle3", "battle 3" or plain "3" → 3; null when unparseable. */
export function parseGameId(input: string): number | null {
  const m = input.trim().match(/^(?:battle\s*)?(\d{1,4})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= MAX_GAMES ? n : null;
}

@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly game = inject(GameService);

  readonly state = signal<SessionState>('lobby');
  /** Shareable id, e.g. "Battle1" (rule 7.2). */
  readonly gameId = signal<string | null>(null);
  /** 0 = host (fires first), 1 = joiner. */
  readonly myPlayer = signal<PlayerId>(0);
  readonly errorMsg = signal<string | null>(null);

  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  /** The n of Battle{n} — the host's stable peer id, used to redial. */
  private gameNumber: number | null = null;

  // Resume bookkeeping: every action I originated this session, and how many
  // of the opponent's I've applied. On resume each side reports its received
  // count and the other resends the tail the counterpart never got.
  private sentLog: GameAction[] = [];
  private receivedCount = 0;

  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private redialTimer: ReturnType<typeof setTimeout> | null = null;
  private reregisterTimer: ReturnType<typeof setTimeout> | null = null;
  /** One dial attempt at a time — parallel dials would race each other. */
  private dialInFlight = false;

  constructor() {
    if (isDevMode()) {
      // Test hook: sever the live data channel as if the network dropped.
      (globalThis as { __battleshipDrop?: () => void }).__battleshipDrop = () =>
        this.conn?.close();
    }
  }

  /** Rule 7.2: claim the lowest free Battle{n} id, then wait for player 2. */
  newGame(): void {
    this.errorMsg.set(null);
    this.state.set('hosting');
    this.claimGameId(1);
  }

  /**
   * Rule 7.3 without the typing: a link that lands the opponent straight in
   * the joining flow. document.baseURI honours the deployed <base href>.
   */
  inviteLink(): string | null {
    return this.gameNumber === null ? null : `${document.baseURI}?join=${this.gameNumber}`;
  }

  /** Rule 7.3: player 2 joins with the id player 1 shared. */
  join(idText: string): void {
    const n = parseGameId(idText);
    if (n === null) {
      this.errorMsg.set('That doesn’t look like a game number — enter just the number, e.g. "1"');
      return;
    }
    this.errorMsg.set(null);
    this.state.set('joining');
    this.gameNumber = n;
    this.gameId.set(`Battle${n}`);

    const peer = this.createPeer(new Peer());
    peer.on('open', () => {
      if (this.state() !== 'joining') return; // broker reconnects re-emit 'open'
      const conn = peer.connect(PEER_PREFIX + n, { reliable: true });
      const failTimer = setTimeout(() => {
        if (this.state() === 'joining') this.fail(`Couldn’t find game Battle${n}. Check the id and try again.`);
      }, 12_000);
      conn.on('open', () => {
        clearTimeout(failTimer);
        this.attachConnection(conn, 1, false);
      });
      conn.on('error', () => {
        clearTimeout(failTimer);
        this.fail(`Couldn’t reach game Battle${n}.`);
      });
    });
  }

  /** Forward a local tap; applies it and mirrors it to the opponent. */
  act(board: PlayerId, c: { x: number; y: number }): void {
    if (this.state() !== 'playing') return;
    const action = this.game.tryLocal(this.myPlayer(), board, c);
    if (action) {
      this.sentLog.push(action);
      this.conn?.send(action);
    }
  }

  /** Rematch on both devices, keeping the connection. */
  playAgain(): void {
    if (this.state() !== 'playing') return;
    const action: GameAction = { kind: 'reset' };
    this.game.reset();
    this.sentLog.push(action);
    this.conn?.send(action);
  }

  /** Tear everything down and return to the lobby (rule 7.1). */
  leave(): void {
    try {
      this.conn?.send({ kind: 'bye' } satisfies WireMessage);
    } catch {
      // connection already gone — nothing to say goodbye to
    }
    this.clearResumeTimers();
    this.stopReregisterLoop();
    this.conn?.close({ flush: true }); // let the 'bye' drain before closing
    this.peer?.destroy();
    this.conn = null;
    this.peer = null;
    this.gameNumber = null;
    this.sentLog = [];
    this.receivedCount = 0;
    this.game.reset();
    this.game.resetScores();
    this.gameId.set(null);
    this.errorMsg.set(null);
    this.state.set('lobby');
  }

  private claimGameId(n: number): void {
    if (n > MAX_GAMES) {
      this.fail('All game ids are busy right now — try again in a minute.');
      return;
    }
    const peer = this.createPeer(new Peer(PEER_PREFIX + n), (err) => {
      if (err.type === 'unavailable-id') {
        // Battle{n} is an active game — try the next number.
        peer.destroy();
        if (this.state() === 'hosting') this.claimGameId(n + 1);
        return true;
      }
      return false;
    });

    peer.on('open', () => {
      this.gameNumber = n;
      this.gameId.set(`Battle${n}`);
    });

    // Registered once, outside 'open' — broker reconnects re-emit 'open' and
    // must not stack duplicate connection handlers.
    peer.on('connection', (conn) => {
      const resume = (conn.metadata as { resume?: boolean } | undefined)?.resume === true;
      conn.on('open', () => {
        if (this.state() === 'hosting' && !this.conn) {
          this.attachConnection(conn, 0, false);
        } else if (resume && (this.state() === 'reconnecting' || this.state() === 'playing')) {
          // Our opponent redialling after a drop — maybe before we even
          // noticed it; swap the connection in and resync.
          this.attachConnection(conn, 0, true);
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
      this.receivedCount = 0;
      this.game.resetScores(); // fresh session — score starts 0–0 (rule 8)
      this.game.reset();
    }
    this.state.set('playing');

    conn.on('data', (data) => this.onMessage(data as WireMessage));
    conn.on('close', () => this.onLost(conn));
    conn.on('error', () => this.onLost(conn));

    // Resume handshake: report what we have; the opponent resends the rest.
    if (resume) conn.send({ kind: 'sync', received: this.receivedCount } satisfies WireMessage);
  }

  private onMessage(msg: WireMessage): void {
    switch (msg.kind) {
      case 'sync':
        // Opponent came back; resend whatever it missed while we were apart.
        for (const action of this.sentLog.slice(msg.received)) this.conn?.send(action);
        break;
      case 'bye':
        this.finalizeDisconnect();
        break;
      default:
        this.receivedCount++;
        this.game.apply(msg);
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

  /** The data channel died while playing — start the resume window. */
  private onLost(conn: DataConnection): void {
    if (conn !== this.conn) return; // an old connection we already replaced
    if (this.state() !== 'playing') return;
    this.conn = null;
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
    this.errorMsg.set(msg);
    this.peer?.destroy();
    this.peer = null;
    this.conn = null;
    this.gameNumber = null;
    this.gameId.set(null);
    this.state.set('error');
  }
}
