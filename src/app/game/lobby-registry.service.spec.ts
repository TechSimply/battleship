import { isPartyPresent, isSessionAlive, SessionRecord } from './lobby-registry.service';

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

  it('never-paired link dies after the 2-minute unoccupied window', () => {
    const empty = rec({ createdAt: now - 3 * MIN, hostAt: now - 3 * MIN, joined: false });
    expect(isSessionAlive(empty, now)).toBe(false);
    const stillFresh = rec({ createdAt: now - 1 * MIN, hostAt: now - 1 * MIN, joined: false });
    expect(isSessionAlive(stillFresh, now)).toBe(true);
  });

  it('a paired link survives the longer 5-minute occupied window once empty', () => {
    // both parties gone (timestamps stale), but the game had paired up
    const paired = rec({ createdAt: now - 4 * MIN, hostAt: now - 4 * MIN, joinerAt: now - 4 * MIN, joined: true });
    expect(isSessionAlive(paired, now)).toBe(true);
    const expired = rec({ createdAt: now - 6 * MIN, hostAt: now - 6 * MIN, joinerAt: now - 6 * MIN, joined: true });
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
    // Created 30 min ago, actively played until ~10s ago, then both closed.
    const justLeft = rec({
      createdAt: now - 30 * MIN,
      hostAt: now - 10_000,
      joinerAt: now - 10_000,
      joined: true,
    });
    expect(isSessionAlive(justLeft, now)).toBe(true);

    // The same record if disconnect had nulled the slots: nothing left to date
    // the session by but createdAt, so a 30-minute-old game reads as long dead.
    const nulled = rec({ createdAt: now - 30 * MIN, hostAt: null, joinerAt: null, joined: true });
    expect(isSessionAlive(nulled, now)).toBe(false);
  });

  it('still expires once the TTL passes with nobody back', () => {
    const abandoned = rec({
      createdAt: now - 30 * MIN,
      hostAt: now - 6 * MIN,
      joinerAt: now - 6 * MIN,
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
