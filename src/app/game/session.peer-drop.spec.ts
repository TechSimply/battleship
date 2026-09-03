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

  /** Somebody knocks on the id we are hosting. */
  incoming(): FakeConn {
    const conn = new FakeConn();
    this.emit('connection', conn);
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
  sent: { kind: string }[] = [];

  on(event: string, cb: (arg?: unknown) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }

  private emit(event: string, arg?: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(arg);
  }

  close(): void {
    this.closed = true;
  }

  send(msg: { kind: string }): void {
    this.sent.push(msg);
  }

  /** The channel opened and a live opponent said hello back. */
  accept(): void {
    this.openOnly();
    this.deliver({ kind: 'hello' });
  }

  /**
   * The channel opened on this side alone — the invite-link ghost: whoever
   * knocked has already walked away, so nothing ever comes back.
   */
  openOnly(): void {
    this.emit('open');
  }

  /** A message arriving from the other side. */
  deliver(msg: unknown): void {
    this.emit('data', msg);
  }

  /** The channel died. */
  drop(): void {
    this.emit('close');
  }
}

vi.mock('peerjs', () => ({ default: FakePeer }));

/** Firebase is not reachable under test; hand back a claim that always works. */
class FakeRegistry {
  presence: number | null = null;
  presenceRole: string | null = null;
  terminated: number[] = [];
  claim = vi.fn(async (n: number) => n > 0);
  isAlive = vi.fn(async () => true);
  isHostAlive = vi.fn(async () => true);
  reclaimHost = vi.fn(async () => true);
  markJoined = vi.fn(async () => {});
  terminate = vi.fn(async (n: number) => void this.terminated.push(n));
  startPresence = vi.fn((n: number, role: string) => {
    this.presence = n;
    this.presenceRole = role;
  });
  stopPresence = vi.fn(() => {
    this.presence = null;
    this.presenceRole = null;
  });
  observe = vi.fn((n: number, cb: (rec: unknown) => void) => {
    this.watchers.push(cb);
    return () => {
      this.watchers = this.watchers.filter((w) => w !== cb);
    };
  });
  serverNow = vi.fn(() => Date.now());
  bump = vi.fn();

  private watchers: ((rec: unknown) => void)[] = [];

  /** Player 2 heartbeats onto the link while they knock (rule 9). */
  joinerOnLink(): void {
    const rec = {
      createdAt: Date.now(),
      hostAt: Date.now(),
      joinerAt: Date.now(),
      joined: false,
      terminated: false,
    };
    for (const w of [...this.watchers]) w(rec);
  }
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
    localStorage.clear(); // no link remembered from a previous test
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
    for (let i = 0; i < 120 && session.state() === 'joining'; i++) {
      const p = FakePeer.instances.at(-1)!;
      if (p.dials.length) p.peerUnavailable();
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(session.state()).toBe('error');
    expect(session.errorMsg()).toMatch(/opponent left/i);
    expect(peer.dials.length).toBeGreaterThan(1); // it did keep trying
  });

  it('waits out a host who is relaunching, not just one who is asleep', async () => {
    // A phone that killed the PWA takes longer to come back than a phone that
    // merely froze the tab. As long as the registry says the host is still
    // within their window, the knocking goes on — giving up at 60s stranded
    // player 2 at exactly the moment player 1 was reopening the app.
    const peer = await openTheLink();
    for (let i = 0; i < 30; i++) {
      FakePeer.instances.at(-1)!.peerUnavailable();
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(session.state()).toBe('joining'); // 90s in and still knocking

    FakePeer.instances.at(-1)!.dials.at(-1)!.accept(); // player 1 is back
    expect(session.state()).toBe('playing');
  });

  it('tells the host someone is on the link while they knock', async () => {
    // The joiner heartbeats its own presence once it knows the link is real —
    // that is what keeps the link reclaimable for a host who is relaunching,
    // and what lets the hosting screen say "they're on the link".
    await openTheLink();
    await vi.advanceTimersByTimeAsync(100);
    expect(registry.presence).toBe(4242);
    expect(registry.presenceRole).toBe('joiner');
  });

  it('believes the registry when the number was never a game', async () => {
    // A mistyped id should not cost the player a minute of knocking.
    registry.isHostAlive = vi.fn(async () => false);
    const peer = await openTheLink();
    peer.peerUnavailable();
    await vi.advanceTimersByTimeAsync(100);

    expect(session.state()).toBe('error');
    expect(session.errorMsg()).toMatch(/opponent left/i);
    expect(registry.presence).toBeNull(); // and we left no junk record behind
  });

  it('keeps knocking when the registry itself is unreachable', async () => {
    // Firebase being down must never turn a live game into "opponent left" —
    // gameplay does not go through it.
    registry.isHostAlive = vi.fn(async () => {
      throw new Error('offline');
    });
    const peer = await openTheLink();
    peer.peerUnavailable();
    await vi.advanceTimersByTimeAsync(2_500);

    expect(session.state()).toBe('joining');
    expect(peer.dials.length).toBe(2);
  });

  it('never hangs up on a host who picks up while an old knock expires', async () => {
    // The bug that wedged invites for good. The broker answers an unanswered
    // knock with "no such peer" about five seconds later, and that answer names
    // no connection — so it can perfectly well belong to a knock we have
    // already replaced. Letting it retire the knock in flight meant hanging up
    // on the host at the exact moment they picked up.
    const peer = await openTheLink();

    await vi.advanceTimersByTimeAsync(11_500); // knock 1 times out, knock 2 goes
    expect(peer.dials.length).toBe(2);

    peer.peerUnavailable(); // the broker's late answer about knock 1
    peer.dials.at(-1)!.accept(); // and the host picks up knock 2

    expect(session.state()).toBe('playing');
    expect(peer.dials.at(-1)!.closed).toBe(false);
  });

  it('keeps looking for the host when a pairing turns out to be empty', async () => {
    // The other half of that bug, from player 2's side: a channel that opens on
    // one side only is not a game, and reporting it as one ("opponent left")
    // ends a join that had every chance of succeeding.
    const peer = await openTheLink();
    peer.dials[0].openOnly(); // opened, but nobody ever answers
    expect(session.state()).toBe('playing');

    await vi.advanceTimersByTimeAsync(7_000);

    expect(session.state()).toBe('joining');
    expect(session.waitingForHost()).toBe(true);
    expect(peer.dials.length).toBeGreaterThan(1); // and it is knocking again
  });

  it('builds a fresh peer when its knocks vanish without an answer', async () => {
    // A thawed webview can hand back a socket that is dead while PeerJS still
    // reads it as open: knocks disappear into it and nothing ever errors.
    // Knocking harder on it is the one thing that can never work.
    const peer = await openTheLink();

    await vi.advanceTimersByTimeAsync(11_500); // knock 1: no answer at all
    expect(peer.dials.length).toBe(2);
    await vi.advanceTimersByTimeAsync(11_500); // knock 2: same

    const fresh = FakePeer.instances.at(-1)!;
    expect(fresh).not.toBe(peer);
    fresh.reachBroker();
    expect(fresh.dials.length).toBe(1);
    expect(session.state()).toBe('joining');
  });

  it('goes back to waiting when a knock pairs with nobody', async () => {
    // The host's side of the ghost: the broker hands over an offer whose owner
    // gave up on it, the channel opens here alone, and the host used to sit in
    // a game with nobody in it — turning away every real knock that followed.
    const peer = await hostAGame();
    const id = session.gameId();
    const ghost = peer.incoming();
    ghost.openOnly();
    expect(session.state()).toBe('playing');

    await vi.advanceTimersByTimeAsync(7_000);

    expect(session.state()).toBe('hosting');
    expect(session.gameId()).toBe(id); // still the number that is in the chat
    expect(ghost.closed).toBe(true);
    expect(registry.markJoined).not.toHaveBeenCalled(); // the link never paired
    expect(localStorage.getItem('battleship.hostedLink')).not.toBeNull();

    // And the knock that follows is let in rather than refused as "game full".
    peer.incoming().accept();
    expect(session.state()).toBe('playing');
    expect(registry.markJoined).toHaveBeenCalled();
  });

  it('takes its number again when knocks are not reaching it', async () => {
    // Nothing errors when a host's broker socket dies quietly: the peer reads
    // as open and the number looks claimed. The registry is what gives it
    // away — player 2 heartbeats onto the link while they knock, so someone
    // demonstrably there and not one knock arriving means our registration is
    // the thing that is wrong.
    const peer = await hostAGame();
    const id = session.gameId();

    registry.joinerOnLink();
    await vi.advanceTimersByTimeAsync(25_000);

    const rebuilt = FakePeer.instances.at(-1)!;
    expect(rebuilt).not.toBe(peer);
    rebuilt.reachBroker();
    expect(session.state()).toBe('hosting');
    expect(session.gameId()).toBe(id); // the same number the link points at
  });

  it('leaves a working host alone while nobody is on the link', async () => {
    const peer = await hostAGame();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakePeer.instances.at(-1)).toBe(peer);
    expect(session.state()).toBe('hosting');
  });

  it('does not kill the host’s link when player 2 cancels a knock', async () => {
    // Cancel is not the in-game Leave button: the joiner never held this link,
    // and deleting the record left player 1 hosting a number that everyone
    // else — player 2 included, on their next try — reads as "game over".
    await openTheLink();
    session.leave();

    expect(registry.terminate).not.toHaveBeenCalled();
    expect(session.state()).toBe('lobby');
  });
});

describe('a host whose app was killed comes back to the same link', () => {
  let session: SessionServiceType;
  let registry: FakeRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    FakePeer.instances = [];
    localStorage.clear();
    registry = new FakeRegistry();
    TestBed.configureTestingModule({
      providers: [SessionService, { provide: LobbyRegistryService, useValue: registry }],
    });
    session = TestBed.inject(SessionService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Host a game, then throw the whole session away as a killed app would. */
  async function hostThenDie(): Promise<string> {
    session.newGame();
    await vi.waitFor(() => expect(FakePeer.instances.length).toBeGreaterThan(0));
    FakePeer.instances.at(-1)!.reachBroker();
    const id = session.gameId()!;
    // A cold boot: a brand-new service, with only localStorage carried over.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [SessionService, { provide: LobbyRegistryService, useValue: registry }],
    });
    session = TestBed.inject(SessionService);
    FakePeer.instances = [];
    return id;
  }

  it('re-takes the number it shared, so the invite still works', async () => {
    const id = await hostThenDie();
    expect(session.state()).toBe('lobby');

    await session.resumeHostedLink();
    await vi.waitFor(() => expect(FakePeer.instances.length).toBeGreaterThan(0));
    FakePeer.instances.at(-1)!.reachBroker();

    expect(session.state()).toBe('hosting');
    expect(session.gameId()).toBe(id); // the same number that is in the chat
    expect(registry.reclaimHost).toHaveBeenCalledWith(Number(id));
  });

  it('falls back to the lobby when the link has expired or paired up', async () => {
    await hostThenDie();
    registry.reclaimHost = vi.fn(async () => false);

    expect(await session.resumeHostedLink()).toBe(false);
    expect(session.state()).toBe('lobby');
    expect(session.gameId()).toBeNull();
  });

  it('re-hosts rather than dialling itself when player 1 opens their own link', async () => {
    const id = await hostThenDie();

    session.join(id); // tapped the invite link they sent
    await vi.waitFor(() => expect(FakePeer.instances.length).toBeGreaterThan(0));
    const peer = FakePeer.instances.at(-1)!;
    peer.reachBroker();

    expect(session.state()).toBe('hosting'); // not 'joining' — it is their game
    expect(peer.dials.length).toBe(0); // and nobody knocked on themselves
    expect(session.gameId()).toBe(id);
  });

  it('forgets a link the player deliberately left', async () => {
    session.newGame();
    await vi.waitFor(() => expect(FakePeer.instances.length).toBeGreaterThan(0));
    FakePeer.instances.at(-1)!.reachBroker();
    session.leave();

    expect(await session.resumeHostedLink()).toBe(false);
    expect(session.state()).toBe('lobby');
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
