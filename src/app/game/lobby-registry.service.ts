import { Injectable } from '@angular/core';
import { initializeApp } from 'firebase/app';
import {
  Database,
  get,
  getDatabase,
  increment,
  onChildAdded,
  onValue,
  push,
  ref,
  remove,
  runTransaction,
  serverTimestamp,
  set,
  update,
} from 'firebase/database';
import { firebaseConfig } from '../../environments/environment';
import { BOARD_H, BOARD_W, GameAction, PlayerId } from './game.service';

/**
 * Rule 9 (durable invite links) — and, since the game moved off WebRTC, the
 * whole of the multiplayer transport.
 *
 * A Firebase Realtime Database record per Battle{n} holds who is present
 * (heartbeat timestamps) and, under `moves`, an append-only log of every action
 * played. Both devices replay that log into the same deterministic rules engine
 * (`GameService`), so the database orders the moves and the two boards cannot
 * drift: there is nothing for them to disagree about.
 *
 * That is a deliberate step back from peer-to-peer. Gameplay used to run over a
 * WebRTC data channel brokered by the free PeerJS cloud, which has three
 * separate ways to fail on a phone — the broker forgets a backgrounded host's
 * id, its offer queue answers late enough to race the joiner's own retries, and
 * ICE simply cannot always cross a carrier NAT, where the fallback is a free
 * shared TURN relay on a single UDP port. Every one of those shows up as two
 * players staring at screens that never change. This is one WebSocket to
 * Google on 443, which is the same connection that was already claiming the
 * game number successfully on those very phones.
 *
 * What it buys beyond reliability: the board outlives both browsers, so a
 * player who closes the app, runs out of battery or walks into a tunnel comes
 * back to the game exactly as they left it (`reclaimSeat` + a log replay), and
 * the link is as durable as rule 9.2's window.
 *
 * Firebase is initialised lazily (first real use) so merely constructing the
 * app — e.g. in unit tests — never opens a socket.
 */

export type SessionRole = 'host' | 'joiner';

/**
 * A seat taken back on a link, and whether the game behind it has actually
 * started — a host returning to a game in progress goes straight to the board,
 * one whose link nobody has opened yet goes back to waiting for player 2.
 */
export interface Seat {
  role: SessionRole;
  joined: boolean;
}

/**
 * One move on the wire. Short keys because every move is a separate record:
 * `p` player, `k` kind, `x`/`y` the square (absent on a round reset).
 */
export interface WireMove {
  p: number;
  k: string;
  x?: number;
  y?: number;
}

/**
 * Rebuild an action from a stored move, or null if it is not one. Anything can
 * write to a session (the database has no accounts — the game number is the
 * only secret), so the log is parsed defensively rather than trusted: a
 * malformed record is skipped, not applied.
 */
export function toAction(raw: unknown): GameAction | null {
  const m = raw as WireMove | null;
  if (!m || typeof m.k !== 'string') return null;
  if (m.k === 'reset') return { kind: 'reset' };
  if (m.k !== 'place' && m.k !== 'fire' && m.k !== 'move') return null;
  if (m.p !== 0 && m.p !== 1) return null;
  const { x, y } = m;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x! < 0 || x! >= BOARD_W || y! < 0 || y! >= BOARD_H) return null;
  return { kind: m.k, player: m.p as PlayerId, c: { x: x!, y: y! } };
}

/** The same action on its way out. */
export function toWire(action: GameAction): WireMove {
  return action.kind === 'reset'
    ? { p: 0, k: 'reset' }
    : { p: action.player, k: action.kind, x: action.c.x, y: action.c.y };
}

/**
 * One `/sessions/{n}` record. `*At` are server-ms of each party's last
 * heartbeat — they are NOT nulled on disconnect, so they double as "last seen":
 * a party is "present" only while its heartbeat is fresh, and the link's TTL is
 * measured from the most recent heartbeat (not from creation), so a game stays
 * reclaimable for the grace window after everyone actually left.
 */
export interface SessionRecord {
  createdAt: number;
  hostAt: number | null;
  joinerAt: number | null;
  /** Sticky: true once a joiner has ever connected (picks the TTL window). */
  joined: boolean;
  /** A deliberate Leave killed the link permanently (rule 9, leave-btn). */
  terminated: boolean;
  /**
   * Which device holds each seat. Rule 9 says a returning player is still the
   * player number they were, and this is what settles it: the *record* decides
   * the seat, so a reopened app takes back the one it had rather than trusting
   * its own memory — and a stranger who guesses the number cannot walk into a
   * seat that is already someone's.
   */
  hostId?: string;
  joinerId?: string;
}

/**
 * Rule 9.2 link lifetimes once nobody is present. A link that never found a
 * second player is a share that went nowhere, and its number is worth
 * recycling; a game that has two players in it is worth keeping through a
 * phone call, a commute or a night's sleep, because the board now lives here
 * and both of them can come back to it exactly as they left it.
 */
const STALE_UNOCCUPIED_MS = 10 * 60_000; // never paired: 10 minutes
const STALE_OCCUPIED_MS = 24 * 60 * 60_000; // paired at least once: a day
/** A presence heartbeat lands this often… */
const HEARTBEAT_MS = 20_000;
/** …and a party counts as "present" until this long after its last beat. */
const PRESENCE_TTL_MS = 50_000;

function lastSeen(rec: SessionRecord): number {
  return Math.max(rec.createdAt ?? 0, rec.hostAt ?? 0, rec.joinerAt ?? 0);
}

/** How many parties have beaten recently enough to still be "on the link". */
function presentCount(rec: SessionRecord, now: number): number {
  let n = 0;
  if (rec.hostAt && now - rec.hostAt < PRESENCE_TTL_MS) n++;
  if (rec.joinerAt && now - rec.joinerAt < PRESENCE_TTL_MS) n++;
  return n;
}

/**
 * Rule 9: is this link still usable? Terminated links are dead forever. While
 * anyone is present it is alive. Once empty it survives the TTL window — the
 * longer, occupied one if the game had ever paired up (so a mid-game drop can
 * be rejoined), the shorter one for a link that never got a second player.
 */
export function isSessionAlive(rec: SessionRecord | null, now: number): boolean {
  if (!rec || rec.terminated) return false;
  if (presentCount(rec, now) > 0) return true;
  const window = rec.joined ? STALE_OCCUPIED_MS : STALE_UNOCCUPIED_MS;
  return now - lastSeen(rec) <= window;
}

/**
 * Is one specific party (host or joiner) currently on the link? True only while
 * their heartbeat is fresh; a Leave/terminate or a dropped app (onDisconnect
 * nulls their slot) both read as absent. This is what tells the other player
 * "your opponent closed the app" without waiting out the reconnect grace.
 */
export function isPartyPresent(
  rec: SessionRecord | null,
  role: SessionRole,
  now: number,
): boolean {
  if (!rec || rec.terminated) return false;
  const ts = role === 'host' ? rec.hostAt : rec.joinerAt;
  return !!ts && now - ts < PRESENCE_TTL_MS;
}

@Injectable({ providedIn: 'root' })
export class LobbyRegistryService {
  private _db: Database | null = null;
  private serverOffset = 0;

  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private presenceN: number | null = null;
  private presenceRole: SessionRole | null = null;

  private db(): Database {
    if (!this._db) {
      this._db = getDatabase(initializeApp(firebaseConfig));
      // RTDB tells us how far our clock is from the server's; all staleness
      // maths runs on server time so a skewed device can't misjudge a TTL.
      onValue(ref(this._db, '.info/serverTimeOffset'), (snap) => {
        this.serverOffset = (snap.val() as number) ?? 0;
      });
    }
    return this._db;
  }

  private now(): number {
    return Date.now() + this.serverOffset;
  }

  /** Server-aligned clock, for callers computing presence freshness (rule 9). */
  serverNow(): number {
    return this.now();
  }

  private sessionRef(n: number) {
    return ref(this.db(), `sessions/${n}`);
  }

  /** Live-subscribe to a session record; returns an unsubscribe function. */
  observe(n: number, cb: (rec: SessionRecord | null) => void): () => void {
    return onValue(this.sessionRef(n), (snap) => {
      cb(snap.exists() ? (snap.val() as SessionRecord) : null);
    });
  }

  /** Current record, or null if there has never been one. */
  async read(n: number): Promise<SessionRecord | null> {
    try {
      const snap = await get(this.sessionRef(n));
      return snap.exists() ? (snap.val() as SessionRecord) : null;
    } catch {
      return null; // Firebase unreachable — caller decides how to degrade
    }
  }

  /** Rule 9: is Battle{n} a live, joinable link right now? */
  async isAlive(n: number): Promise<boolean> {
    return isSessionAlive(await this.read(n), this.now());
  }

  /**
   * Reserve Battle{n} as the host. Atomic: fails if a live session already
   * holds it (so two hosts can't claim the same number), succeeds if the slot
   * is free or an expired/abandoned shell we can overwrite. (A leftover
   * `terminated` tombstone from before links were deleted on leave would have
   * its write rejected by the rules — the caller just tries another number.)
   */
  async claim(n: number, hostId: string): Promise<boolean> {
    try {
      const res = await runTransaction(this.sessionRef(n), (cur: SessionRecord | null) => {
        if (isSessionAlive(cur, this.now())) return; // taken → abort
        return {
          createdAt: serverTimestamp(),
          hostAt: serverTimestamp(),
          joinerAt: null,
          joined: false,
          terminated: false,
          hostId,
        } as unknown as SessionRecord;
      });
      return res.committed;
    } catch {
      return false;
    }
  }

  /**
   * Which seat this device holds on a link it is coming back to — rule 9's
   * "when they return they should represent respective player number". The
   * record decides, not the device's memory of it.
   */
  seatOn(rec: SessionRecord | null, clientId: string): SessionRole | null {
    if (!isSessionAlive(rec, this.now())) return null;
    if (rec?.hostId === clientId) return 'host';
    if (rec?.joinerId === clientId) return 'joiner';
    return null;
  }

  /**
   * Take the empty seat on a live link, as player 2. Fails if somebody else is
   * already in it — the game number is short and public enough that a stranger
   * could otherwise walk into a game in progress.
   */
  async takeJoinerSeat(n: number, joinerId: string): Promise<boolean> {
    const rec = await this.read(n);
    if (!isSessionAlive(rec, this.now())) return false;
    if (rec?.joinerId && rec.joinerId !== joinerId) return false;
    if (rec?.hostId === joinerId) return false; // that is our own link
    try {
      await update(this.sessionRef(n), {
        joinerAt: serverTimestamp(),
        joined: true,
        joinerId,
      });
    } catch {
      return false;
    }
    this.bump('gamesStarted');
    return true;
  }

  private movesRef(n: number) {
    return ref(this.db(), `sessions/${n}/moves`);
  }

  /**
   * Play a move by appending it to the session's log. The log *is* the game:
   * both devices replay it into the same deterministic rules engine, so the
   * database orders the moves and neither device has to agree with the other
   * about anything else. Returns the key it was written under, so the sender
   * can recognise its own move coming back.
   */
  sendMove(n: number, action: GameAction): string | null {
    try {
      const at = push(this.movesRef(n));
      set(at, toWire(action)).catch(() => {});
      return at.key;
    } catch {
      return null; // Firebase unreachable — the caller keeps its local state
    }
  }

  /**
   * Every move already in the log, oldest first, and then each new one as it
   * lands. Replaying from the start is what makes a game resumable: a device
   * that has just opened the app arrives at exactly the board everyone else is
   * looking at, without anybody having to send it anything.
   */
  watchMoves(n: number, cb: (action: GameAction, key: string) => void): () => void {
    return onChildAdded(this.movesRef(n), (snap) => {
      const action = toAction(snap.val());
      if (action && snap.key) cb(action, snap.key);
    });
  }

  /**
   * Rule 9: re-take the seat this device already holds — "when they return they
   * should represent respective player number". Works for either seat and, now
   * that the moves live here rather than in the two browsers, for a game
   * already in progress: the board is rebuilt by replaying the log.
   *
   * Fails (and the caller falls back to the lobby) if the link died, was
   * terminated, is not ours, or Firebase can't be reached — in which case we
   * cannot know the seat is still ours, so we must not take it.
   */
  async reclaimSeat(n: number, clientId: string): Promise<Seat | null> {
    // Read-then-write rather than a transaction: on a fresh page load (exactly
    // the reopen case) the client has no cached value, and a transaction that
    // aborts on the initial null never reaches the server — so the reclaim
    // would always fail. get() forces a server read; there's no real contention
    // here (only the returning owner reclaims its own seat).
    const rec = await this.read(n);
    const role = this.seatOn(rec, clientId);
    if (!role) return null;
    try {
      const field = role === 'host' ? 'hostAt' : 'joinerAt';
      await update(this.sessionRef(n), { [field]: serverTimestamp() });
      return { role, joined: rec?.joined === true };
    } catch {
      return null;
    }
  }

  /**
   * Bump an aggregate play counter under `/stats`. Deliberately just a number —
   * no ids, no timestamps, nothing per-user — so it needs no cookie banner and
   * carries no personal data. Session records are deleted on Leave, so without
   * this there is no lasting trace that anyone ever played. Fire-and-forget:
   * analytics must never fail a game.
   */
  bump(metric: 'gamesStarted' | 'botGames'): void {
    try {
      update(ref(this.db(), 'stats'), { [metric]: increment(1) }).catch(() => {});
    } catch {
      // Firebase unreachable — we simply don't count this one
    }
  }

  /**
   * Leave-btn: kill the link (rule 9). We delete the record rather than
   * tombstoning it, so the link is dead for anyone still holding it (a rejoin
   * finds nothing) while the number is freed for reuse — otherwise every ended
   * game would permanently burn one of the ~9000 ids.
   */
  async terminate(n: number): Promise<void> {
    this.stopPresence();
    try {
      await remove(this.sessionRef(n));
    } catch {
      // if we can't reach Firebase the link will simply age out via its TTL
    }
  }

  /**
   * Heartbeat our presence into the record. We deliberately do NOT null the slot
   * on disconnect: leaving the last heartbeat behind is what lets the link's TTL
   * be measured from when we were last active (so a reopen can reclaim it) — the
   * opponent still sees us drop off once the heartbeat goes stale (PRESENCE_TTL).
   */
  startPresence(n: number, role: SessionRole): void {
    this.stopPresence();
    this.presenceN = n;
    this.presenceRole = role;
    const field = role === 'host' ? 'hostAt' : 'joinerAt';
    const beat = () => {
      update(this.sessionRef(n), { [field]: serverTimestamp() }).catch(() => {});
    };
    beat();
    this.presenceTimer = setInterval(beat, HEARTBEAT_MS);
  }

  /** Stop heartbeating. The last timestamp stays as our "last seen" so the link
   *  remains reclaimable within its TTL window (rule 9.2). */
  stopPresence(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    this.presenceN = null;
    this.presenceRole = null;
  }
}
