import { actionInOrder, parseGameId } from './session.service';
import { GameAction, GameService } from './game.service';

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

describe('actionInOrder (reconnect-replay guard)', () => {
  it('applies only the next action in sequence', () => {
    expect(actionInOrder(1, 0)).toBe(true); // first action
    expect(actionInOrder(5, 4)).toBe(true); // next in order
  });
  it('drops duplicates already applied', () => {
    expect(actionInOrder(4, 4)).toBe(false); // exact resend
    expect(actionInOrder(2, 4)).toBe(false); // older resend
  });
  it('drops out-of-order gaps (a resend brings them in order)', () => {
    expect(actionInOrder(6, 4)).toBe(false);
  });
});

/**
 * Reproduces the reported bug: a player closes the tab mid-game and returns.
 * A reload wipes that device's memory, so it must restore the persisted game
 * and reconnect through the resync — without double-applying the replayed
 * actions — or the two devices disagree about where a ship is and only one sees
 * the win. This models the two devices with the real primitives
 * (GameService.apply/snapshot/restore + actionInOrder) and the wire protocol.
 */
describe('reload mid-game keeps both devices in sync', () => {
  class Device {
    game = new GameService();
    private sentLog: GameAction[] = [];
    private appliedSeq = 0;

    /** Originate a local action: apply it and produce its numbered wire message. */
    send(action: GameAction): { seq: number; action: GameAction } {
      this.game.apply(action);
      this.sentLog.push(action);
      return { seq: this.sentLog.length, action };
    }
    /** Receive the opponent's numbered action, idempotently. */
    recv(msg: { seq: number; action: GameAction }): void {
      if (actionInOrder(msg.seq, this.appliedSeq)) {
        this.appliedSeq = msg.seq;
        this.game.apply(msg.action);
      }
    }
    /** Persisted blob (localStorage), as SessionService.persist() writes it. */
    persisted() {
      return { game: this.game.snapshot(), sentLog: [...this.sentLog], appliedSeq: this.appliedSeq };
    }
    /** On resume, resend our actions the peer hasn't applied yet. */
    resend(peerApplied: number): { seq: number; action: GameAction }[] {
      return this.sentLog
        .slice(peerApplied)
        .map((action, i) => ({ seq: peerApplied + i + 1, action }));
    }
    peerApplied(): number {
      return this.appliedSeq;
    }
    restore(blob: ReturnType<Device['persisted']>): void {
      this.game.restore(blob.game);
      this.sentLog = [...blob.sentLog];
      this.appliedSeq = blob.appliedSeq;
    }
  }

  /** Both devices apply an origination and its mirror. */
  function play(from: Device, to: Device, action: GameAction): void {
    to.recv(from.send(action));
  }

  it('the shooter still sees the win after reloading mid-game', () => {
    const a = new Device(); // player 0, host, fires first
    const b = new Device(); // player 1

    // Placement (rule 4) — each placement is mirrored to the other device.
    play(a, b, { kind: 'place', player: 0, c: { x: 0, y: 0 } });
    play(b, a, { kind: 'place', player: 1, c: { x: 3, y: 3 } });

    // Turn 0: A fires a miss, then must move (rule 5.4).
    play(a, b, { kind: 'fire', player: 0, c: { x: 3, y: 0 } });
    play(a, b, { kind: 'move', player: 0, c: { x: 1, y: 0 } });

    // Turn 1: B fires a miss, then moves its ship to (2,2).
    play(b, a, { kind: 'fire', player: 1, c: { x: 0, y: 0 } });
    play(b, a, { kind: 'move', player: 1, c: { x: 2, y: 2 } });

    // --- A closes the tab and reopens: memory wiped, restored from storage. ---
    const saved = a.persisted();
    const a2 = new Device();
    a2.restore(saved);

    // Reconnect resync: each side resends the tail the other is missing (nothing
    // here), and the dead connection redelivers B's last move as a duplicate.
    for (const m of b.resend(a2.peerApplied())) a2.recv(m);
    a2.recv({ seq: 3, action: { kind: 'move', player: 1, c: { x: 2, y: 2 } } }); // duplicate

    // A2 now fires on B's ship at (2,2) — must be a hit on BOTH devices.
    play(a2, b, { kind: 'fire', player: 0, c: { x: 2, y: 2 } });

    expect(a2.game.phase()).toBe('gameover');
    expect(b.game.phase()).toBe('gameover');
    expect(a2.game.winner()).toBe(0);
    expect(b.game.winner()).toBe(0);
    // Both agree the destroyed ship sat where it was shot.
    expect(a2.game.players()[1].shipDestroyed).toBe(true);
    expect(b.game.players()[1].shipDestroyed).toBe(true);
    expect(a2.game.players()[1].ship).toEqual(b.game.players()[1].ship);
  });
});
