import { Component, inject } from '@angular/core';
import { Game } from './game/game';
import { Lobby } from './lobby/lobby';
import { GdAdsService } from './game/gd-ads.service';
import { SessionService } from './game/session.service';
import { UpdateService } from './update.service';

@Component({
  selector: 'app-root',
  imports: [Game, Lobby],
  host: { id: 'app-root' },
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly session = inject(SessionService);
  protected readonly update = inject(UpdateService);
  private readonly ads = inject(GdAdsService);

  /** Shown in the top-left corner on every screen. */
  protected readonly version = 'v0.36';

  constructor() {
    // No-op unless we are inside GameDistribution's iframe.
    this.ads.init();

    // Invite links (…/?join=3) drop the opponent straight into the joining
    // flow — no typing. Strip the param so a refresh doesn't re-join.
    const join = new URLSearchParams(location.search).get('join');
    if (join !== null) {
      history.replaceState(null, '', location.pathname);
      this.session.join(join);
    }
  }

  protected readonly inGame = () =>
    this.session.state() === 'playing' || this.session.state() === 'disconnected';
}
