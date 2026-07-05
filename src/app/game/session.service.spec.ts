import { parseGameId } from './session.service';

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
