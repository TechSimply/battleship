import { actionInOrder, parseGameId, peerErrorAction } from './session.service';

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

  it('fails on genuinely unrecoverable errors while setting a game up', () => {
    expect(peerErrorAction('browser-incompatible', true, 'hosting')).toBe('fail');
    expect(peerErrorAction('invalid-key', true, 'joining')).toBe('fail');
  });

  it('ignores anything else once a game is under way', () => {
    expect(peerErrorAction('webrtc', true, 'playing')).toBe('ignore');
    expect(peerErrorAction('browser-incompatible', true, 'lobby')).toBe('ignore');
  });
});
