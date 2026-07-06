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
  /** Which share button just fired, for its "Copied!" flash. */
  protected readonly copied = signal<'link' | 'id' | null>(null);
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

  /**
   * Phones get the native share sheet — it overlays the page without
   * backgrounding the tab, so the broker connection (and the Battle{n}
   * registration) survives while the host picks a contact. Desktops copy.
   */
  protected readonly canShare = typeof navigator.share === 'function';

  /** Share/copy a deep link that lands player 2 straight in the game (rule 7.3). */
  protected async shareLink(): Promise<void> {
    const link = this.session.inviteLink();
    if (!link) return;
    if (this.canShare) {
      try {
        await navigator.share({ title: 'Battleship', url: link });
      } catch {
        // user dismissed the share sheet — nothing to do
      }
      return;
    }
    await navigator.clipboard.writeText(link);
    this.flashCopied('link');
  }

  /** Copy the game id so player 2 can type it into Join The Game (rule 7.3). */
  protected async copy(): Promise<void> {
    const id = this.session.gameId();
    if (!id) return;
    await navigator.clipboard.writeText(id);
    this.flashCopied('id');
  }

  private flashCopied(kind: 'link' | 'id'): void {
    this.copied.set(kind);
    setTimeout(() => this.copied.set(null), 1500);
  }
}
