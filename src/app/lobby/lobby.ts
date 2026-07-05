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

  /** Share the game id with player 2 (rule 7.3) — native share sheet on mobile. */
  protected async share(): Promise<void> {
    const id = this.session.gameId();
    if (!id) return;
    const text = `Join my Battleship game! Game id: ${id} — ${location.href}`;
    if (navigator.share) {
      try {
        await navigator.share({ text });
      } catch {
        // user closed the share sheet — nothing to do
      }
    } else {
      await navigator.clipboard.writeText(id);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    }
  }
}
