import { Injectable, signal } from '@angular/core';

/**
 * GameDistribution ads — only when the game is running inside GD's own iframe.
 *
 * GD distributes self-hosted games by wrapping them: `gd-wrapper/index.html`
 * (the zip we upload) iframes our live Firebase build and appends a
 * `gd_sdk_referrer_url` query param. That param is therefore the signal that we
 * are being played *through the portal*, and it is what gates everything here.
 *
 * The gate is deliberate, not incidental: the SDK loads Google ad tags and sets
 * tracking identifiers. Loading it unconditionally would put those on
 * battleship-p2p.web.app too — dragging in a cookie-consent banner and a privacy
 * policy on a site that currently needs neither (see Documentation/monetisation.md).
 * Inside GD's iframe, consent is GD's to collect; on our own domain we stay clean.
 */

const GAME_ID = '80959252d6e640d18447298d25817b57';
const SDK_SRC = 'https://html5.api.gamedistribution.com/main.min.js';
const SCRIPT_ID = 'gamedistribution-jssdk';

declare const gdsdk: { showAd(): void; openConsole(): void } | undefined;

@Injectable({ providedIn: 'root' })
export class GdAdsService {
  /**
   * True while an ad is on screen. The game is turn-based and silent, so there
   * is nothing to actually suspend — but GD requires a game to pause, and this
   * gives us the hook (and lets the UI hide itself behind the ad if we ever
   * want it to).
   */
  readonly paused = signal(false);

  private loaded = false;

  /**
   * Are we being played through GameDistribution's wrapper? Read once, at
   * startup: `app.ts` strips the query string off invite links via
   * `replaceState`, so re-reading `location` later would lose the param and
   * silently turn every ad call into a no-op.
   */
  private readonly portal = new URLSearchParams(location.search).has('gd_sdk_referrer_url');

  private inPortal(): boolean {
    return this.portal;
  }

  /** Inject the SDK once, and only in the portal. Safe to call repeatedly. */
  init(): void {
    if (this.loaded || !this.inPortal()) return;
    if (document.getElementById(SCRIPT_ID)) return;
    this.loaded = true;

    (window as unknown as Record<string, unknown>)['GD_OPTIONS'] = {
      gameId: GAME_ID,
      onEvent: (event: { name: string }) => {
        switch (event.name) {
          case 'SDK_GAME_START':
            this.paused.set(false);
            break;
          case 'SDK_GAME_PAUSE':
            this.paused.set(true);
            break;
        }
      },
    };

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SDK_SRC;
    document.head.appendChild(script);
  }

  /**
   * Ask for an ad at a natural break. No-op outside the portal, and never
   * mid-round — the only call site is the rematch tap, once a game is over.
   */
  showAd(): void {
    if (!this.inPortal()) return;
    try {
      if (typeof gdsdk !== 'undefined' && gdsdk) gdsdk.showAd();
    } catch {
      // an ad failing must never block a rematch
    }
  }
}
