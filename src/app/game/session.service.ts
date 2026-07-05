import { Injectable, inject, signal } from '@angular/core';
import Peer, { DataConnection } from 'peerjs';
import { GameAction, GameService, PlayerId } from './game.service';

/**
 * Rule 7: game sessions. The host claims the lowest free "Battle{n}" id on
 * the PeerJS broker (so ids grow with concurrently running games), shares it,
 * and the joiner connects to it. After that, every game action is applied
 * locally and mirrored to the opponent over the WebRTC data channel.
 */

/** Peer-id namespace so we never collide with unrelated PeerJS apps. */
const PEER_PREFIX = 'techsimply-battleship-battle-';
const MAX_GAMES = 100;

export type SessionState =
  | 'lobby' // choosing New Game / Join The Game (rule 7.1)
  | 'hosting' // game id claimed, waiting for player 2
  | 'joining' // connecting to a host
  | 'playing' // both devices connected
  | 'disconnected' // opponent left / connection lost
  | 'error';

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

  /** Rule 7.2: claim the lowest free Battle{n} id, then wait for player 2. */
  newGame(): void {
    this.errorMsg.set(null);
    this.state.set('hosting');
    this.claimGameId(1);
  }

  /** Rule 7.3: player 2 joins with the id player 1 shared. */
  join(idText: string): void {
    const n = parseGameId(idText);
    if (n === null) {
      this.errorMsg.set('That doesn’t look like a game id — try e.g. "Battle1"');
      return;
    }
    this.errorMsg.set(null);
    this.state.set('joining');
    this.gameId.set(`Battle${n}`);

    const peer = this.createPeer(new Peer());
    peer.on('open', () => {
      const conn = peer.connect(PEER_PREFIX + n, { reliable: true });
      const failTimer = setTimeout(() => {
        if (this.state() === 'joining') this.fail(`Couldn’t find game Battle${n}. Check the id and try again.`);
      }, 12_000);
      conn.on('open', () => {
        clearTimeout(failTimer);
        this.attachConnection(conn, 1);
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
    if (action) this.conn?.send(action);
  }

  /** Rematch on both devices, keeping the connection. */
  playAgain(): void {
    if (this.state() !== 'playing') return;
    this.game.reset();
    this.conn?.send({ kind: 'reset' } satisfies GameAction);
  }

  /** Tear everything down and return to the lobby (rule 7.1). */
  leave(): void {
    this.conn?.close();
    this.peer?.destroy();
    this.conn = null;
    this.peer = null;
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
      this.gameId.set(`Battle${n}`);
      peer.on('connection', (conn) => {
        if (this.conn) {
          conn.close(); // game is full
          return;
        }
        conn.on('open', () => this.attachConnection(conn, 0));
      });
    });
  }

  private attachConnection(conn: DataConnection, me: PlayerId): void {
    this.conn = conn;
    this.myPlayer.set(me);
    this.game.resetScores(); // fresh session — score starts 0–0 (rule 8)
    this.game.reset();
    this.state.set('playing');

    conn.on('data', (data) => this.game.apply(data as GameAction));
    conn.on('close', () => this.onLost());
    conn.on('error', () => this.onLost());
  }

  /** Create a peer with shared error handling; `handled` may intercept errors. */
  private createPeer(peer: Peer, handled?: (err: { type: string }) => boolean): Peer {
    this.peer?.destroy();
    this.peer = peer;
    peer.on('error', (err: Error & { type: string }) => {
      if (handled?.(err)) return;
      if (err.type === 'peer-unavailable') {
        this.fail(`Couldn’t find that game. Check the id and try again.`);
      } else if (this.state() !== 'lobby' && this.state() !== 'playing') {
        this.fail('Connection problem — check your internet and try again.');
      }
    });
    peer.on('disconnected', () => peer.reconnect());
    return peer;
  }

  private onLost(): void {
    if (this.state() === 'playing') {
      this.conn = null;
      this.state.set('disconnected');
    }
  }

  private fail(msg: string): void {
    this.errorMsg.set(msg);
    this.peer?.destroy();
    this.peer = null;
    this.conn = null;
    this.gameId.set(null);
    this.state.set('error');
  }
}
