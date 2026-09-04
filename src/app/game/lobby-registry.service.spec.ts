import {
  isPartyPresent,
  isSessionAlive,
  roundId,
  SessionRecord,
  toAction,
} from './lobby-registry.service';
import { Coord } from './game.service';

/** Rule 9.2 link lifetimes, mirrored from the service for readable tests. */
const MIN = 60_000;
const now = 1_000_000_000_000;

function rec(partial: Partial<SessionRecord>): SessionRecord {
  return { createdAt: now, hostAt: null, joinerAt: null, joined: false, terminated: false, ...partial };
}

describe('isSessionAlive (rule 9 link liveness)', () => {
  it('a fresh host-only link is alive', () => {
    expect(isSessionAlive(rec({ hostAt: now }), now)).toBe(true);
  });

  it('a terminated link is dead forever, even with fresh presence', () => {
    expect(isSessionAlive(rec({ hostAt: now, terminated: true }), now)).toBe(false);
  });

  it('a missing session is dead', () => {
    expect(isSessionAlive(null, now)).toBe(false);
  });

  it('while anyone is present the link stays alive regardless of age', () => {
    // created long ago but the joiner beat recently → still on the link
    expect(isSessionAlive(rec({ createdAt: now - 60 * MIN, joinerAt: now }), now)).toBe(true);
  });

  it('a link nobody joined is recycled after its short window', () => {
    const empty = rec({ createdAt: now - 12 * MIN, hostAt: now - 12 * MIN, joined: false });
    expect(isSessionAlive(empty, now)).toBe(false);
    const stillFresh = rec({ createdAt: now - 5 * MIN, hostAt: now - 5 * MIN, joined: false });
    expect(isSessionAlive(stillFresh, now)).toBe(true);
  });

  it('a game with two players in it survives an evening away', () => {
    // Both parties gone (timestamps stale), but the board is on the server and
    // either of them can come back to it — so the link has to still be there.
    const evening = rec({
      createdAt: now - 5 * 60 * MIN,
      hostAt: now - 2 * 60 * MIN,
      joinerAt: now - 2 * 60 * MIN,
      joined: true,
    });
    expect(isSessionAlive(evening, now)).toBe(true);
    const expired = rec({
      createdAt: now - 8 * 60 * MIN,
      hostAt: now - 4 * 60 * MIN,
      joinerAt: now - 4 * 60 * MIN,
      joined: true,
    });
    expect(isSessionAlive(expired, now)).toBe(false);
  });
});

/**
 * Why presence timestamps are left behind instead of nulled on disconnect.
 * TTL is measured from the newest timestamp on the record, so if closing the
 * app nulled a party's slot, a long game would fall back to `createdAt` and be
 * judged dead the instant both players left — the reopen could never reclaim
 * it. Keeping the last heartbeat makes the TTL run from when they were last
 * active, which is what rule 9.2 actually describes.
 */
describe('a closed game stays reclaimable for its TTL', () => {
  it('is still alive right after both players leave a long game', () => {
    // Created hours ago, actively played until ~10s ago, then both closed
    // the app.
    const justLeft = rec({
      createdAt: now - 5 * 60 * MIN,
      hostAt: now - 10_000,
      joinerAt: now - 10_000,
      joined: true,
    });
    expect(isSessionAlive(justLeft, now)).toBe(true);

    // The same record if disconnect had nulled the slots: nothing left to date
    // the session by but createdAt, so a game played all afternoon reads as
    // long dead the moment both players close the app.
    const nulled = rec({
      createdAt: now - 5 * 60 * MIN,
      hostAt: null,
      joinerAt: null,
      joined: true,
    });
    expect(isSessionAlive(nulled, now)).toBe(false);
  });

  it('still expires once the TTL passes with nobody back', () => {
    const abandoned = rec({
      createdAt: now - 9 * 60 * MIN,
      hostAt: now - 4 * 60 * MIN,
      joinerAt: now - 4 * 60 * MIN,
      joined: true,
    });
    expect(isSessionAlive(abandoned, now)).toBe(false);
  });
});

describe('isPartyPresent (opponent-left signal)', () => {
  it('a fresh heartbeat reads as present', () => {
    expect(isPartyPresent(rec({ joinerAt: now }), 'joiner', now)).toBe(true);
    expect(isPartyPresent(rec({ hostAt: now }), 'host', now)).toBe(true);
  });

  it('a nulled slot (app closed / onDisconnect) reads as absent', () => {
    expect(isPartyPresent(rec({ joinerAt: null }), 'joiner', now)).toBe(false);
  });

  it('a stale heartbeat (no beat for a while) reads as absent', () => {
    expect(isPartyPresent(rec({ joinerAt: now - 2 * MIN }), 'joiner', now)).toBe(false);
  });

  it('a terminated link makes everyone absent', () => {
    expect(isPartyPresent(rec({ hostAt: now, terminated: true }), 'host', now)).toBe(false);
  });

  it('a missing record reads as absent', () => {
    expect(isPartyPresent(null, 'host', now)).toBe(false);
  });
});

/**
 * The log is the game, and what comes back off it is parsed rather than
 * trusted: a junk entry is skipped instead of being fed to the rules engine.
 * Note what is *not* in an entry — a `place` or a `move` never carries a
 * square. That is the anti-cheat: where a ship went is between its owner and
 * the database, and `own` is how this device gets its own squares back.
 */
describe('toAction (the log)', () => {
  const mine = (c: Coord | null) => () => c;
  const nobody = () => null;

  it('reads a placement without giving the square away', () => {
    const raw = { p: 1, k: 'place', r: 'r', e: 0, ram: false };
    expect(toAction(raw, nobody)).toEqual({ kind: 'place', player: 1, c: null, ram: false });
    // …unless it is our own, which we can fill in from our own secret.
    expect(toAction(raw, mine({ x: 2, y: 3 }))).toEqual({
      kind: 'place',
      player: 1,
      c: { x: 2, y: 3 },
      ram: false,
    });
  });

  it('reads a move the same way, and a ram with the square both wrecks share', () => {
    expect(toAction({ p: 0, k: 'move', r: 'r', e: 4, oe: 3, ram: false }, nobody)).toEqual({
      kind: 'move',
      player: 0,
      c: null,
      ram: false,
    });
    expect(
      toAction({ p: 0, k: 'move', r: 'r', e: 4, oe: 3, ram: true, x: 1, y: 1 }, nobody),
    ).toEqual({ kind: 'move', player: 0, c: { x: 1, y: 1 }, ram: true });
  });

  it('reads a shot with both of its squares and the answer to it', () => {
    expect(
      toAction({ p: 0, k: 'fire', r: 'r', e: 1, te: 1, x: 3, y: 4, fx: 0, fy: 0, hit: true }, nobody),
    ).toEqual({
      kind: 'fire',
      player: 0,
      from: { x: 0, y: 0 },
      to: { x: 3, y: 4 },
      hit: true,
    });
  });

  it('reads the skipped move, the reveal and the rematch', () => {
    expect(toAction({ p: 1, k: 'stay', r: 'r', e: 2 }, nobody)).toEqual({
      kind: 'stay',
      player: 1,
    });
    expect(toAction({ p: 1, k: 'reveal', r: 'r', e: 2, x: 0, y: 1 }, nobody)).toEqual({
      kind: 'reveal',
      player: 1,
      c: { x: 0, y: 1 },
    });
    expect(toAction({ p: 0, k: 'reset', r: 'r' }, nobody)).toEqual({ kind: 'reset' });
  });

  it('refuses anything that is not an entry', () => {
    expect(toAction(null, nobody)).toBeNull();
    expect(toAction('place', nobody)).toBeNull();
    expect(toAction({}, nobody)).toBeNull();
    expect(toAction({ k: 'explode', p: 0, r: 'r', e: 0 }, nobody)).toBeNull();
    expect(toAction({ k: 'place', p: 0, e: 0, ram: false }, nobody)).toBeNull(); // no round
  });

  it('refuses a square that would land off the board', () => {
    const fire = (x: number, y: number) =>
      toAction({ p: 0, k: 'fire', r: 'r', e: 0, te: 0, x, y, fx: 0, fy: 0, hit: false }, nobody);
    expect(fire(4, 0)).toBeNull();
    expect(fire(0, 5)).toBeNull();
    expect(fire(-1, 0)).toBeNull();
    expect(fire(1.5, 0)).toBeNull();
  });

  it('refuses an entry from a player who does not exist', () => {
    expect(toAction({ p: 2, k: 'stay', r: 'r', e: 0 }, nobody)).toBeNull();
    expect(toAction({ k: 'stay', r: 'r', e: 0 }, nobody)).toBeNull();
  });

  it('refuses an answer it cannot check: a ram with nowhere to draw the wrecks', () => {
    expect(toAction({ p: 0, k: 'move', r: 'r', e: 1, oe: 0, ram: true }, nobody)).toBeNull();
    expect(toAction({ p: 0, k: 'move', r: 'r', e: 1, oe: 0 }, nobody)).toBeNull();
  });
});

describe('roundId', () => {
  it('names a round by the session it belongs to and the reset that opened it', () => {
    // A recycled game number never lands on the last game's secrets, and a
    // rematch starts a namespace of its own.
    expect(roundId(1700000000000)).toBe('1700000000000_0');
    expect(roundId(1700000000000, 'k0007')).toBe('1700000000000_k0007');
  });
});
