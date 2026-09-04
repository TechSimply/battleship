import { TestBed } from '@angular/core/testing';
import { Game } from './game';
import { GameService } from './game.service';
import { SessionService } from './session.service';

/**
 * The board view, tested for what it *draws* — specifically that it never draws
 * a hull on a square no ship is standing on. The enemy's position is the one
 * secret the game has (rule 4), so a stray hull is not a cosmetic glitch: it is
 * the game telling the player something untrue about where the other ship is.
 */
describe('Game view', () => {
  beforeAll(() => {
    // jsdom has neither, and the component reaches for both while it is being
    // constructed. Real browsers have had them for years.
    const g = globalThis as Record<string, unknown>;
    g['visualViewport'] ??= { addEventListener() {}, removeEventListener() {} };
    g['matchMedia'] ??= () => ({ matches: false });
  });

  /** Every square currently drawing a ship's hull — real, ghost or wreck. */
  function hulls(el: HTMLElement): string[] {
    return [...el.querySelectorAll('.icon-ship, .icon-wreck')].map(
      (icon) => (icon.closest('.cell') as HTMLElement).id,
    );
  }

  function start() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const game = TestBed.inject(GameService);
    const session = TestBed.inject(SessionService);
    session.myPlayer.set(0);
    session.state.set('playing');
    return { game, session };
  }

  /** A round played out to a kill: I sink the enemy with my second hit. */
  function roundEndingOnAHit(game: GameService) {
    game.apply({ kind: 'place', player: 0, c: { x: 0, y: 0 } });
    game.apply({ kind: 'place', player: 1, c: { x: 3, y: 4 } });
    game.apply({ kind: 'fire', player: 0, c: { x: 3, y: 4 } }); // hit — 50%, burning
    game.apply({ kind: 'move', player: 0, c: { x: 1, y: 0 } });
    game.apply({ kind: 'fire', player: 1, c: { x: 2, y: 2 } }); // miss
    game.apply({ kind: 'move', player: 1, c: { x: 2, y: 4 } });
    game.apply({ kind: 'fire', player: 0, c: { x: 2, y: 4 } }); // sunk
    expect(game.phase()).toBe('gameover');
  }

  /**
   * The killing blow lights the struck hull up for a second (rule 6.2.1). A new
   * board must not inherit that flash: "Play vs Computer" from the lobby builds
   * a brand-new view, and its animation effects run once on creation against
   * whatever shot the service is still holding.
   */
  it('opens a new game with empty water, not the last round’s hit flash', async () => {
    const first = start();
    roundEndingOnAHit(first.game);

    // Leave, then start another game: reset() is what leave()/playComputer() do.
    first.game.reset();
    const fixture = TestBed.createComponent(Game);
    await fixture.whenStable();

    expect(hulls(fixture.nativeElement as HTMLElement)).toEqual([]);
  });

  it('clears the hit flash when "Play again" starts the next round', async () => {
    const { game } = start();
    const fixture = TestBed.createComponent(Game);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    roundEndingOnAHit(game);
    await fixture.whenStable();

    game.reset(); // "Play again", tapped while the flash is still burning
    await fixture.whenStable();

    expect(hulls(el)).toEqual([]);
    expect(el.querySelector('.hit-burst')).toBeNull();
  });

  it('still draws my own ship where I put it', async () => {
    const { game } = start();
    const fixture = TestBed.createComponent(Game);
    await fixture.whenStable();

    game.apply({ kind: 'place', player: 0, c: { x: 2, y: 3 } });
    game.apply({ kind: 'place', player: 1, c: { x: 0, y: 0 } });
    await fixture.whenStable();

    // Mine, and only mine: the enemy stays hidden until the round is over.
    expect(hulls(fixture.nativeElement as HTMLElement)).toEqual(['cell-2-3']);
  });
});
