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
  /**
   * Rule 11: the two hulls collided here. The angle (deg) is the course the
   * rammer came in on, so the crash plays along the line it actually sailed.
   */
  ram: { angle: number; mineRammed: boolean } | null;
  /** A crater that was a hit, not a miss — it keeps burning instead of greying. */
  hitCrater: boolean;
  /** The shot that just landed here found a ship: play the impact. */
  impact: boolean;
  /** Draw the struck hull in the flash — only where no ship is drawn already. */
  impactGhost: boolean;
  /** Rule 5.2: the enemy fired from here a moment ago — light their hull up. */
  fireGhost: boolean;
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
  /** This ship was just hit — the gauge takes the blow with it. */
  struck: boolean;
  /**
   * Rule 12: the chance this ship's next shot finds its target, in percent.
   * Null once the round is over — there is nothing left to aim at (rule 12.5).
   */
  aim: number | null;
  /** Rule 12.3: this is the gun currently taking aim — light the bar up. */
  aiming: boolean;
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
 * A rocket's burning exhaust. The enemy's is left on screen until they fire
 * again; your own is only the animation of your own shot and burns out after
 * `OWN_TRAIL_MS` (rule 5.5).
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
/** How long the hit flash stays on the square, in ms (the shell lands at ~300). */
const IMPACT_MS = 1400;
/**
 * Rule 5.2, made visible: how long the enemy's hull stays lit by its own muzzle
 * flash, in ms, measured from the launch. Firing already gives their square
 * away, so seeing the ship standing on it for a moment tells you nothing the
 * exposure marker doesn't — and it is off the board again long before they
 * sail, which is the part that must stay hidden. Cut short anyway the moment
 * they move; keep in step with the `fire-reveal` animation in game.scss.
 */
const FIRE_REVEAL_MS = 1100;
/**
 * Rule 5.5: how long your own flame lives, in ms, measured from the launch.
 * It tells you nothing you don't already know — you fired it — so it fades out
 * and leaves the board carrying exactly one standing flame: the enemy's.
 * Keep in step with the `trail-fade` animation in game.scss.
 */
const OWN_TRAIL_MS = 1000;

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
   * At most one burning trail per player — the newest rocket replaces it — and
   * in practice only the enemy's stands for long (rule 5.5). Rendered from the
   * template (not appended by hand) so the component's emulated style
   * encapsulation actually reaches the flame.
   */
  protected readonly trails = signal<TrailVM[]>([]);
  protected readonly rocket = signal<RocketVM | null>(null);
  private rocketTimer?: ReturnType<typeof setTimeout>;
  private ownTrailTimer?: ReturnType<typeof setTimeout>;

  /**
   * Rule 6.2's moment: a shot that found a ship. The struck hull flashes into
   * view on that square with a burst, and the victim's gauge takes the blow —
   * then it is gone, so nothing lasting is revealed about where they are.
   */
  protected readonly impact = signal<{ c: Coord; victim: PlayerId } | null>(null);
  private impactTimer?: ReturnType<typeof setTimeout>;

  /**
   * Rule 5.2's moment, from the other side: the square the enemy just fired
   * from, with their hull lit up on it. Only ever set for the *enemy's* shot —
   * your own ship is drawn all game anyway — and only until they sail on.
   */
  protected readonly muzzle = signal<{ c: Coord; shooter: PlayerId } | null>(null);
  private muzzleTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    // Tracer: fly a rocket from the shooter's (exposed) square to the bombed
    // square, so the exposure visibly originates from the shot.
    effect(() => {
      const shot = this.game.lastShot();
      if (shot) untracked(() => this.animateShot(shot));
    });

    // A hit plays its own beat on top of the tracer: the flash on the square,
    // and the shaken gauge. Both are transient — the board goes back to hiding
    // the enemy the moment it is over.
    effect(() => {
      const shot = this.game.lastShot();
      if (!shot?.hit) return;
      untracked(() => {
        clearTimeout(this.impactTimer);
        this.impact.set({ c: shot.to, victim: shot.shooter === 0 ? 1 : 0 });
        this.impactTimer = setTimeout(() => this.impact.set(null), IMPACT_MS);
      });
    });

    // The muzzle flash gives the enemy away for a second: the rocket leaves
    // their square (rule 5.2), so their hull is lit up on it as it goes. Where
    // they sail afterwards (rule 5.4) is still theirs to keep — the reveal is
    // over long before, and is torn down early below if they are quick.
    effect(() => {
      const shot = this.game.lastShot();
      if (!shot?.from || shot.shooter === this.session.myPlayer()) return;
      untracked(() => {
        clearTimeout(this.muzzleTimer);
        this.muzzle.set({ c: shot.from!, shooter: shot.shooter });
        this.muzzleTimer = setTimeout(() => this.muzzle.set(null), FIRE_REVEAL_MS);
      });
    });

    // …and the sea takes them back the instant they move, so the hull is never
    // drawn on a square they have already left — or, worse, one they moved to.
    effect(() => {
      const flash = this.muzzle();
      if (!flash) return;
      const ship = this.game.players()[flash.shooter].ship;
      if (!ship || ship.x !== flash.c.x || ship.y !== flash.c.y) {
        untracked(() => this.clearMuzzle());
      }
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
      clearTimeout(this.ownTrailTimer);
      clearTimeout(this.impactTimer);
      clearTimeout(this.muzzleTimer);
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

  /**
   * Rule 12: what this device's next shot is worth — one square out of the
   * ones the enemy could still be on, which is exactly the set the board
   * highlights while aiming. Counted as the hunter, since you know your own
   * square (rule 12.4).
   */
  protected readonly myAim = computed(() =>
    this.game.hitChance(this.session.myPlayer() === 0 ? 1 : 0, true),
  );

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
        // Rule 12.6: the prompt that asks for the shot says what the shot is
        // worth, so the odds are in front of the player while they aim. Rule
        // 12.5's nothing-to-shoot-at is worth saying in words: a bare 0% next
        // to an empty board reads as a bug rather than as an enemy sitting
        // where rule 5.3 says nobody may bomb.
        if (!this.myTurn()) return 'Enemy is taking aim…';
        return this.myAim() > 0
          ? `Fire! Tap a square — ${this.myAim()}% to hit`
          : 'Fire! Tap a square — they are pinned on a crater, 0% to hit';
      case 'move': {
        const shot = this.game.lastShot();
        if (!this.myTurn()) {
          return shot?.hit && shot.shooter !== me
            ? `You have been hit — on fire at ${this.game.players()[me].health}%`
            : 'Enemy ship is repositioning…';
        }
        if (shot?.hit && shot.shooter === me) {
          return `Direct hit! Enemy at ${this.game.players()[me === 0 ? 1 : 0].health}% and burning`;
        }
        // Rule 6.3: moving while on fire costs another 10%.
        return this.game.players()[me].health < 100
          ? 'Move one square — the fire costs you 10%'
          : 'Your position is exposed — move your ship one square';
      }
      case 'gameover':
        // Rule 11.2: a ram wrecks both ships and scores for neither. A ram with
        // no approach is rule 11.5 — both players picked the same square.
        if (this.game.rammed()) {
          return this.game.lastRam()?.from
            ? 'You rammed each other — no point for anyone'
            : 'You both started on the same square — no point for anyone';
        }
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
    const phase = this.game.phase();
    return {
      mine,
      struck: this.impact()?.victim === id,
      label: mine ? 'Your ship' : 'Enemy ship',
      health: state.health,
      color: healthColor(state.health),
      ships: state.shipDestroyed ? 0 : 1,
      // Rule 12.3: this bar carries the odds of the gun it belongs to, so the
      // enemy's chance of finding you is read off their bar exactly as yours is
      // read off your own. `mine` doubles as rule 12.4's "does this player know
      // where the shooter is standing" — for your own gun, you do.
      aim: phase === 'gameover' ? null : this.game.hitChance(id === 0 ? 1 : 0, mine),
      aiming: phase === 'fire' && this.game.currentPlayer() === id,
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

    // Where the enemy ship must be, deduced from public state alone (rule
    // 12.2): a shot exposed their square (rule 5.2) or a shell was seen finding
    // them on it (rule 6.2.1), and the forced move (rule 5.4) either put them
    // on one of its usable neighbours or, with nowhere to go, left them on it.
    // The bot already fires by this same deduction, so showing it just spares
    // the player the arithmetic — it reveals nothing they could not work out
    // from the board. Only while choosing a shot, and only once the ship has
    // been seen at all: before that every unbombed square qualifies and the
    // highlight would be noise.
    //
    // `aimSquares` and not the raw deduction, so nothing is marked that no shot
    // may be aimed at — a ship pinned on its own crater (rule 12.5) is drawn as
    // no hint at all, which is what its 0% says too.
    const hints =
      this.game.phase() === 'fire' && this.myTurn() && foeState.seenAt
        ? this.game.aimSquares(foe)
        : [];

    const at = (c: Coord | null, x: number, y: number) => !!c && c.x === x && c.y === y;

    // Rule 11's collision: the wrecks slide together along the rammer's own
    // course. A ram at placement has no approach, so it plays straight across.
    const hitSquares = this.game.hitSquares();
    const impact = this.impact();
    const muzzle = this.muzzle();
    const lastRam = this.game.lastRam();
    const ramAngle =
      lastRam && lastRam.from
        ? (Math.atan2(lastRam.at.y - lastRam.from.y, lastRam.at.x - lastRam.from.x) * 180) /
          Math.PI
        : 0;

    const cells: CellVM[] = [];
    for (let y = 0; y < BOARD_H; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        const mine = at(mineState.ship, x, y);
        const enemy = at(foeState.ship, x, y) && showFoe;
        // Rule 5.2: the enemy's own gun flash shows them up for a second. Only
        // where the sea is otherwise empty — with a ship already drawn there
        // (the round is over, or they wrecked) there is nothing to reveal.
        const fireGhost = !!muzzle && at(muzzle.c, x, y) && !mine && !enemy;
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
          // Rule 6.4: whatever hull is drawn here wears its own health. The
          // muzzle flash included — the gauge has been saying that colour all
          // along, so it gives nothing away.
          color: mine
            ? healthColor(mineState.health)
            : enemy || fireGhost
              ? healthColor(foeState.health)
              : '',
          ram:
            lastRam && at(lastRam.at, x, y) && mineState.shipDestroyed && foeState.shipDestroyed
              ? { angle: ramAngle, mineRammed: lastRam.rammer === me }
              : null,
          hitCrater: hitSquares[y * BOARD_W + x],
          impact: !!impact && at(impact.c, x, y),
          impactGhost: !!impact && at(impact.c, x, y) && !mine && !enemy,
          fireGhost,
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
   * height is likewise not exactly the height it was sized for, since its
   * rows each snap to the device pixel grid. Either way the
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
      // Measured against the board's own box, which is definite by
      // construction (border-box, `--board-size` wide and `--board-h` tall), so
      // this is purely the chrome and nothing about the board leaks into it.
      const panelX = wrapBox.width - boardBox.width;
      const panelY = wrapBox.height - boardBox.height;

      // The board is 4 across and 5 down, so height is the binding constraint
      // on a phone: convert the height a panel may have into the width that
      // fits it (`--board-size` is the width; the CSS derives the height).
      const room = Math.min(
        free.width - panelX,
        (((free.height - gaps) / rows - panelY) * BOARD_W) / BOARD_H,
        MAX_BOARD,
      );
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
      // Overflow is vertical, `applied` is a width: a pixel off the width
      // takes BOARD_H / BOARD_W pixels off the height.
      const shrink = Math.ceil(((over / rows) * BOARD_W) / BOARD_H);
      applied = Math.max(applied - Math.max(shrink, 1), MIN_BOARD);
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
   * State markers land with a matching delay. The enemy's trail stays put until
   * they fire again (each shooter owns exactly one trail); your own burns out a
   * second after the launch, per rule 5.5.
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

    // Rule 5.5: your own flame is the tracer of your own shot, nothing more —
    // you already know the square you fired from. It fades out (the `trail-fade`
    // animation in game.scss) and is dropped here on the same beat, so the only
    // flame left standing on the board is the enemy's last shot. Under reduced
    // motion nothing fades, but this still takes it off at the same moment.
    if (mine) {
      clearTimeout(this.ownTrailTimer);
      this.ownTrailTimer = setTimeout(
        () => this.trails.update((trails) => trails.filter((t) => t.id !== shot.n)),
        OWN_TRAIL_MS,
      );
    }

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
    clearTimeout(this.ownTrailTimer);
    this.trails.set([]);
    this.rocket.set(null);
    this.clearMuzzle();
  }

  private clearMuzzle(): void {
    clearTimeout(this.muzzleTimer);
    this.muzzle.set(null);
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
