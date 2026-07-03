import { Injectable, computed, signal } from '@angular/core';

export const BOARD_W = 5;
export const BOARD_H = 7;
export const SHIPS_PER_PLAYER = 2;

/**
 * Per the design notes, the game ends as soon as any ship is hit.
 * Flip to false to require destroying all of a player's ships instead.
 */
export const WIN_ON_FIRST_HIT = true;

export type PlayerId = 0 | 1;
export type Phase = 'placement' | 'select-ship' | 'fire' | 'move' | 'gameover';

export interface Coord {
  x: number;
  y: number;
}

export interface Ship {
  id: number;
  pos: Coord;
  /** Position the opponent saw when this ship last fired. */
  exposedAt: Coord | null;
  destroyed: boolean;
}

export interface PlayerState {
  ships: Ship[];
  /** Squares hit by a bomb are unusable forever; indexed y * BOARD_W + x. */
  destroyed: boolean[];
}

const idx = (c: Coord) => c.y * BOARD_W + c.x;
const sameCell = (a: Coord, b: Coord) => a.x === b.x && a.y === b.y;

function emptyPlayer(): PlayerState {
  return { ships: [], destroyed: Array(BOARD_W * BOARD_H).fill(false) };
}

@Injectable({ providedIn: 'root' })
export class GameService {
  readonly phase = signal<Phase>('placement');
  readonly currentPlayer = signal<PlayerId>(0);
  readonly winner = signal<PlayerId | null>(null);
  readonly selectedShipId = signal<number | null>(null);
  readonly players = signal<[PlayerState, PlayerState]>([emptyPlayer(), emptyPlayer()]);

  readonly message = computed(() => {
    const p = `Player ${this.currentPlayer() + 1}`;
    switch (this.phase()) {
      case 'placement': {
        const placed = this.players()[this.currentPlayer()].ships.length;
        return `${p}: tap your board to place your ships (${placed}/${SHIPS_PER_PLAYER})`;
      }
      case 'select-ship':
        return `${p}: tap one of your ships to fire with`;
      case 'fire':
        return `${p}: tap a square on the enemy board to fire (or tap another of your ships)`;
      case 'move':
        return `${p}: your ship is exposed — move it one square`;
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
      case 'select-ship':
      case 'fire':
        if (board === me) this.selectShip(c);
        else if (this.phase() === 'fire') this.fireAt(c);
        break;
      case 'move':
        if (board === me) this.moveTo(c);
        break;
    }
  }

  /** Legal one-square moves (up/down/left/right) for a ship on its own board. */
  legalMoves(player: PlayerId, ship: Ship): Coord[] {
    const state = this.players()[player];
    const candidates: Coord[] = [
      { x: ship.pos.x + 1, y: ship.pos.y },
      { x: ship.pos.x - 1, y: ship.pos.y },
      { x: ship.pos.x, y: ship.pos.y + 1 },
      { x: ship.pos.x, y: ship.pos.y - 1 },
    ];
    return candidates.filter(
      (c) =>
        c.x >= 0 &&
        c.x < BOARD_W &&
        c.y >= 0 &&
        c.y < BOARD_H &&
        !state.destroyed[idx(c)] &&
        !state.ships.some((s) => !s.destroyed && sameCell(s.pos, c)),
    );
  }

  reset(): void {
    this.phase.set('placement');
    this.currentPlayer.set(0);
    this.winner.set(null);
    this.selectedShipId.set(null);
    this.players.set([emptyPlayer(), emptyPlayer()]);
  }

  private placeShip(c: Coord): void {
    const me = this.currentPlayer();
    const state = this.players()[me];
    if (state.ships.length >= SHIPS_PER_PLAYER) return;
    if (state.ships.some((s) => sameCell(s.pos, c))) return;

    const ship: Ship = { id: state.ships.length, pos: c, exposedAt: null, destroyed: false };
    this.updatePlayer(me, (p) => ({ ...p, ships: [...p.ships, ship] }));

    if (this.players()[me].ships.length === SHIPS_PER_PLAYER) {
      if (me === 0) {
        this.currentPlayer.set(1);
      } else {
        this.currentPlayer.set(0);
        this.phase.set('select-ship');
      }
    }
  }

  private selectShip(c: Coord): void {
    const me = this.currentPlayer();
    const ship = this.players()[me].ships.find((s) => !s.destroyed && sameCell(s.pos, c));
    if (!ship) return;
    this.selectedShipId.set(ship.id);
    this.phase.set('fire');
  }

  private fireAt(c: Coord): void {
    const me = this.currentPlayer();
    const enemy: PlayerId = me === 0 ? 1 : 0;
    const enemyState = this.players()[enemy];
    if (enemyState.destroyed[idx(c)]) return; // square already bombed

    this.updatePlayer(enemy, (p) => {
      const destroyed = [...p.destroyed];
      destroyed[idx(c)] = true;
      return {
        ...p,
        destroyed,
        ships: p.ships.map((s) => (sameCell(s.pos, c) ? { ...s, destroyed: true } : s)),
      };
    });

    const hit = enemyState.ships.some((s) => !s.destroyed && sameCell(s.pos, c));
    const enemyShipsLeft = this.players()[enemy].ships.some((s) => !s.destroyed);
    if (hit && (WIN_ON_FIRST_HIT || !enemyShipsLeft)) {
      this.winner.set(me);
      this.phase.set('gameover');
      return;
    }

    // Firing exposes the shooter's position, then it must move one square if it can.
    const shipId = this.selectedShipId()!;
    this.updatePlayer(me, (p) => ({
      ...p,
      ships: p.ships.map((s) => (s.id === shipId ? { ...s, exposedAt: { ...s.pos } } : s)),
    }));

    const firingShip = this.players()[me].ships.find((s) => s.id === shipId)!;
    if (this.legalMoves(me, firingShip).length === 0) {
      this.endTurn();
    } else {
      this.phase.set('move');
    }
  }

  private moveTo(c: Coord): void {
    const me = this.currentPlayer();
    const shipId = this.selectedShipId()!;
    const ship = this.players()[me].ships.find((s) => s.id === shipId)!;
    if (!this.legalMoves(me, ship).some((m) => sameCell(m, c))) return;

    this.updatePlayer(me, (p) => ({
      ...p,
      ships: p.ships.map((s) => (s.id === shipId ? { ...s, pos: c } : s)),
    }));
    this.endTurn();
  }

  private endTurn(): void {
    this.selectedShipId.set(null);
    this.currentPlayer.update((p) => (p === 0 ? 1 : 0));
    this.phase.set('select-ship');
  }

  private updatePlayer(id: PlayerId, fn: (p: PlayerState) => PlayerState): void {
    this.players.update((players) => {
      const next: [PlayerState, PlayerState] = [...players];
      next[id] = fn(players[id]);
      return next;
    });
  }
}
