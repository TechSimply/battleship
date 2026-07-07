import { TestBed } from '@angular/core/testing';
import { BOARD_W, Coord, GameService, PlayerId } from './game.service';

describe('GameService', () => {
  let game: GameService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    game = TestBed.inject(GameService);
  });

  /**
   * Tap `board` as whoever may legally act right now: the board owner during
   * placement, the current player otherwise (mirrors what each device sends).
   */
  function click(board: PlayerId, c: Coord) {
    const actor = game.phase() === 'placement' ? board : game.currentPlayer();
    return game.tryLocal(actor, board, c);
  }

  function placeBothShips(p1 = { x: 0, y: 0 }, p2 = { x: 3, y: 3 }) {
    click(0, p1);
    click(1, p2);
  }

  it('starts in placement with player 1', () => {
    expect(game.phase()).toBe('placement');
    expect(game.currentPlayer()).toBe(0);
  });

  it('moves to battle once both players placed their ship', () => {
    placeBothShips();
    expect(game.phase()).toBe('fire');
    expect(game.currentPlayer()).toBe(0);
    expect(game.players()[0].ship).toEqual({ x: 0, y: 0 });
    expect(game.players()[1].ship).toEqual({ x: 3, y: 3 });
  });

  it('lets players place in either order (simultaneous placement)', () => {
    click(1, { x: 2, y: 2 }); // player 2 places first
    expect(game.phase()).toBe('placement');
    click(0, { x: 0, y: 0 });
    expect(game.phase()).toBe('fire');
  });

  it('rejects placing a second ship for the same player', () => {
    click(0, { x: 0, y: 0 });
    expect(game.tryLocal(0, 0, { x: 1, y: 1 })).toBeNull();
    expect(game.players()[0].ship).toEqual({ x: 0, y: 0 });
  });

  it('rejects acting out of turn', () => {
    placeBothShips();
    // It's player 1's turn; player 2 may not fire.
    expect(game.tryLocal(1, 0, { x: 1, y: 1 })).toBeNull();
    expect(game.players()[0].destroyed.every((d) => !d)).toBe(true);
  });

  it('returns the applied action so it can be sent to the opponent', () => {
    click(0, { x: 0, y: 0 });
    const action = game.tryLocal(1, 1, { x: 3, y: 3 });
    expect(action).toEqual({ kind: 'place', player: 1, c: { x: 3, y: 3 } });
  });

  it('ends the game when a ship is hit (rule 6)', () => {
    placeBothShips();
    click(1, { x: 3, y: 3 }); // direct hit
    expect(game.phase()).toBe('gameover');
    expect(game.winner()).toBe(0);
  });

  it('marks the bombed square unusable and exposes the shooter on a miss (rules 5.2, 5.3)', () => {
    placeBothShips();
    click(1, { x: 1, y: 2 }); // miss
    expect(game.players()[1].destroyed[2 * BOARD_W + 1]).toBe(true);
    expect(game.players()[0].exposedAt).toEqual({ x: 0, y: 0 });
    expect(game.phase()).toBe('move');
  });

  it('lets the shooter move to any of the 8 bordering squares (rule 3)', () => {
    placeBothShips({ x: 1, y: 1 }); // interior square: all 8 neighbours in bounds
    click(1, { x: 0, y: 0 }); // miss -> move phase
    expect(game.legalMoves(0)).toHaveLength(8);
    click(0, { x: 2, y: 2 }); // diagonal move
    expect(game.players()[0].ship).toEqual({ x: 2, y: 2 });
    expect(game.currentPlayer()).toBe(1);
    expect(game.phase()).toBe('fire');
  });

  it('rejects a move onto a bombed square (rule 5.4 via 5.3)', () => {
    placeBothShips({ x: 1, y: 1 });
    click(1, { x: 0, y: 0 }); // p1 miss
    click(0, { x: 2, y: 2 }); // p1 moves to (2,2)
    click(0, { x: 2, y: 1 }); // p2 fires at p1's board, misses
    click(1, { x: 3, y: 2 }); // p2 moves
    // Now p1 fires and must move, but (2,1) is bombed.
    click(1, { x: 0, y: 1 }); // miss -> move phase
    const before = game.players()[0].ship;
    click(0, { x: 2, y: 1 }); // bombed square: rejected
    expect(game.players()[0].ship).toEqual(before);
    expect(game.phase()).toBe('move');
  });

  it('ignores firing at an already-bombed square', () => {
    placeBothShips();
    click(1, { x: 1, y: 2 }); // p1 miss
    click(0, { x: 1, y: 1 }); // p1 moves
    click(0, { x: 3, y: 0 }); // p2 miss
    click(1, { x: 2, y: 3 }); // p2 moves
    click(1, { x: 1, y: 2 }); // p1 fires same square again
    expect(game.phase()).toBe('fire'); // nothing happened, still p1 to fire
    expect(game.currentPlayer()).toBe(0);
  });

  it('passes the turn when the shooter has no usable square to move to', () => {
    // Player 1 sits in the corner; player 2 bombs the three neighbouring
    // squares over several turns while player 1 shuffles between (0,0),
    // (0,1) and (1,1) as they get bombed one by one.
    placeBothShips({ x: 0, y: 0 });
    click(1, { x: 0, y: 0 }); // p1 miss
    click(0, { x: 0, y: 1 }); // p1 -> (0,1)
    click(0, { x: 1, y: 0 }); // p2 bombs (1,0), miss
    click(1, { x: 3, y: 2 }); // p2 -> (3,2)
    click(1, { x: 0, y: 1 }); // p1 miss
    click(0, { x: 0, y: 0 }); // p1 -> (0,0)
    click(0, { x: 0, y: 1 }); // p2 bombs (0,1), miss
    click(1, { x: 3, y: 3 }); // p2 -> (3,3)
    click(1, { x: 0, y: 2 }); // p1 miss, only (1,1) left to move to
    expect(game.legalMoves(0)).toEqual([{ x: 1, y: 1 }]);
    click(0, { x: 1, y: 1 }); // p1 -> (1,1), forced
    click(0, { x: 3, y: 0 }); // p2 miss
    click(1, { x: 3, y: 2 }); // p2 -> (3,2)
    click(1, { x: 0, y: 3 }); // p1 miss
    click(0, { x: 0, y: 0 }); // p1 -> (0,0)
    click(0, { x: 1, y: 1 }); // p2 bombs (1,1), miss
    click(1, { x: 3, y: 3 }); // p2 -> (3,3)

    // All three neighbours of (0,0) are now bombed: firing must auto-pass the turn.
    click(1, { x: 1, y: 0 }); // p1 miss
    expect(game.players()[0].ship).toEqual({ x: 0, y: 0 });
    expect(game.currentPlayer()).toBe(1);
    expect(game.phase()).toBe('fire');
  });

  it('has no exposed square yet, so every square is a possible ship location', () => {
    placeBothShips();
    expect(game.possibleShipSquares(0)).toHaveLength(16);
  });

  it('narrows possible ship squares to the bordering squares after a forced move, excluding bombed ones', () => {
    placeBothShips({ x: 1, y: 1 });
    click(1, { x: 0, y: 0 }); // p1 miss -> player 0 exposed at (1,1)
    click(0, { x: 2, y: 2 }); // player 0 moves to (2,2)
    click(0, { x: 2, y: 1 }); // player 1 bombs (2,1) on player 0's board, miss
    click(1, { x: 3, y: 2 }); // player 1 moves
    click(1, { x: 0, y: 1 }); // player 0 fires again, re-exposed at (2,2); miss
    click(0, { x: 3, y: 3 }); // player 0 forced to move
    expect(game.currentPlayer()).toBe(1);

    // The ship is now at one of (2,2)'s 8 neighbours, minus the bombed (2,1).
    const candidates = game.possibleShipSquares(0);
    expect(candidates).toHaveLength(7);
    expect(candidates).not.toContainEqual({ x: 2, y: 1 });
    expect(candidates).toContainEqual({ x: 3, y: 3 }); // where it actually went
  });

  it('pins the possible ship square to where it was exposed when it had no legal move', () => {
    // Same corner-trap sequence as the "passes the turn" test above: all
    // three neighbours of (0,0) end up bombed, so the ship never moved.
    placeBothShips({ x: 0, y: 0 });
    click(1, { x: 0, y: 0 });
    click(0, { x: 0, y: 1 });
    click(0, { x: 1, y: 0 });
    click(1, { x: 3, y: 2 });
    click(1, { x: 0, y: 1 });
    click(0, { x: 0, y: 0 });
    click(0, { x: 0, y: 1 });
    click(1, { x: 3, y: 3 });
    click(1, { x: 0, y: 2 });
    click(0, { x: 1, y: 1 });
    click(0, { x: 3, y: 0 });
    click(1, { x: 3, y: 2 });
    click(1, { x: 0, y: 3 });
    click(0, { x: 0, y: 0 });
    click(0, { x: 1, y: 1 });
    click(1, { x: 3, y: 3 });
    click(1, { x: 1, y: 0 }); // p1 miss, no legal move left -> auto-pass

    expect(game.currentPlayer()).toBe(1);
    expect(game.possibleShipSquares(0)).toEqual([{ x: 0, y: 0 }]);
  });

  it('applies actions received from the opponent identically', () => {
    // What the joiner's device does with the host's mirrored actions.
    game.apply({ kind: 'place', player: 0, c: { x: 0, y: 0 } });
    game.apply({ kind: 'place', player: 1, c: { x: 3, y: 3 } });
    game.apply({ kind: 'fire', player: 0, c: { x: 3, y: 3 } });
    expect(game.phase()).toBe('gameover');
    expect(game.winner()).toBe(0);
  });

  it('scores one point for the winner and keeps it across a rematch (rule 8)', () => {
    placeBothShips();
    click(1, { x: 3, y: 3 }); // player 1 hits player 2
    expect(game.scores()).toEqual([1, 0]);

    game.apply({ kind: 'reset' }); // "play again" keeps the score
    expect(game.scores()).toEqual([1, 0]);

    placeBothShips({ x: 1, y: 1 }, { x: 2, y: 2 });
    click(1, { x: 0, y: 0 }); // player 1 fires at enemy waters, misses
    click(0, { x: 0, y: 0 }); // player 1 (exposed) moves onto (0,0)
    click(0, { x: 0, y: 0 }); // player 2 fires at (0,0) and sinks player 1
    expect(game.scores()).toEqual([1, 1]);
  });

  it('clears the score for a fresh session', () => {
    placeBothShips();
    click(1, { x: 3, y: 3 });
    expect(game.scores()).toEqual([1, 0]);
    game.resetScores();
    expect(game.scores()).toEqual([0, 0]);
  });

  it('resets to a fresh game', () => {
    placeBothShips();
    click(1, { x: 3, y: 3 });
    game.apply({ kind: 'reset' });
    expect(game.phase()).toBe('placement');
    expect(game.currentPlayer()).toBe(0);
    expect(game.players()[0].ship).toBeNull();
  });
});
