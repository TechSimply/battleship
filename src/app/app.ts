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

  protected readonly inGame = () =>
    this.session.state() === 'playing' ||
    this.session.state() === 'reconnecting' ||
    this.session.state() === 'disconnected';
}
