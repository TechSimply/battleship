import { DestroyRef, Injectable, inject, isDevMode, signal } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';

/** How often to look for a new build while the app stays open. */
const POLL_MS = 60 * 60 * 1000;
/** Floor between checks, so foreground flapping can't hammer the network. */
const MIN_GAP_MS = 60 * 1000;

/**
 * Notices a newly deployed build and offers it to the player.
 *
 * The service worker answers from cache instantly and only swaps a new version
 * in for a *fresh* client. A phone treats an installed PWA as always-running —
 * it is suspended, not closed — so without this the app can sit on a months-old
 * build no matter how many times it is deployed or reopened. So: check on
 * launch, every time the app comes back to the foreground, and hourly while it
 * stays open, then say so rather than waiting to be discovered.
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly sw = inject(SwUpdate);
  private readonly destroyRef = inject(DestroyRef);

  /** A newer build is downloaded and one reload away. */
  readonly ready = signal(false);

  private lastCheck = 0;

  constructor() {
    if (isDevMode()) {
      // Test hook: the service worker is switched off in dev builds, so let
      // tests and screenshots raise the banner by hand.
      (globalThis as { __battleshipUpdate?: () => void }).__battleshipUpdate = () =>
        this.ready.set(true);
    }
    if (!this.sw.isEnabled) return;

    const versions = this.sw.versionUpdates.subscribe((event) => {
      // VERSION_READY means the new build is already downloaded — activating it
      // is instant, so the player never waits after tapping Update.
      if (event.type === 'VERSION_READY') this.ready.set(true);
    });

    // The cached build is broken (assets evicted from under us). There is
    // nothing to offer here; a reload is the only way back to a working app.
    const broken = this.sw.unrecoverable.subscribe(() => location.reload());

    const check = () => this.check();
    document.addEventListener('visibilitychange', check);
    const timer = setInterval(check, POLL_MS);

    this.destroyRef.onDestroy(() => {
      versions.unsubscribe();
      broken.unsubscribe();
      document.removeEventListener('visibilitychange', check);
      clearInterval(timer);
    });

    this.check();
  }

  /** Swap the new build in. Reloads even if activation fails, so the fresh
   * assets the worker already holds are picked up on the way back up. */
  async apply(): Promise<void> {
    if (this.sw.isEnabled) {
      await this.sw.activateUpdate().catch(() => undefined);
    }
    location.reload();
  }

  /** Not now — the next check (foreground, or hourly) will offer it again. */
  dismiss(): void {
    this.ready.set(false);
  }

  private check(): void {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - this.lastCheck < MIN_GAP_MS) return;
    this.lastCheck = now;
    // Being offline is the normal case for a PWA, not an error worth surfacing.
    this.sw.checkForUpdate().catch(() => undefined);
  }
}
