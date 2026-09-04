import { TestBed } from '@angular/core/testing';
import { BOARD_H, BOARD_W, Coord, GameService, PlayerId } from './game.service';

describe('GameService', () => {
  let game: GameService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    game = TestBed.inject(GameService);
  });

  /**
   * Tap the united board as whoever may legally act right now: during
   * placement as `player`, otherwise as the current player (mirrors what each
   * device sends).
   */
  function click(player: PlayerId, c: Coord) {
    const actor = game.phase() === 'placement' ? player : game.currentPlayer();
    return game.tryLocal(actor, c);
  }

  function placeBothShips(p1 = { x: 0, y: 0 }, p2 = { x: 3, y: 3 }) {
    click(0, p1);
    click(1, p2);
  }

  const at = (a: Coord | null, b: Coord) => !!a && a.x === b.x && a.y === b.y;

  function allSquares(): Coord[] {
    const all: Coord[] = [];
    for (let y = 0; y < BOARD_H; y++) for (let x = 0; x < BOARD_W; x++) all.push({ x, y });
    return all;
  }

  /** A still usable square that neither ship is standing on. */
  function emptySquare(): Coord {
    const ships = game.players().map((p) => p.ship);
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
    const foe: PlayerId = player === 0 ? 1 : 0;
    game.apply({ kind: 'fire', player, c: emptySquare() });
    if (game.phase() === 'move') {
      const foeShip = game.players()[foe].ship!;
      game.apply({
        kind: 'move',
        player,
        c: game.legalMoves(player).find((m) => !at(foeShip, m))!,
      });
    }
  }

  /**
   * Wreck `shooter`'s enemy the short way: a hit puts them on 50% (rule 6.2)
   * and a second one finishes them (rule 6.5). Between the two the other
   * player takes an ordinary, harmless turn.
   */
  function sink(shooter: PlayerId) {
    const enemy: PlayerId = shooter === 0 ? 1 : 0;
    game.apply({ kind: 'fire', player: shooter, c: game.players()[enemy].ship! });
    if (game.phase() === 'move') {
      const foeShip = game.players()[enemy].ship!;
      game.apply({
        kind: 'move',
        player: shooter,
        c: game.legalMoves(shooter).find((m) => !at(foeShip, m))!,
      });
    }
    playSafeTurn(enemy);
    game.apply({ kind: 'fire', player: shooter, c: game.players()[enemy].ship! });
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
    expect(game.tryLocal(0, { x: 1, y: 1 })).toBeNull();
    expect(game.players()[0].ship).toEqual({ x: 0, y: 0 });
  });

  it('rejects acting out of turn', () => {
    placeBothShips();
    // It's player 1's turn; player 2 may not fire.
    expect(game.tryLocal(1, { x: 1, y: 1 })).toBeNull();
    expect(game.destroyed().every((d) => !d)).toBe(true);
  });

  it('returns the applied action so it can be sent to the opponent', () => {
    click(0, { x: 0, y: 0 });
    const action = game.tryLocal(1, { x: 3, y: 3 });
    expect(action).toEqual({ kind: 'place', player: 1, c: { x: 3, y: 3 } });
  });

  // --- Rule 2.3: one united board -----------------------------------------

  it('bombs one shared board, so a crater is dead for both ships (rules 2.3, 5.3)', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 3, y: 3 });
    click(1, { x: 2, y: 2 }); // player 1 fires, misses
    expect(game.destroyed()[2 * BOARD_W + 2]).toBe(true);
    // The crater is off limits to the ship that made it as well.
    expect(game.legalMoves(1)).not.toContainEqual({ x: 2, y: 2 });
    click(0, { x: 1, y: 1 }); // player 1 moves off (0,0)
    expect(game.legalMoves(1)).not.toContainEqual({ x: 2, y: 2 });
  });

  it('refuses to fire at the square your own ship is on', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 3, y: 3 });
    expect(game.tryLocal(0, { x: 0, y: 0 })).toBeNull();
    expect(game.phase()).toBe('fire');
  });

  it('marks the bombed square unusable and exposes the shooter on a miss (rules 5.2, 5.3)', () => {
    placeBothShips();
    click(1, { x: 1, y: 2 }); // miss
    expect(game.destroyed()[2 * BOARD_W + 1]).toBe(true);
    expect(game.players()[0].exposedAt).toEqual({ x: 0, y: 0 });
    expect(game.phase()).toBe('move');
  });

  it('lets the shooter move to any of the 8 bordering squares (rule 3)', () => {
    placeBothShips({ x: 1, y: 1 }, { x: 3, y: 3 }); // interior square
    click(1, { x: 0, y: 0 }); // miss -> move phase
    expect(game.legalMoves(0)).toHaveLength(7); // (0,0) was just bombed
    click(0, { x: 2, y: 2 }); // diagonal move
    expect(game.players()[0].ship).toEqual({ x: 2, y: 2 });
    expect(game.currentPlayer()).toBe(1);
    expect(game.phase()).toBe('fire');
  });

  it('rejects a move onto a bombed square (rule 5.4 via 5.3)', () => {
    placeBothShips({ x: 1, y: 1 }, { x: 3, y: 0 });
    click(1, { x: 2, y: 2 }); // p1 fires at (2,2), miss -> move phase
    const before = game.players()[0].ship;
    click(0, { x: 2, y: 2 }); // bombed square: rejected
    expect(game.players()[0].ship).toEqual(before);
    expect(game.phase()).toBe('move');
  });

  it('ignores firing at an already-bombed square', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 3, y: 3 });
    click(1, { x: 1, y: 2 }); // p1 miss
    click(0, { x: 1, y: 1 }); // p1 moves
    click(0, { x: 3, y: 0 }); // p2 miss
    click(1, { x: 2, y: 3 }); // p2 moves
    click(1, { x: 1, y: 2 }); // p1 fires at the same crater again
    expect(game.phase()).toBe('fire'); // nothing happened, still p1 to fire
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
    click(1, { x: 3, y: 3 }); // direct hit
    expect(game.players()[1].health).toBe(50);
    expect(game.players()[1].shipDestroyed).toBe(false);
    expect(game.phase()).toBe('move'); // the shooter still has to move (rule 5.4)
    expect(game.winner()).toBeNull();
  });

  it('burns 10% off a hit ship with every move it makes (rule 6.3)', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 2, y: 2 });
    click(1, { x: 2, y: 2 }); // p1 hits p2 -> 50%
    click(0, { x: 1, y: 0 }); // p1 must move
    expect(game.players()[1].health).toBe(50); // the fire costs p2, not p1

    playSafeTurn(1); // p2 fires and moves while burning
    expect(game.players()[1].health).toBe(40);
    expect(game.players()[0].health).toBe(100); // p1 was never hit
  });

  it('wrecks a burning ship once its health reaches 0% (rule 6.6)', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 2, y: 2 });
    click(1, { x: 2, y: 2 }); // p1 hits p2 -> 50%
    click(0, { x: 1, y: 0 }); // p1 moves

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

  it('finishes a burning ship outright on a second hit (rule 6.5)', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 2, y: 2 });
    click(1, { x: 2, y: 2 }); // hit -> 50%
    click(0, { x: 1, y: 0 }); // p1 moves
    playSafeTurn(1); // p2 fires and moves -> 40%
    click(1, game.players()[1].ship!); // p1 hits the burning ship again
    expect(game.players()[1].health).toBe(0);
    expect(game.phase()).toBe('gameover');
    expect(game.winner()).toBe(0);
  });

  // --- Rule 11: ramming ----------------------------------------------------

  it('wrecks both ships and scores nothing when one sails into the other (rule 11)', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 1, y: 1 });
    click(1, { x: 3, y: 3 }); // p1 fires far away, miss -> move phase
    expect(game.legalMoves(0)).toContainEqual({ x: 1, y: 1 }); // ramming is legal
    click(0, { x: 1, y: 1 }); // p1 sails into p2

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
    click(1, { x: 2, y: 2 }); // p1 hits p2 -> 50%
    click(0, { x: 2, y: 1 }); // p1 moves next to it

    const turn = (player: PlayerId, shot: Coord, to: Coord) => {
      game.apply({ kind: 'fire', player, c: shot });
      game.apply({ kind: 'move', player, c: to });
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
    game.apply({ kind: 'fire', player: 1, c: { x: 3, y: 0 } });
    const p1Square = game.players()[0].ship!;
    expect(game.legalMoves(1)).toContainEqual(p1Square);
    game.apply({ kind: 'move', player: 1, c: p1Square });

    expect(game.rammed()).toBe(true);
    expect(game.winner()).toBeNull();
    expect(game.scores()).toEqual([0, 0]);
  });

  it('treats placing both ships on the same square as a ram (rules 4, 11)', () => {
    placeBothShips({ x: 2, y: 1 }, { x: 2, y: 1 });
    expect(game.phase()).toBe('gameover');
    expect(game.rammed()).toBe(true);
    expect(game.scores()).toEqual([0, 0]);
  });

  // --- Deduction, scoring, reset ------------------------------------------

  it('has no exposed square yet, so every square but the hunter\'s own is possible', () => {
    placeBothShips();
    expect(game.possibleShipSquares(1)).toHaveLength(BOARD_W * BOARD_H - 1);
  });

  it('narrows possible ship squares to the bordering squares after a forced move, excluding bombed ones', () => {
    placeBothShips({ x: 1, y: 1 }, { x: 3, y: 0 });
    click(1, { x: 2, y: 1 }); // p1 fires at (2,1), miss -> player 0 exposed at (1,1)
    click(0, { x: 2, y: 2 }); // player 0 moves to (2,2)

    // The ship is at one of (1,1)'s 8 neighbours, minus the bombed (2,1).
    const candidates = game.possibleShipSquares(0);
    expect(candidates).not.toContainEqual({ x: 2, y: 1 });
    expect(candidates).toContainEqual({ x: 2, y: 2 }); // where it actually went
  });

  // --- Shooting odds (rule 12) --------------------------------------------

  it('opens the round at one square in nineteen — case (a) (rules 12.2, 12.9)', () => {
    placeBothShips();
    // C = B - D - {h}: 20 squares, nothing bombed, less the hunter's own.
    expect(game.possibleShipSquares(1)).toHaveLength(BOARD_W * BOARD_H - 1);
    expect(game.hitChance(1, true)).toBe(5);
  });

  it('counts the odds off the same squares the board can aim at (rule 12.2)', () => {
    placeBothShips({ x: 1, y: 1 }, { x: 3, y: 0 });
    click(1, { x: 2, y: 1 }); // p2 fires at (2,1), miss -> player 0 seen at (1,1)
    click(0, { x: 2, y: 2 }); // player 0 is forced to move (rule 5.4)

    const candidates = game.possibleShipSquares(0);
    expect(game.aimSquares(0)).toEqual(candidates); // case (c) is always reachable
    expect(game.hitChance(0, true)).toBe(Math.round(100 / candidates.length));
  });

  it('takes the square it fired from off the list once it has moved — case (c) (rule 12.3)', () => {
    placeBothShips({ x: 1, y: 1 }, { x: 3, y: 3 });
    click(0, { x: 0, y: 4 }); // player 0 fires from (1,1), miss
    click(0, { x: 1, y: 2 }); // rule 5.4 forces it off (1,1)

    // It is on one of (1,1)'s usable neighbours and provably not on (1,1).
    expect(game.possibleShipSquares(0)).not.toContainEqual({ x: 1, y: 1 });
    expect(game.possibleShipSquares(0)).toContainEqual({ x: 1, y: 2 });
  });

  it('pins a cornered ship on the square it fired from — case (b) (rules 5.4, 12.3)', () => {
    // Rule 5.4: with every bordering square already a crater it does not move,
    // so it is still exactly where it fired from and the next shot cannot miss.
    placeBothShips({ x: 0, y: 0 }, { x: 3, y: 4 });
    game.destroyed.update((d) => {
      const next = [...d];
      for (const c of [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]) {
        next[c.y * BOARD_W + c.x] = true;
      }
      return next;
    });

    game.apply({ kind: 'fire', player: 0, c: { x: 2, y: 2 } });
    expect(game.phase()).toBe('fire'); // its turn ended without a move
    expect(game.players()[0].movedSinceSeen).toBe(false);
    expect(game.possibleShipSquares(0)).toEqual([{ x: 0, y: 0 }]);
    expect(game.hitChance(0, true)).toBe(100);
  });

  it('pins a ship where a shell found it, even one that has never fired (rule 6.2.1)', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 3, y: 3 });
    game.apply({ kind: 'fire', player: 0, c: { x: 3, y: 3 } }); // a hit

    // Player 1 has fired nothing, so only rule 6.2.1's sighting can pin it —
    // and it does, exactly: case (b), one square, no guessing.
    expect(game.players()[1].exposedAt).toBeNull();
    expect(game.possibleShipSquares(1)).toEqual([{ x: 3, y: 3 }]);
  });

  it('gives 0 for a ship pinned on a square no shot may be aimed at (rule 12.5)', () => {
    placeBothShips({ x: 0, y: 0 }, { x: 3, y: 3 });
    game.apply({ kind: 'fire', player: 0, c: { x: 3, y: 3 } }); // a hit: (3,3) is a crater now

    // Certain — and untouchable, because rule 5.3 closed the only square it
    // can be on. C and F share nothing, so the shot is worth nothing.
    expect(game.possibleShipSquares(1)).toEqual([{ x: 3, y: 3 }]);
    expect(game.aimSquares(1)).toEqual([]);
    expect(game.hitChance(1, true)).toBe(0);
  });

  it('keeps 1/|C| rather than 1/|C∩F| when part of C cannot be fired at (rule 12.5)', () => {
    // The only unreachable candidate is a pinned ship's own crater, which is a
    // one-square C — so the two readings differ exactly there: 0, not 100.
    placeBothShips({ x: 0, y: 0 }, { x: 3, y: 3 });
    game.apply({ kind: 'fire', player: 0, c: { x: 3, y: 3 } });
    expect(game.hitChance(1, true)).toBe(0);
    expect(game.aimSquares(1)).toHaveLength(0); // 1/|C∩F| would divide by zero
  });

  it('re-pins a ship on the newer of its two kinds of sighting (rule 12.2)', () => {
    placeBothShips({ x: 1, y: 1 }, { x: 3, y: 3 });
    click(0, { x: 0, y: 4 }); // player 0 fires from (1,1)
    click(0, { x: 1, y: 2 }); // and moves — case (c) from (1,1)
    expect(game.players()[0].seenAt).toEqual({ x: 1, y: 1 });

    game.apply({ kind: 'fire', player: 1, c: { x: 1, y: 2 } }); // a hit finds it
    // The hit is the newer sighting, so it replaces the older exposure.
    expect(game.players()[0].exposedAt).toEqual({ x: 1, y: 1 });
    expect(game.possibleShipSquares(0)).toEqual([{ x: 1, y: 2 }]);
  });

  it('leaves the hunter\'s own square in when the odds are not the hunter\'s (rule 12.8)', () => {
    // Player 0 fires from (1,1) and sails to (2,2); the hunter, player 1, sits
    // at (0,0) — one of (1,1)'s neighbours, so it is a square player 0 cannot
    // have gone to, and it counts for the hunter alone.
    placeBothShips({ x: 1, y: 1 }, { x: 0, y: 0 });
    click(1, { x: 3, y: 3 }); // player 0 fires, exposing (1,1)
    click(0, { x: 2, y: 2 }); // and moves

    const asHunter = game.possibleShipSquares(0, true);
    const public_ = game.possibleShipSquares(0, false);
    expect(public_).toContainEqual({ x: 0, y: 0 }); // the hunter's own square
    expect(asHunter).not.toContainEqual({ x: 0, y: 0 });
    expect(public_).toHaveLength(asHunter.length + 1);
    // Which is exactly the square of difference between the two percentages.
    expect(game.hitChance(0, true)).toBe(Math.round(100 / asHunter.length));
    expect(game.hitChance(0, false)).toBe(Math.round(100 / public_.length));
  });

  it('never rules out the square the ship is actually on', () => {
    // The whole deduction is worthless if it can exclude the truth, so play a
    // long random game and assert the invariant on every single state.
    let seed = 20260904;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) >>> 8) % n;
    const pick = <T,>(xs: T[]): T => xs[rnd(xs.length)];

    let checks = 0;
    let pinned = 0;
    for (let round = 0; round < 40; round++) {
      game.apply({ kind: 'reset' });
      game.apply({ kind: 'place', player: 0, c: { x: rnd(BOARD_W), y: rnd(BOARD_H) } });
      game.apply({ kind: 'place', player: 1, c: { x: rnd(BOARD_W), y: rnd(BOARD_H) } });

      for (let step = 0; step < 60 && game.phase() !== 'gameover'; step++) {
        const p = game.currentPlayer();
        for (const id of [0, 1] as PlayerId[]) {
          const ship = game.players()[id].ship!;
          // Both readings of C (rule 12.8) must contain the real square.
          expect(game.possibleShipSquares(id, true)).toContainEqual(ship);
          expect(game.possibleShipSquares(id, false)).toContainEqual(ship);
          checks++;
          if (game.possibleShipSquares(id, true).length === 1) pinned++;
        }
        if (game.phase() === 'fire') {
          const shots = game.firableSquares(p);
          if (!shots.length) break;
          game.apply({ kind: 'fire', player: p, c: pick(shots) });
        } else {
          game.apply({ kind: 'move', player: p, c: pick(game.legalMoves(p)) });
        }
      }
    }
    // …and that the sweep really visited the states it claims to cover, rather
    // than passing because every round ended on the first move.
    expect(checks).toBeGreaterThan(400);
    expect(pinned).toBeGreaterThan(0); // case (b) reached, not just (a) and (c)
  });

  it('applies actions received from the opponent identically', () => {
    // What the joiner's device does with the host's mirrored actions.
    game.apply({ kind: 'place', player: 0, c: { x: 0, y: 0 } });
    game.apply({ kind: 'place', player: 1, c: { x: 3, y: 3 } });
    game.apply({ kind: 'fire', player: 0, c: { x: 3, y: 3 } });
    expect(game.players()[1].health).toBe(50);
    expect(game.phase()).toBe('move');
  });

  it('scores one point for the winner and keeps it across a rematch (rule 8)', () => {
    placeBothShips();
    sink(0); // player 1 hits player 2 twice
    expect(game.scores()).toEqual([1, 0]);

    game.apply({ kind: 'reset' }); // "play again" keeps the score
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
    expect(game.players().map((p) => p.health)).toEqual([100, 100]);
    expect(game.destroyed().every((d) => !d)).toBe(true);
  });
});
