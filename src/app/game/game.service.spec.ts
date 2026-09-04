import { TestBed } from '@angular/core/testing';
import { BOARD_H, BOARD_W, Coord, GameService, PlayerId } from './game.service';

/**
 * These run one `GameService` the way a real device runs it: as *one* player's
 * board. Since ship positions moved into the database, this device is told its
 * own square and never the enemy's, so the spec keeps both itself and hands the
 * reducer exactly what the log would carry — including the two answers the
 * database settles on a client's behalf, `hit` and `ram`.
 *
 * `VIEW` is whose device this is. Everything the enemy does arrives without a
 * square, which is the property most of these tests are really about.
 */
describe('GameService', () => {
  let game: GameService;
  const VIEW: PlayerId = 0;

  /** The referee's private copy: what the database knows and nobody else does. */
  let ships: [Coord | null, Coord | null];

  beforeEach(() => {
    TestBed.configureTestingModule({});
    game = TestBed.inject(GameService);
    ships = [null, null];
  });

  const foe = (p: PlayerId): PlayerId => (p === 0 ? 1 : 0);
  const at = (a: Coord | null, b: Coord) => !!a && a.x === b.x && a.y === b.y;
  /** The database's answer to "is that square occupied?" (rules 6.2 and 11). */
  const strikes = (p: PlayerId, c: Coord) => at(ships[p], c);
  /** What the rules would let that ship sail to (rule 3 minus rule 5.3). */
  const movesFor = (p: PlayerId) => (ships[p] ? game.neighborsOf(ships[p]!) : []);

  function place(p: PlayerId, c: Coord) {
    const ram = strikes(foe(p), c);
    ships[p] = c;
    game.apply({ kind: 'place', player: p, c: p === VIEW || ram ? c : null, ram });
  }

  function fire(p: PlayerId, to: Coord) {
    game.apply({ kind: 'fire', player: p, from: ships[p]!, to, hit: strikes(foe(p), to) });
    // Rule 5.4: a boxed-in shooter says so instead of moving.
    if (game.phase() === 'move' && !movesFor(p).length) game.apply({ kind: 'stay', player: p });
  }

  function move(p: PlayerId, c: Coord) {
    const ram = strikes(foe(p), c);
    ships[p] = c;
    game.apply({ kind: 'move', player: p, c: p === VIEW || ram ? c : null, ram });
  }

  function placeBothShips(p1 = { x: 0, y: 0 }, p2 = { x: 3, y: 3 }) {
    place(0, p1);
    place(1, p2);
  }

  function allSquares(): Coord[] {
    const all: Coord[] = [];
    for (let y = 0; y < BOARD_H; y++) for (let x = 0; x < BOARD_W; x++) all.push({ x, y });
    return all;
  }

  /** A still usable square that neither ship is standing on. */
  function emptySquare(): Coord {
    const destroyed = game.destroyed();
    return allSquares().find(
      (c) => !destroyed[c.y * BOARD_W + c.x] && !ships.some((s) => at(s, c)),
    )!;
  }

  /**
   * Play one whole turn for `player` without hitting or ramming anybody: fire
   * at a square neither ship is on, then take a move that misses the other
   * ship. Used by the burn-down tests, where the point is the fire (rule 6.3).
   */
  function playSafeTurn(player: PlayerId) {
    fire(player, emptySquare());
    if (game.phase() === 'move') {
      move(player, movesFor(player).find((m) => !strikes(foe(player), m))!);
    }
  }

  /**
   * Wreck `shooter`'s enemy the short way: a hit puts them on 50% (rule 6.2)
   * and a second one finishes them (rule 6.5). Between the two the other
   * player takes an ordinary, harmless turn.
   */
  function sink(shooter: PlayerId) {
    const enemy = foe(shooter);
    fire(shooter, ships[enemy]!);
    if (game.phase() === 'move') {
      move(shooter, movesFor(shooter).find((m) => !strikes(enemy, m))!);
    }
    playSafeTurn(enemy);
    fire(shooter, ships[enemy]!);
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
    expect(game.bothPlaced()).toBe(true);
  });

  it('lets players place in either order (simultaneous placement)', () => {
    place(1, { x: 2, y: 2 }); // player 2 places first
    expect(game.phase()).toBe('placement');
    place(0, { x: 0, y: 0 });
    expect(game.phase()).toBe('fire');
  });

  it('rejects placing a second ship for the same player', () => {
    place(0, { x: 0, y: 0 });
    expect(game.intent(0, { x: 1, y: 1 })).toBeNull();
    expect(game.players()[0].ship).toEqual({ x: 0, y: 0 });
  });

  it('rejects acting out of turn', () => {
    placeBothShips();
    // It's player 1's turn; player 2 may not fire.
    expect(game.intent(1, { x: 1, y: 1 })).toBeNull();
    expect(game.destroyed().every((d) => !d)).toBe(true);
  });

  it('reads a tap as the action it would be', () => {
    expect(game.intent(0, { x: 0, y: 0 })).toBe('place');
    placeBothShips();
    expect(game.intent(0, { x: 2, y: 2 })).toBe('fire');
  });

  // --- Hidden ships --------------------------------------------------------

  it('never learns where the enemy ship is', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 3, y: 3 });
    expect(game.players()[1].placed).toBe(true);
    expect(game.players()[1].ship).toBeNull();

    fire(0, { x: 2, y: 2 }); // miss
    move(0, { x: 1, y: 1 });
    fire(1, { x: 0, y: 3 }); // rule 5.2: firing gives their own square away
    expect(game.players()[1].ship).toEqual({ x: 3, y: 3 });
    move(1, { x: 2, y: 3 }); // …and sailing takes it back again
    expect(game.players()[1].ship).toBeNull();
    expect(game.players()[1].exposedAt).toEqual({ x: 3, y: 3 });
  });

  it('shows the struck hull on a hit, and only until it sails (rule 6.2.1)', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 2, y: 2 });
    fire(0, { x: 2, y: 2 });
    expect(game.players()[1].ship).toEqual({ x: 2, y: 2 });
    expect(game.players()[1].health).toBe(50);
    move(0, { x: 1, y: 0 });
    playSafeTurn(1);
    expect(game.players()[1].ship).toBeNull();
  });

  it('counts epochs, so a shot can name the position it was aimed at', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 3, y: 3 });
    expect(game.players().map((p) => p.epoch)).toEqual([0, 0]);
    playSafeTurn(0);
    expect(game.players().map((p) => p.epoch)).toEqual([1, 0]);
    playSafeTurn(1);
    expect(game.players().map((p) => p.epoch)).toEqual([1, 1]);
  });

  // --- Rule 2.3: one united board -----------------------------------------

  it('bombs one shared board, so a crater is dead for both ships (rules 2.3, 5.3)', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 3, y: 3 });
    fire(0, { x: 2, y: 2 }); // player 1 fires, misses
    expect(game.destroyed()[2 * BOARD_W + 2]).toBe(true);
    // The crater is off limits to the ship that made it as well.
    expect(game.legalMoves(0)).not.toContainEqual({ x: 2, y: 2 });
    move(0, { x: 1, y: 1 });
    expect(game.neighborsOf({ x: 1, y: 1 })).not.toContainEqual({ x: 2, y: 2 });
  });

  it('refuses to fire at the square your own ship is on', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 3, y: 3 });
    expect(game.intent(0, { x: 0, y: 0 })).toBeNull();
    expect(game.phase()).toBe('fire');
  });

  it('marks the bombed square unusable and exposes the shooter on a miss (rules 5.2, 5.3)', () => {
    placeBothShips();
    fire(0, { x: 1, y: 2 }); // miss
    expect(game.destroyed()[2 * BOARD_W + 1]).toBe(true);
    expect(game.players()[0].exposedAt).toEqual({ x: 0, y: 0 });
    expect(game.phase()).toBe('move');
  });

  it('lets the shooter move to any of the 8 bordering squares (rule 3)', () => {
    placeBothShips({ x: 1, y: 1 }, { x: 3, y: 3 }); // interior square
    fire(0, { x: 0, y: 0 }); // miss -> move phase
    expect(game.legalMoves(0)).toHaveLength(7); // (0,0) was just bombed
    move(0, { x: 2, y: 2 }); // diagonal move
    expect(game.players()[0].ship).toEqual({ x: 2, y: 2 });
    expect(game.currentPlayer()).toBe(1);
    expect(game.phase()).toBe('fire');
  });

  it('rejects a move onto a bombed square (rule 5.4 via 5.3)', () => {
    placeBothShips({ x: 1, y: 1 }, { x: 3, y: 0 });
    fire(0, { x: 2, y: 2 }); // p1 fires at (2,2), miss -> move phase
    expect(game.intent(0, { x: 2, y: 2 })).toBeNull();
    expect(game.phase()).toBe('move');
  });

  it('passes the turn when the shooter is boxed in (rule 5.4)', () => {
    // A corner ship with all three of its neighbours bombed has nowhere to go.
    placeBothShips({ x: 0, y: 0 }, { x: 3, y: 4 });
    for (const c of [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]) {
      game.destroyed.update((d) => {
        const next = [...d];
        next[c.y * BOARD_W + c.x] = true;
        return next;
      });
    }
    fire(0, { x: 2, y: 2 }); // fires, and stays put
    expect(game.players()[0].ship).toEqual({ x: 0, y: 0 });
    expect(game.phase()).toBe('fire');
    expect(game.currentPlayer()).toBe(1);
  });

  it('ignores firing at an already-bombed square', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 3, y: 3 });
    fire(0, { x: 1, y: 2 }); // p1 miss
    move(0, { x: 1, y: 1 });
    fire(1, { x: 3, y: 0 }); // p2 miss
    move(1, { x: 2, y: 3 });
    expect(game.intent(0, { x: 1, y: 2 })).toBeNull(); // the same crater again
    expect(game.phase()).toBe('fire');
    expect(game.currentPlayer()).toBe(0);
  });

  // --- Rule 6: health ------------------------------------------------------

  it('starts both ships at full health (rule 6.1)', () => {
    expect(game.players().map((p) => p.health)).toEqual([100, 100]);
    placeBothShips();
    expect(game.players().map((p) => p.health)).toEqual([100, 100]);
  });

  it('sets a hit ship on fire at 50% instead of sinking it (rule 6.2)', () => {
    placeBothShips();
    fire(0, { x: 3, y: 3 }); // direct hit
    expect(game.players()[1].health).toBe(50);
    expect(game.players()[1].shipDestroyed).toBe(false);
    expect(game.phase()).toBe('move'); // the shooter still has to move (rule 5.4)
    expect(game.winner()).toBeNull();
  });

  it('burns 10% off a hit ship with every move it makes (rule 6.3)', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 2, y: 2 });
    fire(0, { x: 2, y: 2 }); // p1 hits p2 -> 50%
    move(0, { x: 1, y: 0 }); // p1 must move
    expect(game.players()[1].health).toBe(50); // the fire costs p2, not p1

    playSafeTurn(1); // p2 fires and moves while burning
    expect(game.players()[1].health).toBe(40);
    expect(game.players()[0].health).toBe(100); // p1 was never hit
  });

  it('wrecks a burning ship once its health reaches 0% (rule 6.6)', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 2, y: 2 });
    fire(0, { x: 2, y: 2 }); // p1 hits p2 -> 50%
    move(0, { x: 1, y: 0 });

    // From here neither side lands another hit — p2 simply burns down 10% per
    // move until there is nothing left: 40, 30, 20, 10, 0.
    const burnt: number[] = [];
    for (let turn = 0; turn < 6 && game.phase() !== 'gameover'; turn++) {
      playSafeTurn(1);
      burnt.push(game.players()[1].health);
      if (game.phase() === 'gameover') break;
      playSafeTurn(0);
    }

    expect(burnt).toEqual([40, 30, 20, 10, 0]);
    expect(game.players()[0].health).toBe(100); // p1 was never hit
    expect(game.players()[1].shipDestroyed).toBe(true);
    expect(game.phase()).toBe('gameover');
    expect(game.winner()).toBe(0); // the ship that was never hit wins
  });

  it('shows the wreck of a ship that burned out, once its owner says where it is', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 2, y: 2 });
    fire(0, { x: 2, y: 2 });
    move(0, { x: 1, y: 0 });
    while (game.phase() !== 'gameover') {
      playSafeTurn(1);
      if (game.phase() !== 'gameover') playSafeTurn(0);
    }
    // It burned out somewhere this device was never told about…
    expect(game.players()[1].ship).toBeNull();
    // …so the round ends with each player showing their own square.
    game.apply({ kind: 'reveal', player: 1, c: ships[1]! });
    expect(game.players()[1].ship).toEqual(ships[1]);
  });

  it('finishes a burning ship outright on a second hit (rule 6.5)', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 2, y: 2 });
    fire(0, { x: 2, y: 2 }); // hit -> 50%
    move(0, { x: 1, y: 0 });
    playSafeTurn(1); // p2 fires and moves -> 40%
    fire(0, ships[1]!); // p1 hits the burning ship again
    expect(game.players()[1].health).toBe(0);
    expect(game.phase()).toBe('gameover');
    expect(game.winner()).toBe(0);
  });

  // --- Rule 11: ramming ----------------------------------------------------

  it('wrecks both ships and scores nothing when one sails into the other (rule 11)', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 1, y: 1 });
    fire(0, { x: 3, y: 3 }); // p1 fires far away, miss -> move phase
    expect(game.legalMoves(0)).toContainEqual({ x: 1, y: 1 }); // ramming is legal
    move(0, { x: 1, y: 1 }); // p1 sails into p2

    expect(game.players().map((p) => p.shipDestroyed)).toEqual([true, true]);
    expect(game.players().map((p) => p.health)).toEqual([0, 0]);
    expect(game.phase()).toBe('gameover');
    expect(game.winner()).toBeNull();
    expect(game.rammed()).toBe(true);
    expect(game.scores()).toEqual([0, 0]); // rule 11.2: no point for anyone
    // Rule 11.3: both wrecks end up on the one square.
    expect(game.players()[0].ship).toEqual({ x: 1, y: 1 });
    expect(game.players()[1].ship).toEqual({ x: 1, y: 1 });
  });

  it('does not let a ship on its last 10% lose by ramming (rule 11.4)', () => {
    // A scripted chase: player 1 hits player 2 and then shadows it while the
    // fire eats 10% per move, so player 2 arrives at 10% right beside player 1.
    placeBothShips({ x: 1, y: 1 }, { x: 2, y: 2 });
    fire(0, { x: 2, y: 2 }); // p1 hits p2 -> 50%
    move(0, { x: 2, y: 1 }); // p1 moves next to it

    const turn = (player: PlayerId, shot: Coord, to: Coord) => {
      fire(player, shot);
      move(player, to);
    };
    turn(1, { x: 0, y: 0 }, { x: 3, y: 2 }); // p2 -> 40%
    turn(0, { x: 1, y: 0 }, { x: 3, y: 1 });
    turn(1, { x: 2, y: 0 }, { x: 2, y: 3 }); // p2 -> 30%
    turn(0, { x: 0, y: 1 }, { x: 3, y: 2 });
    turn(1, { x: 0, y: 2 }, { x: 3, y: 3 }); // p2 -> 20%
    turn(0, { x: 0, y: 3 }, { x: 2, y: 3 });
    turn(1, { x: 1, y: 3 }, { x: 3, y: 2 }); // p2 -> 10%
    turn(0, { x: 1, y: 2 }, { x: 3, y: 3 });

    expect(game.players()[1].health).toBe(10);
    expect(game.phase()).toBe('fire');
    expect(game.currentPlayer()).toBe(1);

    // p2's next move would burn it to 0% — instead it rams, so the round is a
    // draw and its owner does not lose on that last step.
    fire(1, { x: 3, y: 0 });
    move(1, ships[0]!);

    expect(game.rammed()).toBe(true);
    expect(game.winner()).toBeNull();
    expect(game.scores()).toEqual([0, 0]);
  });

  it('treats placing both ships on the same square as a ram (rules 4, 11)', () => {
    placeBothShips({ x: 2, y: 1 }, { x: 2, y: 1 });
    expect(game.phase()).toBe('gameover');
    expect(game.rammed()).toBe(true);
    expect(game.scores()).toEqual([0, 0]);
    expect(game.players()[1].ship).toEqual({ x: 2, y: 1 }); // both wrecks, one square
  });

  // --- Deduction, scoring, reset ------------------------------------------

  it("has no exposed square yet, so every square but the hunter's own is possible", () => {
    placeBothShips();
    expect(game.possibleShipSquares(1)).toHaveLength(BOARD_W * BOARD_H - 1);
  });

  it('narrows possible ship squares to the bordering squares after a forced move, excluding bombed ones', () => {
    placeBothShips({ x: 1, y: 1 }, { x: 3, y: 0 });
    fire(0, { x: 2, y: 1 }); // p1 fires at (2,1), miss -> player 0 exposed at (1,1)
    move(0, { x: 2, y: 2 }); // player 0 moves to (2,2)

    // The ship is at one of (1,1)'s 8 neighbours, minus the bombed (2,1).
    const candidates = game.possibleShipSquares(0);
    expect(candidates).not.toContainEqual({ x: 2, y: 1 });
    expect(candidates).toContainEqual({ x: 2, y: 2 }); // where it actually went
  });

  it('applies the enemy’s actions off the log without their square', () => {
    // What the joiner's device does with the host's entries.
    game.apply({ kind: 'place', player: 0, c: null, ram: false });
    game.apply({ kind: 'place', player: 1, c: { x: 3, y: 3 }, ram: false });
    game.apply({ kind: 'fire', player: 0, from: { x: 0, y: 0 }, to: { x: 3, y: 3 }, hit: true });
    expect(game.players()[1].health).toBe(50);
    expect(game.players()[0].ship).toEqual({ x: 0, y: 0 }); // rule 5.2 gave it away
    expect(game.phase()).toBe('move');
  });

  it('scores one point for the winner and keeps it across a rematch (rule 8)', () => {
    placeBothShips();
    sink(0); // player 1 hits player 2 twice
    expect(game.scores()).toEqual([1, 0]);

    game.apply({ kind: 'reset' }); // "play again" keeps the score
    ships = [null, null];
    expect(game.scores()).toEqual([1, 0]);

    placeBothShips({ x: 1, y: 1 }, { x: 3, y: 3 });
    playSafeTurn(0); // player 1 fires at empty water and moves
    sink(1); // player 2 sinks player 1 instead
    expect(game.scores()).toEqual([1, 1]);
  });

  it('clears the score for a fresh session', () => {
    placeBothShips();
    sink(0);
    expect(game.scores()).toEqual([1, 0]);
    game.resetScores();
    expect(game.scores()).toEqual([0, 0]);
  });

  it('resets to a fresh game', () => {
    placeBothShips();
    sink(0);
    game.apply({ kind: 'reset' });
    expect(game.phase()).toBe('placement');
    expect(game.currentPlayer()).toBe(0);
    expect(game.players()[0].ship).toBeNull();
    expect(game.players()[0].placed).toBe(false);
    expect(game.players().map((p) => p.health)).toEqual([100, 100]);
    expect(game.destroyed().every((d) => !d)).toBe(true);
  });
});
