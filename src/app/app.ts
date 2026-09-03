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
  protected readonly version = 'v0.47';

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
      // Rule 9: a host whose phone killed the PWA (which is exactly what can
      // happen while they are in a messaging app sending the invite) comes
      // straight back onto the number they shared, so the link already sent
      // starts working instead of leaving player 2 knocking at nobody.
      void this.session.resumeHostedLink();
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
