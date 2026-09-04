import { Injectable, computed, signal } from '@angular/core';

export const BOARD_W = 4;
/**
 * Taller than it is wide: 4 across, 5 down (20 squares). Everything here is
 * written against these two constants, but the board's *shape* also reaches
 * the CSS — `.board` spells out its row count, and `fitBoards()` sizes a
 * board of this ratio — so both have to move together. The database rules
 * (`tools/rules.mjs`) carry the same two numbers.
 */
export const BOARD_H = 5;

export type PlayerId = 0 | 1;
export type Phase = 'placement' | 'fire' | 'move' | 'gameover';

export interface Coord {
  x: number;
  y: number;
}

/**
 * Everything that changes the game is a serializable action, applied the same
 * way whether this device played it or read it off the session's log.
 *
 * Only what a player is *entitled* to know travels in one. A ship's square is
 * never in a `place` or a `move`: `c` is filled in for your own ship, and for
 * the enemy's only when something has genuinely given it away — a ram, a wreck,
 * the reveal at the end of a round. `hit` and `ram` are answers this device
 * cannot work out for itself, which is why they are settled by the database
 * (see `tools/rules.mjs`) rather than computed here.
 */
export type GameAction =
  | { kind: 'place'; player: PlayerId; c: Coord | null; ram: boolean }
  | { kind: 'fire'; player: PlayerId; from: Coord; to: Coord; hit: boolean }
  | { kind: 'move'; player: PlayerId; c: Coord | null; ram: boolean }
  /** Rule 5.4 with nowhere to go: the shooter is boxed in and the turn passes. */
  | { kind: 'stay'; player: PlayerId }
  /** A player showing its own square once the round is over. */
  | { kind: 'reveal'; player: PlayerId; c: Coord }
  | { kind: 'reset' };

/** What a tap on the board would mean right now; null if it means nothing. */
export type Intent = 'place' | 'fire' | 'move';

/** Rule 6.1: every ship starts the game whole. */
export const FULL_HEALTH = 100;
/** Rule 6.2: the first hit halves it — on fire, not wrecked. */
export const HIT_HEALTH = 50;
/** Rule 6.3: a burning ship loses this much on each of its own moves. */
export const BURN_PER_MOVE = 10;

export interface PlayerState {
  /**
   * Where this ship is, as far as this device is entitled to know: your own
   * always, the enemy's only while it is showing (rule 5.2's muzzle flash, a
   * hit, a wreck, the end of the round). Null the rest of the time — the
   * position lives in the database, which never hands it to the other player.
   */
  ship: Coord | null;
  /** Rule 4: their ship is on the board, wherever it is. */
  placed: boolean;
  /**
   * Which position in this ship's life it is standing in: 0 where it was
   * placed, one more with every move. The database keys each ship's squares by
   * this, so a shot names the epoch it was aimed at and can never be dodged by
   * a ship that moves afterwards.
   */
  epoch: number;
  /**
   * Rule 6: 100 while untouched, 50 from the first hit, then 10 less with
   * every move this player makes, and 0 = wrecked (that player loses).
   */
  health: number;
  shipDestroyed: boolean;
  /** Square the opponent saw when this player last fired (rule 5.2). */
  exposedAt: Coord | null;
}

const idx = (c: Coord) => c.y * BOARD_W + c.x;
const sameCell = (a: Coord, b: Coord) => a.x === b.x && a.y === b.y;
const other = (p: PlayerId): PlayerId => (p === 0 ? 1 : 0);

function emptyPlayer(): PlayerState {
  return {
    ship: null,
    placed: false,
    epoch: 0,
    health: FULL_HEALTH,
    shipDestroyed: false,
    exposedAt: null,
  };
}

@Injectable({ providedIn: 'root' })
export class GameService {
  readonly phase = signal<Phase>('placement');
  /** Whose turn it is during fire/move. Player 0 (the host) fires first. */
  readonly currentPlayer = signal<PlayerId>(0);
  /** Null during play, and null at 'gameover' when the round was a draw. */
  readonly winner = signal<PlayerId | null>(null);
  readonly players = signal<[PlayerState, PlayerState]>([emptyPlayer(), emptyPlayer()]);
  /**
   * Rule 2.3: one united board. The two boards exist only for placement, so
   * bombed squares (rule 5.3) are a single shared set — a crater is dead for
   * both ships. Indexed y * BOARD_W + x.
   */
  readonly destroyed = signal<boolean[]>(Array(BOARD_W * BOARD_H).fill(false));
  /** Rule 8: running score within the session — one point per victory. */
  readonly scores = signal<[number, number]>([0, 0]);

  readonly bothPlaced = computed(() => this.players().every((p) => p.placed));
  /** Rule 11.2: the round ended with both ships wrecked and nobody scoring. */
  readonly rammed = computed(
    () => this.phase() === 'gameover' && this.players().every((p) => p.shipDestroyed),
  );

  /**
   * Transient: the last ram (rule 11), for the collision animation — where the
   * two hulls met, and which square the rammer came in from (null when both
   * ships were simply placed on the same square, so there is no approach).
   * `n` makes each ram a distinct value, like `lastShot`.
   */
  readonly lastRam = signal<{
    at: Coord;
    from: Coord | null;
    rammer: PlayerId;
    n: number;
  } | null>(null);

  /**
   * Transient: the last shot fired, for the tracer animation (from the
   * shooter's exposed square to the bombed square). `n` makes each shot a
   * distinct value so effects fire even when coordinates repeat.
   */
  readonly lastShot = signal<{
    shooter: PlayerId;
    from: Coord | null;
    to: Coord;
    /** Rule 6.2: the shot found the enemy ship. */
    hit: boolean;
    n: number;
  } | null>(null);

  /**
   * Craters that were hits, not misses — the squares where a ship was actually
   * struck. Public knowledge (both players watched the shot land), and what
   * lets the board keep a hit square burning instead of grey.
   */
  readonly hitSquares = signal<boolean[]>(Array(BOARD_W * BOARD_H).fill(false));

  /**
   * What a tap by `actor` on that square would mean right now, or null if it
   * would mean nothing. Everything it can check, it checks against what this
   * device knows for certain — its own ship and the public board — so an
   * impossible tap never reaches the database at all.
   */
  intent(actor: PlayerId, c: Coord): Intent | null {
    const me = this.players()[actor];
    switch (this.phase()) {
      case 'placement':
        return me.placed ? null : 'place';
      case 'fire':
        if (actor !== this.currentPlayer()) return null;
        if (this.destroyed()[idx(c)]) return null; // square already bombed
        // Rule 2.3: one board — not under your own keel.
        if (me.ship && sameCell(me.ship, c)) return null;
        return 'fire';
      case 'move':
        if (actor !== this.currentPlayer()) return null;
        return this.legalMoves(actor).some((m) => sameCell(m, c)) ? 'move' : null;
      default:
        return null;
    }
  }

  /** Apply an action — one this device played, or one off the session's log. */
  apply(action: GameAction): boolean {
    switch (action.kind) {
      case 'place':
        return this.placeShip(action.player, action.c, action.ram);
      case 'fire':
        return this.fireAt(action.player, action.from, action.to, action.hit);
      case 'move':
        return this.moveTo(action.player, action.c, action.ram);
      case 'stay':
        return this.stayPut(action.player);
      case 'reveal':
        return this.reveal(action.player, action.c);
      case 'reset':
        this.reset();
        return true;
    }
  }

  /** Bordering squares of `c` (rule 3) that aren't bombed (rule 5.3). */
  neighborsOf(c: Coord, destroyed = this.destroyed()): Coord[] {
    const moves: Coord[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const n = { x: c.x + dx, y: c.y + dy };
        if (n.x < 0 || n.x >= BOARD_W || n.y < 0 || n.y >= BOARD_H) continue;
        if (destroyed[idx(n)]) continue;
        moves.push(n);
      }
    }
    return moves;
  }

  /**
   * Legal one-square moves: all 8 bordering squares (rule 3) that are still
   * usable (rule 5.3). The square the other ship is on is deliberately among
   * them — sailing into it is a ram (rule 11), not an illegal move, and this
   * device could not exclude it anyway: it does not know where they are.
   *
   * Only ever answerable for a ship this device can see, which is exactly the
   * ships it is allowed to move.
   */
  legalMoves(player: PlayerId): Coord[] {
    const state = this.players()[player];
    if (!state.ship) return [];
    return this.neighborsOf(state.ship);
  }

  /**
   * Squares where `player`'s ship could possibly be right now, deducible from
   * public information alone — there is nothing else left to peek at. Firing
   * exposes the exact square (rule 5.2); after that the ship either had to
   * move to a still-usable bordering square (rule 5.4) or, if none existed,
   * never moved at all. Everything else is provably impossible — including
   * the square the *asking* player is standing on, since a ship that had
   * sailed into them would have rammed (rule 11). Used by the computer
   * opponent, and to hint the same deduction to a human.
   */
  possibleShipSquares(player: PlayerId): Coord[] {
    const state = this.players()[player];
    const hunter = this.players()[other(player)].ship;
    const free = (c: Coord) => !hunter || !sameCell(c, hunter);

    if (!state.exposedAt) {
      const all: Coord[] = [];
      const destroyed = this.destroyed();
      for (let y = 0; y < BOARD_H; y++) {
        for (let x = 0; x < BOARD_W; x++) {
          if (!destroyed[y * BOARD_W + x] && free({ x, y })) all.push({ x, y });
        }
      }
      return all;
    }
    const moved = this.neighborsOf(state.exposedAt).filter(free);
    return moved.length > 0 ? moved : [state.exposedAt];
  }

  /** Reset the round for a rematch; the session score is kept (rule 8). */
  reset(): void {
    this.phase.set('placement');
    this.currentPlayer.set(0);
    this.winner.set(null);
    this.players.set([emptyPlayer(), emptyPlayer()]);
    this.destroyed.set(Array(BOARD_W * BOARD_H).fill(false));
    this.hitSquares.set(Array(BOARD_W * BOARD_H).fill(false));
    this.lastRam.set(null);
    this.lastShot.set(null);
  }

  /** Clear the score — a fresh session (rule 8 scope is one game id). */
  resetScores(): void {
    this.scores.set([0, 0]);
  }

  /**
   * Rule 4: both players place their own ship, each on their own board and
   * hidden from the other, so nothing stops them from picking the same square.
   * On the united board that is a ram before the first shot (rule 11.5) — and
   * since neither device can see the other's square, `ram` is the database's
   * answer, not a comparison made here.
   */
  private placeShip(player: PlayerId, c: Coord | null, ram: boolean): boolean {
    if (this.phase() !== 'placement') return false;
    if (this.players()[player].placed) return false; // already placed
    this.updatePlayer(player, (p) => ({ ...p, ship: c ?? p.ship, placed: true }));
    // Rule 11.5: the ram that happens before a shot is fired. It always comes
    // with the square, since both wrecks have to be drawn on it.
    if (ram && c) {
      this.ram(c, null, player);
      return true;
    }
    if (!this.bothPlaced()) return true;
    this.currentPlayer.set(0);
    this.phase.set('fire');
    return true;
  }

  /**
   * `hit` comes from the log, where the database put it after checking it
   * against the enemy's committed square: the one thing a losing player would
   * most like to lie about is the one thing they cannot.
   */
  private fireAt(shooter: PlayerId, from: Coord, to: Coord, hit: boolean): boolean {
    if (this.phase() !== 'fire' || shooter !== this.currentPlayer()) return false;
    if (this.destroyed()[idx(to)]) return false; // square already bombed
    if (sameCell(from, to)) return false; // rule 2.3: not under your own keel

    const enemy = other(shooter);
    this.lastShot.update((prev) => ({
      shooter,
      from: { ...from },
      to: { ...to },
      hit,
      n: (prev?.n ?? 0) + 1,
    }));
    if (hit) {
      this.hitSquares.update((h) => {
        const next = [...h];
        next[idx(to)] = true;
        return next;
      });
    }

    // Rule 5.3: the crater is dead for both ships now.
    this.destroyed.update((d) => {
      const next = [...d];
      next[idx(to)] = true;
      return next;
    });

    // Rule 5.2: firing gives the shooter's square away, so it stops being a
    // secret — the board may draw the muzzle flash on it, and the exposure
    // marker stays behind after they sail.
    this.updatePlayer(shooter, (p) => ({ ...p, ship: { ...from }, exposedAt: { ...from } }));

    this.updatePlayer(enemy, (p) => {
      // Rule 6.2: the first hit takes the ship to 50% and sets it on fire.
      // Rule 6.5: a hit on a ship that is already burning finishes it.
      const health = hit ? (p.health > HIT_HEALTH ? HIT_HEALTH : 0) : p.health;
      // A shot that lands says exactly where that ship was standing.
      return {
        ...p,
        ship: hit ? { ...to } : p.ship,
        health,
        shipDestroyed: p.shipDestroyed || health === 0,
      };
    });

    // Rule 6.6: at 0% that player loses. Rule 8: the winner scores a point.
    if (this.players()[enemy].shipDestroyed) {
      this.endGame(shooter);
      return true;
    }

    // Rule 5.4: the shooter must now move. Whether it *can* is a question only
    // its own device can answer — the squares around it are public, but which
    // square it is on is not — so a ship with nowhere to go says so with a
    // `stay`, which the database only accepts from a ship that really is boxed
    // in. Either way the turn ends on the entry that follows.
    this.phase.set('move');
    return true;
  }

  /**
   * `c` is null for the enemy's move: it sails somewhere among the squares
   * bordering the one it fired from, and that is all this device is told.
   * `ram` is the database's answer to the one question the mover could not ask
   * itself — whether the square it sailed into was already occupied (rule 11).
   */
  private moveTo(player: PlayerId, c: Coord | null, ram: boolean): boolean {
    if (this.phase() !== 'move' || player !== this.currentPlayer()) return false;
    if (c && !this.legalMoves(player).some((m) => sameCell(m, c))) return false;

    const from = this.players()[player].ship;
    // Rule 11: sailing onto the other ship rams it — both go down and nobody
    // scores. Rule 11.4: this is settled before the fire, so a ship on its last
    // 10% that rams does not lose the round; it draws it.
    if (ram && c) {
      this.updatePlayer(player, (p) => ({ ...p, ship: { ...c }, epoch: p.epoch + 1 }));
      this.ram(c, from, player);
      return true;
    }

    // Rule 6.3: a burning ship loses another 10% every time it moves — sailing
    // on fans the flames. An untouched ship moves for free.
    this.updatePlayer(player, (p) => {
      const health = p.health < FULL_HEALTH ? Math.max(p.health - BURN_PER_MOVE, 0) : p.health;
      return {
        ...p,
        // Where the enemy sailed is theirs to keep: the sea takes their hull
        // back until something gives it away again.
        ship: c ? { ...c } : null,
        epoch: p.epoch + 1,
        health,
        shipDestroyed: p.shipDestroyed || health === 0,
      };
    });

    // Rule 6.6: burning down to 0% loses the game for its owner.
    if (this.players()[player].shipDestroyed) {
      this.endGame(other(player));
      return true;
    }

    this.endTurn();
    return true;
  }

  /**
   * Rule 5.4 with nowhere to go: every bordering square is a crater, so the
   * ship stays where it is and the turn passes. The database checks that a
   * player claiming this really is boxed in, because standing still while the
   * log says you sailed would quietly break the deduction in
   * `possibleShipSquares()` that the whole game is played on.
   */
  private stayPut(player: PlayerId): boolean {
    if (this.phase() !== 'move' || player !== this.currentPlayer()) return false;
    this.endTurn();
    return true;
  }

  /** Rule 6/11's aftermath: a player showing where its wreck actually lies. */
  private reveal(player: PlayerId, c: Coord): boolean {
    if (this.phase() !== 'gameover') return false;
    this.updatePlayer(player, (p) => ({ ...p, ship: { ...c } }));
    return true;
  }

  /** Rule 11: both ships wrecked on the same square, and no point for anyone. */
  private ram(at: Coord, from: Coord | null, rammer: PlayerId): void {
    this.lastRam.update((prev) => ({
      at: { ...at },
      from: from ? { ...from } : null,
      rammer,
      n: (prev?.n ?? 0) + 1,
    }));
    this.players.update(
      ([a, b]) =>
        [
          { ...a, ship: { ...at }, health: 0, shipDestroyed: true },
          { ...b, ship: { ...at }, health: 0, shipDestroyed: true },
        ] as [PlayerState, PlayerState],
    );
    this.winner.set(null);
    this.phase.set('gameover');
  }

  /** Rule 6.6 + rule 8: the round is over and the winner takes a point. */
  private endGame(winner: PlayerId): void {
    this.winner.set(winner);
    this.scores.update((s) => {
      const next: [number, number] = [...s];
      next[winner] += 1;
      return next;
    });
    this.phase.set('gameover');
  }

  private endTurn(): void {
    this.currentPlayer.update((p) => (p === 0 ? 1 : 0));
    this.phase.set('fire');
  }

  private updatePlayer(id: PlayerId, fn: (p: PlayerState) => PlayerState): void {
    this.players.update((players) => {
      const next: [PlayerState, PlayerState] = [...players];
      next[id] = fn(players[id]);
      return next;
    });
  }
}
