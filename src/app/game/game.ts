import { Component, computed, inject } from '@angular/core';
import { BOARD_H, BOARD_W, GameService, PlayerId } from './game.service';

interface CellVM {
  x: number;
  y: number;
  destroyed: boolean;
  hasShip: boolean;
  shipDestroyed: boolean;
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
    const isMyTurn = this.game.currentPlayer() === id;
    const moveTargets =
      this.game.phase() === 'move' && isMyTurn ? this.game.legalMoves(id) : [];

    const cells: CellVM[] = [];
    for (let y = 0; y < BOARD_H; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        const hasShip = state.ship?.x === x && state.ship.y === y;
        cells.push({
          x,
          y,
          destroyed: state.destroyed[y * BOARD_W + x],
          hasShip,
          shipDestroyed: hasShip && state.shipDestroyed,
          exposed: state.exposedAt?.x === x && state.exposedAt.y === y && !hasShip,
          moveTarget: moveTargets.some((m) => m.x === x && m.y === y),
        });
      }
    }
    return cells;
  }
}
