# Battleship — project guide

A two-player Battleship game built as an installable Angular PWA, mobile-first.
Deployed to GitHub Pages: https://techsimply.github.io/battleship/

## Game rules

The authoritative spec is [`Documentation/game-logic.txt`](Documentation/game-logic.txt)
(the owner edits it directly — always re-read it before changing game logic). In short:

- **One united 4×5 board (4 wide, 5 high)** (rule 2.3). The two boards survive only as the private placement
  step: each player picks their starting square hidden from the other, and from the first shot
  on both ships sail, fire at and bomb the same 20 squares — a crater is dead for both.
- **One ship per player**, occupying one square; it can move to any of its 8 bordering squares.
- Then alternating fire: firing **exposes** the square you fired from (rule 5.2), the bombed
  square becomes **permanently unusable** (rule 5.3), and after firing you **must move** one
  square if any usable neighbour remains (rule 5.4). You cannot bomb the square you sit on.
- **Health (rule 6):** a ship starts at 100%. The first hit does not sink it — it drops to
  **50%** and catches fire (orange); every **move** its owner then makes burns another
  **10%** off, and the colour slides from orange towards the wreck's red. A second hit takes
  it straight to 0%. At **0% that player loses** and the ship plays the shipwreck animation.
  A hit shows on the board too (rule 6.2.1): the struck hull flashes into view for a second
  under the blast, and its crater stays orange and smoking instead of grey.
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
- **Firebase Realtime Database** is the whole backend: session records *and* the move log
  (see the architecture notes below for why the game left WebRTC). No server code of our own.

## Architecture

- `src/app/game/game.service.ts` — pure rules engine, and now a *partially observable* one:
  it knows this device's own ship and only what the enemy has actually given away. State in
  signals; every mutation is a serializable `GameAction` (`place` / `fire` / `move` / `stay` /
  `reveal` / `reset`). `apply()` runs an action (played here, or read off the log);
  `intent(actor, coord)` says what a tap would mean, checked against what this device knows
  for certain. A `place`/`move` carries a square only when this device is entitled to it —
  its own, or a ram; `hit` and `ram` are answers the database supplies, because no client is
  allowed to work them out. `PlayerState.placed` (their ship is out there somewhere) is
  therefore not the same question as `ship !== null` (we can see it), and `epoch` counts a
  ship's positions so a shot can name the one it was aimed at. `stay` is rule 5.4's boxed-in
  shooter, explicit now because no device can tell whether the *enemy* had anywhere to sail. Craters live in a single shared `destroyed` signal (rule 2.3), not per
  player; `rammed()` is the draw (`phase === 'gameover'` with `winner() === null`). Because
  both devices apply the same actions deterministically, derived state (exposure, bombed
  squares, scores) stays in sync with no extra messages. `reset()` = round reset (keeps score);
  `resetScores()` = new session.
- `src/app/game/session.service.ts` — the lobby state machine and this device's seat.
  `newGame()` claims a random free number, `join()` takes the empty seat on a link,
  `resumeSession()` walks back into the game this device was in, `act()` plays a tap
  (two writes: commit the square, then log it with the database's answer) and is asynchronous
  for that reason — `busy()` holds the board while one is in flight, and `problem()` says so
  when the database refuses one. `parseGameId()` accepts `Battle3` / `battle 3` / `3`.
  **There is nobody to find any more.** Player 2 does not dial player 1 and does not wait
  for them to be awake: the seat is a field on a database record, so they are in the game
  immediately and can place their ship while player 1 is still in the messaging app they
  sent the invite from. This deleted the whole family of bugs the file used to be built
  around — knocking, ghost pairings, ids the broker was still holding, sockets that died
  without saying so, `hello` handshakes to prove somebody was there.
  **A seat belongs to a device, not to a connection.** Each device stores a `clientId` in
  `localStorage`; `claim()` writes it as `hostId` and `takeJoinerSeat()` as `joinerId`.
  `registry.seatOn()` reads the seat back off the record, so rule 9's "when they return they
  should represent respective player number" is settled by the record rather than by what the
  app happens to remember — and a stranger who guesses a live number is turned away instead
  of walking into someone's game.
  **Leaving is not losing.** Closing the app, a flat battery or a tunnel is a pause: the board
  is on the server, so `app.ts` calls `resumeSession()` on any load without `?join=` and the
  player lands back on their own board mid-game. Only the Leave button ends a game — it
  terminates the link for both players (`state === 'disconnected'` on the other side).
  **Applying a move exactly once.** The acting device applies its own action as soon as the
  database has answered it, and drops the echo that comes back off `onChildAdded`; it claims
  the key *before* writing, because Firebase shows a device its own writes long before the
  server has agreed to them — including a guess that is about to be rejected. A replay after
  a relaunch starts with an empty set, so on that path the *same* entries are applied, which
  is exactly what rebuilding the board means. This device's own squares are not in the log,
  so a replay reads them back out of the secret (`ownShips`) before it starts.
- `src/app/game/lobby-registry.service.ts` — Firebase Realtime Database: session bookkeeping
  for rule 9 **and the multiplayer transport** (project `battleship-p2p`, europe-west1; rules
  in `database.rules.json`). One `/sessions/{n}` record per game: `claim()` reserves a number
  atomically, presence heartbeats keep it alive, `isSessionAlive()` applies the rule 9.2 TTLs
  (10 min never-paired / 3 h once paired, measured from the newest heartbeat), `terminate()`
  deletes the record on Leave so the number is reusable, and `reclaimSeat()` gives a returning
  device the seat its `clientId` holds. Under `moves` is an append-only log of every action:
  `sendMove()` pushes one, `watchMoves()` replays the whole log and then follows it, and
  `toAction()` parses defensively — anyone who knows a number can write to the database, so a
  malformed record is skipped rather than fed to the rules engine. Because `GameService` is a
  deterministic reducer, replaying the same log gives every device the same board, which is
  what makes both sync and resume free.
  **Why the game left WebRTC.** Gameplay used to run peer-to-peer over a data channel brokered
  by the free PeerJS cloud, and it had three independent ways to fail on a phone: the broker
  forgets a backgrounded host's id, its offer queue answers late enough to race the joiner's
  own retries, and ICE cannot always cross a carrier NAT (the fallback being a free shared TURN
  relay on one UDP port). Each one surfaced as two players staring at screens that never
  changed. This is one WebSocket to Google on 443 — the same connection that was already
  claiming the game number successfully on the very phones where the game would not start.
  Latency is irrelevant to a turn-based game; the free tier's ~100 simultaneous connections
  (two per game) is the ceiling worth watching.
  **`reclaim` must do an explicit `get()` then `update()`** — a `runTransaction` sees `null` on
  a cold page load and aborts without ever reaching the server.
  **Rules are not deployed by the Pages workflow.** `database.rules.json` is deployed by
  `firebase-hosting-merge.yml` (before hosting, so a failure leaves the working build up) or by
  hand with `firebase deploy --only database`. A client that writes against rules that do not
  know about it is a game that cannot be played, so rules go out first — and the Pages workflow
  runs independently of that one, so on a change touching both, watch the rules deploy land
  before the app does. `npm run test:rules` catches both rejected writes and rules that do not
  parse (the file takes no comment keys, unlike `firebase.json`).
  **The rules are generated.** Edit [`tools/rules.mjs`](tools/rules.mjs) and run `npm run rules`
  — never `database.rules.json` by hand. The expressions are far too long to write as JSON (the
  boxed-in test alone is eight bordering squares), and the file cannot carry a comment saying
  what any of them mean.
  **Anonymous auth is a hard dependency.** Every read and write needs a signed-in account now,
  so *Authentication → Sign-in method → Anonymous* must stay enabled in the Firebase console.
  With it off there is no lobby and no game.
- `src/app/lobby/` — the New Game / Join The Game lobby (mobile-first). The host can copy an
  invite link (`…/?join={n}`, built from `document.baseURI`) that `app.ts` auto-joins on load,
  or share just the number for manual entry (digits-only field with a fixed "Battle" prefix).
  "Play vs Computer" runs a local bot (session mode `'bot'`, nothing written to the database):
  an effect in `SessionService` feeds random-but-legal place/fire/move actions into `game.apply()` on a
  short thinking delay whenever the game waits on player 1.
- `src/app/game/` — per-player game view of the one united board: your ship is drawn, the
  enemy's is hidden until it is wrecked or the game ends — a *burning* enemy is never drawn,
  since revealing its square each turn would make finishing it trivial; its damage shows only
  in the health gauge. The one glimpse you get of it is its **muzzle flash**: firing already
  gives the square away (rule 5.2), so when the enemy shoots, their hull lights up on the
  square the rocket leaves (`muzzle` in game.ts, `.fire-ghost` / `fire-reveal` in game.scss)
  and the sea takes it back after `FIRE_REVEAL_MS` — or sooner, since a second effect drops
  the reveal the moment their ship actually moves. Where they sail afterwards (rule 5.4) is
  never drawn; only the exposure reticle stays behind. It is the same one hull element as the
  hit reveal (rule 6.2.1) — a shot's launch square and its target square are never the same. The two gauges sit inside the board panel, above the board, so
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
  burning exhaust behind. **Only the enemy's flame stands** (rule 5.5): theirs burns from
  their shot until their next one, so the square they fired from keeps saying so, while
  your own — which tells you nothing you didn't already know — fades out and is dropped
  a second after the launch (`OWN_TRAIL_MS` in `game.ts`, the `trail-fade` animation in
  `game.scss`; keep the two in step). Rocket and trails are rendered from the template (never `createElement` — the
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

## Anti-cheat: where the ships live

Both boards used to hold both ships, so the enemy's square was one console command away, and
every rule the game turns on — a hit, a legal step, a ram — was whatever a client said it was.
It isn't any more. **A ship's position never travels over the wire.** It is written to
`/secrets/{n}/{round}/{seat}/{epoch}`, which `database.rules.json` lets only that seat's own
device read, and the database is the only party that ever sees both of them.

Everything a client would otherwise be trusted with is checked there, against data it cannot
read:

- **a position is write-once**, must border the one before it and may not be a crater — so no
  teleporting, and no dodging a shot that has already been fired at the epoch you were in;
- **`hit` and `ram` are validated** against the enemy's committed square, so neither can be
  claimed nor denied;
- **a shot is fired from the square the shooter is really on** (rule 5.2), and never at the
  square under its own keel;
- **a `stay`** (rule 5.4 with nowhere to go) is only accepted from a ship that is genuinely
  boxed in — otherwise standing still while the log says you sailed would quietly break the
  deduction in `possibleShipSquares()` that the whole game is played on;
- **a seat is an anonymous auth uid**, so only your device can play your moves: no firing on
  your opponent's behalf, and no ramming yourself to a draw in their name.

Two things follow, and both are load-bearing:

**Every action is two writes.** A rejected write is itself a signal, so nothing may be
learnable from one until the action is spent: the move commits first (the new position, or the
crater record for a shot) and only then is the entry logged with the answer. The client simply
*guesses* that answer — `false`, then `true` — because by then the shot or the move has already
happened, and the guess reveals nothing it was not about to reveal anyway. Fold the two writes
back into one and the validation becomes an oracle a cheater can sweep the board with.

**A move is a round trip.** `act()` is asynchronous, the board is held (`busy()`) while a tap
is in flight, and if either write is refused the status pill says so (`problem()`). If a
connection dies between the two writes, the next attempt finds the epoch already committed and
carries on from the square that actually landed — otherwise the round would be stuck forever.

What this does **not** do: it cannot stop a player from reading their own board, and the
computer opponent is all on one device by definition, so `'bot'` mode settles its own hits and
rams locally. And the guarantee is about what the *other* device will accept — a cheat that
only fools the cheater is not worth spending a rule on.

## Commands

```bash
npm test                                   # vitest unit tests
npm run rules                              # regenerate database.rules.json from tools/rules.mjs
npm run test:rules                         # …and check it against the database emulator (needs Java)
npx ng build --configuration production    # prod build
npx ng serve --port 4200                   # dev server
```

- `allowedCommonJsDependencies: ["sdp"]` in `angular.json` silences a webrtc-adapter CJS warning.
- Deploy is automatic on push to `main` via `.github/workflows/deploy-pages.yml`
  (uses `actions/configure-pages` with `enablement: true` so Pages self-enables).

## Verifying changes

`session.invite.spec.ts` runs the whole invite between **two real `SessionService`s** and one
in-memory stand-in for the database (records, presence, the move log). It covers what the old
transport could not do at all: player 2 joining while player 1's app is closed, either player
relaunching mid-game and getting their board back, a stranger being turned away, and Leave
ending it for both. Assert a move *crossing* — two devices looking at unrelated boards both
say "playing" too.

The anti-cheat is asserted in exactly one place, and it is not in the app: **`npm run
test:rules`** boots the database emulator on the real `database.rules.json` and drives it over
REST as three signed-in devices — the two seats and a stranger — checking that a player cannot
read the other ship, teleport, dodge, lie about a hit or a ram, fire from somewhere it isn't,
claim to be boxed in, or write a move in the other seat's name. The client tests can only show
that the app plays by the rules; these are what show the database *makes* it. They also check
that every write the client actually makes is accepted (including `update()` calls, where the
rules see the merged node), and that the file parses at all — that is how the "no comment keys
in a rules file" trap gets caught before a deploy. Add a case here for anything that touches
`tools/rules.mjs`.

The two-device flow is verified end-to-end by driving two isolated browser contexts with
**Playwright** against `ng serve` with `databaseURL` pointed at that emulator (remember to put
`environment.ts` back). That is a real game between real browsers over the real SDK and the
real rules — it is how "player 2 joins while player 1 is away" and "reload mid-game keeps the
board" were confirmed, and it catches integration bugs the fakes cannot.

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

**Spectating and history.** The move log makes both nearly free — a third subscriber could
watch a game, and a finished one could be stepped through.

**Pruning.** Nothing deletes an abandoned record before its TTL, `moves` grows for the life of
a session, and `/secrets/{n}` outlives the game it belonged to (a Leave deletes the record but
cannot delete the secret, which is why a round's namespace carries the session's `createdAt` —
a recycled number never lands on the last game's positions). All tiny, but a scheduled cleanup
(or `onDisconnect` housekeeping) would keep the free tier comfortable if the game gets busy.

**A rematch is still a client's word.** `reset` is the one entry the rules do not check, so a
player who is losing can force the next round rather than lose the point. Settling it would
mean teaching the rules the whole health ladder; a cheaper fix is to let the log record who
asked and let the other player see it.

Random first player, real-world two-phone connection test, further PWA polish.
