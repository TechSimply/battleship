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
  /** Rule 5.3: bombed, and dead for both ships now (rule 2.3). */
  destroyed: boolean;
  /** My ship sits here (and, once the round is over, the enemy's too). */
  mine: boolean;
  enemy: boolean;
  /** Rule 6.2: hit but still afloat — that ship is drawn on fire. */
  burningMine: boolean;
  burningEnemy: boolean;
  /** Rule 11.3: both wrecks share this one square. */
  wreckMine: boolean;
  wreckEnemy: boolean;
  /** Rule 5.2: a square someone was seen firing from. */
  exposedMine: boolean;
  exposedEnemy: boolean;
  moveTarget: boolean;
  /** A square the enemy ship could still be on (rules 5.2/5.4). */
  hint: boolean;
  /** Rotation (deg) of the move arrow — points away from my ship. */
  moveDir: number;
  /** Health colour of whichever ship is drawn here (rule 6.4); '' if none. */
  color: string;
}

/** One player's health readout: the gauges above the board (rule 10). */
interface GaugeVM {
  mine: boolean;
  label: string;
  /** Rule 6: 100 → 50 on the first hit → −10 per move → 0 = wrecked. */
  health: number;
  /** The colour that health paints everything in (rule 6.4 / rule 10.3). */
  color: string;
  /** Rule 10.5: 1 all game, 0 once this ship is wrecked. */
  ships: number;
}

/**
 * Rule 6.4's ladder: green while whole, orange from the first hit, and
 * closer to the wreck's red with every 10% burnt away.
 */
const HEALTH_COLORS: Record<number, string> = {
  100: '#48e295',
  50: '#ffb03c',
  40: '#ff9a33',
  30: '#ff8730',
  20: '#ff732b',
  10: '#ff6128',
  0: '#ff5c4a',
};

export function healthColor(health: number): string {
  const step = Math.max(0, Math.min(100, Math.round(health / 10) * 10));
  // 60–90% can only be reached by a rules change; treat anything above the
  // first hit as untouched rather than leaving the colour undefined.
  return HEALTH_COLORS[step] ?? (step > 50 ? HEALTH_COLORS[100] : HEALTH_COLORS[50]);
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

  /** Rule 2.3: one united board, seen from this device's point of view. */
  protected readonly cells = computed<CellVM[]>(() => this.buildCells());

  /** Rule 10: both healths, side by side above the board. */
  protected readonly gauges = computed<GaugeVM[]>(() => {
    const me = this.session.myPlayer();
    return [this.buildGauge(me, true), this.buildGauge(me === 0 ? 1 : 0, false)];
  });

  /** True while the board is waiting for this player to tap it. */
  protected readonly boardActive = computed(() => {
    if (this.session.state() !== 'playing') return false;
    switch (this.game.phase()) {
      case 'placement':
        return !this.game.players()[this.session.myPlayer()].ship;
      case 'fire':
      case 'move':
        return this.myTurn();
      default:
        return false;
    }
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
          : 'Tap a square to place your ship';
      case 'fire':
        return this.myTurn() ? 'Fire! Tap a square' : 'Enemy is taking aim…';
      case 'move':
        if (!this.myTurn()) return 'Enemy ship is repositioning…';
        // Rule 6.3: moving while on fire costs another 10%.
        return this.game.players()[me].health < 100
          ? 'Move one square — the fire costs you 10%'
          : 'Your position is exposed — move your ship one square';
      case 'gameover':
        // Rule 11.2: a ram wrecks both ships and scores for neither.
        if (this.game.rammed()) return 'You rammed each other — no point for anyone';
        return this.game.winner() === me
          ? 'Victory! Enemy ship destroyed'
          : 'Your ship was destroyed';
    }
  });

  protected onCellClick(cell: CellVM): void {
    this.session.act({ x: cell.x, y: cell.y });
  }

  private buildGauge(id: PlayerId, mine: boolean): GaugeVM {
    const state = this.game.players()[id];
    return {
      mine,
      label: mine ? 'Your ship' : 'Enemy ship',
      health: state.health,
      color: healthColor(state.health),
      ships: state.shipDestroyed ? 0 : 1,
    };
  }

  private buildCells(): CellVM[] {
    const me = this.session.myPlayer();
    const foe: PlayerId = me === 0 ? 1 : 0;
    const mineState = this.game.players()[me];
    const foeState = this.game.players()[foe];
    const destroyed = this.game.destroyed();
    const gameover = this.game.phase() === 'gameover';

    // Rule 4: the enemy ship is not visible until the round is over or it is
    // wrecked. A *burning* enemy stays hidden too — one board means drawing it
    // would hand you its square, and the gauge already tells you it is hurt.
    const showFoe = gameover || foeState.shipDestroyed;
    const moveTargets =
      this.game.phase() === 'move' && this.myTurn() ? this.game.legalMoves(me) : [];

    // Where the enemy ship must be, deduced from public state alone: firing
    // exposed their square (rule 5.2) and the forced move (rule 5.4) put them
    // on one of its usable neighbours. The bot already fires by this same
    // deduction, so showing it just spares the player the arithmetic — it
    // reveals nothing they could not work out from the board. Only while
    // choosing a shot, and only once they have fired: before that every
    // unbombed square qualifies and the highlight would be noise.
    const hints =
      this.game.phase() === 'fire' && this.myTurn() && foeState.exposedAt
        ? this.game.possibleShipSquares(foe)
        : [];

    const at = (c: Coord | null, x: number, y: number) => !!c && c.x === x && c.y === y;

    const cells: CellVM[] = [];
    for (let y = 0; y < BOARD_H; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        const mine = at(mineState.ship, x, y);
        const enemy = at(foeState.ship, x, y) && showFoe;
        cells.push({
          x,
          y,
          destroyed: destroyed[y * BOARD_W + x],
          mine: mine && !mineState.shipDestroyed,
          enemy: enemy && !foeState.shipDestroyed,
          burningMine: mine && !mineState.shipDestroyed && mineState.health < 100,
          burningEnemy: enemy && !foeState.shipDestroyed && foeState.health < 100,
          wreckMine: mine && mineState.shipDestroyed,
          wreckEnemy: enemy && foeState.shipDestroyed,
          // The exposure reticle yields only to a ship actually drawn in the
          // cell — the enemy must see the exposure even while a ship sits there.
          exposedMine: at(mineState.exposedAt, x, y) && !mine,
          exposedEnemy: at(foeState.exposedAt, x, y) && !enemy && !mine,
          moveTarget: moveTargets.some((m) => m.x === x && m.y === y),
          hint: hints.some((h) => h.x === x && h.y === y),
          // Arrow points from my ship outward to this escape square.
          moveDir: mineState.ship
            ? (Math.atan2(y - mineState.ship.y, x - mineState.ship.x) * 180) / Math.PI
            : 0,
          color: mine
            ? healthColor(mineState.health)
            : enemy
              ? healthColor(foeState.health)
              : '',
        });
      }
    }
    return cells;
  }

  /**
   * The board must fit the screen with no scrolling. `.boards` is the flex row
   * that absorbs whatever height the chrome leaves over, so measuring it needs
   * no hardcoded chrome estimate: the board is sized to that space (minus the
   * panel's own padding and header) and shrinks — "zoom out" — as the viewport
   * gets smaller. The loop still counts panels, so it kept working when rule
   * 2.3 turned the two stacked boards into one.
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

    const panels = [...boards.querySelectorAll<HTMLElement>('.board-wrap')];
    const rows = panels.length;
    if (!rows) return;
    if (!boards.getBoundingClientRect().height) return; // not laid out (or hidden) yet
    const gap = parseFloat(getComputedStyle(boards).rowGap) || 0;
    const gaps = gap * (rows - 1);

    const set = (size: number) => boards.style.setProperty('--board-size', `${size}px`);
    let applied = parseFloat(boards.style.getPropertyValue('--board-size')) || 0;

    for (let pass = 0; pass < FIT_PASSES; pass++) {
      const free = boards.getBoundingClientRect();
      const wrapBox = wrap.getBoundingClientRect();
      const boardBox = board.getBoundingClientRect();
      // What one panel costs around its board — its header, padding and border.
      // Measured against the board's own box, which is `--board-size` square by
      // construction (border-box, definite width *and* height), so this is
      // purely the chrome and nothing about the board leaks into it.
      const panelX = wrapBox.width - boardBox.width;
      const panelY = wrapBox.height - boardBox.height;

      const room = Math.min(free.width - panelX, (free.height - gaps) / rows - panelY, MAX_BOARD);
      const size = Math.max(Math.floor(room - FIT_SLACK), MIN_BOARD);
      if (size === applied) break; // settled — the panels measure the same as they render
      applied = size;
      set(size);
      // The next pass re-reads the panel against the size just written, so a
      // chrome that shifted with it (a rounded header, a font that loaded) is
      // taken off the next estimate rather than pushed off the screen.
    }

    // Last word: the model above is an estimate, and every device rounds it its
    // own way. This is not an estimate — it is what the browser actually laid
    // out. `.boards` centres and clips, so an overflow of even two pixels shows
    // up as a shaved header on the top panel and a cut-off bottom row on the
    // other. Measure the real panels, hand back whatever they went over by, and
    // repeat until they genuinely fit.
    for (let pass = 0; pass < FIT_PASSES && applied > MIN_BOARD; pass++) {
      const free = boards.getBoundingClientRect().height;
      const used = panels.reduce((h, p) => h + p.getBoundingClientRect().height, 0) + gaps;
      const over = used - free;
      if (over <= 0) break;
      applied = Math.max(applied - Math.ceil(over / rows), MIN_BOARD);
      set(applied);
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
    const geom = this.measure(layer, from, shot.to);
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
        const now = this.measure(layer, from, shot.to) ?? geom;
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
      const geom = this.measure(layer, t.from, t.to);
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
   * Centre-to-centre geometry of a shot, in shot-layer coordinates. Both ends
   * are squares of the one united board (rule 2.3).
   */
  private measure(layer: HTMLElement, from: Coord, to: Coord): ShotGeom | null {
    const root = this.host.nativeElement;
    const fromEl = root.querySelector(`#cell-${from.x}-${from.y}`);
    const toEl = root.querySelector(`#cell-${to.x}-${to.y}`);
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
