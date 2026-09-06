import { Injectable } from '@angular/core';
import { FirebaseApp, initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  Database,
  child,
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
import { BOARD_H, BOARD_W, Coord, GameAction, PlayerId } from './game.service';

/**
 * Rule 9 (durable invite links), the multiplayer transport — and, since ship
 * positions stopped travelling over it, the referee.
 *
 * A Firebase Realtime Database record per Battle{n} holds who is present
 * (heartbeat timestamps) and, under `moves`, an append-only log of every action
 * played. Both devices replay that log into the same rules engine
 * (`GameService`), so the database orders the moves and the two boards cannot
 * drift.
 *
 * What the database keeps to itself is the important part. A ship's square is
 * written to `/secrets/{n}/{round}/{seat}/{epoch}`, which the rules let only
 * that seat's device read — the opponent's app is never told where the ship is,
 * so there is nothing in it to find with the console open. Everything a client
 * would otherwise be trusted to compute from both positions is instead checked
 * by `database.rules.json` against data it cannot read:
 *
 *  - a position is written once, must border the one before it, and may not be
 *    a crater, so a ship can neither teleport nor dodge a shot after the fact;
 *  - `hit` and `ram` are validated against the enemy's committed square, so
 *    neither can be claimed or denied;
 *  - a shot is fired from the square the shooter is really on (rule 5.2);
 *  - only the device holding a seat can play that seat's moves.
 *
 * Every action is therefore two writes: one that *commits* it (the new position
 * for a move, the crater record for a shot) and one that logs it with the
 * answer. That order matters — a rejected write is itself a signal, so the
 * commitment has to land before anything can be learned from a rejection. On
 * the answer itself the client simply guesses (`false`, then `true`): by then
 * the shot or the move is already spent, so the guess reveals nothing the
 * action was not about to reveal anyway.
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
  /** Server clock at the claim: the first half of every round id (see below). */
  createdAt: number;
}

/**
 * One entry of the log. Short keys because every entry is a separate record.
 * `p` player, `k` kind, `r` round, `e` that ship's epoch, `te`/`oe` the epoch
 * the enemy was living in when it was shot at / sailed into, `x`/`y` the bombed
 * square (or a revealed one), `fx`/`fy` the square it was fired from, and the
 * two answers the database settles, `hit` and `ram`.
 *
 * There is deliberately no square on a `place` or a `move`: that is the whole
 * point — where a ship went is between its owner and the database.
 */
export interface WireMove {
  p: number;
  k: string;
  r: string;
  e?: number;
  te?: number;
  oe?: number;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
  hit?: boolean;
  ram?: boolean;
}

const isCoord = (x: unknown, y: unknown): boolean =>
  Number.isInteger(x) &&
  Number.isInteger(y) &&
  (x as number) >= 0 &&
  (x as number) < BOARD_W &&
  (y as number) >= 0 &&
  (y as number) < BOARD_H;

/**
 * Rebuild an action from a stored entry, or null if it is not one. `own` hands
 * back this device's own ship position for one of its own entries — the log
 * does not carry it, and on a replay after a relaunch it comes from the
 * secret the database has been keeping for us. For the opponent's entries it
 * returns null, which is exactly the point: their square is not ours to know.
 */
export function toAction(
  raw: unknown,
  own: (p: PlayerId, epoch: number) => Coord | null,
): GameAction | null {
  const m = raw as WireMove | null;
  if (!m || typeof m.k !== 'string' || typeof m.r !== 'string') return null;
  if (m.k === 'reset') return { kind: 'reset' };
  if (m.p !== 0 && m.p !== 1) return null;
  const player = m.p as PlayerId;
  const epoch = m.e;
  if (!Number.isInteger(epoch) || (epoch as number) < 0) return null;
  const at = isCoord(m.x, m.y) ? { x: m.x!, y: m.y! } : null;

  switch (m.k) {
    case 'place':
    case 'move': {
      if (typeof m.ram !== 'boolean') return null;
      // A ram is the one move that comes with its square: both wrecks have to
      // be drawn on it (rule 11.3).
      if (m.ram && !at) return null;
      const c = m.ram ? at : own(player, epoch as number);
      return m.k === 'place'
        ? { kind: 'place', player, c, ram: m.ram }
        : { kind: 'move', player, c, ram: m.ram };
    }
    case 'fire':
      if (typeof m.hit !== 'boolean' || !at || !isCoord(m.fx, m.fy)) return null;
      return { kind: 'fire', player, from: { x: m.fx!, y: m.fy! }, to: at, hit: m.hit };
    case 'stay':
      return { kind: 'stay', player };
    case 'reveal':
      return at ? { kind: 'reveal', player, c: at } : null;
    default:
      return null;
  }
}

/** The round an entry belongs to; entries from any other round are ignored. */
export const roundOf = (raw: unknown): string | null => {
  const r = (raw as WireMove | null)?.r;
  return typeof r === 'string' ? r : null;
};

/**
 * A round's namespace for the secret positions: the session's own creation
 * time, so a recycled game number never lands on the last game's leftovers,
 * and the push key of the `reset` that opened the round ("0" for the first),
 * so a rematch starts clean without a counter for two devices to race over.
 */
export const roundId = (createdAt: number, resetKey = '0'): string => `${createdAt}_${resetKey}`;

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
   * Which device holds each seat — an anonymous Firebase auth uid, taken once
   * and never reassigned. Rule 9 says a returning player is still the player
   * number they were, and this is what settles it; it is also what the database
   * rules mean by "the player whose ship this is", so a seat is now the thing
   * that authorises every move made in its name.
   */
  hostId?: string;
  joinerId?: string;
}

/**
 * Rule 9.2 link lifetimes once nobody is present. A link that never found a
 * second player is a share that went nowhere, and its number is worth
 * recycling; a game that has two players in it is worth keeping through a
 * phone call, a commute or an evening out, because the board now lives here
 * and both of them can come back to it exactly as they left it.
 */
const STALE_UNOCCUPIED_MS = 10 * 60_000; // never paired: 10 minutes
const STALE_OCCUPIED_MS = 3 * 60 * 60_000; // paired at least once: 3 hours
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
 * their heartbeat is fresh; a Leave/terminate or a dropped app both read as
 * absent. This is what tells the other player "your opponent closed the app".
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

/** Rule 7: the host is player 0 and fires first; the joiner is player 1. */
export const seatNo = (role: SessionRole): PlayerId => (role === 'host' ? 0 : 1);

@Injectable({ providedIn: 'root' })
export class LobbyRegistryService {
  private _app: FirebaseApp | null = null;
  private _db: Database | null = null;
  private _uid: Promise<string> | null = null;
  private serverOffset = 0;

  private presenceTimer: ReturnType<typeof setInterval> | null = null;

  private app(): FirebaseApp {
    return (this._app ??= initializeApp(firebaseConfig));
  }

  private db(): Database {
    if (!this._db) {
      this._db = getDatabase(this.app());
      // RTDB tells us how far our clock is from the server's; all staleness
      // maths runs on server time so a skewed device can't misjudge a TTL.
      onValue(ref(this._db, '.info/serverTimeOffset'), (snap) => {
        this.serverOffset = (snap.val() as number) ?? 0;
      });
    }
    return this._db;
  }

  /**
   * This device's identity, and now its authority: an anonymous Firebase
   * account. It is what holds a seat (rule 9) *and* what the database rules
   * check before accepting a move played in that seat's name, so a stranger —
   * or the other player — cannot act for you. Firebase keeps the same account
   * across relaunches, which is what lets a reopened app walk back into its own
   * game; where storage is blocked (private mode) it is a fresh account each
   * run, and the seat is only ours for as long as the app stays open.
   */
  uid(): Promise<string> {
    return (this._uid ??= signInAnonymously(getAuth(this.app())).then((cred) => cred.user.uid));
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
  private movesRef(n: number) {
    return ref(this.db(), `sessions/${n}/moves`);
  }
  private craterRef(n: number, round: string, c: Coord) {
    return ref(this.db(), `sessions/${n}/craters/${round}/${c.x}_${c.y}`);
  }
  private shipRef(n: number, round: string, seat: PlayerId, epoch: number) {
    return ref(this.db(), `secrets/${n}/${round}/${seat}/${epoch}`);
  }

  /**
   * Live-subscribe to a session record; returns an unsubscribe function. The
   * subscription waits for this device to be signed in, since without an
   * account the rules do not let it read anything at all.
   */
  observe(n: number, cb: (rec: SessionRecord | null) => void): () => void {
    let off: (() => void) | null = null;
    let cancelled = false;
    void this.uid().then(() => {
      if (cancelled) return;
      off = onValue(this.sessionRef(n), (snap) => {
        cb(snap.exists() ? (snap.val() as SessionRecord) : null);
      });
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }

  /** Current record, or null if there has never been one. */
  async read(n: number): Promise<SessionRecord | null> {
    try {
      await this.uid();
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
   * is free or an expired/abandoned shell we can overwrite.
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
  async takeJoinerSeat(n: number, joinerId: string): Promise<Seat | null> {
    const rec = await this.read(n);
    if (!isSessionAlive(rec, this.now())) return null;
    if (rec?.joinerId && rec.joinerId !== joinerId) return null;
    if (rec?.hostId === joinerId) return null; // that is our own link
    try {
      await update(this.sessionRef(n), {
        joinerAt: serverTimestamp(),
        joined: true,
        joinerId,
      });
    } catch {
      return null;
    }
    this.bump('gamesStarted');
    return { role: 'joiner', joined: true, createdAt: rec!.createdAt };
  }

  /**
   * Rule 9: re-take the seat this device already holds — "when they return they
   * should represent respective player number". Works for either seat and, now
   * that the moves live here rather than in the two browsers, for a game
   * already in progress: the board is rebuilt by replaying the log, and this
   * device's own ship comes back out of the secret only it can read.
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
    if (!role || !rec) return null;
    try {
      const field = role === 'host' ? 'hostAt' : 'joinerAt';
      await update(this.sessionRef(n), { [field]: serverTimestamp() });
      return { role, joined: rec.joined === true, createdAt: rec.createdAt };
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------- gameplay

  /**
   * Commit a ship to a square before anything can be learned about it. The
   * rules check the step against the position before it and against the
   * craters, and refuse to let it be written twice — so this is the moment the
   * ship *is* there, as far as the rest of the game is concerned.
   *
   * Returns the square that actually ended up committed. Normally that is the
   * one asked for; if a connection died between this write and the log entry
   * that belongs with it, the epoch is already spoken for, and the ship is
   * where it says it is rather than where the player has just tapped. Without
   * this the second attempt would be refused forever and the round would be
   * stuck — the one way a two-step move could be worse than a one-step one.
   */
  private async commitShip(
    n: number,
    round: string,
    seat: PlayerId,
    epoch: number,
    c: Coord,
  ): Promise<Coord> {
    await this.uid();
    const at = this.shipRef(n, round, seat, epoch);
    try {
      await set(at, { x: c.x, y: c.y, e: epoch });
      return c;
    } catch (err) {
      const prev = (await get(at)).val() as { x?: number; y?: number } | null;
      if (prev && isCoord(prev.x, prev.y)) return { x: prev.x!, y: prev.y! };
      throw err;
    }
  }

  /**
   * The key an entry is about to be written under. Handed out before the write
   * because Firebase shows a device its own writes the moment they are made,
   * long before the server has agreed to them: the caller marks the key as its
   * own first, so a guess that is about to be rejected is never mistaken for
   * something that happened.
   */
  newKey(n: number): string {
    return push(this.movesRef(n)).key!;
  }

  /**
   * Append one entry, guessing the answer the database keeps to itself. The
   * commitment is already written by the time this runs, so a rejection costs
   * a round trip and reveals nothing that was not about to be revealed anyway.
   *
   * `reveal` is the square that goes in *only* if the answer turns out to be
   * true — the one both wrecks share after a ram (rule 11.3). It must not ride
   * along on the ordinary entry: that would put the ship's own square in the
   * public log and hand away everything these rules exist to keep.
   */
  private async logGuess(
    n: number,
    key: string,
    entry: WireMove,
    field: 'hit' | 'ram',
    reveal?: Coord,
  ): Promise<boolean> {
    await this.uid();
    const at = child(this.movesRef(n), key);
    for (const value of [false, true]) {
      try {
        await set(at, {
          ...entry,
          [field]: value,
          ...(value && reveal ? { x: reveal.x, y: reveal.y } : {}),
        });
        return value;
      } catch {
        // wrong guess — or a genuinely bad move, which the second try rejects
      }
    }
    throw new Error(`the database rejected this ${entry.k}`);
  }

  private async log(n: number, key: string, entry: WireMove): Promise<void> {
    await this.uid();
    await set(child(this.movesRef(n), key), entry);
  }

  /** Rule 4: place, then say so. The square itself stays in the secret. */
  async place(
    n: number,
    round: string,
    seat: PlayerId,
    c: Coord,
    key: string,
  ): Promise<{ c: Coord; ram: boolean }> {
    const at = await this.commitShip(n, round, seat, 0, c);
    const ram = await this.logGuess(n, key, { p: seat, k: 'place', r: round, e: 0 }, 'ram', at);
    return { c: at, ram };
  }

  /**
   * Rule 5: fire. The crater record commits the shot — which square, from which
   * epoch, at which of the enemy's — and only then does the log entry carry
   * whether it hit, checked by the rules against a square this device has never
   * seen.
   */
  async fire(
    n: number,
    round: string,
    seat: PlayerId,
    epoch: number,
    targetEpoch: number,
    from: Coord,
    to: Coord,
    key: string,
  ): Promise<boolean> {
    await this.uid();
    const shot = { by: seat, e: epoch, te: targetEpoch, x: to.x, y: to.y };
    try {
      await set(this.craterRef(n, round, to), shot);
    } catch (err) {
      // A square is bombed once. If this is our own shot coming round again
      // after a dropped connection, all that is left to do is log it.
      const cur = (await get(this.craterRef(n, round, to))).val() as typeof shot | null;
      if (!cur || cur.by !== seat || cur.e !== epoch || cur.te !== targetEpoch) throw err;
    }
    return this.logGuess(
      n,
      key,
      {
        p: seat,
        k: 'fire',
        r: round,
        e: epoch,
        te: targetEpoch,
        x: to.x,
        y: to.y,
        fx: from.x,
        fy: from.y,
      },
      'hit',
    );
  }

  /** Rule 5.4: sail one square. Rule 11's answer comes back with it. */
  async move(
    n: number,
    round: string,
    seat: PlayerId,
    epoch: number,
    enemyEpoch: number,
    c: Coord,
    key: string,
  ): Promise<{ c: Coord; ram: boolean }> {
    const at = await this.commitShip(n, round, seat, epoch, c);
    const ram = await this.logGuess(
      n,
      key,
      { p: seat, k: 'move', r: round, e: epoch, oe: enemyEpoch },
      'ram',
      at,
    );
    return { c: at, ram };
  }

  /** Rule 5.4 with nowhere to go — accepted only from a ship that is boxed in. */
  stay(n: number, round: string, seat: PlayerId, epoch: number, key: string): Promise<void> {
    return this.log(n, key, { p: seat, k: 'stay', r: round, e: epoch });
  }

  /** Show your own square once the round is over, so both wrecks can be drawn. */
  reveal(
    n: number,
    round: string,
    seat: PlayerId,
    epoch: number,
    c: Coord,
    key: string,
  ): Promise<void> {
    return this.log(n, key, { p: seat, k: 'reveal', r: round, e: epoch, x: c.x, y: c.y });
  }

  /** Rule 8: a rematch. Its key becomes the namespace the next round lives in. */
  rematch(n: number, round: string, seat: PlayerId, key: string): Promise<void> {
    return this.log(n, key, { p: seat, k: 'reset', r: round });
  }

  /** The squares this device's own ship stood on, by epoch, for a replay. */
  async ownShips(n: number, round: string, seat: PlayerId): Promise<Map<number, Coord>> {
    const out = new Map<number, Coord>();
    try {
      await this.uid();
      const snap = await get(ref(this.db(), `secrets/${n}/${round}/${seat}`));
      const val = (snap.val() ?? {}) as Record<string, { x?: number; y?: number }>;
      for (const [epoch, c] of Object.entries(val)) {
        if (isCoord(c?.x, c?.y)) out.set(Number(epoch), { x: c.x!, y: c.y! });
      }
    } catch {
      // unreadable (or nothing placed yet) — the caller falls back to the lobby
    }
    return out;
  }

  /**
   * The log as it stands, oldest first. Replaying it is what makes a game
   * resumable: a device that has just opened the app arrives at exactly the
   * board everyone else is looking at. It is fetched rather than streamed
   * because the log no longer carries this device's own squares — the caller
   * has to go and get those out of the secret first, one round at a time, since
   * that is the granularity the rules hand them out at.
   */
  async backlog(n: number): Promise<[string, WireMove][]> {
    await this.uid();
    const snap = await get(this.movesRef(n));
    const out: [string, WireMove][] = [];
    snap.forEach((child) => {
      if (child.key) out.push([child.key, child.val() as WireMove]);
    });
    return out;
  }

  /**
   * …and every entry from here on, including our own coming back to us. Keys
   * already in `seen` are skipped exactly once each, which covers both the
   * backlog above and this device's own writes, applied the moment they were
   * played so the board answers under the finger.
   */
  follow(n: number, seen: Set<string>, cb: (raw: WireMove, key: string) => void): () => void {
    let off: (() => void) | null = null;
    let cancelled = false;
    void this.uid().then(() => {
      if (cancelled) return;
      off = onChildAdded(this.movesRef(n), (child) => {
        if (!child.key || seen.has(child.key)) return;
        seen.add(child.key);
        cb(child.val() as WireMove, child.key);
      });
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }

  /**
   * Bump an aggregate play counter under `/stats`. Deliberately just a number —
   * no ids, no timestamps, nothing per-user — so it needs no cookie banner and
   * carries no personal data. Fire-and-forget: analytics must never fail a game.
   */
  bump(metric: 'gamesStarted' | 'botGames'): void {
    void this.uid()
      .then(() => update(ref(this.db(), 'stats'), { [metric]: increment(1) }))
      .catch(() => {});
  }

  /**
   * Leave-btn: kill the link (rule 9). We delete the record rather than
   * tombstoning it, so the link is dead for anyone still holding it (a rejoin
   * finds nothing) while the number is freed for reuse. The secrets keep their
   * own namespace per session, so nothing of this game is left where the next
   * holder of the number could stumble into it.
   */
  async terminate(n: number): Promise<void> {
    this.stopPresence();
    try {
      await this.uid();
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
    const field = role === 'host' ? 'hostAt' : 'joinerAt';
    const beat = () => {
      void this.uid()
        .then(() => update(this.sessionRef(n), { [field]: serverTimestamp() }))
        .catch(() => {});
    };
    beat();
    this.presenceTimer = setInterval(beat, HEARTBEAT_MS);
  }

  /** Stop heartbeating. The last timestamp stays as our "last seen" so the link
   *  remains reclaimable within its TTL window (rule 9.2). */
  stopPresence(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }
}
