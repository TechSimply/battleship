import { Injectable, computed, signal } from '@angular/core';

export const BOARD_W = 5;
export const BOARD_H = 7;

export type PlayerId = 0 | 1;
export type Phase = 'placement' | 'fire' | 'move' | 'gameover';

export interface Coord {
  x: number;
  y: number;
}

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
  readonly currentPlayer = signal<PlayerId>(0);
  readonly winner = signal<PlayerId | null>(null);
  readonly players = signal<[PlayerState, PlayerState]>([emptyPlayer(), emptyPlayer()]);

  readonly message = computed(() => {
    const p = `Player ${this.currentPlayer() + 1}`;
    switch (this.phase()) {
      case 'placement':
        return `${p}: tap your board to place your ship`;
      case 'fire':
        return `${p}: fire! Tap a square on Player ${this.currentPlayer() === 0 ? 2 : 1}'s board`;
      case 'move':
        return `${p}: your position is exposed — move your ship one square`;
      case 'gameover':
        return `Player ${this.winner()! + 1} wins!`;
    }
  });

  handleCellClick(board: PlayerId, c: Coord): void {
    const me = this.currentPlayer();
    switch (this.phase()) {
      case 'placement':
        if (board === me) this.placeShip(c);
        break;
      case 'fire':
        if (board !== me) this.fireAt(c);
        break;
      case 'move':
        if (board === me) this.moveTo(c);
        break;
    }
  }

  /** Legal one-square moves: all 8 bordering squares (rule 3) that are usable (rule 5.3). */
  legalMoves(player: PlayerId): Coord[] {
    const state = this.players()[player];
    if (!state.ship) return [];
    const moves: Coord[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const c = { x: state.ship.x + dx, y: state.ship.y + dy };
        if (c.x < 0 || c.x >= BOARD_W || c.y < 0 || c.y >= BOARD_H) continue;
        if (state.destroyed[idx(c)]) continue;
        moves.push(c);
      }
    }
    return moves;
  }

  reset(): void {
    this.phase.set('placement');
    this.currentPlayer.set(0);
    this.winner.set(null);
    this.players.set([emptyPlayer(), emptyPlayer()]);
  }

  private placeShip(c: Coord): void {
    const me = this.currentPlayer();
    this.updatePlayer(me, (p) => ({ ...p, ship: c }));

    if (me === 0) {
      this.currentPlayer.set(1);
    } else {
      this.currentPlayer.set(0);
      this.phase.set('fire');
    }
  }

  private fireAt(c: Coord): void {
    const me = this.currentPlayer();
    const enemy: PlayerId = me === 0 ? 1 : 0;
    const enemyState = this.players()[enemy];
    if (enemyState.destroyed[idx(c)]) return; // square already bombed

    this.updatePlayer(enemy, (p) => {
      const destroyed = [...p.destroyed];
      destroyed[idx(c)] = true;
      const hit = !!p.ship && sameCell(p.ship, c);
      return { ...p, destroyed, shipDestroyed: p.shipDestroyed || hit };
    });

    // Rule 6: if the ship is hit, game over.
    if (this.players()[enemy].shipDestroyed) {
      this.winner.set(me);
      this.phase.set('gameover');
      return;
    }

    // Rule 5.2: firing exposes the square it was fired from.
    this.updatePlayer(me, (p) => ({ ...p, exposedAt: p.ship ? { ...p.ship } : null }));

    // Rule 5.4: the shooter must move, if any usable square borders it.
    if (this.legalMoves(me).length === 0) {
      this.endTurn();
    } else {
      this.phase.set('move');
    }
  }

  private moveTo(c: Coord): void {
    const me = this.currentPlayer();
    if (!this.legalMoves(me).some((m) => sameCell(m, c))) return;
    this.updatePlayer(me, (p) => ({ ...p, ship: c }));
    this.endTurn();
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
