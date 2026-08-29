# Monetisation

Live: https://battleship-p2p.web.app · repo: private property, see LICENSE

## Reality check

"Instant submission + pays well" is a trade-off. Fast portals pay little because
they bring little traffic. Picky ones pay because they bring players.

| Platform | Multiplayer | Submission | Pays |
|---|---|---|---|
| **GameDistribution** | yes | light, ~days | ad revshare | 
| **Newgrounds** | yes | instant | small revshare |
| **itch.io** | yes | instant | ~$0 (no traffic) |
| CrazyGames | yes | review, weeks | good |
| Poki | yes | very picky | best |

**Closest to what we want: GameDistribution.** Non-exclusive, so it does not
block CrazyGames later.

## Done

- [x] Hosted on Firebase + GitHub Pages, auto-deploy on push to `main`
- [x] Renamed off "Battleship" (Hasbro trademark) → **Ship Duel**
- [x] LICENSE — all rights reserved
- [x] RTDB rules hardened: no future-dated timestamps, `joined` sticky
- [x] Play counters at `/stats` (`gamesStarted`, `botGames`) — cookieless, no
      consent banner needed. Verified writing.

## ToDo

- [ ] Put full legal name in LICENSE (currently just "Nukri")
- [ ] Post to r/WebGames with a GIF — lead with "Play vs Computer"
- [ ] itch.io page (free, instant)
- [ ] Newgrounds — instant, revshare. Fastest path to first revenue.
- [ ] Submit to GameDistribution (~1h: integrate their ad SDK, they host the build)
- [ ] Watch `/stats` for a week — do people replay?
- [ ] Only if retention looks good: CrazyGames, then Poki

## Blocked / later

- **Ads**: work today, no rewrite. Need traffic first.
- **Wagering** (Skillz-style): needs server-authoritative state — ship coords
  currently cross the wire, so devtools reveals them. Not viable as built.
- **Anonymous Auth**: anyone can still write to `/sessions`. Griefing risk only
  matters once we have players.
- **Repo private**: possible now we are on Firebase Hosting (Pages needs public).
- Rename repo/folder off `battleship`.
