import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { Coord, GameService, PlayerId } from './game.service';
import {
  LobbyRegistryService,
  Seat,
  SessionRecord,
  SessionRole,
  WireMove,
  isSessionAlive,
} from './lobby-registry.service';

/**
 * The whole invite, end to end, with two real sessions on either side of one
 * in-memory stand-in for the Realtime Database — records, presence heartbeats,
 * the append-only log, and the secret each ship's position lives in.
 *
 * The stand-in referees like the real rules do (`tools/rules.mjs`, tested for
 * real against the emulator by `npm run test:rules`): a device's own square is
 * the only one it can read back, and `hit` and `ram` are answered from the
 * secret rather than by the player claiming them. That is what makes these
 * tests worth anything now — if a device could still see the other ship, every
 * one of them would pass anyway.
 *
 * Assert a move *crossing*, not just that both sides say "playing" — two
 * devices looking at unrelated boards say that too.
 */

/** Where this device's anonymous account is remembered between relaunches. */
const UID_KEY = 'fake.uid';
const same = (a: Coord | undefined, b: Coord) => !!a && a.x === b.x && a.y === b.y;

/** Everything the two sessions share: this is the database. */
class Db {
  sessions = new Map<number, SessionRecord>();
  moves = new Map<number, { key: string; raw: WireMove }[]>();
  watchers = new Map<number, ((rec: SessionRecord | null) => void)[]>();
  moveWatchers = new Map<number, ((raw: WireMove, key: string) => void)[]>();
  /** `{n}/{round}/{seat}/{epoch}` → the square. Nobody reads another's. */
  ships = new Map<string, Coord>();
  /** `{n}/{round}/{x}_{y}` — one per shot, and every crater test (rule 5.3). */
  craters = new Set<string>();
  private seq = 0;
  private accounts = 0;

  now = 1_700_000_000_000;

  nextKey(): string {
    return `k${String(++this.seq).padStart(4, '0')}`;
  }

  nextAccount(): string {
    return `uid${++this.accounts}`;
  }

  publish(n: number): void {
    const rec = this.sessions.get(n) ?? null;
    for (const w of [...(this.watchers.get(n) ?? [])]) w(rec ? { ...rec } : null);
  }
}

/**
 * A LobbyRegistryService backed by `Db` instead of Firebase, refereeing the
 * same way the database rules do. Deliberately the real `isSessionAlive` around
 * a fake socket, so what these tests exercise is the session choreography and
 * not a re-statement of it.
 */
class FakeRegistry {
  /** This device's account — remembered like Firebase remembers an anonymous
   *  one, so a relaunch comes back as the same player (rule 9). */
  private readonly id: string;

  constructor(private db: Db) {
    this.id = localStorage.getItem(UID_KEY) ?? db.nextAccount();
    localStorage.setItem(UID_KEY, this.id);
  }

  private presence: { n: number; role: SessionRole } | null = null;

  serverNow = () => this.db.now;

  async uid(): Promise<string> {
    return this.id;
  }

  async read(n: number): Promise<SessionRecord | null> {
    const rec = this.db.sessions.get(n);
    return rec ? { ...rec } : null;
  }

  async claim(n: number, hostId: string): Promise<boolean> {
    if (isSessionAlive(this.db.sessions.get(n) ?? null, this.db.now)) return false;
    this.db.sessions.set(n, {
      createdAt: this.db.now,
      hostAt: this.db.now,
      joinerAt: null,
      joined: false,
      terminated: false,
      hostId,
    });
    this.db.moves.delete(n);
    for (const k of [...this.db.ships.keys()]) if (k.startsWith(`${n}/`)) this.db.ships.delete(k);
    for (const k of [...this.db.craters]) if (k.startsWith(`${n}/`)) this.db.craters.delete(k);
    this.db.publish(n);
    return true;
  }

  seatOn(rec: SessionRecord | null, clientId: string): SessionRole | null {
    if (!isSessionAlive(rec, this.db.now)) return null;
    if (rec?.hostId === clientId) return 'host';
    if (rec?.joinerId === clientId) return 'joiner';
    return null;
  }

  async reclaimSeat(n: number, clientId: string): Promise<Seat | null> {
    const rec = this.db.sessions.get(n) ?? null;
    const role = this.seatOn(rec, clientId);
    if (!role || !rec) return null;
    rec[role === 'host' ? 'hostAt' : 'joinerAt'] = this.db.now;
    this.db.publish(n);
    return { role, joined: rec.joined === true, createdAt: rec.createdAt };
  }

  async takeJoinerSeat(n: number, joinerId: string): Promise<Seat | null> {
    const rec = this.db.sessions.get(n) ?? null;
    if (!isSessionAlive(rec, this.db.now) || !rec) return null;
    if (rec.joinerId && rec.joinerId !== joinerId) return null;
    if (rec.hostId === joinerId) return null;
    rec.joinerId = joinerId;
    rec.joinerAt = this.db.now;
    rec.joined = true;
    this.db.publish(n);
    return { role: 'joiner', joined: true, createdAt: rec.createdAt };
  }

  observe(n: number, cb: (rec: SessionRecord | null) => void): () => void {
    const list = this.db.watchers.get(n) ?? [];
    list.push(cb);
    this.db.watchers.set(n, list);
    // Firebase delivers the current value on subscribe, on its own tick.
    setTimeout(() => cb(this.db.sessions.get(n) ? { ...this.db.sessions.get(n)! } : null), 0);
    return () =>
      this.db.watchers.set(
        n,
        (this.db.watchers.get(n) ?? []).filter((w) => w !== cb),
      );
  }

  // ------------------------------------------------------------- refereeing

  private shipKey = (n: number, r: string, seat: PlayerId, e: number) => `${n}/${r}/${seat}/${e}`;
  private foe = (seat: PlayerId): PlayerId => (seat === 0 ? 1 : 0);

  newKey(): string {
    return this.db.nextKey();
  }

  private append(n: number, key: string, raw: WireMove): void {
    const log = this.db.moves.get(n) ?? [];
    log.push({ key, raw });
    this.db.moves.set(n, log);
    // Delivered to every listener, including the writer's own.
    setTimeout(() => {
      for (const w of [...(this.db.moveWatchers.get(n) ?? [])]) w(raw, key);
    }, 0);
  }

  /** Write-once, like the rules: where a ship stood is settled when it stands. */
  private commit(n: number, r: string, seat: PlayerId, e: number, c: Coord): void {
    const k = this.shipKey(n, r, seat, e);
    if (this.db.ships.has(k)) throw new Error('a position is written once');
    this.db.ships.set(k, c);
  }

  async place(
    n: number,
    r: string,
    seat: PlayerId,
    c: Coord,
    key: string,
  ): Promise<{ c: Coord; ram: boolean }> {
    this.commit(n, r, seat, 0, c);
    const ram = same(this.db.ships.get(this.shipKey(n, r, this.foe(seat), 0)), c);
    this.append(n, key, { p: seat, k: 'place', r, e: 0, ram, ...(ram ? { x: c.x, y: c.y } : {}) });
    return { c, ram };
  }

  async fire(
    n: number,
    r: string,
    seat: PlayerId,
    e: number,
    te: number,
    from: Coord,
    to: Coord,
    key: string,
  ): Promise<boolean> {
    this.db.craters.add(`${n}/${r}/${to.x}_${to.y}`);
    const hit = same(this.db.ships.get(this.shipKey(n, r, this.foe(seat), te)), to);
    this.append(n, key, {
      p: seat,
      k: 'fire',
      r,
      e,
      te,
      x: to.x,
      y: to.y,
      fx: from.x,
      fy: from.y,
      hit,
    });
    return hit;
  }

  async move(
    n: number,
    r: string,
    seat: PlayerId,
    e: number,
    oe: number,
    c: Coord,
    key: string,
  ): Promise<{ c: Coord; ram: boolean }> {
    this.commit(n, r, seat, e, c);
    const ram = same(this.db.ships.get(this.shipKey(n, r, this.foe(seat), oe)), c);
    this.append(n, key, { p: seat, k: 'move', r, e, oe, ram, ...(ram ? { x: c.x, y: c.y } : {}) });
    return { c, ram };
  }

  async stay(n: number, r: string, seat: PlayerId, e: number, key: string): Promise<void> {
    this.append(n, key, { p: seat, k: 'stay', r, e });
  }

  async reveal(
    n: number,
    r: string,
    seat: PlayerId,
    e: number,
    c: Coord,
    key: string,
  ): Promise<void> {
    this.append(n, key, { p: seat, k: 'reveal', r, e, x: c.x, y: c.y });
  }

  async rematch(n: number, r: string, seat: PlayerId, key: string): Promise<void> {
    this.append(n, key, { p: seat, k: 'reset', r });
  }

  /** Only ever this seat's own squares — the other's are not readable at all. */
  async ownShips(n: number, r: string, seat: PlayerId): Promise<Map<number, Coord>> {
    const out = new Map<number, Coord>();
    for (const [k, c] of this.db.ships) {
      const [num, round, s, e] = k.split('/');
      if (Number(num) === n && round === r && Number(s) === seat) out.set(Number(e), c);
    }
    return out;
  }

  async backlog(n: number): Promise<[string, WireMove][]> {
    return (this.db.moves.get(n) ?? []).map(({ key, raw }) => [key, raw]);
  }

  follow(n: number, seen: Set<string>, cb: (raw: WireMove, key: string) => void): () => void {
    const wrapped = (raw: WireMove, key: string) => {
      if (seen.has(key)) return;
      seen.add(key);
      cb(raw, key);
    };
    const list = this.db.moveWatchers.get(n) ?? [];
    list.push(wrapped);
    this.db.moveWatchers.set(n, list);
    return () =>
      this.db.moveWatchers.set(
        n,
        (this.db.moveWatchers.get(n) ?? []).filter((w) => w !== wrapped),
      );
  }

  startPresence = vi.fn((n: number, role: SessionRole) => {
    this.presence = { n, role };
    const rec = this.db.sessions.get(n);
    if (!rec) return;
    rec[role === 'host' ? 'hostAt' : 'joinerAt'] = this.db.now;
    this.db.publish(n);
  });

  stopPresence = vi.fn(() => {
    this.presence = null;
  });

  async terminate(n: number): Promise<void> {
    this.stopPresence();
    this.db.sessions.delete(n);
    this.db.moves.delete(n);
    this.db.publish(n);
  }

  bump = vi.fn();
}

const { SessionService } = await import('./session.service');
type SessionServiceType = InstanceType<typeof SessionService>;

/** One player: their own session, their own board, their own localStorage. */
interface Device {
  session: SessionServiceType;
  game: GameService;
  storage: Record<string, string>;
}

describe('a game that lives on the server', () => {
  let db: Db;
  let p1: Device;
  let p2: Device;
  let active: Record<string, string>;

  /**
   * localStorage is per device, not per test run: swap the backing object as
   * each session is built and whenever one is driven, so player 1's remembered
   * game and client id are not player 2's.
   */
  function useStorage(store: Record<string, string>): void {
    active = store;
  }

  function newDevice(storage: Record<string, string> = {}): Device {
    useStorage(storage);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        SessionService,
        { provide: LobbyRegistryService, useValue: new FakeRegistry(db) },
      ],
    });
    return { session: TestBed.inject(SessionService), game: TestBed.inject(GameService), storage };
  }

  /**
   * The app is killed and opened again: everything in memory is gone and only
   * localStorage carries over, which is exactly what a phone reclaiming a
   * backgrounded PWA does.
   */
  async function relaunch(d: Device): Promise<Device> {
    const fresh = newDevice(d.storage);
    await vi.advanceTimersByTimeAsync(50);
    return fresh;
  }

  /** Run something as this device, with its own storage in place. */
  async function as<T>(d: Device, fn: () => T | Promise<T>): Promise<T> {
    useStorage(d.storage);
    const out = await fn();
    await vi.advanceTimersByTimeAsync(50);
    return out;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Db();
    active = {};
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((k: string) => active[k] ?? null);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k: string, v: string) => {
      active[k] = v;
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((k: string) => {
      delete active[k];
    });
    p1 = newDevice();
    p2 = newDevice();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function hostAGame(): Promise<string> {
    await as(p1, () => p1.session.newGame());
    expect(p1.session.state()).toBe('hosting');
    return p1.session.gameId()!;
  }

  /**
   * Both boards agree that the game has started, and each device knows exactly
   * one ship: its own. The moves crossed — the phase only moves on when both
   * placements have landed — and neither device learned anything it shouldn't.
   */
  async function expectARealGame(): Promise<void> {
    expect([p1.session.state(), p2.session.state()]).toEqual(['playing', 'playing']);
    await as(p1, () => p1.session.act({ x: 0, y: 0 }));
    await as(p2, () => p2.session.act({ x: 3, y: 4 }));
    for (const d of [p1, p2]) {
      expect(d.game.players().map((p) => p.placed)).toEqual([true, true]);
      expect(d.game.phase()).toBe('fire');
    }
    expect(p1.game.players()[0].ship).toEqual({ x: 0, y: 0 });
    expect(p1.game.players()[1].ship).toBeNull();
    expect(p2.game.players()[1].ship).toEqual({ x: 3, y: 4 });
    expect(p2.game.players()[0].ship).toBeNull();
  }

  it('pairs both players and carries their moves', async () => {
    const id = await hostAGame();
    await as(p2, () => p2.session.join(id));

    expect(p1.session.myPlayer()).toBe(0);
    expect(p2.session.myPlayer()).toBe(1);
    await expectARealGame();
  });

  it('lets player 2 in while player 1 is still away', async () => {
    // The shape of every invite: player 1 shares the link from a messaging app
    // and their phone freezes the tab. Under the old transport there was
    // nobody on the broker to dial and player 2 sat on "Still knocking".
    // Nothing to dial now — the seat is on the record.
    const id = await hostAGame();
    p1 = await relaunch(p1); // player 1's app is gone

    await as(p2, () => p2.session.join(id));
    expect(p2.session.state()).toBe('playing');
    await as(p2, () => p2.session.act({ x: 3, y: 4 })); // and they can play

    // Player 1 comes back to a game that started without them.
    await as(p1, () => p1.session.resumeSession());
    expect(p1.session.state()).toBe('playing');
    expect(p1.session.myPlayer()).toBe(0);
    expect(p1.game.players()[1].placed).toBe(true); // they played while we were out
    expect(p1.game.players()[1].ship).toBeNull(); // …and we still can't see them
  });

  it('brings a player back to the board they left, mid-game', async () => {
    const id = await hostAGame();
    await as(p2, () => p2.session.join(id));
    await as(p1, () => p1.session.act({ x: 0, y: 0 }));
    await as(p2, () => p2.session.act({ x: 3, y: 4 }));
    await as(p1, () => p1.session.act({ x: 2, y: 2 })); // player 1 fires

    const before = JSON.stringify(p2.game.destroyed());
    p2 = await relaunch(p2); // player 2's app is killed
    await as(p2, () => p2.session.resumeSession());

    expect(p2.session.state()).toBe('playing');
    expect(p2.session.myPlayer()).toBe(1); // rule 9: same seat
    expect(JSON.stringify(p2.game.destroyed())).toBe(before); // same board
    // Its own ship is back, out of the secret only this device can read — the
    // log it replayed never carried the square.
    expect(p2.game.players()[1].ship).toEqual({ x: 3, y: 4 });
    // Player 1 is showing only because firing gave their square away (rule 5.2).
    expect(p2.game.players()[0].ship).toEqual({ x: 0, y: 0 });

    // …and play continues into the resumed board: player 1 still owes the move
    // that firing costs them (rule 5.4), and player 2 sees it land — without
    // being told where they sailed to.
    await as(p1, () => p1.session.act({ x: 1, y: 1 }));
    expect(p2.game.players()[0].ship).toBeNull();
    expect(p2.game.currentPlayer()).toBe(1);
  });

  it('keeps player 1 in seat 0 when they open their own link', async () => {
    const id = await hostAGame();
    await as(p1, () => p1.session.join(id)); // tapped the invite they sent

    expect(p1.session.state()).toBe('hosting'); // still their game, still waiting
    expect(p1.session.myPlayer()).toBe(0);
    await as(p2, () => p2.session.join(id));
    await expectARealGame();
  });

  it('turns away a stranger who guesses a game in progress', async () => {
    const id = await hostAGame();
    await as(p2, () => p2.session.join(id));

    const p3 = newDevice();
    await as(p3, () => p3.session.join(id));
    expect(p3.session.state()).toBe('error');
    expect(p3.session.errorMsg()).toMatch(/couldn’t find that game/i);
    // …and the real game is untouched.
    await expectARealGame();
  });

  it('ends the game for both when someone presses Leave', async () => {
    const id = await hostAGame();
    await as(p2, () => p2.session.join(id));
    await as(p1, () => p1.session.leave());

    expect(p1.session.state()).toBe('lobby');
    expect(p2.session.state()).toBe('disconnected');
    // And there is nothing left to come back to.
    await as(p2, () => p2.session.leave());
    expect(await p2.session.resumeSession()).toBe(false);
  });

  it('does not offer a link that has expired', async () => {
    const id = await hostAGame();
    expect(id).not.toBe('');
    p1 = await relaunch(p1);
    db.now += 11 * 60_000; // nobody ever joined: the number is recycled

    expect(await as(p1, () => p1.session.resumeSession())).toBe(false);
    expect(p1.session.state()).toBe('lobby');
  });

  it('rebuilds craters, health and score from the log alone', async () => {
    // The question this design turns on: nothing but the moves is stored, so
    // everything a returning player needs has to fall out of replaying them.
    const id = await hostAGame();
    await as(p2, () => p2.session.join(id));
    await as(p1, () => p1.session.act({ x: 0, y: 0 }));
    await as(p2, () => p2.session.act({ x: 3, y: 4 }));
    await as(p1, () => p1.session.act({ x: 3, y: 4 })); // a hit: player 2 to 50%
    await as(p1, () => p1.session.act({ x: 0, y: 1 })); // and the move it costs

    expect(p1.game.players()[1].health).toBeLessThan(100);
    const snapshot = (g: GameService) => ({
      players: g.players(),
      destroyed: g.destroyed(),
      hitSquares: g.hitSquares(),
      phase: g.phase(),
      turn: g.currentPlayer(),
      scores: g.scores(),
    });
    const truth = JSON.stringify(snapshot(p2.game));

    p2 = await relaunch(p2); // player 2's app is killed mid-game
    await as(p2, () => p2.session.resumeSession());

    // Not just "a board" — the same board, down to the burning hull, the
    // craters and its own ship, none of which was ever stored as such: it all
    // falls out of replaying the log and reading back one private square.
    expect(JSON.stringify(snapshot(p2.game))).toBe(truth);
  });

  it('answers a shot from the secret, not from the shooter', async () => {
    // The shooter's device does not know where the enemy is, so it cannot know
    // whether it hit: the answer comes back with the entry, checked against a
    // square neither device could read.
    const id = await hostAGame();
    await as(p2, () => p2.session.join(id));
    await as(p1, () => p1.session.act({ x: 0, y: 0 }));
    await as(p2, () => p2.session.act({ x: 3, y: 4 }));

    await as(p1, () => p1.session.act({ x: 3, y: 4 })); // straight onto them
    for (const d of [p1, p2]) {
      expect(d.game.players()[1].health).toBe(50); // rule 6.2
      expect(d.game.players()[1].ship).toEqual({ x: 3, y: 4 }); // the hull shows
      expect(d.game.hitSquares()[4 * 4 + 3]).toBe(true);
    }
    // …and sailing on takes it back: the enemy is a secret again.
    await as(p1, () => p1.session.act({ x: 1, y: 1 })); // rule 5.4
    await as(p2, () => p2.session.act({ x: 0, y: 0 })); // p2 fires
    await as(p2, () => p2.session.act({ x: 2, y: 3 })); // …and sails
    expect(p1.game.players()[1].ship).toBeNull();
    expect(p1.game.players()[1].health).toBe(40); // rule 6.3: the fire burns on
  });

  it('wrecks both ships when one sails into the other (rule 11)', async () => {
    const id = await hostAGame();
    await as(p2, () => p2.session.join(id));
    await as(p1, () => p1.session.act({ x: 0, y: 0 }));
    await as(p2, () => p2.session.act({ x: 1, y: 1 }));
    await as(p1, () => p1.session.act({ x: 3, y: 4 })); // p1 fires far away
    await as(p1, () => p1.session.act({ x: 1, y: 1 })); // …and sails into p2

    for (const d of [p1, p2]) {
      expect(d.game.rammed()).toBe(true);
      expect(d.game.scores()).toEqual([0, 0]); // rule 11.2
      // Rule 11.3: both wrecks on the one square, on both boards.
      expect(d.game.players()[0].ship).toEqual({ x: 1, y: 1 });
      expect(d.game.players()[1].ship).toEqual({ x: 1, y: 1 });
    }
  });

  it('starts a rematch on a fresh round, with fresh ships', async () => {
    const id = await hostAGame();
    await as(p2, () => p2.session.join(id));
    await as(p1, () => p1.session.act({ x: 0, y: 0 }));
    await as(p2, () => p2.session.act({ x: 3, y: 4 }));

    await as(p1, () => p1.session.playAgain());
    for (const d of [p1, p2]) expect(d.game.phase()).toBe('placement');

    // The same squares again: a round that shared the last one's namespace
    // would be refused here, because a position is written once and never
    // again.
    await as(p1, () => p1.session.act({ x: 0, y: 0 }));
    await as(p2, () => p2.session.act({ x: 3, y: 4 }));
    expect(p1.session.problem()).toBeNull();
    expect(p2.session.problem()).toBeNull();
    for (const d of [p1, p2]) expect(d.game.phase()).toBe('fire');

    // …and a player who comes back mid-rematch still finds their own ship: the
    // replay has to read the secret for the round it ends up in, not the one it
    // started from.
    p2 = await relaunch(p2);
    await as(p2, () => p2.session.resumeSession());
    expect(p2.game.players()[1].ship).toEqual({ x: 3, y: 4 });
    expect(p2.game.phase()).toBe('fire');
  });

  it('applies each move once, however it arrives', async () => {
    const id = await hostAGame();
    await as(p2, () => p2.session.join(id));
    await as(p1, () => p1.session.act({ x: 0, y: 0 }));
    await as(p2, () => p2.session.act({ x: 3, y: 4 }));

    // Player 1 fires; the shot must land on both boards exactly once, so the
    // turn comes back to the same player on each of them.
    await as(p1, () => p1.session.act({ x: 2, y: 2 }));
    expect(p1.game.phase()).toBe('move');
    expect(p2.game.phase()).toBe('move');
    expect(p1.game.destroyed().filter(Boolean).length).toBe(1);
    expect(p2.game.destroyed().filter(Boolean).length).toBe(1);
  });
});
