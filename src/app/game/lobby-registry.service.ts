import { Injectable } from '@angular/core';
import { initializeApp } from 'firebase/app';
import {
  Database,
  get,
  getDatabase,
  onDisconnect,
  onValue,
  ref,
  runTransaction,
  serverTimestamp,
  update,
} from 'firebase/database';
import { firebaseConfig } from '../../environments/environment';

/**
 * Rule 9 (durable invite links). PeerJS only knows a Battle{n} id is claimed
 * while the host's tab is open — close the tab and the id silently frees, the
 * link dies, and a returning host comes back as a different random number. That
 * makes links too flaky to publish.
 *
 * This service is the session bookkeeping layer that outlives the browsers: a
 * Firebase Realtime Database record per Battle{n} that tracks who is present
 * (heartbeat timestamps, cleared server-side on disconnect) so the link stays
 * claimable for a grace window (rule 9.2) even while nobody is connected, and
 * the same number can be reclaimed as the same player on return. Gameplay never
 * touches this — it stays peer-to-peer over PeerJS.
 *
 * Firebase is initialised lazily (first real use) so merely constructing the
 * app — e.g. in unit tests — never opens a socket.
 */

export type SessionRole = 'host' | 'joiner';

/** One `/sessions/{n}` record. `*At` are server-ms, nulled on disconnect. */
export interface SessionRecord {
  createdAt: number;
  hostAt: number | null;
  joinerAt: number | null;
  /** Sticky: true once a joiner has ever connected (picks the TTL window). */
  joined: boolean;
  /** A deliberate Leave killed the link permanently (rule 9, leave-btn). */
  terminated: boolean;
}

/** Rule 9.2 link lifetimes once nobody is present. */
const STALE_UNOCCUPIED_MS = 2 * 60_000; // never paired: 2 minutes
const STALE_OCCUPIED_MS = 5 * 60_000; // paired at least once: 5 minutes
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
   * is free, terminated, or an expired shell we can overwrite.
   */
  async claim(n: number): Promise<boolean> {
    try {
      const res = await runTransaction(this.sessionRef(n), (cur: SessionRecord | null) => {
        if (isSessionAlive(cur, this.now())) return; // taken → abort
        return {
          createdAt: serverTimestamp(),
          hostAt: serverTimestamp(),
          joinerAt: null,
          joined: false,
          terminated: false,
        } as unknown as SessionRecord;
      });
      return res.committed;
    } catch {
      return false;
    }
  }

  /**
   * A host or joiner returning to a link it already owns: refresh its presence
   * on the existing record. Fails if the link has since died/terminated.
   */
  async reclaim(n: number, role: SessionRole): Promise<boolean> {
    try {
      const field = role === 'host' ? 'hostAt' : 'joinerAt';
      const res = await runTransaction(this.sessionRef(n), (cur: SessionRecord | null) => {
        if (!isSessionAlive(cur, this.now())) return; // gone → abort
        return { ...(cur as SessionRecord), [field]: serverTimestamp() };
      });
      return res.committed;
    } catch {
      return false;
    }
  }

  /** Player 2 has connected: mark the session occupied and record presence. */
  async markJoined(n: number): Promise<void> {
    try {
      await update(this.sessionRef(n), { joinerAt: serverTimestamp(), joined: true });
    } catch {
      // best-effort — a missed write just means the link ages a bit faster
    }
  }

  /** Leave-btn: kill the link permanently (rule 9). */
  async terminate(n: number): Promise<void> {
    this.stopPresence();
    try {
      await update(this.sessionRef(n), { terminated: true });
    } catch {
      // if we can't reach Firebase the link will simply age out via its TTL
    }
  }

  /**
   * Start heartbeating our presence into the record and arm a server-side
   * clear for when we drop off (tab close, network loss) so the slot frees the
   * instant we vanish rather than waiting out the TTL.
   */
  startPresence(n: number, role: SessionRole): void {
    this.stopPresence();
    this.presenceN = n;
    this.presenceRole = role;
    const field = role === 'host' ? 'hostAt' : 'joinerAt';
    onDisconnect(ref(this.db(), `sessions/${n}/${field}`))
      .set(null)
      .catch(() => {});
    const beat = () => {
      update(this.sessionRef(n), { [field]: serverTimestamp() }).catch(() => {});
    };
    beat();
    this.presenceTimer = setInterval(beat, HEARTBEAT_MS);
  }

  /** Stop heartbeating and clear our presence now (a graceful leave). */
  stopPresence(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    const n = this.presenceN;
    const role = this.presenceRole;
    this.presenceN = null;
    this.presenceRole = null;
    if (n === null || !role) return;
    const field = role === 'host' ? 'hostAt' : 'joinerAt';
    onDisconnect(ref(this.db(), `sessions/${n}/${field}`))
      .cancel()
      .catch(() => {});
    update(this.sessionRef(n), { [field]: null }).catch(() => {});
  }
}
