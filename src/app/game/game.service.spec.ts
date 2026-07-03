import { TestBed } from '@angular/core/testing';
import { GameService } from './game.service';

describe('GameService', () => {
  let game: GameService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    game = TestBed.inject(GameService);
  });

  function placeBothShips(p1 = { x: 0, y: 0 }, p2 = { x: 4, y: 6 }) {
    game.handleCellClick(0, p1);
    game.handleCellClick(1, p2);
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
    expect(game.players()[1].ship).toEqual({ x: 4, y: 6 });
  });

  it('ends the game when a ship is hit (rule 6)', () => {
    placeBothShips();
    game.handleCellClick(1, { x: 4, y: 6 }); // direct hit
    expect(game.phase()).toBe('gameover');
    expect(game.winner()).toBe(0);
  });

  it('marks the bombed square unusable and exposes the shooter on a miss (rules 5.2, 5.3)', () => {
    placeBothShips();
    game.handleCellClick(1, { x: 2, y: 2 }); // miss
    expect(game.players()[1].destroyed[2 * 5 + 2]).toBe(true);
    expect(game.players()[0].exposedAt).toEqual({ x: 0, y: 0 });
    expect(game.phase()).toBe('move');
  });

  it('lets the shooter move to any of the 8 bordering squares (rule 3)', () => {
    placeBothShips({ x: 2, y: 3 }); // center-ish: all 8 neighbours in bounds
    game.handleCellClick(1, { x: 0, y: 0 }); // miss -> move phase
    expect(game.legalMoves(0)).toHaveLength(8);
    game.handleCellClick(0, { x: 3, y: 4 }); // diagonal move
    expect(game.players()[0].ship).toEqual({ x: 3, y: 4 });
    expect(game.currentPlayer()).toBe(1);
    expect(game.phase()).toBe('fire');
  });

  it('rejects a move onto a bombed square (rule 5.4 via 5.3)', () => {
    placeBothShips({ x: 2, y: 3 });
    // Player 1 misses; player 2 bombs a square next to player 1's ship.
    game.handleCellClick(1, { x: 0, y: 0 });
    game.handleCellClick(0, { x: 3, y: 4 }); // p1 moves to (3,4)
    game.handleCellClick(0, { x: 3, y: 3 }); // p2 fires at p1's board, misses
    game.handleCellClick(1, { x: 0, y: 6 }); // p2 moves
    // Now p1 fires and must move, but (3,3) is bombed.
    game.handleCellClick(1, { x: 0, y: 1 }); // miss -> move phase
    const before = game.players()[0].ship;
    game.handleCellClick(0, { x: 3, y: 3 }); // bombed square: rejected
    expect(game.players()[0].ship).toEqual(before);
    expect(game.phase()).toBe('move');
  });

  it('ignores firing at an already-bombed square', () => {
    placeBothShips();
    game.handleCellClick(1, { x: 2, y: 2 }); // p1 miss
    game.handleCellClick(0, { x: 1, y: 1 }); // p1 moves
    game.handleCellClick(0, { x: 4, y: 4 }); // p2 miss
    game.handleCellClick(1, { x: 3, y: 5 }); // p2 moves
    game.handleCellClick(1, { x: 2, y: 2 }); // p1 fires same square again
    expect(game.phase()).toBe('fire'); // nothing happened, still p1 to fire
    expect(game.currentPlayer()).toBe(0);
  });

  it('passes the turn when the shooter has no usable square to move to', () => {
    // Player 1 sits in the corner; player 2 bombs the three neighbouring
    // squares over several turns while player 1 shuffles between (0,0),
    // (0,1) and (1,1) as they get bombed one by one.
    placeBothShips({ x: 0, y: 0 });
    game.handleCellClick(1, { x: 0, y: 0 }); // p1 miss
    game.handleCellClick(0, { x: 0, y: 1 }); // p1 -> (0,1)
    game.handleCellClick(0, { x: 1, y: 0 }); // p2 bombs (1,0), miss
    game.handleCellClick(1, { x: 4, y: 5 }); // p2 -> (4,5)
    game.handleCellClick(1, { x: 0, y: 1 }); // p1 miss
    game.handleCellClick(0, { x: 0, y: 0 }); // p1 -> (0,0)
    game.handleCellClick(0, { x: 0, y: 1 }); // p2 bombs (0,1), miss
    game.handleCellClick(1, { x: 4, y: 6 }); // p2 -> (4,6)
    game.handleCellClick(1, { x: 0, y: 2 }); // p1 miss, only (1,1) left to move to
    expect(game.legalMoves(0)).toEqual([{ x: 1, y: 1 }]);
    game.handleCellClick(0, { x: 1, y: 1 }); // p1 -> (1,1), forced
    game.handleCellClick(0, { x: 4, y: 0 }); // p2 miss
    game.handleCellClick(1, { x: 4, y: 5 }); // p2 -> (4,5)
    game.handleCellClick(1, { x: 0, y: 3 }); // p1 miss
    game.handleCellClick(0, { x: 0, y: 0 }); // p1 -> (0,0)
    game.handleCellClick(0, { x: 1, y: 1 }); // p2 bombs (1,1), miss
    game.handleCellClick(1, { x: 4, y: 6 }); // p2 -> (4,6)

    // All three neighbours of (0,0) are now bombed: firing must auto-pass the turn.
    game.handleCellClick(1, { x: 0, y: 4 }); // p1 miss
    expect(game.players()[0].ship).toEqual({ x: 0, y: 0 });
    expect(game.currentPlayer()).toBe(1);
    expect(game.phase()).toBe('fire');
  });

  it('resets to a fresh game', () => {
    placeBothShips();
    game.handleCellClick(1, { x: 4, y: 6 });
    game.reset();
    expect(game.phase()).toBe('placement');
    expect(game.currentPlayer()).toBe(0);
    expect(game.players()[0].ship).toBeNull();
  });
});
