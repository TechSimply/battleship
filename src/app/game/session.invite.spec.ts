import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { GameService } from './game.service';
import {
  LobbyRegistryService,
  Seat,
  SessionRecord,
  SessionRole,
  isSessionAlive,
  toAction,
  toWire,
} from './lobby-registry.service';

/**
 * The whole invite, end to end, with two real sessions on either side of one
 * in-memory stand-in for the Realtime Database — records, presence heartbeats
 * and the append-only move log, with the same semantics the rules enforce.
 *
 * These are the cases the old WebRTC transport could not do at all, and they
 * are the reason it was replaced: player 2 opening a link while player 1 is
 * still in their messaging app, and either player closing the app mid-game and
 * coming back to the board exactly as they left it.
 *
 * Assert a move *crossing*, not just that both sides say "playing" — two
 * devices looking at unrelated boards say that too.
 */

/** Everything the two sessions share: this is the database. */
class Db {
  sessions = new Map<number, SessionRecord>();
  moves = new Map<number, { key: string; raw: unknown }[]>();
  watchers = new Map<number, ((rec: SessionRecord | null) => void)[]>();
  moveWatchers = new Map<number, ((raw: unknown, key: string) => void)[]>();
  private seq = 0;

  now = 1_700_000_000_000;

  nextKey(): string {
    return `k${String(++this.seq).padStart(4, '0')}`;
  }

  publish(n: number): void {
    const rec = this.sessions.get(n) ?? null;
    for (const w of [...(this.watchers.get(n) ?? [])]) w(rec ? { ...rec } : null);
  }
}

/**
 * A LobbyRegistryService backed by `Db` instead of Firebase. Deliberately the
 * real logic (`isSessionAlive`, `toWire`/`toAction`) around a fake socket, so
 * what these tests exercise is the session choreography and not a re-statement
 * of it.
 */
class FakeRegistry {
  constructor(private db: Db) {}

  private presence: { n: number; role: SessionRole } | null = null;

  serverNow = () => this.db.now;

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
    return { role, joined: rec.joined === true };
  }

  async takeJoinerSeat(n: number, joinerId: string): Promise<boolean> {
    const rec = this.db.sessions.get(n) ?? null;
    if (!isSessionAlive(rec, this.db.now) || !rec) return false;
    if (rec.joinerId && rec.joinerId !== joinerId) return false;
    if (rec.hostId === joinerId) return false;
    rec.joinerId = joinerId;
    rec.joinerAt = this.db.now;
    rec.joined = true;
    this.db.publish(n);
    return true;
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

  sendMove(n: number, action: Parameters<typeof toWire>[0]): string | null {
    const key = this.db.nextKey();
    const raw = toWire(action);
    const log = this.db.moves.get(n) ?? [];
    log.push({ key, raw });
    this.db.moves.set(n, log);
    // Delivered to every listener, including the writer's own.
    setTimeout(() => {
      for (const w of [...(this.db.moveWatchers.get(n) ?? [])]) w(raw, key);
    }, 0);
    return key;
  }

  watchMoves(
    n: number,
    cb: (action: NonNullable<ReturnType<typeof toAction>>, key: string) => void,
  ) {
    const wrapped = (raw: unknown, key: string) => {
      const action = toAction(raw);
      if (action) cb(action, key);
    };
    const list = this.db.moveWatchers.get(n) ?? [];
    list.push(wrapped);
    this.db.moveWatchers.set(n, list);
    // …and the backlog first, oldest to newest: that is the replay.
    setTimeout(() => {
      for (const m of this.db.moves.get(n) ?? []) wrapped(m.raw, m.key);
    }, 0);
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

  /** Both boards agree about both ships: the moves really crossed. */
  async function expectARealGame(): Promise<void> {
    expect([p1.session.state(), p2.session.state()]).toEqual(['playing', 'playing']);
    await as(p1, () => p1.session.act({ x: 0, y: 0 }));
    await as(p2, () => p2.session.act({ x: 3, y: 4 }));
    for (const d of [p1, p2]) {
      expect(d.game.players()[0].ship).toEqual({ x: 0, y: 0 });
      expect(d.game.players()[1].ship).toEqual({ x: 3, y: 4 });
      expect(d.game.phase()).toBe('fire');
    }
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
    expect(p1.game.players()[1].ship).toEqual({ x: 3, y: 4 });
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
    expect(p2.game.players()[0].ship).toEqual({ x: 0, y: 0 });
    expect(p2.game.players()[1].ship).toEqual({ x: 3, y: 4 });

    // …and play continues into the resumed board: player 1 still owes the move
    // that firing costs them (rule 5.4), and player 2 sees it land.
    await as(p1, () => p1.session.act({ x: 1, y: 1 }));
    expect(p2.game.players()[0].ship).toEqual({ x: 1, y: 1 });
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
    const truth = JSON.stringify(snapshot(p1.game));

    p2 = await relaunch(p2); // player 2's app is killed mid-game
    await as(p2, () => p2.session.resumeSession());

    // Not just "a board" — the same board, down to the burning hull and the
    // craters, with no field of it ever having been written to the database.
    expect(JSON.stringify(snapshot(p2.game))).toBe(truth);
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
