import { TestBed } from '@angular/core/testing';
import { InstallService } from './install.service';

/** Chrome's install event, faked well enough to be captured and replayed. */
class FakeInstallPrompt extends Event {
  prompts = 0;
  outcome: 'accepted' | 'dismissed' = 'accepted';
  /** Set when the event has already been used, like the real one-shot event. */
  spent = false;

  constructor() {
    super('beforeinstallprompt', { cancelable: true });
  }

  prompt(): Promise<void> {
    if (this.spent) return Promise.reject(new Error('already used'));
    this.spent = true;
    this.prompts++;
    return Promise.resolve();
  }

  get userChoice(): Promise<{ outcome: 'accepted' | 'dismissed' }> {
    return Promise.resolve({ outcome: this.outcome });
  }
}

/** jsdom answers every media query with `false`; some tests need a `true`. */
function stubDisplayMode(standalone: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: standalone && query.includes('display-mode'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

describe('InstallService', () => {
  const realMatchMedia = window.matchMedia;

  beforeEach(() => {
    stubDisplayMode(false);
    localStorage.clear();
    delete (globalThis as { __battleshipInstallEvent?: unknown }).__battleshipInstallEvent;
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it('offers the app on every screen while it is not installed', () => {
    expect(TestBed.inject(InstallService).visible()).toBe(true);
  });

  it('says nothing once the app runs from the home screen', () => {
    stubDisplayMode(true);
    expect(TestBed.inject(InstallService).visible()).toBe(false);
  });

  it('keeps the browser prompt instead of letting it fire and vanish', async () => {
    const install = TestBed.inject(InstallService);
    const event = new FakeInstallPrompt();

    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true); // or Chrome shows its own bar and drops ours
    expect(install.route()).toBe('prompt');

    await install.install();
    expect(event.prompts).toBe(1);
    expect(install.visible()).toBe(false); // accepted — nothing left to offer
  });

  it('picks up a prompt that arrived before the app had bootstrapped', () => {
    const event = new FakeInstallPrompt();
    (globalThis as { __battleshipInstallEvent?: unknown }).__battleshipInstallEvent = event;

    const install = TestBed.inject(InstallService);
    expect(install.route()).toBe('prompt');
    // Taken out of the holding slot, so a second service can't replay a spent one.
    expect(
      (globalThis as { __battleshipInstallEvent?: unknown }).__battleshipInstallEvent,
    ).toBeUndefined();
  });

  it('keeps offering after a declined prompt, now by explaining the manual route', async () => {
    const install = TestBed.inject(InstallService);
    const event = new FakeInstallPrompt();
    event.outcome = 'dismissed';
    window.dispatchEvent(event);

    await install.install();
    expect(install.visible()).toBe(true);
    expect(install.route()).not.toBe('prompt'); // the one-shot event is spent
    expect(install.sheetOpen()).toBe(false);
  });

  it('explains the browser-menu route where there is no prompt to raise', async () => {
    const install = TestBed.inject(InstallService);
    expect(install.route()).toBe('manual');

    await install.install();
    expect(install.sheetOpen()).toBe(true);

    install.closeSheet();
    expect(install.sheetOpen()).toBe(false);
  });

  it('steers an in-app browser out to a real one first', () => {
    const ua = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      value: `${ua} [FBAN/FBIOS]`,
      configurable: true,
    });
    try {
      expect(TestBed.inject(InstallService).route()).toBe('webview');
    } finally {
      Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
    }
  });

  it('shrinks to the corner chip, and remembers that between screens', () => {
    const install = TestBed.inject(InstallService);
    install.collapse();
    expect(install.collapsed()).toBe(true);
    // Still visible — collapsing puts the offer in the corner, it does not
    // take it away.
    expect(install.visible()).toBe(true);

    TestBed.resetTestingModule();
    expect(TestBed.inject(InstallService).collapsed()).toBe(true);

    const reopened = TestBed.inject(InstallService);
    reopened.expand();
    expect(reopened.collapsed()).toBe(false);
    TestBed.resetTestingModule();
    expect(TestBed.inject(InstallService).collapsed()).toBe(false);
  });

  it('stands down when the app is installed from the browser menu', () => {
    const install = TestBed.inject(InstallService);
    window.dispatchEvent(new Event('appinstalled'));
    expect(install.visible()).toBe(false);
  });
});
