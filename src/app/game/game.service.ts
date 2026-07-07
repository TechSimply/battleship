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

export interface PlayerState {
  /** Each player has exactly one ship; null until placed. */
  ship: Coord | null;
  shipDestroyed: boolean;
  /** Square the opponent saw when this player last fired (rule 5.2). */
  exposedAt: Coord | null;
  /** Bombed squares are unusable forever (rule 5.3); indexed y * BOARD_W + x. */
  destroyed: boolean[];
}

const idx = (c: Coord) => c.y * BOARD_W + c.x;
const sameCell = (a: Coord, b: Coord) => a.x === b.x && a.y === b.y;

function emptyPlayer(): PlayerState {
  return {
    ship: null,
    shipDestroyed: false,
    exposedAt: null,
    destroyed: Array(BOARD_W * BOARD_H).fill(false),
  };
}

@Injectable({ providedIn: 'root' })
export class GameService {
  readonly phase = signal<Phase>('placement');
  /** Whose turn it is during fire/move. Player 0 (the host) fires first. */
  readonly currentPlayer = signal<PlayerId>(0);
  readonly winner = signal<PlayerId | null>(null);
  readonly players = signal<[PlayerState, PlayerState]>([emptyPlayer(), emptyPlayer()]);
  /** Rule 8: running score within the session — one point per victory. */
  readonly scores = signal<[number, number]>([0, 0]);

  readonly bothPlaced = computed(() => this.players().every((p) => p.ship !== null));

  /**
   * Transient: the last shot fired, for the tracer animation (from the
   * shooter's exposed square to the bombed square). `n` makes each shot a
   * distinct value so effects fire even when coordinates repeat.
   */
  readonly lastShot = signal<{
    shooter: PlayerId;
    from: Coord | null;
    to: Coord;
    n: number;
  } | null>(null);

  /**
   * Interpret a tap by `actor` on `board` as a game action, apply it, and
   * return it so the caller can forward it to the other device.
   * Returns null when the tap is not a legal action right now.
   */
  tryLocal(actor: PlayerId, board: PlayerId, c: Coord): GameAction | null {
    let action: GameAction | null = null;
    switch (this.phase()) {
      case 'placement':
        if (board === actor) action = { kind: 'place', player: actor, c };
        break;
      case 'fire':
        if (board !== actor && actor === this.currentPlayer())
          action = { kind: 'fire', player: actor, c };
        break;
      case 'move':
        if (board === actor && actor === this.currentPlayer())
          action = { kind: 'move', player: actor, c };
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
  neighborsOf(c: Coord, destroyed: boolean[]): Coord[] {
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

  /** Legal one-square moves: all 8 bordering squares (rule 3) that are usable (rule 5.3). */
  legalMoves(player: PlayerId): Coord[] {
    const state = this.players()[player];
    if (!state.ship) return [];
    return this.neighborsOf(state.ship, state.destroyed);
  }

  /**
   * Squares where `player`'s ship could possibly be right now, deducible from
   * public information alone — no peeking at the real `ship` field. Firing
   * exposes the exact square (rule 5.2); after that the ship either had to
   * move to a still-usable bordering square (rule 5.4) or, if none existed,
   * never moved at all. Everything else is provably impossible. Used by the
   * computer opponent so it never wastes a shot on a square the rules have
   * already ruled out, while still choosing randomly among what's left.
   */
  possibleShipSquares(player: PlayerId): Coord[] {
    const state = this.players()[player];
    if (!state.exposedAt) {
      const all: Coord[] = [];
      for (let y = 0; y < BOARD_H; y++) {
        for (let x = 0; x < BOARD_W; x++) {
          if (!state.destroyed[y * BOARD_W + x]) all.push({ x, y });
        }
      }
      return all;
    }
    const moved = this.neighborsOf(state.exposedAt, state.destroyed);
    return moved.length > 0 ? moved : [state.exposedAt];
  }

  /** Reset the round for a rematch; the session score is kept (rule 8). */
  reset(): void {
    this.phase.set('placement');
    this.currentPlayer.set(0);
    this.winner.set(null);
    this.players.set([emptyPlayer(), emptyPlayer()]);
  }

  /** Clear the score — a fresh session (rule 8 scope is one game id). */
  resetScores(): void {
    this.scores.set([0, 0]);
  }

  /** Rule 4: both players place their own ship; done once each has placed. */
  private placeShip(player: PlayerId, c: Coord): boolean {
    if (this.phase() !== 'placement') return false;
    if (this.players()[player].ship) return false; // already placed
    this.updatePlayer(player, (p) => ({ ...p, ship: c }));

    if (this.bothPlaced()) {
      this.currentPlayer.set(0);
      this.phase.set('fire');
    }
    return true;
  }

  private fireAt(shooter: PlayerId, c: Coord): boolean {
    if (this.phase() !== 'fire' || shooter !== this.currentPlayer()) return false;
    const enemy: PlayerId = shooter === 0 ? 1 : 0;
    const enemyState = this.players()[enemy];
    if (enemyState.destroyed[idx(c)]) return false; // square already bombed

    const firedFrom = this.players()[shooter].ship;
    this.lastShot.update((prev) => ({
      shooter,
      from: firedFrom ? { ...firedFrom } : null,
      to: { ...c },
      n: (prev?.n ?? 0) + 1,
    }));

    this.updatePlayer(enemy, (p) => {
      const destroyed = [...p.destroyed];
      destroyed[idx(c)] = true;
      const hit = !!p.ship && sameCell(p.ship, c);
      return { ...p, destroyed, shipDestroyed: p.shipDestroyed || hit };
    });

    // Rule 6: if the ship is hit, game over. Rule 8: winner scores a point.
    if (this.players()[enemy].shipDestroyed) {
      this.winner.set(shooter);
      this.scores.update((s) => {
        const next: [number, number] = [...s];
        next[shooter] += 1;
        return next;
      });
      this.phase.set('gameover');
      return true;
    }

    // Rule 5.2: firing exposes the square it was fired from.
    this.updatePlayer(shooter, (p) => ({ ...p, exposedAt: p.ship ? { ...p.ship } : null }));

    // Rule 5.4: the shooter must move, if any usable square borders it.
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
    this.updatePlayer(player, (p) => ({ ...p, ship: c }));
    this.endTurn();
    return true;
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
