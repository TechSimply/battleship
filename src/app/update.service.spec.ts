import { TestBed } from '@angular/core/testing';
import { SwUpdate, VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { UpdateService } from './update.service';

/** Stands in for the real worker channel, which cannot run under test. */
class FakeSwUpdate {
  isEnabled = true;
  versionUpdates = new Subject<VersionEvent>();
  unrecoverable = new Subject<{ type: 'UNRECOVERABLE_STATE'; reason: string }>();
  checks = 0;
  activations = 0;

  checkForUpdate(): Promise<boolean> {
    this.checks++;
    return Promise.resolve(true);
  }

  activateUpdate(): Promise<boolean> {
    this.activations++;
    return Promise.resolve(true);
  }
}

describe('UpdateService', () => {
  let sw: FakeSwUpdate;
  let update: UpdateService;

  beforeEach(() => {
    sw = new FakeSwUpdate();
    TestBed.configureTestingModule({
      providers: [{ provide: SwUpdate, useValue: sw }],
    });
    update = TestBed.inject(UpdateService);
  });

  it('looks for a new build as soon as the app starts', () => {
    expect(sw.checks).toBe(1);
  });

  it('stays quiet until the new build is downloaded', () => {
    // DETECTED only means the worker has spotted one; offering it here would
    // mean the reload stalls waiting for assets that haven't arrived.
    sw.versionUpdates.next({
      type: 'VERSION_DETECTED',
      version: { hash: 'b' },
    } as VersionEvent);
    expect(update.ready()).toBe(false);

    sw.versionUpdates.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'a' },
      latestVersion: { hash: 'b' },
    } as VersionEvent);
    expect(update.ready()).toBe(true);
  });

  it('lets the player put it off, and does not re-check within the minimum gap', () => {
    sw.versionUpdates.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'a' },
      latestVersion: { hash: 'b' },
    } as VersionEvent);
    update.dismiss();
    expect(update.ready()).toBe(false);

    document.dispatchEvent(new Event('visibilitychange'));
    expect(sw.checks).toBe(1); // throttled: the launch check was moments ago
  });

  it('does nothing at all when the worker is not running', () => {
    sw = new FakeSwUpdate();
    sw.isEnabled = false;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: SwUpdate, useValue: sw }],
    });
    const offline = TestBed.inject(UpdateService);

    expect(sw.checks).toBe(0);
    expect(offline.ready()).toBe(false);
  });
});
