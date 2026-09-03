import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { GameService } from './game.service';
import { LobbyRegistryService } from './lobby-registry.service';

/**
 * The invite, end to end, with two real sessions on either side of a stand-in
 * broker that behaves like the PeerJS one — including the two behaviours that
 * used to wedge a game for good:
 *
 *  - a connect to an id nobody is holding is *queued*, and only answered with
 *    `peer-unavailable` five seconds later, so that answer routinely arrives
 *    after the knock it belongs to has been replaced;
 *  - a queued offer is delivered if the host registers within that window, so a
 *    knock its owner has already given up on can still open on the host's side
 *    alone — the ghost.
 *
 * Both are exactly what happens when player 1 sends the link from a messaging
 * app, their phone freezes the tab, and player 2 opens it during that gap.
 * The real two-device check (Playwright + system Edge, see CLAUDE.md) still
 * owns the WebRTC layer; this owns the choreography.
 */

const EXPIRE_MS = 5_000; // PeerJS server's default queue timeout

/** One end of a data channel. The two ends are linked, and can be unlinked. */
class Channel {
  private handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  peer!: Channel;
  open = false;
  closed = false;

  on(event: string, cb: (arg?: unknown) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }

  emit(event: string, arg?: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(arg);
  }

  send(msg: unknown): void {
    // A channel whose owner has hung up carries nothing — and says nothing
    // about it either, which is what makes a ghost a ghost.
    if (!this.open || this.closed || !this.peer.open) return;
    setTimeout(() => this.peer.emit('data', msg), 0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const wasOpen = this.open;
    this.open = false;
    // Only a channel that had actually come up tells the other end it is going.
    if (wasOpen && this.peer.open) setTimeout(() => this.peer.emit('close'), 0);
  }
}

/** The broker: who is registered, and what is queued for whoever is not. */
class Broker {
  static registered = new Map<string, FakePeer>();
  static queue: { from: FakePeer; to: string; caller: Channel; at: number }[] = [];

  /** How long the WebRTC handshake takes before the channel actually opens. */
  static answerDelay = 0;

  static reset(): void {
    Broker.registered.clear();
    Broker.queue = [];
    Broker.answerDelay = 0;
  }

  static register(peer: FakePeer): void {
    Broker.registered.set(peer.id!, peer);
    // Deliver anything still queued for this id — the stale-offer case.
    const due = Broker.queue.filter((q) => q.to === peer.id);
    Broker.queue = Broker.queue.filter((q) => q.to !== peer.id);
    for (const q of due) Broker.deliver(peer, q.caller);
  }

  static unregister(peer: FakePeer): void {
    if (peer.id && Broker.registered.get(peer.id) === peer) Broker.registered.delete(peer.id);
  }

  static deliver(host: FakePeer, caller: Channel): void {
    const callee = new Channel();
    callee.peer = caller;
    caller.peer = callee;
    setTimeout(() => {
      host.emit('connection', callee);
      setTimeout(() => {
        // The host's side comes up first (it answers), then the caller's — and
        // a handshake slow enough to outlast the caller's patience is how a
        // knock nobody is waiting on any more opens on the host's side alone.
        if (!callee.closed) {
          callee.open = true;
          callee.emit('open');
        }
        setTimeout(() => {
          if (caller.closed) return; // the caller gave up while we answered
          caller.open = true;
          caller.emit('open');
        }, 0);
      }, Broker.answerDelay);
    }, 0);
  }
}

let peerSeq = 0;

class FakePeer {
  private handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  id: string;
  destroyed = false;
  disconnected = false;
  open = false;

  constructor(id?: string) {
    this.id = id ?? `anon-${++peerSeq}`;
    // The broker answers a fresh socket a tick later, like a real one.
    setTimeout(() => {
      if (this.destroyed) return;
      if (Broker.registered.has(this.id)) {
        this.emit('error', Object.assign(new Error('ID is taken'), { type: 'unavailable-id' }));
        return;
      }
      this.open = true;
      Broker.register(this);
      this.emit('open', this.id);
    }, 0);
  }

  on(event: string, cb: (arg?: unknown) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }

  emit(event: string, arg?: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(arg);
  }

  destroy(): void {
    this.destroyed = true;
    this.open = false;
    Broker.unregister(this);
  }

  /** The tab is frozen: reconnects go nowhere until the player comes back. */
  private frozen = false;

  reconnect(): void {
    if (this.frozen) return; // still asleep — PeerJS just keeps trying
    this.disconnected = false;
    this.open = true;
    Broker.register(this);
  }

  connect(target: string): Channel {
    const caller = new Channel();
    caller.peer = new Channel(); // replaced on delivery
    caller.peer.peer = caller;
    const host = Broker.registered.get(target);
    if (host) {
      Broker.deliver(host, caller);
      return caller;
    }
    // Nobody is holding that id: queue the offer, and answer much later.
    const entry = { from: this, to: target, caller, at: Date.now() };
    Broker.queue.push(entry);
    setTimeout(() => {
      if (!Broker.queue.includes(entry)) return; // delivered after all
      Broker.queue = Broker.queue.filter((q) => q !== entry);
      if (this.destroyed) return;
      this.emit(
        'error',
        Object.assign(new Error(`Could not connect to peer ${target}`), {
          type: 'peer-unavailable',
        }),
      );
    }, EXPIRE_MS);
    return caller;
  }

  /** The phone froze this tab: the socket goes, PeerJS says so. */
  freeze(): void {
    this.frozen = true;
    this.open = false;
    Broker.unregister(this);
    this.emit('error', Object.assign(new Error('Lost connection to server.'), { type: 'network' }));
    this.disconnected = true;
    this.emit('disconnected', this.id);
  }

  /** Player 1 looks at their screen again and the socket comes back. */
  thaw(): void {
    this.frozen = false;
    this.reconnect();
    this.emit('open', this.id);
  }
}

vi.mock('peerjs', () => ({ default: FakePeer }));

/** Firebase stand-in shared by both sessions, so presence crosses between them. */
class SharedRegistry {
  static records = new Map<number, { host: number; joiner: number; joined: boolean }>();

  claim = vi.fn(async (n: number) => {
    if (SharedRegistry.records.has(n)) return false;
    SharedRegistry.records.set(n, { host: Date.now(), joiner: 0, joined: false });
    return true;
  });
  isAlive = vi.fn(async (n: number) => SharedRegistry.records.has(n));
  isHostAlive = vi.fn(async (n: number) => SharedRegistry.records.has(n));
  reclaimHost = vi.fn(async () => true);
  markJoined = vi.fn(async (n: number) => {
    const rec = SharedRegistry.records.get(n);
    if (rec) rec.joined = true;
  });
  terminate = vi.fn(async (n: number) => void SharedRegistry.records.delete(n));
  startPresence = vi.fn((n: number, role: string) => {
    const rec = SharedRegistry.records.get(n) ?? { host: 0, joiner: 0, joined: false };
    rec[role === 'host' ? 'host' : 'joiner'] = Date.now();
    SharedRegistry.records.set(n, rec);
  });
  stopPresence = vi.fn();
  observe = vi.fn(() => () => {});
  serverNow = vi.fn(() => Date.now());
  bump = vi.fn();
}

const { SessionService } = await import('./session.service');
type SessionServiceType = InstanceType<typeof SessionService>;

/** A session of its own, with its own board, as if on its own phone. */
function newSession(): { session: SessionServiceType; game: GameService } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [SessionService, { provide: LobbyRegistryService, useValue: new SharedRegistry() }],
  });
  return { session: TestBed.inject(SessionService), game: TestBed.inject(GameService) };
}

describe('an invite, from the link to both boards', () => {
  let host: SessionServiceType;
  let joiner: SessionServiceType;
  let hostGame: GameService;
  let joinerGame: GameService;

  beforeEach(() => {
    vi.useFakeTimers();
    Broker.reset();
    SharedRegistry.records.clear();
    localStorage.clear();
    ({ session: host, game: hostGame } = newSession());
    ({ session: joiner, game: joinerGame } = newSession());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Both sides say "playing" — but so do two devices holding opposite ends of
   * a channel that carries nothing. The proof is a move crossing: place a ship
   * from each side and see both boards agree about both of them.
   */
  async function expectARealGame(): Promise<void> {
    expect([host.state(), joiner.state()]).toEqual(['playing', 'playing']);
    host.act({ x: 0, y: 0 });
    joiner.act({ x: 3, y: 4 });
    await vi.advanceTimersByTimeAsync(500);
    for (const game of [hostGame, joinerGame]) {
      expect(game.players()[0].ship).toEqual({ x: 0, y: 0 });
      expect(game.players()[1].ship).toEqual({ x: 3, y: 4 });
    }
  }

  async function hostAGame(): Promise<string> {
    host.newGame();
    await vi.advanceTimersByTimeAsync(50);
    expect(host.state()).toBe('hosting');
    // These are two phones, not two tabs: player 2 must not find player 1's
    // remembered link in storage and take the number for their own.
    localStorage.clear();
    return host.gameId()!;
  }

  it('pairs both sides when the host is awake', async () => {
    const id = await hostAGame();

    joiner.join(id);
    await vi.advanceTimersByTimeAsync(200);

    expect(joiner.myPlayer()).toBe(1);
    expect(host.myPlayer()).toBe(0);

    // Both sides greet each other, so neither drops the pairing when the
    // window for proving it is real runs out.
    await vi.advanceTimersByTimeAsync(10_000);
    await expectARealGame();
    expect(hostGame.phase()).toBe('fire');
    expect(joinerGame.phase()).toBe('fire');
  });

  it('pairs when player 2 opens the link while the host’s phone is asleep', async () => {
    // The shape of every real invite: the link is sent from a messaging app,
    // which freezes the host's tab and takes its id off the broker, and player
    // 2 opens it during exactly that gap.
    const id = await hostAGame();
    const hostPeer = [...Broker.registered.values()][0];
    hostPeer.freeze();

    joiner.join(id);
    await vi.advanceTimersByTimeAsync(6_000); // the broker expires the knock
    expect(joiner.state()).toBe('joining');
    expect(joiner.waitingForHost()).toBe(true); // and the lobby says so

    // Player 1 glances at their phone twenty seconds in — knocks and their
    // expiries are overlapping by now, which is what used to lose the one that
    // got through.
    await vi.advanceTimersByTimeAsync(14_000);
    hostPeer.thaw();
    await vi.advanceTimersByTimeAsync(15_000);

    await expectARealGame();
  });

  it('recovers when a knock the joiner gave up on reaches the host', async () => {
    // The ghost. The host comes back just in time for the broker to hand over
    // a queued offer, but the handshake drags on past the point where player 2
    // has given up on that knock — so the channel opens on the host's side
    // alone. The host used to stay in that empty game and turn away every real
    // knock after it, which is a wedge nothing could clear.
    const id = await hostAGame();
    const hostPeer = [...Broker.registered.values()][0];
    hostPeer.freeze();

    joiner.join(id);
    await vi.advanceTimersByTimeAsync(4_900); // the knock is queued
    Broker.answerDelay = 6_000; // …and the handshake will crawl
    hostPeer.thaw();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(joiner.state()).toBe('joining'); // player 2 moved on at 9s
    Broker.answerDelay = 0; // the network settles

    await vi.advanceTimersByTimeAsync(30_000);

    expect(host.gameId()).toBe(id);
    await expectARealGame();
  });
});
