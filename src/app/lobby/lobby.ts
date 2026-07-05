import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SessionService } from '../game/session.service';

@Component({
  selector: 'app-lobby',
  imports: [FormsModule],
  host: { id: 'lobby-component' },
  templateUrl: './lobby.html',
  styleUrl: './lobby.scss',
})
export class Lobby {
  protected readonly session = inject(SessionService);

  protected readonly joinOpen = signal(false);
  protected readonly copied = signal(false);
  protected joinId = '';

  protected openJoin(): void {
    this.joinOpen.set(true);
  }

  protected back(): void {
    this.joinOpen.set(false);
    this.joinId = '';
    this.session.leave();
  }

  protected join(): void {
    this.session.join(this.joinId);
  }

  /** Copy the game id so player 2 can paste it into Join The Game (rule 7.3). */
  protected async copy(): Promise<void> {
    const id = this.session.gameId();
    if (!id) return;
    await navigator.clipboard.writeText(id);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }
}
