import { DestroyRef, Injectable, computed, inject, isDevMode, signal } from '@angular/core';

/**
 * Chrome's install event. It is not in lib.dom, and it is the only way to raise
 * the browser's own install dialog: the event has to be caught, kept, and
 * replayed from a user gesture later.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * How this browser installs a PWA, which is what the Install button has to do.
 * - `prompt`  — we hold a `beforeinstallprompt`: one tap raises the real dialog.
 * - `ios`     — Safari has no such event; the player does it from the Share sheet.
 * - `webview` — an in-app browser (Messenger, Instagram…) cannot install at all;
 *               the first step is getting out of it. Invites arrive through
 *               exactly these apps, so this is a common landing state.
 * - `manual`  — anything else: point at the browser menu.
 */
export type InstallRoute = 'prompt' | 'ios' | 'webview' | 'manual';

/** Remembers that the player shrank the bar to the corner chip. */
const COLLAPSED_KEY = 'battleship.install.collapsed';

/** Is the app already running as an installed app rather than in a tab? */
function isStandalone(): boolean {
  const display = ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay'];
  const asApp = display.some((mode) => window.matchMedia?.(`(display-mode: ${mode})`).matches);
  // `navigator.standalone` is iOS's own (only) answer to the same question.
  const iosApp = (navigator as { standalone?: boolean }).standalone === true;
  return asApp || iosApp || document.referrer.startsWith('android-app://');
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac; the touch points give it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** The in-app browsers invite links are opened from. None of them can install. */
function isWebView(): boolean {
  return /FBAN|FBAV|FB_IAB|Instagram|Messenger|Line\/|Snapchat|Twitter|TikTok|WhatsApp|GSA\//i.test(
    navigator.userAgent,
  );
}

/**
 * Offers the app for installation, everywhere, until it is installed.
 *
 * The game is a PWA and is much better as one — full screen, on the home
 * screen, no browser chrome eating the two boards, and it opens instantly when
 * an invite link arrives. But the browser's own install affordance is a menu
 * item most players never look for, and Chrome fires `beforeinstallprompt` once
 * and then waits for us to use it. So we hold that event and put our own button
 * on screen — on the lobby *and* mid-game, since a player who came in through
 * an invite link may never see the lobby at all.
 *
 * Everything here is a no-op once the app is installed (`display-mode:
 * standalone`) or when we are inside someone else's iframe (the
 * GameDistribution portal wrapper), where installing our page is neither
 * possible nor ours to offer.
 */
@Injectable({ providedIn: 'root' })
export class InstallService {
  private readonly destroyRef = inject(DestroyRef);

  /** The captured `beforeinstallprompt`, replayable exactly once. */
  private deferred: BeforeInstallPromptEvent | null = null;

  /** Already installed (or launched from the home screen) — nothing to offer. */
  readonly installed = signal(false);
  /** We hold a live `beforeinstallprompt`. */
  private readonly promptable = signal(false);
  /** The bar is shrunk to the corner chip. */
  readonly collapsed = signal(false);
  /** The step-by-step sheet is open. */
  readonly sheetOpen = signal(false);
  /** The browser dialog is up; the button must not be tapped twice. */
  readonly busy = signal(false);

  /** Inside an iframe (the GD portal wrapper) — not our page to install. */
  private readonly embedded = safe(() => window.top !== window.self, false);

  readonly route = computed<InstallRoute>(() => {
    if (this.promptable()) return 'prompt';
    if (isWebView()) return 'webview';
    if (isIos()) return 'ios';
    return 'manual';
  });

  /** Should the download prompt be on screen at all? */
  readonly visible = computed(() => !this.installed() && !this.embedded);

  constructor() {
    this.installed.set(safe(isStandalone, false));
    this.collapsed.set(safe(() => localStorage.getItem(COLLAPSED_KEY) === '1', false));

    const captured = (globalThis as { __battleshipInstallEvent?: BeforeInstallPromptEvent })
      .__battleshipInstallEvent;
    if (captured) this.keep(captured);

    const onPrompt = (event: Event) => {
      // Chrome shows its own mini-infobar unless the event is cancelled, and
      // only a cancelled event stays replayable — this is what buys us the
      // right to prompt from our own button later.
      event.preventDefault();
      this.keep(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      this.installed.set(true);
      this.sheetOpen.set(false);
      this.deferred = null;
      this.promptable.set(false);
    };
    // Installing from the browser's own menu (or the iOS Share sheet) never
    // tells this tab anything; the display-mode flip is the only signal, and it
    // arrives when the app is next opened from the home screen.
    const standalone = safe(() => window.matchMedia('(display-mode: standalone)'), null);
    const onDisplay = () => this.installed.set(safe(isStandalone, false));

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    standalone?.addEventListener?.('change', onDisplay);

    if (isDevMode()) {
      // Test hook: no browser will offer to install a dev build served over
      // localhost with the worker switched off, so let tests and screenshots
      // raise the bar by hand.
      (globalThis as { __battleshipInstall?: () => void }).__battleshipInstall = () => {
        this.installed.set(false);
        this.collapsed.set(false);
      };
    }

    this.destroyRef.onDestroy(() => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      standalone?.removeEventListener?.('change', onDisplay);
    });
  }

  /**
   * The Install button. Raises the browser's dialog where there is one, and
   * otherwise opens the sheet that explains this browser's own route — the
   * button always does something, on every browser.
   */
  async install(): Promise<void> {
    const event = this.deferred;
    if (!event) {
      this.sheetOpen.set(true);
      return;
    }
    this.busy.set(true);
    try {
      await event.prompt();
      const { outcome } = await event.userChoice;
      if (outcome === 'accepted') this.installed.set(true);
    } catch {
      // A prompt can only be replayed once; if this one is spent, fall back to
      // telling the player where the browser keeps it.
      this.sheetOpen.set(true);
    } finally {
      // Spent either way: Chrome fires a fresh `beforeinstallprompt` if the
      // player is still eligible, which puts us back on the `prompt` route.
      this.deferred = null;
      this.promptable.set(false);
      this.busy.set(false);
    }
  }

  /**
   * Put the bar away for good — the offer lives on as the corner chip, which
   * installs in one tap just as the bar's button does. Nothing brings the bar
   * back; a player who has said "not like that" once should not have to say it
   * again on the next screen.
   */
  collapse(): void {
    this.collapsed.set(true);
    this.sheetOpen.set(false);
    safe(() => localStorage.setItem(COLLAPSED_KEY, '1'), undefined);
  }

  closeSheet(): void {
    this.sheetOpen.set(false);
  }

  private keep(event: BeforeInstallPromptEvent): void {
    this.deferred = event;
    this.promptable.set(true);
    // Taken out of the pre-bootstrap holding slot, so a spent prompt can never
    // be handed out a second time.
    delete (globalThis as { __battleshipInstallEvent?: BeforeInstallPromptEvent })
      .__battleshipInstallEvent;
  }
}

/** Storage and `window.top` both throw in the situations we care about least. */
function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}
