import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Chrome fires `beforeinstallprompt` once, and only an event that was cancelled
// stays replayable from our own Install button. It can land before Angular has
// finished bootstrapping, so catch it here and park it where `InstallService`
// picks it up on construction.
addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  (globalThis as Record<string, unknown>)['__battleshipInstallEvent'] = event;
});

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
