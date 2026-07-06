import { Component, inject } from '@angular/core';
import { Game } from './game/game';
import { Lobby } from './lobby/lobby';
import { SessionService } from './game/session.service';

@Component({
  selector: 'app-root',
  imports: [Game, Lobby],
  host: { id: 'app-root' },
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly session = inject(SessionService);

  constructor() {
    // Invite links (…/?join=3) drop the opponent straight into the joining
    // flow — no typing. Strip the param so a refresh doesn't re-join.
    const join = new URLSearchParams(location.search).get('join');
    if (join !== null) {
      history.replaceState(null, '', location.pathname);
      // Patient: the host may still be in their messaging app after sending
      // this link, with their game tab backgrounded — wait for them.
      this.session.join(join, { patient: true });
    }
  }

  protected readonly inGame = () =>
    this.session.state() === 'playing' ||
    this.session.state() === 'reconnecting' ||
    this.session.state() === 'disconnected';
}
