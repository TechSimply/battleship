import { Component, computed, inject } from '@angular/core';
import { BOARD_H, BOARD_W, GameService, PlayerId } from './game.service';
import { SessionService } from './session.service';

interface CellVM {
  x: number;
  y: number;
  destroyed: boolean;
  hasShip: boolean;
  shipDestroyed: boolean;
  exposed: boolean;
  moveTarget: boolean;
}

interface BoardVM {
  id: PlayerId;
  mine: boolean;
  cells: CellVM[];
}

@Component({
  selector: 'app-game',
  host: { id: 'game-component' },
  templateUrl: './game.html',
  styleUrl: './game.scss',
})
export class Game {
  protected readonly game = inject(GameService);
  protected readonly session = inject(SessionService);

  protected readonly myTurn = computed(
    () => this.game.currentPlayer() === this.session.myPlayer(),
  );

  // Rule 8: session score, shown from this device's point of view.
  protected readonly myScore = computed(() => this.game.scores()[this.session.myPlayer()]);
  protected readonly enemyScore = computed(
    () => this.game.scores()[this.session.myPlayer() === 0 ? 1 : 0],
  );

  // Each device shows its own perspective: enemy waters on top, own fleet below.
  protected readonly boards = computed<BoardVM[]>(() => {
    const me = this.session.myPlayer();
    const enemy: PlayerId = me === 0 ? 1 : 0;
    return [this.buildBoard(enemy, false), this.buildBoard(me, true)];
  });

  protected readonly message = computed(() => {
    const me = this.session.myPlayer();
    switch (this.game.phase()) {
      case 'placement':
        return this.game.players()[me].ship
          ? 'Waiting for your opponent to place their ship…'
          : 'Tap your fleet board to place your ship';
      case 'fire':
        return this.myTurn() ? 'Fire! Tap a square in enemy waters' : 'Enemy is taking aim…';
      case 'move':
        return this.myTurn()
          ? 'Your position is exposed — move your ship one square'
          : 'Enemy ship is repositioning…';
      case 'gameover':
        return this.game.winner() === me
          ? 'Victory! Enemy ship destroyed 🎉'
          : 'Your ship was destroyed 💥';
    }
  });

  protected onCellClick(board: BoardVM, cell: CellVM): void {
    this.session.act(board.id, { x: cell.x, y: cell.y });
  }

  protected isActiveBoard(board: BoardVM): boolean {
    switch (this.game.phase()) {
      case 'placement':
        return board.mine && !this.game.players()[board.id].ship;
      case 'fire':
        return this.myTurn() && !board.mine;
      case 'move':
        return this.myTurn() && board.mine;
      default:
        return false;
    }
  }

  private buildBoard(id: PlayerId, mine: boolean): BoardVM {
    const state = this.game.players()[id];
    const gameover = this.game.phase() === 'gameover';
    // Rule 4: the ship is not visible to the opposing player (until it's hit
    // or the game is over, when both fleets are revealed).
    const showShip = mine || gameover || state.shipDestroyed;
    const moveTargets =
      mine && this.game.phase() === 'move' && this.myTurn() ? this.game.legalMoves(id) : [];

    const cells: CellVM[] = [];
    for (let y = 0; y < BOARD_H; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        const hasShip = state.ship?.x === x && state.ship.y === y;
        const shipVisible = hasShip && showShip;
        cells.push({
          x,
          y,
          destroyed: state.destroyed[y * BOARD_W + x],
          hasShip: shipVisible,
          shipDestroyed: hasShip && state.shipDestroyed,
          // The 🎯 marker yields only to a ship actually drawn in the cell —
          // the enemy must see the exposure even while the ship still sits there.
          exposed: state.exposedAt?.x === x && state.exposedAt.y === y && !shipVisible,
          moveTarget: moveTargets.some((m) => m.x === x && m.y === y),
        });
      }
    }
    return { id, mine, cells };
  }
}
