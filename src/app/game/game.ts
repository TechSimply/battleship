import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
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

/**
 * A rocket's burning exhaust, left on screen until its owner fires again.
 * `from`/`to` are kept so the trail can be re-measured when the boards resize;
 * `transform`/`width` are what the template actually draws.
 */
interface TrailVM {
  /** The shot's sequence number: a fresh id gives the next rocket of the same
   * player a brand-new element, so its flame is drawn from scratch. */
  id: number;
  shooter: PlayerId;
  /** True when this device's own rocket left the trail (picks the flame colour
   * and which board each end of the trail sits on). */
  mine: boolean;
  from: Coord;
  to: Coord;
  transform: string;
  width: number;
}

/** The in-flight rocket; null between shots. */
interface RocketVM {
  mine: boolean;
  transform: string;
}

/** Pixel geometry of one shot, measured inside the shot layer. */
interface ShotGeom {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  angle: number;
  len: number;
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
  private readonly destroyRef = inject(DestroyRef);

  /**
   * At most one burning trail per player — the newest rocket replaces it.
   * Rendered from the template (not appended by hand) so the component's
   * emulated style encapsulation actually reaches the flame.
   */
  protected readonly trails = signal<TrailVM[]>([]);
  protected readonly rocket = signal<RocketVM | null>(null);
  private rocketTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    // Tracer: fly a rocket from the shooter's (exposed) square to the bombed
    // square, so the exposure visibly originates from the shot.
    effect(() => {
      const shot = this.game.lastShot();
      if (shot) untracked(() => this.animateShot(shot));
    });

    // A new round starts from clean water: no rockets have been fired yet.
    effect(() => {
      if (this.game.phase() === 'placement') untracked(() => this.clearTrails());
    });

    // Trails are positioned in pixels, so they have to be re-measured whenever
    // the boards change size (rotation, keyboard, browser chrome collapsing).
    afterNextRender(() => {
      const obs = new ResizeObserver(() => this.relayoutTrails());
      obs.observe(this.host.nativeElement);
      this.destroyRef.onDestroy(() => {
        obs.disconnect();
        clearTimeout(this.rocketTimer);
      });
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

  /**
   * Fly a rocket across the boards and leave its exhaust burning behind it.
   * State markers land with a matching delay; the trail stays put until the
   * same player fires again (each shooter owns exactly one trail).
   */
  private animateShot(shot: {
    shooter: PlayerId;
    from: Coord | null;
    to: Coord;
    n: number;
  }): void {
    if (!shot.from) return;
    const layer = this.shotLayer();
    const mine = shot.shooter === this.session.myPlayer();
    const geom = layer && this.measure(layer, shot.from, shot.to, mine);
    if (!geom) return;

    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const launch = `translate(${geom.ax}px, ${geom.ay}px) rotate(${geom.angle}deg)`;

    // The flame replaces this shooter's previous one and starts with no length:
    // it is painted on as the rocket travels, growing to the full flight
    // distance over exactly the flight time (the width transition in game.scss).
    this.trails.update((trails) => [
      ...trails.filter((t) => t.shooter !== shot.shooter),
      {
        id: shot.n,
        shooter: shot.shooter,
        mine,
        from: shot.from!,
        to: shot.to,
        transform: launch,
        width: still ? geom.len : 0,
      },
    ]);
    if (still) return; // the standing trail tells the story; nothing flies

    clearTimeout(this.rocketTimer);
    this.rocket.set({ mine, transform: launch });
    // Two frames: the launch position has to be rendered and painted before the
    // target transform can transition away from it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const impact = `translate(${geom.bx}px, ${geom.by}px) rotate(${geom.angle}deg)`;
        this.rocket.update((r) => (r ? { ...r, transform: impact } : r));
        this.trails.update((trails) =>
          trails.map((t) => (t.id === shot.n ? { ...t, width: geom.len } : t)),
        );
      }),
    );
    // The rocket is consumed on impact — normally by its own transitionend,
    // with this as the safety net if that event never arrives.
    this.rocketTimer = setTimeout(() => this.rocket.set(null), 1000);
  }

  /** Re-measure every standing trail after the boards change size. */
  private relayoutTrails(): void {
    const layer = this.shotLayer();
    if (!layer || this.trails().length === 0) return;
    this.trails.update((trails) =>
      trails.flatMap((t) => {
        const geom = this.measure(layer, t.from, t.to, t.mine);
        if (!geom) return [];
        return [
          {
            ...t,
            transform: `translate(${geom.ax}px, ${geom.ay}px) rotate(${geom.angle}deg)`,
            width: geom.len,
          },
        ];
      }),
    );
  }

  private clearTrails(): void {
    this.trails.set([]);
    this.rocket.set(null);
  }

  private shotLayer(): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>('#shot-layer');
  }

  /**
   * Centre-to-centre geometry of a shot, in shot-layer coordinates. A shot
   * always crosses the two boards: the shooter's square is on their own board,
   * the target square on the board being bombed.
   */
  private measure(layer: HTMLElement, from: Coord, to: Coord, mine: boolean): ShotGeom | null {
    const root = this.host.nativeElement;
    const fromEl = root.querySelector(`#${mine ? 'fleet' : 'enemy'}-cell-${from.x}-${from.y}`);
    const toEl = root.querySelector(`#${mine ? 'enemy' : 'fleet'}-cell-${to.x}-${to.y}`);
    if (!fromEl || !toEl) return null;

    const lr = layer.getBoundingClientRect();
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    const ax = a.left + a.width / 2 - lr.left;
    const ay = a.top + a.height / 2 - lr.top;
    const bx = b.left + b.width / 2 - lr.left;
    const by = b.top + b.height / 2 - lr.top;
    return {
      ax,
      ay,
      bx,
      by,
      angle: (Math.atan2(by - ay, bx - ax) * 180) / Math.PI,
      len: Math.hypot(bx - ax, by - ay),
    };
  }
}
