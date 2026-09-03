import { Injectable, computed, signal } from '@angular/core';

export const BOARD_W = 4;
export const BOARD_H = 4;

export type PlayerId = 0 | 1;
export type Phase = 'placement' | 'fire' | 'move' | 'gameover';

export interface Coord {
  x: number;
  y: number;
}

/**
 * Everything that changes the game is a serializable action, so the same
 * action can be applied locally and sent to the opponent's device (P2P sync).
 */
export type GameAction =
  | { kind: 'place'; player: PlayerId; c: Coord }
  | { kind: 'fire'; player: PlayerId; c: Coord }
  | { kind: 'move'; player: PlayerId; c: Coord }
  | { kind: 'reset' };

/** Rule 6.1: every ship starts the game whole. */
export const FULL_HEALTH = 100;
/** Rule 6.2: the first hit halves it — on fire, not wrecked. */
export const HIT_HEALTH = 50;
/** Rule 6.3: a burning ship loses this much on each of its own moves. */
export const BURN_PER_MOVE = 10;

export interface PlayerState {
  /** Each player has exactly one ship; null until placed. */
  ship: Coord | null;
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

  readonly bothPlaced = computed(() => this.players().every((p) => p.ship !== null));
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
   * Interpret a tap by `actor` on the board as a game action, apply it, and
   * return it so the caller can forward it to the other device.
   * Returns null when the tap is not a legal action right now.
   */
  tryLocal(actor: PlayerId, c: Coord): GameAction | null {
    let action: GameAction | null = null;
    switch (this.phase()) {
      case 'placement':
        action = { kind: 'place', player: actor, c };
        break;
      case 'fire':
        if (actor === this.currentPlayer()) action = { kind: 'fire', player: actor, c };
        break;
      case 'move':
        if (actor === this.currentPlayer()) action = { kind: 'move', player: actor, c };
        break;
    }
    return action && this.apply(action) ? action : null;
  }

  /** Apply an action (local or received from the opponent). */
  apply(action: GameAction): boolean {
    switch (action.kind) {
      case 'place':
        return this.placeShip(action.player, action.c);
      case 'fire':
        return this.fireAt(action.player, action.c);
      case 'move':
        return this.moveTo(action.player, action.c);
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
   * them — sailing into it is a ram (rule 11), not an illegal move.
   */
  legalMoves(player: PlayerId): Coord[] {
    const state = this.players()[player];
    if (!state.ship) return [];
    return this.neighborsOf(state.ship);
  }

  /**
   * Squares where `player`'s ship could possibly be right now, deducible from
   * public information alone — no peeking at the real `ship` field. Firing
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
  }

  /** Clear the score — a fresh session (rule 8 scope is one game id). */
  resetScores(): void {
    this.scores.set([0, 0]);
  }

  /**
   * Rule 4: both players place their own ship, each on their own board and
   * hidden from the other, so nothing stops them from picking the same square.
   * On the united board that is a ram before the first shot (rule 11).
   */
  private placeShip(player: PlayerId, c: Coord): boolean {
    if (this.phase() !== 'placement') return false;
    if (this.players()[player].ship) return false; // already placed
    this.updatePlayer(player, (p) => ({ ...p, ship: c }));
    if (!this.bothPlaced()) return true;

    const [a, b] = this.players();
    if (sameCell(a.ship!, b.ship!)) {
      this.ram(a.ship!, null, player);
      return true;
    }
    this.currentPlayer.set(0);
    this.phase.set('fire');
    return true;
  }

  private fireAt(shooter: PlayerId, c: Coord): boolean {
    if (this.phase() !== 'fire' || shooter !== this.currentPlayer()) return false;
    if (this.destroyed()[idx(c)]) return false; // square already bombed
    const own = this.players()[shooter].ship;
    if (own && sameCell(own, c)) return false; // rule 2.3: one board — not under your own keel

    const enemy = other(shooter);
    const enemyShip = this.players()[enemy].ship;
    const hit = !!enemyShip && sameCell(enemyShip, c);
    this.lastShot.update((prev) => ({
      shooter,
      from: own ? { ...own } : null,
      to: { ...c },
      hit,
      n: (prev?.n ?? 0) + 1,
    }));
    if (hit) {
      this.hitSquares.update((h) => {
        const next = [...h];
        next[idx(c)] = true;
        return next;
      });
    }

    // Rule 5.3: the crater is dead for both ships now.
    this.destroyed.update((d) => {
      const next = [...d];
      next[idx(c)] = true;
      return next;
    });

    this.updatePlayer(enemy, (p) => {
      // Rule 6.2: the first hit takes the ship to 50% and sets it on fire.
      // Rule 6.5: a hit on a ship that is already burning finishes it.
      const health = hit ? (p.health > HIT_HEALTH ? HIT_HEALTH : 0) : p.health;
      return { ...p, health, shipDestroyed: p.shipDestroyed || health === 0 };
    });

    // Rule 6.6: at 0% that player loses. Rule 8: the winner scores a point.
    if (this.players()[enemy].shipDestroyed) {
      this.endGame(shooter);
      return true;
    }

    // Rule 5.2: firing exposes the square it was fired from.
    this.updatePlayer(shooter, (p) => ({ ...p, exposedAt: p.ship ? { ...p.ship } : null }));

    // Rule 5.4: the shooter must move, if any usable square borders it.
    // Boxed in — every bordering square a crater — it simply stays put and the
    // turn passes. That is the harshest place to be on this board: `exposedAt`
    // keeps pointing at the square it never left, so `possibleShipSquares()`
    // narrows to that one square and the next shot cannot miss. Hiding the hint
    // would not save it either — the rocket flies from the shooter's square and
    // leaves its trail there, so the position is on screen anyway.
    // Two consequences we know about and are leaving as they are for now:
    // a stranded ship never moves, so a burning one stops losing its 10% a move
    // (rule 6.3), and once it has been hit it stands on its own crater, which
    // the guard at the top of this method makes an illegal target — untouchable
    // at 50% for the rest of the round.
    if (this.legalMoves(shooter).length === 0) {
      this.endTurn();
    } else {
      this.phase.set('move');
    }
    return true;
  }

  private moveTo(player: PlayerId, c: Coord): boolean {
    if (this.phase() !== 'move' || player !== this.currentPlayer()) return false;
    if (!this.legalMoves(player).some((m) => sameCell(m, c))) return false;

    // Rule 11: sailing onto the other ship rams it — both go down and nobody
    // scores. Rule 11.4: this is settled before the fire, so a ship on its last
    // 10% that rams does not lose the round; it draws it.
    const foe = this.players()[other(player)].ship;
    if (foe && sameCell(foe, c)) {
      const from = this.players()[player].ship;
      this.updatePlayer(player, (p) => ({ ...p, ship: c }));
      this.ram(c, from, player);
      return true;
    }

    // Rule 6.3: a burning ship loses another 10% every time it moves — sailing
    // on fans the flames. An untouched ship moves for free.
    this.updatePlayer(player, (p) => {
      const health = p.health < FULL_HEALTH ? Math.max(p.health - BURN_PER_MOVE, 0) : p.health;
      return { ...p, ship: c, health, shipDestroyed: p.shipDestroyed || health === 0 };
    });

    // Rule 6.6: burning down to 0% loses the game for its owner.
    if (this.players()[player].shipDestroyed) {
      this.endGame(other(player));
      return true;
    }

    this.endTurn();
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
          { ...a, health: 0, shipDestroyed: true },
          { ...b, health: 0, shipDestroyed: true },
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
