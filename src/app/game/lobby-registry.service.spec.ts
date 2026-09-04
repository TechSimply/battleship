import { isPartyPresent, isSessionAlive, SessionRecord, toAction, toWire } from './lobby-registry.service';
import { GameAction } from './game.service';

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

  it('a game with two players in it survives a night away', () => {
    // Both parties gone (timestamps stale), but the board is on the server and
    // either of them can come back to it — so the link has to still be there.
    const overnight = rec({
      createdAt: now - 20 * 60 * MIN,
      hostAt: now - 8 * 60 * MIN,
      joinerAt: now - 8 * 60 * MIN,
      joined: true,
    });
    expect(isSessionAlive(overnight, now)).toBe(true);
    const expired = rec({
      createdAt: now - 30 * 60 * MIN,
      hostAt: now - 25 * 60 * MIN,
      joinerAt: now - 25 * 60 * MIN,
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
    // Created a day and a half ago, actively played until ~10s ago, then both
    // closed the app.
    const justLeft = rec({
      createdAt: now - 36 * 60 * MIN,
      hostAt: now - 10_000,
      joinerAt: now - 10_000,
      joined: true,
    });
    expect(isSessionAlive(justLeft, now)).toBe(true);

    // The same record if disconnect had nulled the slots: nothing left to date
    // the session by but createdAt, so a game played all afternoon reads as
    // long dead the moment both players close the app.
    const nulled = rec({
      createdAt: now - 36 * 60 * MIN,
      hostAt: null,
      joinerAt: null,
      joined: true,
    });
    expect(isSessionAlive(nulled, now)).toBe(false);
  });

  it('still expires once the TTL passes with nobody back', () => {
    const abandoned = rec({
      createdAt: now - 40 * 60 * MIN,
      hostAt: now - 26 * 60 * MIN,
      joinerAt: now - 26 * 60 * MIN,
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
 * The move log is the game, and anyone who knows a game number can write to
 * it — the database has no accounts. So what comes back off it is parsed, not
 * trusted: a junk record is skipped rather than fed to the rules engine.
 */
describe('toAction / toWire (the move log)', () => {
  const roundTrip = (a: GameAction) => toAction(toWire(a));

  it('carries every kind of action there and back', () => {
    const actions: GameAction[] = [
      { kind: 'place', player: 0, c: { x: 0, y: 0 } },
      { kind: 'fire', player: 1, c: { x: 3, y: 4 } },
      { kind: 'move', player: 1, c: { x: 2, y: 1 } },
      { kind: 'reset' },
    ];
    for (const a of actions) expect(roundTrip(a)).toEqual(a);
  });

  it('refuses anything that is not a move', () => {
    expect(toAction(null)).toBeNull();
    expect(toAction('place')).toBeNull();
    expect(toAction({})).toBeNull();
    expect(toAction({ k: 'explode', p: 0, x: 1, y: 1 })).toBeNull();
  });

  it('refuses a move that would land off the board', () => {
    expect(toAction({ k: 'fire', p: 0, x: 4, y: 0 })).toBeNull();
    expect(toAction({ k: 'fire', p: 0, x: 0, y: 5 })).toBeNull();
    expect(toAction({ k: 'fire', p: 0, x: -1, y: 0 })).toBeNull();
    expect(toAction({ k: 'fire', p: 0, x: 1.5, y: 0 })).toBeNull();
  });

  it('refuses a move from a player who does not exist', () => {
    expect(toAction({ k: 'fire', p: 2, x: 1, y: 1 })).toBeNull();
    expect(toAction({ k: 'fire', x: 1, y: 1 })).toBeNull();
  });
});
