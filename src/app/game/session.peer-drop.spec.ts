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

  connect(): unknown {
    return { on: () => {}, close: () => {} };
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
}

vi.mock('peerjs', () => ({ default: FakePeer }));

/** Firebase is not reachable under test; hand back a claim that always works. */
class FakeRegistry {
  presence: number | null = null;
  terminated: number[] = [];
  claim = vi.fn(async (n: number) => n > 0);
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

  it('still reports a socket that never came up at all', async () => {
    session.newGame();
    await vi.waitFor(() => expect(FakePeer.instances.length).toBeGreaterThan(0));
    // Never reached the broker: nothing was claimed and there is nothing to
    // reconnect to, so the player does need to hear about their connection.
    FakePeer.instances.at(-1)!.failToReachBroker();

    expect(session.state()).toBe('error');
    expect(session.errorMsg()).toMatch(/check your internet/i);
  });
});
