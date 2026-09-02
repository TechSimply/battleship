import { TestBed } from '@angular/core/testing';
import { SwUpdate } from '@angular/service-worker';
import { App } from './app';

/** No worker under test, same as a dev build: UpdateService stands down. */
const swDisabled = { isEnabled: false } as SwUpdate;

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: SwUpdate, useValue: swDisabled }],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the game board', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Ship Duel');
  });

  it('offers the install prompt alongside whichever screen is up', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    // Not in the lobby's template: a player who arrived on an invite link goes
    // straight to the game and would otherwise never be offered the app.
    // Class, not id: earlier tests' fixtures are still in the document with the
    // same ids, and an id selector finds those first.
    expect(compiled.querySelector('.install-bar')).toBeTruthy();
    expect(compiled.querySelector('.install-action')?.textContent).toContain('Install');
  });
});
