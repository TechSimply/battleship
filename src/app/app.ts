import { Component, computed, inject } from '@angular/core';
import { Game } from './game/game';
import { Lobby } from './lobby/lobby';
import { GdAdsService } from './game/gd-ads.service';
import { SessionService } from './game/session.service';
import { InstallService } from './install.service';
import { UpdateService } from './update.service';

@Component({
  selector: 'app-root',
  imports: [Game, Lobby],
  host: {
    id: 'app-root',
    // The install sheet is the only modal in the app; Escape closes it.
    '(document:keydown.escape)': 'install.closeSheet()',
  },
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly session = inject(SessionService);
  protected readonly update = inject(UpdateService);
  protected readonly install = inject(InstallService);
  private readonly ads = inject(GdAdsService);

  /** Shown in the top-left corner on every screen. */
  protected readonly version = 'v0.56';

  constructor() {
    // No-op unless we are inside GameDistribution's iframe.
    this.ads.init();

    // Invite links (…/?join=3) drop the opponent straight into the joining
    // flow — no typing. Strip the param so a refresh doesn't re-join.
    const join = new URLSearchParams(location.search).get('join');
    if (join !== null) {
      history.replaceState(null, '', location.pathname);
      this.session.join(join);
    } else {
      // Rule 9: the board lives on the server now, so a launch is a return.
      // Whatever ended the last run — the phone killing a backgrounded PWA,
      // a flat battery, a closed tab — the player comes back into the same
      // seat of the same game, at the position they left it.
      void this.session.resumeSession();
    }
  }

  protected readonly inGame = () =>
    this.session.state() === 'playing' || this.session.state() === 'disconnected';

  /**
   * In a game the offer shrinks to a corner chip: the boards are the screen,
   * and every row the bar takes is a row of ocean the player loses. The lobby
   * has room to spare, so there it stays a bar — unless the player put it away.
   */
  protected readonly compactInstall = computed(() => this.install.collapsed() || this.inGame());
}
