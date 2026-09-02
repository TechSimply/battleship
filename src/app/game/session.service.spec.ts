import { actionInOrder, parseGameId, parseHostedLink, peerErrorAction } from './session.service';

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

describe('parseHostedLink (a killed app finding its way back to its link)', () => {
  const now = 1_000_000_000_000;
  const stored = (n: number, ageMs: number) => JSON.stringify({ n, at: now - ageMs });

  it('re-takes a number claimed moments ago', () => {
    expect(parseHostedLink(stored(1553, 10_000), now)).toBe(1553);
  });

  it('lets go of one older than any link can be (rule 9.2)', () => {
    expect(parseHostedLink(stored(1553, 6 * 60_000), now)).toBeNull();
  });

  it('ignores nothing stored, and anything that is not ours', () => {
    expect(parseHostedLink(null, now)).toBeNull();
    expect(parseHostedLink('not json', now)).toBeNull();
    expect(parseHostedLink('{}', now)).toBeNull();
    expect(parseHostedLink(JSON.stringify({ n: '1553', at: now }), now)).toBeNull();
    expect(parseHostedLink(JSON.stringify({ n: 1553 }), now)).toBeNull();
    expect(parseHostedLink(stored(0, 0), now)).toBeNull();
    expect(parseHostedLink(stored(99_999, 0), now)).toBeNull();
  });
});

describe('actionInOrder (apply each move once, in order)', () => {
  it('applies only the next action in sequence', () => {
    expect(actionInOrder(1, 0)).toBe(true); // first action
    expect(actionInOrder(5, 4)).toBe(true); // next in order
  });
  it('drops an action already applied', () => {
    expect(actionInOrder(4, 4)).toBe(false); // exact repeat
    expect(actionInOrder(2, 4)).toBe(false); // older repeat
  });
  it('drops one that skips ahead', () => {
    expect(actionInOrder(6, 4)).toBe(false);
  });
});

describe('peerErrorAction (a dropped broker socket is not a dead game)', () => {
  it('rides out broker trouble while there is still a way back', () => {
    // The host shares the invite link, the phone backgrounds the tab and the
    // broker socket goes with it. PeerJS reports that as an error first and a
    // disconnect second; treating the error as fatal used to end the game
    // (and destroy the peer, so the re-register loop never ran). `server-error`
    // is the same story on the broker's HTTP side — what a webview that has
    // just been unfrozen sees while its network comes back.
    const types = ['network', 'socket-closed', 'socket-error', 'disconnected', 'server-error'];
    for (const type of types) {
      expect(peerErrorAction(type, true, 'hosting')).toBe('recover');
      expect(peerErrorAction(type, true, 'joining')).toBe('recover');
      expect(peerErrorAction(type, true, 'playing')).toBe('recover');
    }
  });

  it('reports a connection that has run out of ways back', () => {
    // Never reached the broker and out of retries: the player really does need
    // to hear about their connection.
    expect(peerErrorAction('network', false, 'hosting')).toBe('fail');
    expect(peerErrorAction('socket-closed', false, 'joining')).toBe('fail');
    expect(peerErrorAction('server-error', false, 'joining')).toBe('fail');
  });

  it('keeps "no such game" separate from a connection problem', () => {
    expect(peerErrorAction('peer-unavailable', true, 'joining')).toBe('not-found');
    expect(peerErrorAction('peer-unavailable', false, 'joining')).toBe('not-found');
  });

  it('ignores a "no such peer" that lands after the join is over', () => {
    // The last knock's error can arrive after the registry has already ended
    // the join; letting it speak would replace the real reason with a stale one.
    expect(peerErrorAction('peer-unavailable', true, 'error')).toBe('ignore');
    expect(peerErrorAction('peer-unavailable', true, 'playing')).toBe('ignore');
  });

  it('fails on genuinely unrecoverable errors while setting a game up', () => {
    expect(peerErrorAction('browser-incompatible', true, 'hosting')).toBe('fail');
    expect(peerErrorAction('invalid-key', true, 'joining')).toBe('fail');
  });

  it('ignores anything else once a game is under way', () => {
    expect(peerErrorAction('webrtc', true, 'playing')).toBe('ignore');
    expect(peerErrorAction('browser-incompatible', true, 'lobby')).toBe('ignore');
  });
});
