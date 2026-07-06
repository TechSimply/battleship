import { Component, ElementRef, computed, effect, inject, untracked } from '@angular/core';
import { BOARD_H, BOARD_W, Coord, GameService, PlayerId } from './game.service';
import { SessionService } from './session.service';

interface CellVM {
  x: number;
  y: number;
  destroyed: boolean;
  hasShip: boolean;
  shipDestroyed: boolean;
  exposed: boolean;
  moveTarget: boolean;
  /** Rotation (deg) of the move arrow — points away from the ship. */
  moveDir: number;
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
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    // Tracer: fly a shell from the shooter's (exposed) square to the bombed
    // square, so the exposure visibly originates from the shot.
    effect(() => {
      const shot = this.game.lastShot();
      if (shot) untracked(() => this.animateShot(shot));
    });
  }

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
    if (this.session.state() === 'reconnecting') return 'Connection lost — reconnecting';
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
          ? 'Victory! Enemy ship destroyed'
          : 'Your ship was destroyed';
    }
  });

  protected onCellClick(board: BoardVM, cell: CellVM): void {
    this.session.act(board.id, { x: cell.x, y: cell.y });
  }

  protected isActiveBoard(board: BoardVM): boolean {
    if (this.session.state() !== 'playing') return false;
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
          // The exposure reticle yields only to a ship actually drawn in the cell —
          // the enemy must see the exposure even while the ship still sits there.
          exposed: state.exposedAt?.x === x && state.exposedAt.y === y && !shipVisible,
          moveTarget: moveTargets.some((m) => m.x === x && m.y === y),
          // Arrow points from the ship outward to this escape square.
          moveDir: state.ship
            ? (Math.atan2(y - state.ship.y, x - state.ship.x) * 180) / Math.PI
            : 0,
        });
      }
    }
    return { id, mine, cells };
  }

  /** Fly a shell across the boards; state markers land with a matching delay. */
  private animateShot(shot: { shooter: PlayerId; from: Coord | null; to: Coord }): void {
    if (!shot.from) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const root = this.host.nativeElement;
    const layer = root.querySelector<HTMLElement>('#shot-layer');
    const mineShot = shot.shooter === this.session.myPlayer();
    const fromEl = root.querySelector(
      `#${mineShot ? 'fleet' : 'enemy'}-cell-${shot.from.x}-${shot.from.y}`,
    );
    const toEl = root.querySelector(
      `#${mineShot ? 'enemy' : 'fleet'}-cell-${shot.to.x}-${shot.to.y}`,
    );
    if (!layer || !fromEl || !toEl) return;

    const lr = layer.getBoundingClientRect();
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    const ax = a.left + a.width / 2 - lr.left;
    const ay = a.top + a.height / 2 - lr.top;
    const bx = b.left + b.width / 2 - lr.left;
    const by = b.top + b.height / 2 - lr.top;
    const angle = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;

    const shell = document.createElement('div');
    shell.className = 'shell';
    shell.style.transform = `translate(${ax}px, ${ay}px) rotate(${angle}deg)`;
    layer.appendChild(shell);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        shell.style.transform = `translate(${bx}px, ${by}px) rotate(${angle}deg)`;
      }),
    );
    shell.addEventListener('transitionend', () => shell.remove());
    setTimeout(() => shell.remove(), 1000); // safety net if the event never fires
  }
}
