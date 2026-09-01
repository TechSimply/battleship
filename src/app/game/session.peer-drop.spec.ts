import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { LobbyRegistryService } from './lobby-registry.service';

/**
 * The bug this file exists for: a host who claimed a game id and stepped out of
 * the app to send the invite came back to "Connection problem — check your
 * internet and try again." Backgrounding a tab freezes its broker socket, and
 * PeerJS reports that loss as an `error` (type `network`) *before* it reports
 * the `disconnected` that the re-register loop listens for — so the error
 * handler failed the session and destroyed the peer, and the recovery written
 * for exactly this case never got to run.
 *
 * It came back, by a longer road. Reconnecting straight after a socket drop
 * usually finds the broker still holding our own id, and PeerJS answers that
 * with `unavailable-id` and throws the peer away. The peer we build to replace
 * it has no history — so the *next* blip, on a session that had been happily
 * sitting on a claimed number, read as "this device has never been online" and
 * failed all over again. Hence `brokerSeen`: a fact about the session, not
 * about whichever Peer object PeerJS currently has.
 *
 * These tests drive the real SessionService against a stand-in Peer, so the
 * wiring is covered and not just the classification.
 */

/** Minimal PeerJS stand-in: enough surface for SessionService, fully driveable. */
class FakePeer {
  static instances: FakePeer[] = [];
  private handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  id: string | null;
  destroyed = false;
  disconnected = false;
  open = false;
  reconnects = 0;

  constructor(id?: string) {
    this.id = id ?? null;
    FakePeer.instances.push(this);
  }

  on(event: string, cb: (arg?: unknown) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }

  private emit(event: string, arg?: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(arg);
  }

  destroy(): void {
    this.destroyed = true;
  }

  reconnect(): void {
    this.reconnects++;
    this.disconnected = false;
    this.open = true;
  }

  /** Every dial this peer has made, newest last. */
  dials: FakeConn[] = [];

  connect(): FakeConn {
    const conn = new FakeConn();
    this.dials.push(conn);
    return conn;
  }

  /** The broker has no such id right now — the host's app is asleep. */
  peerUnavailable(): void {
    this.emit(
      'error',
      Object.assign(new Error('Could not connect to peer'), { type: 'peer-unavailable' }),
    );
  }

  // --- driving the fake from a test ---

  /** The broker accepted us and we hold our id. */
  reachBroker(): void {
    this.open = true;
    this.emit('open', this.id);
  }

  /**
   * What a phone does to a backgrounded tab, in PeerJS's own order: the error
   * first, then the disconnect (see peer.ts — `emitError(Network)` runs before
   * `disconnect()`).
   */
  dropSocket(type = 'network'): void {
    this.open = false;
    this.emit('error', Object.assign(new Error('Lost connection to server.'), { type }));
    this.disconnected = true;
    this.emit('disconnected', this.id);
  }

  /** A socket that never came up at all: PeerJS destroys the peer outright. */
  failToReachBroker(type = 'network'): void {
    this.emit('error', Object.assign(new Error('Could not connect to server.'), { type }));
    this.destroy();
  }

  /**
   * What the broker says when we reconnect before it has noticed our old socket
   * die: the id we are asking for is (still) our own. PeerJS destroys the peer.
   */
  idStillTaken(): void {
    this.emit('error', Object.assign(new Error('ID is taken'), { type: 'unavailable-id' }));
  }
}

/** A dial in progress: the joiner's end of `peer.connect()`. */
class FakeConn {
  private handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  closed = false;

  on(event: string, cb: (arg?: unknown) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }

  close(): void {
    this.closed = true;
  }

  send(): void {}

  /** The host picked up. */
  accept(): void {
    for (const cb of this.handlers['open'] ?? []) cb();
  }
}

vi.mock('peerjs', () => ({ default: FakePeer }));

/** Firebase is not reachable under test; hand back a claim that always works. */
class FakeRegistry {
  presence: number | null = null;
  terminated: number[] = [];
  claim = vi.fn(async (n: number) => n > 0);
  isAlive = vi.fn(async () => true);
  markJoined = vi.fn(async () => {});
  terminate = vi.fn(async (n: number) => void this.terminated.push(n));
  startPresence = vi.fn((n: number) => void (this.presence = n));
  stopPresence = vi.fn(() => void (this.presence = null));
  observe = vi.fn(() => () => {});
  serverNow = vi.fn(() => Date.now());
  bump = vi.fn();
}

// Imported after vi.mock so the service picks up the fake Peer.
const { SessionService } = await import('./session.service');
type SessionServiceType = InstanceType<typeof SessionService>;

describe('a backgrounded host keeps its game', () => {
  let session: SessionServiceType;
  let registry: FakeRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    FakePeer.instances = [];
    registry = new FakeRegistry();
    TestBed.configureTestingModule({
      providers: [SessionService, { provide: LobbyRegistryService, useValue: registry }],
    });
    session = TestBed.inject(SessionService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** New Game through to a claimed id on the broker. */
  async function hostAGame(): Promise<FakePeer> {
    session.newGame();
    await vi.waitFor(() => expect(FakePeer.instances.length).toBeGreaterThan(0));
    const peer = FakePeer.instances.at(-1)!;
    peer.reachBroker();
    return peer;
  }

  it('claims an id and waits for player 2', async () => {
    await hostAGame();
    expect(session.state()).toBe('hosting');
    expect(session.gameId()).not.toBeNull();
  });

  it('survives the socket drop that sharing the invite causes', async () => {
    const peer = await hostAGame();
    const id = session.gameId();

    peer.dropSocket(); // stepped out to Messenger; the tab froze

    expect(session.state()).toBe('hosting'); // not 'error'
    expect(session.errorMsg()).toBeNull();
    expect(session.gameId()).toBe(id); // same number — the shared link still points here
    expect(peer.destroyed).toBe(false);
  });

  it('re-registers the id, and keeps retrying until it sticks', async () => {
    const peer = await hostAGame();

    peer.dropSocket();
    expect(peer.reconnects).toBe(0); // the retry loop is armed, not fired

    await vi.advanceTimersByTimeAsync(1_500);
    expect(peer.reconnects).toBe(1);

    // Still offline when the first attempt ran: keep trying rather than
    // silently leaving Battle{n} unclaimed.
    peer.disconnected = true;
    peer.open = false;
    await vi.advanceTimersByTimeAsync(3_500);
    expect(peer.reconnects).toBe(2);

    // Back on the broker — the loop stops rather than reconnecting forever.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(peer.reconnects).toBe(2);
    expect(session.state()).toBe('hosting');
  });

  it('rides out every flavour of socket loss', async () => {
    for (const type of ['network', 'socket-closed', 'socket-error', 'disconnected']) {
      FakePeer.instances = [];
      const peer = await hostAGame();
      peer.dropSocket(type);
      expect([type, session.state()]).toEqual([type, 'hosting']);
    }
  });

  it('keeps the same number when the broker is still holding it', async () => {
    const peer = await hostAGame();
    const id = session.gameId();

    // Stepped out, came back, reconnected before the broker noticed the old
    // socket die — so it hands back our own id as taken.
    peer.dropSocket();
    await vi.advanceTimersByTimeAsync(1_500);
    peer.idStillTaken();

    // The number is reserved for us in Firebase and the link is already sent:
    // wait the broker out on that number rather than grabbing a different one.
    await vi.advanceTimersByTimeAsync(2_500);
    const rebuilt = FakePeer.instances.at(-1)!;
    expect(rebuilt).not.toBe(peer);
    rebuilt.reachBroker();

    expect(session.state()).toBe('hosting');
    expect(session.gameId()).toBe(id);
  });

  it('does not call a rebuilt peer’s first blip a dead connection', async () => {
    // The exact chain that put the reported error back on screen: drop, an
    // id-still-taken reconnect, then a network blip on the replacement peer
    // before it has managed to open. The replacement has no history — but the
    // session does, and the session is what decides.
    const peer = await hostAGame();
    const id = session.gameId();

    peer.dropSocket();
    await vi.advanceTimersByTimeAsync(1_500);
    peer.idStillTaken();
    await vi.advanceTimersByTimeAsync(2_500);

    const rebuilt = FakePeer.instances.at(-1)!;
    rebuilt.failToReachBroker(); // never got as far as 'open'

    expect(session.state()).toBe('hosting');
    expect(session.errorMsg()).toBeNull();

    // And it keeps working the number rather than sitting on a dead peer.
    await vi.advanceTimersByTimeAsync(5_000);
    const next = FakePeer.instances.at(-1)!;
    expect(next).not.toBe(rebuilt);
    next.reachBroker();
    expect(session.gameId()).toBe(id);
  });

  /** Player 2 through to a peer of their own on the broker, mid-dial. */
  async function openTheLink(): Promise<FakePeer> {
    session.join('4242');
    await vi.waitFor(() => expect(FakePeer.instances.length).toBeGreaterThan(0));
    const peer = FakePeer.instances.at(-1)!;
    peer.reachBroker();
    return peer;
  }

  it('keeps knocking while the host’s phone has the app asleep', async () => {
    // The whole shape of an invite: the host sends the link from a messaging
    // app, which puts their PWA to sleep and takes Battle{n} off the broker
    // with it. Player 2 opens the link during exactly that gap. Calling the
    // game over on the first unanswered knock made every invite fail.
    const peer = await openTheLink();
    expect(peer.dials.length).toBe(1);

    peer.peerUnavailable();
    expect(session.state()).toBe('joining'); // not 'error'
    expect(session.errorMsg()).toBeNull();
    expect(session.waitingForHost()).toBe(true);

    await vi.advanceTimersByTimeAsync(2_500);
    expect(peer.dials.length).toBe(2); // knocked again

    peer.dials.at(-1)!.accept(); // host tapped back into the app
    expect(session.state()).toBe('playing');
    expect(session.waitingForHost()).toBe(false);
  });

  it('a stale knock cannot tear down the one that got through', async () => {
    const peer = await openTheLink();
    const first = peer.dials[0];

    peer.peerUnavailable();
    await vi.advanceTimersByTimeAsync(2_500);
    peer.dials.at(-1)!.accept();
    expect(session.state()).toBe('playing');

    // The first knock's 5s timeout now comes due. It belongs to a dial that
    // has been superseded, so it must not end the game that is under way.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.state()).toBe('playing');
    expect(first.closed).toBe(true);
  });

  it('gives up once the join window really has run out', async () => {
    const peer = await openTheLink();
    for (let i = 0; i < 60 && session.state() === 'joining'; i++) {
      const p = FakePeer.instances.at(-1)!;
      if (p.dials.length) p.peerUnavailable();
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(session.state()).toBe('error');
    expect(session.errorMsg()).toMatch(/opponent left/i);
    expect(peer.dials.length).toBeGreaterThan(1); // it did keep trying
  });

  it('believes the registry when the number was never a game', async () => {
    // A mistyped id should not cost the player a minute of knocking.
    registry.isAlive = vi.fn(async () => false);
    const peer = await openTheLink();
    peer.peerUnavailable();
    await vi.advanceTimersByTimeAsync(100);

    expect(session.state()).toBe('error');
    expect(session.errorMsg()).toMatch(/opponent left/i);
  });

  it('keeps knocking when the registry itself is unreachable', async () => {
    // Firebase being down must never turn a live game into "opponent left" —
    // gameplay does not go through it.
    registry.isAlive = vi.fn(async () => {
      throw new Error('offline');
    });
    const peer = await openTheLink();
    peer.peerUnavailable();
    await vi.advanceTimersByTimeAsync(2_500);

    expect(session.state()).toBe('joining');
    expect(peer.dials.length).toBe(2);
  });

  it('still reports a connection that never comes up at all', async () => {
    session.newGame();
    await vi.waitFor(() => expect(FakePeer.instances.length).toBeGreaterThan(0));

    // Never reached the broker, and every retry fails the same way: nothing was
    // ever claimed, so the player does need to hear about their connection.
    for (let attempt = 0; attempt < 8 && session.state() === 'hosting'; attempt++) {
      FakePeer.instances.at(-1)!.failToReachBroker();
      await vi.advanceTimersByTimeAsync(10_000);
    }

    expect(session.state()).toBe('error');
    expect(session.errorMsg()).toMatch(/check your internet/i);
  });
});
