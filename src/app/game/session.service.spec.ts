import { parseGameId, parseSession } from './session.service';

describe('parseGameId', () => {
  it('accepts the shared id formats players will actually type', () => {
    expect(parseGameId('Battle1')).toBe(1);
    expect(parseGameId('battle 12')).toBe(12);
    expect(parseGameId('  BATTLE3 ')).toBe(3);
    expect(parseGameId('7')).toBe(7);
  });

  it('rejects everything else', () => {
    expect(parseGameId('')).toBeNull();
    expect(parseGameId('Battle')).toBeNull();
    expect(parseGameId('0')).toBeNull();
    expect(parseGameId('warship5')).toBeNull();
    expect(parseGameId('Battle1x')).toBeNull();
  });
});

describe('parseSession (coming back to the game you were in)', () => {
  const now = 1_000_000_000_000;
  const stored = (n: number, ageMs: number) => JSON.stringify({ n, at: now - ageMs });

  it('returns to a game played moments ago', () => {
    expect(parseSession(stored(1553, 10_000), now)).toBe(1553);
  });

  it('returns to one left hours ago — the board is still on the server', () => {
    expect(parseSession(stored(1553, 8 * 60 * 60_000), now)).toBe(1553);
  });

  it('lets go of one older than any link can be (rule 9.2)', () => {
    expect(parseSession(stored(1553, 25 * 60 * 60_000), now)).toBeNull();
  });

  it('ignores nothing stored, and anything that is not ours', () => {
    expect(parseSession(null, now)).toBeNull();
    expect(parseSession('not json', now)).toBeNull();
    expect(parseSession('{}', now)).toBeNull();
    expect(parseSession(JSON.stringify({ n: '1553', at: now }), now)).toBeNull();
    expect(parseSession(JSON.stringify({ n: 1553 }), now)).toBeNull();
    expect(parseSession(stored(0, 0), now)).toBeNull();
    expect(parseSession(stored(99_999, 0), now)).toBeNull();
  });
});
