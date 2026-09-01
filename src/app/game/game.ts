import {
  Component,
  DestroyRef,
  ElementRef,
  afterEveryRender,
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
  /** Enemy waters: a square the enemy ship could still be on (rules 5.2/5.4). */
  hint: boolean;
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
  /** True while the flame is still being painted on behind the rocket: a
   * re-measure must leave its width alone or the grow animation is cut short. */
  growing: boolean;
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

/** Bounds for the measured board size, in px: playable floor, tidy ceiling. */
const MIN_BOARD = 32;
const MAX_BOARD = 420;
/**
 * Pixels held back from the measured fit. Board and panel geometry is snapped
 * to device pixels, so a board sized to the last hundredth of the space can
 * still land a fraction over it once painted — and `.boards` clips that
 * overflow (top *and* bottom, it centres its content) rather than scrolling it.
 */
const FIT_SLACK = 1;
/** Re-measure passes per fit; see `fitBoards`. Two is normally plenty. */
const FIT_PASSES = 3;

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

    // Keep the boards fitted to the leftover space after every render — the
    // status text can rewrap and the post-game button comes and goes. Standing
    // trails are anchored to cell centres in pixels, so every refit has to be
    // followed by a re-measure or the flames keep the geometry of the board
    // size they were fired at.
    afterEveryRender(() => this.fitAndRealign());

    // Viewport changes (rotation, browser chrome, on-screen keyboard) don't
    // run change detection, so listen for them directly.
    const refit = () => this.fitAndRealign();
    addEventListener('resize', refit);
    addEventListener('orientationchange', refit);
    visualViewport?.addEventListener('resize', refit);
    this.destroyRef.onDestroy(() => {
      removeEventListener('resize', refit);
      removeEventListener('orientationchange', refit);
      visualViewport?.removeEventListener('resize', refit);
      clearTimeout(this.rocketTimer);
    });
  }

  protected readonly myTurn = computed(
    () => this.game.currentPlayer() === this.session.myPlayer(),
  );

  /** The opponent's app is closed / off the link while a game is live. */
  protected readonly opponentAway = computed(
    () => this.session.opponentPresent() === false && this.session.state() === 'playing',
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
    // Firebase presence notices a closed app a moment before the data channel
    // does, so say so rather than leaving the player staring at a dead board.
    if (this.opponentAway()) return 'Opponent left the game';
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

    // Where the enemy ship must be, deduced from public state alone: firing
    // exposed their square (rule 5.2) and the forced move (rule 5.4) put them
    // on one of its usable neighbours. The bot already fires by this same
    // deduction, so showing it just spares the player the arithmetic — it
    // reveals nothing they could not work out from the board. Only while
    // choosing a shot, and only once they have fired: before that every
    // unbombed square qualifies and the highlight would be noise.
    const hints =
      !mine && this.game.phase() === 'fire' && this.myTurn() && state.exposedAt
        ? this.game.possibleShipSquares(id)
        : [];

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
          hint: hints.some((h) => h.x === x && h.y === y),
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
   * Rule 2.2's two stacked boards must share one screen with no scrolling.
   * `.boards` is the flex row that absorbs whatever height the chrome leaves
   * over, so measuring it needs no hardcoded chrome estimate: the boards are
   * sized to exactly half of that space (minus one board panel's own padding
   * and header), and shrink — "zoom out" — as the viewport gets smaller.
   *
   * Everything is measured fractionally and re-measured after being applied.
   * `offsetWidth`/`offsetHeight` round to whole pixels, and a panel that
   * rounds down leaves the pair a hair too tall for the row; the board's own
   * height is likewise not exactly `--board-size`, since its four
   * `aspect-ratio: 1` rows each snap to the device pixel grid. Either way the
   * excess is invisible in the numbers but not on screen: `.boards` centres
   * its content and hides the overflow, so a fit that misses by a couple of
   * pixels quietly shaves the top board's header and the bottom board's last
   * row — the exact symptom this loop exists to prevent. Correcting against
   * the applied size absorbs all of it, whatever the device rounds to.
   */
  private fitBoards(): void {
    const boards = this.host.nativeElement.querySelector<HTMLElement>('#boards');
    const wrap = boards?.querySelector<HTMLElement>('.board-wrap');
    const board = boards?.querySelector<HTMLElement>('.board');
    if (!boards || !wrap || !board) return;

    const free = boards.getBoundingClientRect();
    if (!free.width || !free.height) return; // not laid out (or hidden) yet
    const gap = parseFloat(getComputedStyle(boards).rowGap) || 0;

    let applied = parseFloat(boards.style.getPropertyValue('--board-size')) || 0;
    for (let pass = 0; pass < FIT_PASSES; pass++) {
      const wrapBox = wrap.getBoundingClientRect();
      const boardBox = board.getBoundingClientRect();
      // What one panel costs around its board, measured against the board's
      // *width* — that is exactly `--board-size` (the board is border-box),
      // so any height the board carries beyond its own square is counted here
      // as panel cost instead of being assumed away.
      const panelX = wrapBox.width - boardBox.width;
      const panelY = wrapBox.height - boardBox.width;

      const room = Math.min(free.width - panelX, (free.height - gap) / 2 - panelY, MAX_BOARD);
      const size = Math.max(Math.floor(room - FIT_SLACK), MIN_BOARD);
      if (size === applied) return; // settled — the panels measure the same as they render
      applied = size;
      boards.style.setProperty('--board-size', `${size}px`);
      // The next pass re-reads the panel against the size just written, so a
      // chrome that shifted with it (a rounded header, a font that loaded) is
      // taken off the next estimate rather than pushed off the screen.
    }
  }

  /**
   * Fit the boards, then put the standing flames back on the cell centres they
   * were fired at. Order matters: `fitBoards()` can change `--board-size`, and
   * the trails are measured against the size it leaves behind.
   */
  private fitAndRealign(): void {
    this.fitBoards();
    this.relayoutTrails();
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
    const from = shot.from;
    const layer = this.shotLayer();
    if (!from || !layer) return;
    const mine = shot.shooter === this.session.myPlayer();
    const geom = this.measure(layer, from, shot.to, mine);
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
        from,
        to: shot.to,
        transform: launch,
        width: still ? geom.len : 0,
        growing: !still,
      },
    ]);
    if (still) return; // the standing trail tells the story; nothing flies

    clearTimeout(this.rocketTimer);
    this.rocket.set({ mine, transform: launch });
    // Two frames: the launch position has to be rendered and painted before the
    // target transform can transition away from it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // Re-measure rather than reuse the launch geometry: firing changes the
        // status line and can refit the boards, moving every cell centre.
        const now = this.measure(layer, from, shot.to, mine) ?? geom;
        this.rocket.update((r) =>
          r ? { ...r, transform: `translate(${now.bx}px, ${now.by}px) rotate(${now.angle}deg)` } : r,
        );
        this.trails.update((trails) =>
          trails.map((t) =>
            t.id === shot.n
              ? {
                  ...t,
                  transform: `translate(${now.ax}px, ${now.ay}px) rotate(${now.angle}deg)`,
                  width: now.len,
                  growing: false,
                }
              : t,
          ),
        );
      }),
    );
    // The rocket is consumed on impact — normally by its own transitionend,
    // with this as the safety net if that event never arrives.
    this.rocketTimer = setTimeout(() => this.rocket.set(null), 1000);
  }

  /**
   * Re-anchor every standing trail to the cell centres it was fired between.
   * Runs after each render, so it must write only when the geometry actually
   * moved — an unconditional signal write here would schedule the next render
   * and spin forever.
   */
  private relayoutTrails(): void {
    const layer = this.shotLayer();
    const current = this.trails();
    if (!layer || current.length === 0) return;

    let moved = false;
    const next = current.flatMap((t) => {
      const geom = this.measure(layer, t.from, t.to, t.mine);
      if (!geom) {
        moved = true; // the board it was drawn across is gone
        return [];
      }
      const transform = `translate(${geom.ax}px, ${geom.ay}px) rotate(${geom.angle}deg)`;
      // A trail still being painted on keeps its width: the rocket's own frame
      // sets the final length when it lands.
      const width = t.growing ? t.width : geom.len;
      if (transform === t.transform && width === t.width) return [t];
      moved = true;
      return [{ ...t, transform, width }];
    });
    if (moved) this.trails.set(next);
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
