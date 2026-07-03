import { Component, computed, inject } from '@angular/core';
import { BOARD_H, BOARD_W, Coord, GameService, PlayerId } from './game.service';

interface CellVM {
  x: number;
  y: number;
  destroyed: boolean;
  hasShip: boolean;
  shipDestroyed: boolean;
  selected: boolean;
  exposed: boolean;
  moveTarget: boolean;
}

@Component({
  selector: 'app-game',
  templateUrl: './game.html',
  styleUrl: './game.scss',
})
export class Game {
  protected readonly game = inject(GameService);

  protected readonly boards = computed<[CellVM[], CellVM[]]>(() => [
    this.buildBoard(0),
    this.buildBoard(1),
  ]);

  protected onCellClick(board: number, cell: CellVM): void {
    this.game.handleCellClick(board as PlayerId, { x: cell.x, y: cell.y });
  }

  protected isActiveBoard(board: number): boolean {
    const me = this.game.currentPlayer();
    const phase = this.game.phase();
    if (phase === 'gameover') return false;
    if (phase === 'fire') return board !== me;
    return board === me;
  }

  private buildBoard(id: PlayerId): CellVM[] {
    const state = this.game.players()[id];
    const phase = this.game.phase();
    const isMyTurn = this.game.currentPlayer() === id;
    const selectedId = this.game.selectedShipId();

    const selectedShip =
      isMyTurn && selectedId !== null ? state.ships.find((s) => s.id === selectedId) : undefined;
    const moveTargets =
      phase === 'move' && selectedShip ? this.game.legalMoves(id, selectedShip) : [];

    const cells: CellVM[] = [];
    for (let y = 0; y < BOARD_H; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        const ship = state.ships.find((s) => s.pos.x === x && s.pos.y === y);
        cells.push({
          x,
          y,
          destroyed: state.destroyed[y * BOARD_W + x],
          hasShip: !!ship,
          shipDestroyed: !!ship?.destroyed,
          selected: !!ship && ship.id === selectedId && isMyTurn,
          exposed: state.ships.some(
            (s) => s.exposedAt?.x === x && s.exposedAt.y === y && !this.sameAsShip(s, x, y),
          ),
          moveTarget: moveTargets.some((m) => m.x === x && m.y === y),
        });
      }
    }
    return cells;
  }

  private sameAsShip(s: { pos: Coord }, x: number, y: number): boolean {
    return s.pos.x === x && s.pos.y === y;
  }
}
