import { Component, inject, signal } from '@angular/core';
import { SessionService } from '../game/session.service';

@Component({
  selector: 'app-lobby',
  imports: [],
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

  /** Digits only, max 7 — rewrite the field so nothing else can even appear. */
  protected onIdInput(e: Event): void {
    const el = e.target as HTMLInputElement;
    const clean = el.value.replace(/\D/g, '').slice(0, 7);
    if (el.value !== clean) el.value = clean;
    this.joinId = clean;
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
