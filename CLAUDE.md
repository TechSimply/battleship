# Battleship — project guide

A peer-to-peer Battleship game built as an installable Angular PWA, mobile-first.
Deployed to GitHub Pages: https://techsimply.github.io/battleship/

## Game rules

The authoritative spec is [`Documentation/game-logic.txt`](Documentation/game-logic.txt)
(the owner edits it directly — always re-read it before changing game logic). In short:

- **One united 4×4 board** (rule 2.3). The two boards survive only as the private placement
  step: each player picks their starting square hidden from the other, and from the first shot
  on both ships sail, fire at and bomb the same 16 squares — a crater is dead for both.
- **One ship per player**, occupying one square; it can move to any of its 8 bordering squares.
- Then alternating fire: firing **exposes** the square you fired from (rule 5.2), the bombed
  square becomes **permanently unusable** (rule 5.3), and after firing you **must move** one
  square if any usable neighbour remains (rule 5.4). You cannot bomb the square you sit on.
- **Health (rule 6):** a ship starts at 100%. The first hit does not sink it — it drops to
  **50%** and catches fire (orange); every **move** its owner then makes burns another
  **10%** off, and the colour slides from orange towards the wreck's red. A second hit takes
  it straight to 0%. At **0% that player loses** and the ship plays the shipwreck animation.
- **Ramming (rule 11):** sailing onto the other ship wrecks **both** — the round ends with
  **no point for either player** and both wrecks on that one square, played as a collision
  (the hulls run together along the rammer's own course, then flash, ring and shake) rather
  than the ordinary sinking. It is settled *before*
  the fire, so a ship at 10% that rams draws instead of losing. Placing both ships on the same
  square is the same thing, before the first shot (rule 11.5) — deliberately not prevented,
  since "that square is taken" would tell player 2 exactly where player 1 is.
- **Health display (rule 10):** both healths are on screen from the first second, as two
  horizontal gauges above the board, with the little ship icon and the percentage in the
  ship's current colour, plus a **ship counter** (1, or 0 once wrecked) so nobody reads this
  as the classic fleet game. On-screen wording never says "fleet".
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
  (local or received); `tryLocal(actor, coord)` validates a tap on the one board and returns
  the action to mirror. Craters live in a single shared `destroyed` signal (rule 2.3), not per
  player; `rammed()` is the draw (`phase === 'gameover'` with `winner() === null`). Because
  both devices apply the same actions deterministically, derived state (exposure, bombed
  squares, scores) stays in sync with no extra messages. `reset()` = round reset (keeps score);
  `resetScores()` = new session.
- `src/app/game/session.service.ts` — owns the PeerJS lifecycle. Host claims peer id
  `techsimply-battleship-battle-{n}` (shown as the plain number), joiner connects by id; game
  actions flow over the data channel, each numbered per sender and applied strictly in order
  exactly once (`actionInOrder`). Handles join errors and opponent-disconnect. `parseGameId()`
  accepts `Battle3` / `battle 3` / `3`.
  **The joiner knocks, it does not knock once.** The normal shape of an invite is: host sends
  the link from a messaging app, which puts their PWA to sleep and takes `Battle{n}` off the
  broker with it, and player 2 opens the link during exactly that gap. A single dial answered
  with `peer-unavailable` therefore means "asleep", not "gone", and failing on it made every
  invite land on "Game over — opponent left". `dialHost()` now re-dials every 2s (the host
  re-registers the moment they look at their screen), knocks carry a generation number so a
  superseded dial's timeout cannot tear down the one that got through, and how long the
  knocking lasts is decided by the registry, not a stopwatch: `watchHostLink()` asks
  `registry.isHostAlive()` every 8s and pushes the deadline back to `JOIN_WINDOW_MS` on every
  yes, up to a hard `MAX_JOIN_WINDOW_MS` of 5 minutes. Only a definite `false` ends it early
  (a Firebase that is merely unreachable must never downgrade a live game to "opponent left").
  A fixed 60s window was too short for the case below — a host whose app was *killed* needs a
  relaunch, not a glance. `session.waitingForHost` tells the lobby to say so; the joiner also
  heartbeats its own presence once it knows the link is real, which is what lets the hosting
  screen say "They're on the link" (`session.joinerWaiting`) and keeps the link reclaimable
  for player 1 while someone is actually waiting on it.
  **A killed host re-takes its number on the next launch.** Freezing a backgrounded tab is
  one thing; a phone may instead *kill* an installed PWA outright — which is exactly what can
  happen while the host is in a messaging app sending the invite. Player 1 then cold-boots
  into the lobby with no peer and no number, "New Game" would hand them a different one, and
  the friend staring at "Still knocking" could not be reached by anything player 1 did. So
  `hostWithId()` writes the number to `localStorage` (refreshed on every visibility change,
  since the write before hiding is the one that survives the kill) and `resumeHostedLink()`
  — called by `app.ts` on any load without a `?join=` param, and by `join()` when the number
  typed/opened is our own — reclaims the seat in Firebase and hosts the *same* `Battle{n}`
  again. It is only ever offered for a link that never paired: once a game has started its
  state lives in the two browsers and still cannot be resumed. The memory is dropped as soon
  as the link pairs up or the player leaves.
  **Cancel is not Leave.** A joiner whose knock never got through does not hold the link, so
  `leave()` only `terminate()`s from `hosting` / `playing` / `disconnected` — cancelling a
  join used to delete the host's record, killing the game for its owner too.
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
  internet" the moment they left the app to send the invite.
  **Recovery is a property of the session, not of a `Peer`.** PeerJS aborts and discards
  peers freely — a socket that never carried an id, or (very common) a reconnect that lands
  while the broker is still holding the id from the socket that just died, which comes back
  as `unavailable-id`. Every replacement peer arrives with no history, so judging it on its
  own history put that same error back on screen for a host who had been sitting on a
  claimed number. Hence `brokerSeen` on the service: once we have held a number, broker
  trouble is ridden out — reconnect if the peer survives, otherwise `rebuildPeer()` claims
  the *same* reserved number again so the link already shared keeps working — and the error
  screen is reached only with the app on screen (never while backgrounded) and the retry
  budget genuinely spent. `peerErrorAction()` classifies; `session.peer-drop.spec.ts` drives
  the whole chain against a stand-in Peer. Leaving sends `bye`. Dev builds expose
  `__battleshipDrop()` to sever the channel in tests.
- `src/app/game/lobby-registry.service.ts` — Firebase Realtime Database bookkeeping for
  rule 9 (project `battleship-p2p`, europe-west1; rules in `database.rules.json`). Holds one
  `/sessions/{n}` record per game: `claim()` reserves a number atomically, presence heartbeats
  keep it alive, `isSessionAlive()` applies the rule 9.2 TTLs (2 min never-paired / 5 min once
  paired, measured from the newest heartbeat), and `terminate()` deletes the record on Leave so
  the number is reusable. `isPartyPresent()` drives `session.opponentPresent`, which tells a
  player their opponent closed the app. `reclaimHost()` is how a relaunched player 1 gets its
  seat back (rule 9's "the one who created the link is player1 … when they return they should
  represent respective player number"); it refuses a link that has paired, because that game
  cannot be resumed. `isHostReachable()` is deliberately *not* `isSessionAlive()`: a knocking
  player 2 heartbeats itself onto the record, and a joiner that read its own presence as proof
  of life would knock on an abandoned link forever — so it dates the link by the host's own
  last beat, with the occupied window while a player 2 waits. Gameplay never goes through Firebase. If Firebase is
  unreachable the app degrades to a PeerJS-only claim. Note `reclaim()` must do an explicit
  `get()` then `update()` — a `runTransaction` sees `null` on a cold page load and aborts
  without ever reaching the server.
- `src/app/lobby/` — the New Game / Join The Game lobby (mobile-first). The host can copy an
  invite link (`…/?join={n}`, built from `document.baseURI`) that `app.ts` auto-joins on load,
  or share just the number for manual entry (digits-only field with a fixed "Battle" prefix).
  "Play vs Computer" runs a local bot (session mode `'bot'`, no PeerJS): an effect in
  `SessionService` feeds random-but-legal place/fire/move actions into `game.apply()` on a
  short thinking delay whenever the game waits on player 1.
- `src/app/game/` — per-player game view of the one united board: your ship is drawn, the
  enemy's is hidden until it is wrecked or the game ends — a *burning* enemy is never drawn,
  since revealing its square each turn would make finishing it trivial; its damage shows only
  in the health gauge. The two gauges sit inside the board panel, above the board, so
  `fitBoards()` counts them as panel chrome and the board still fits exactly. Health colours live in `healthColor()` (game.ts) and reach
  the CSS as `--ship-color` on the board panel, so gauge, ship icon, counter and the flame on
  the deck are always the same colour. It is a fixed, viewport-sized column
  that never scrolls: one dense top row (game id · score · leave), the status pill,
  then the boards taking all the space that's left. `fitBoards()` measures that
  leftover space after every render (and on resize/rotation) and sets `--board-size`,
  so the two boards always fit exactly; the chrome itself scales with the `--ui`
  clamp, zooming out on smaller screens. `.boards` centres and clips rather than
  scrolls, so a fit that misses by a couple of pixels shows up as a shaved top header
  and a cut-off bottom row. Two things keep it honest. The board is `--board-size`
  square *by construction* — definite width and height plus
  `grid-template-rows: repeat(4, 1fr)`, never four `aspect-ratio: 1` cells whose
  separately-rounded row heights add up to whatever the device pixel grid says. And
  the fit ends by measuring the panels as they were actually laid out and handing back
  any overflow, instead of trusting its own model of the chrome.
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
- `src/app/install.service.ts` — offers the app for installation on *every* screen until it
  is installed. A player who arrives on an invite link goes straight into a game and may never
  see the lobby, so the offer lives in `app.html` (lobby and game alike), not in the lobby.
  Chrome fires `beforeinstallprompt` once and only a *cancelled* one stays replayable — hence
  the pre-bootstrap catch in `main.ts` that parks it in `__battleshipInstallEvent` for the
  service to pick up. Where there is no such event the Install button opens a sheet with that
  browser's own route (`route()`: iOS Share sheet, an in-app browser that must be escaped
  first — invites arrive through exactly those — or the browser menu). Silent once
  `display-mode: standalone` (or `navigator.standalone`) says we are installed, and inside the
  GD portal iframe. It takes a strip at the bottom that both screens reserve via
  `--install-strip` (set in `app.scss`); it never floats over the fleet board, where it would
  eat taps meant for the last row of cells. **In a game it is only a corner chip** — one slim
  line of lobby is cheap, a bar across the board is not — and the same chip replaces the bar
  everywhere once the player dismisses it (remembered in `localStorage`; nothing brings the
  bar back). The chip installs in one tap, exactly like the bar's button. Dev builds expose
  `__battleshipInstall()`.
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
