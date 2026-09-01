# Battleship — project guide

A peer-to-peer Battleship game built as an installable Angular PWA, mobile-first.
Deployed to GitHub Pages: https://techsimply.github.io/battleship/

## Game rules

The authoritative spec is [`Documentation/game-logic.txt`](Documentation/game-logic.txt)
(the owner edits it directly — always re-read it before changing game logic). In short:

- Two boards, **4×4** each, stacked vertically (enemy waters on top, your fleet below).
- **One ship per player**, occupying one square; it can move to any of its 8 bordering squares.
- Placement phase (both players place their own ship; ships are hidden from the opponent).
- Then alternating fire: firing **exposes** the square you fired from (rule 5.2), the bombed
  square becomes **permanently unusable** (rule 5.3), and after firing you **must move** one
  square if any usable neighbour remains (rule 5.4).
- First ship hit **loses** (rule 6).
- **Sessions (rule 7):** a lobby offers *New Game* / *Join The Game*. New Game claims the
  lowest free `Battle{n}` id; the opponent joins by typing that id.
- **Scoring (rule 8):** within a session, one victory = one point; score persists across
  rematches and resets when the session ends.

## Stack & constraints

- **Angular 21**, SCSS, signals, standalone components, no SSR, PWA via `@angular/service-worker`.
- Angular is pinned to 21 because the owner's **Node is 22.15.0**, too old for Angular CLI 22
  (needs Node ≥ 22.22.3). Don't bump to 22 without a Node upgrade.
- **PeerJS** provides the P2P transport (WebRTC over the free PeerJS cloud broker — no backend).

## Architecture

- `src/app/game/game.service.ts` — pure rules engine. State in signals; every mutation is a
  serializable `GameAction` (`place` / `fire` / `move` / `reset`). `apply()` runs an action
  (local or received); `tryLocal()` validates a tap and returns the action to mirror. Because
  both devices apply the same actions deterministically, derived state (exposure, bombed
  squares, scores) stays in sync with no extra messages. `reset()` = round reset (keeps score);
  `resetScores()` = new session.
- `src/app/game/session.service.ts` — owns the PeerJS lifecycle. Host claims peer id
  `techsimply-battleship-battle-{n}` (shown as the plain number), joiner connects by id; game
  actions flow over the data channel, each numbered per sender and applied strictly in order
  exactly once (`actionInOrder`). Handles join errors and opponent-disconnect. `parseGameId()`
  accepts `Battle3` / `battle 3` / `3`.
  **There is deliberately no reconnect/resume.** Losing the data channel — closing the tab,
  quitting the PWA, a network drop — ends the game: both sides go to `disconnected` and must
  start a new one. An earlier version tried to resume by replaying missed actions, but the
  game state lives only in the two browsers, so any gap desynced the boards (players seeing
  different bombed squares, or a win only one side saw). Doing this properly means persisting
  the authoritative game server-side, not replaying deltas — see "Possible next steps".
  The one exception: if the host's connection dies before any action crossed it, that is the
  invite-link ghost dial, so the host just goes back to `hosting` (nothing was played).
  Broker-socket loss triggers a re-register retry loop so the id stays claimed while waiting
  for player 2. **Mind the order PeerJS reports that loss in:** it emits an `error`
  (`network` / `socket-closed` / `socket-error`) *before* the `disconnected` the retry loop
  listens for, so an error handler that treats those as fatal kills the peer and the retry
  loop never runs — which is what used to dump a host into "Connection problem — check your
  internet" the moment they left the app to send the invite. `peerErrorAction()` keeps them
  apart: a socket drop is only recoverable once the peer has actually been on the broker
  (PeerJS destroys a peer whose socket never came up, and that really is a connectivity
  problem). Leaving sends `bye`. Dev builds expose `__battleshipDrop()` to sever the
  channel in tests.
- `src/app/game/lobby-registry.service.ts` — Firebase Realtime Database bookkeeping for
  rule 9 (project `battleship-p2p`, europe-west1; rules in `database.rules.json`). Holds one
  `/sessions/{n}` record per game: `claim()` reserves a number atomically, presence heartbeats
  keep it alive, `isSessionAlive()` applies the rule 9.2 TTLs (2 min never-paired / 5 min once
  paired, measured from the newest heartbeat), and `terminate()` deletes the record on Leave so
  the number is reusable. `isPartyPresent()` drives `session.opponentPresent`, which tells a
  player their opponent closed the app. Gameplay never goes through Firebase. If Firebase is
  unreachable the app degrades to a PeerJS-only claim. Note `reclaim()` must do an explicit
  `get()` then `update()` — a `runTransaction` sees `null` on a cold page load and aborts
  without ever reaching the server.
- `src/app/lobby/` — the New Game / Join The Game lobby (mobile-first). The host can copy an
  invite link (`…/?join={n}`, built from `document.baseURI`) that `app.ts` auto-joins on load,
  or share just the number for manual entry (digits-only field with a fixed "Battle" prefix).
  "Play vs Computer" runs a local bot (session mode `'bot'`, no PeerJS): an effect in
  `SessionService` feeds random-but-legal place/fire/move actions into `game.apply()` on a
  short thinking delay whenever the game waits on player 1.
- `src/app/game/` — per-player game view: shows only this device's perspective; the enemy ship
  is hidden until it is hit or the game ends. It is a fixed, viewport-sized column
  that never scrolls: one dense top row (game id · score · leave), the status pill,
  then the boards taking all the space that's left. `fitBoards()` measures that
  leftover space after every render (and on resize/rotation) and sets `--board-size`,
  so the two boards always fit exactly; the chrome itself scales with the `--ui`
  clamp, zooming out on smaller screens. It measures fractionally and re-checks the
  panels against the size it just wrote — `offsetWidth`/`offsetHeight` round to whole
  pixels and the board's `aspect-ratio: 1` rows snap to the device pixel grid, so an
  open-loop fit can miss by a couple of pixels, and `.boards` centres and clips rather
  than scrolls: the miss shows up as a shaved top header and a cut-off bottom row.
  Firing flies a rocket from the shooter's square to the bombed square and leaves its
  burning exhaust behind: one trail per player, replaced only by that same player's next
  shot. Rocket and trails are rendered from the template (never `createElement` — the
  component's emulated encapsulation would not style hand-made elements) and anchored to
  cell centres in pixels, so `fitAndRealign()` re-measures them after every refit.
  On your fire turn, enemy waters also mark the squares their ship must be on —
  `possibleShipSquares()`, the same deduction the bot fires by, so the hint reveals
  nothing a player could not derive from the flame and the craters. Shown only once
  the enemy has fired (before that every unbombed square qualifies).
- `src/app/update.service.ts` — offers newly deployed builds. The service worker serves
  from cache and only swaps a new version in for a *fresh* client, and a phone suspends an
  installed PWA rather than closing it, so without this the app can sit on an old build
  indefinitely. Checks on launch, on every return to the foreground (throttled to once a
  minute) and hourly; on `VERSION_READY` — downloaded, not merely detected — `app.html`
  shows a "New version ready" pill. It is held back while `inGame()`, since reloading drops
  the peer connection and the round with it. Dev builds expose `__battleshipUpdate()` to
  raise the banner (the worker is disabled outside production).
- `src/app/app.ts` — swaps between lobby and game based on session state.
- Host = player 0 and fires first. Placement is simultaneous.

## Commands

```bash
npm test                                   # vitest unit tests
npx ng build --configuration production    # prod build
npx ng serve --port 4200                   # dev server
```

- `allowedCommonJsDependencies: ["sdp"]` in `angular.json` silences a webrtc-adapter CJS warning.
- Deploy is automatic on push to `main` via `.github/workflows/deploy-pages.yml`
  (uses `actions/configure-pages` with `enablement: true` so Pages self-enables).

## Verifying changes

Beyond unit tests, the two-device flow is verified end-to-end by driving two isolated browser
contexts with **Playwright + system Edge** (`channel: 'msedge'`, headless works) against the dev
server over a real PeerJS connection. That test caught a real exposure-marker bug — keep using it
for networked/multi-device changes.

## Conventions & gotchas

- **Bump the app version on every change.** The version shown in the header is the hardcoded
  string `version` in [`src/app/app.ts`](src/app/app.ts) (e.g. `v0.0.3`). Increment its patch
  digit as part of each commit that changes app behaviour, so the deployed PWA visibly reflects
  which build is live.
- The owner sometimes commits from their IDE with auto-generated messages — **check `git log`
  before committing**.
- **`gh` CLI is not installed.** For GitHub API use PowerShell `Invoke-RestMethod`; `curl` in Git
  Bash has SSL cert issues on this machine.
- Mobile-first: design every UI change for phones first.

## Possible next steps

**Server-authoritative game state.** The big one, and the prerequisite for
bringing back reconnect/resume: keep the board in Firebase (alongside the
session record) instead of only in the two browsers, so a player who closes the
app can rejoin the game exactly as it stood. Replaying deltas over P2P was tried
and removed — it desynced the boards whenever the replay had a gap.

TURN fallback for strict NATs (the free PeerJS cloud has no relay), random
first player, real-world two-phone connection test, further PWA polish.
