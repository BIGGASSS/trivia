# World Trivia

World Trivia is a Vue/Vite geography trivia app. Players are prompted with a country name and must find it on an unlabeled, border-only world map.

## Features

- Landing page for the World Trivia game hub
- Country guessing game with a pannable, zoomable SVG world map
- Solo mode with timed rounds, score, streak, and accuracy tracking
- Multiplayer rooms with shareable room codes, live room updates, and leaderboards
- Server-sent events for multiplayer synchronization and reconnect handling
- Configurable round count, up to the loaded country count, and up to 5 multiplayer players per room

## Tech stack

- Vue 3 + TypeScript with [vue-router](https://router.vuejs.org/)
- Vite+ (`vp`) toolchain (Vite, Vitest, Oxlint, Oxfmt)
- Custom Vite middleware in `server/` for the multiplayer API
- `shared/` module with types, constants, and helpers used by both the browser client and the server middleware

## Project layout

- `src/views/` — routed views (`HomeView`, `CountryGameView`)
- `src/components/WorldMap.vue` — game orchestrator wiring composables to the presentational components in `src/components/country-game/`
- `src/composables/` — countries data loading, solo game engine, multiplayer client, map viewport, reveal-zoom animation
- `shared/` — isomorphic types/constants/utils shared by client and server
- `server/` — multiplayer room engine (`room-manager.ts`) and HTTP/SSE middleware (`multiplayer.ts`)
- `scripts/build-country-paths.ts` — map data build script

## Map data

The map pipeline has three stages:

1. `data/countries.geo.json` — the source GeoJSON feature collection (committed to git so builds are reproducible without a download step).
2. `scripts/build-country-paths.ts` — converts the GeoJSON into compact SVG path strings, simplifying shared borders topologically so neighbouring countries stay crack-free. Run it with `vp run build:map` (also runs automatically as part of `vp run build`).
3. `public/countries.paths.json` — the generated payload, served by Vite at `/countries.paths.json` in development and copied into `dist/` during production builds. The multiplayer middleware reads the same file for country prompts.

The build script accepts these environment variables:

| Variable                            | Default | Meaning                                            |
| ----------------------------------- | ------- | -------------------------------------------------- |
| `COUNTRY_MAP_TOLERANCE`             | `0.08`  | Douglas–Peucker simplification tolerance (degrees) |
| `COUNTRY_MAP_MIN_AREA`              | `0.02`  | Minimum outer-ring area to keep (square degrees)   |
| `COUNTRY_MAP_MAX_RINGS_PER_COUNTRY` | `20`    | Maximum rings (islands) kept per country           |
| `COUNTRY_MAP_DECIMALS`              | `3`     | Coordinate decimal places in the output            |

To refresh the map data, replace `data/countries.geo.json` with an updated GeoJSON feature collection and run `vp run build:map`. Every named feature must include Polygon or MultiPolygon geometry so the full data set is visible and guessable in-game.

## Project setup

Install [Vite+](https://viteplus.dev/guide/), then run:

```sh
vp install
```

Vite+ manages Node.js **26.8.2** and pnpm **12.4.1**, pinned in
`package.json` under `devEngines`. To update both to the latest releases:

```sh
vp env pin latest pnpm@latest --force
vp install
```

## Development

```sh
vp dev
```

### Multiplayer server

The multiplayer backend (`server/multiplayer.ts`) is plain Node HTTP
middleware. It's mounted into `vp dev` / `vp preview` by a Vite plugin, and
into the standalone production server (`server/main.ts`) described below.
Rooms are kept in memory, so restarting the server clears active rooms; idle
rooms are swept automatically after 30 minutes.

The dev, preview, and production servers provide:

- `GET /countries.paths.json` (static map data)
- `POST /api/multiplayer/rooms`
- `GET /api/multiplayer/rooms/:roomCode`
- `GET /api/multiplayer/rooms/:roomCode/events` (SSE)
- `POST /api/multiplayer/rooms/:roomCode/join`
- `POST /api/multiplayer/rooms/:roomCode/start`
- `POST /api/multiplayer/rooms/:roomCode/guess`
- `POST /api/multiplayer/rooms/:roomCode/skip`
- `POST /api/multiplayer/rooms/:roomCode/leave`

## Production

Don't run `vp dev` (or `vp preview`) in production. Build the client and the
server, then run the bundled server with plain Node:

```sh
vp run build          # client -> dist/
vp run build:server   # server -> dist-server/main.mjs (dependencies inlined)
vp run start          # node dist-server/main.mjs
```

The server serves `dist/` (with an `index.html` fallback for client routes and
immutable caching for `assets/`) and the multiplayer API. Only `dist/` and
`dist-server/` plus a Node.js runtime are needed at deploy time — no
`node_modules`.

| Variable     | Default                        |
| ------------ | ------------------------------ |
| `PORT`       | `3000`                         |
| `HOST`       | `0.0.0.0`                      |
| `STATIC_DIR` | `dist/` next to `dist-server/` |

Deployment notes:

- **Run a single instance.** Room state is in memory; multiple replicas or
  serverless functions would each see different rooms.
- **Use a host that allows long-lived connections** (VM, container, Fly,
  Railway, Render, …). Room updates stream over SSE.
- **Terminate TLS in a reverse proxy** (Caddy, nginx). Responses set
  `X-Accel-Buffering: no` so nginx won't buffer SSE. Redact the
  `sessionToken` query parameter from access logs (see below).
- The server shuts down gracefully on `SIGTERM`/`SIGINT`.

### Multiplayer sessions and ordering

Create/join responses include a private `sessionToken`, stored locally for rejoining.
Player IDs and room codes are public identifiers, **not credentials**. Authenticated
POST bodies require `sessionToken`; state/SSE GETs carry it in the `sessionToken`
query parameter because native EventSource cannot set authorization headers. Never
share these API URLs; use HTTPS and redact query credentials in proxy/access logs.
Room links contain only the room code. Snapshots never include session tokens and
API responses disable caching.

Guesses/skips also require the current snapshot's `matchId` and `roundId`. The
server scores synchronously, once per player/round and before the deadline.
Snapshots carry increasing `revision` values so delayed HTTP/SSE responses cannot
replace newer state. Navigation cancels local requests and subscriptions without
leaving the membership; explicit leave revokes the session and every subscription.
Departed players remain in match history but cannot answer or become host.

Temporary rejoin failures retain credentials and offer **Retry rejoin** (also
retried when the browser comes online). Missing rooms or invalid sessions clear
only the affected credential. Legacy ID-only stored sessions cannot authenticate
and are discarded; players must join again after this protocol update.

## Build and checks

```sh
vp run build  # build:map + type-check + Vite build
vp test       # unit tests
vp check      # format, lint, and type checks
vp fmt        # format files
vp exec playwright install chromium  # once, for browser tests
vp run test:browser                  # builds, then runs Chromium tests
```

Tests cover shared utilities, the room engine, real HTTP/SSE authorization,
concurrent answers, reconnects, snapshot ordering, route teardown, solo gameplay,
and map data. Browser tests exercise actual mouse drag/wheel, mobile pinch,
keyboard focus/guessing, and reduced motion in responsive SVG layouts. They serve
built assets through Playwright request interception; **no dev or preview server
is started**. Browser traces on failure are in `node_modules/.cache/playwright-results`.

CI (`.github/workflows/ci.yml`) uses `setup-vp` to resolve the same pinned Node.js
and pnpm versions, then runs checks, unit/integration tests, the build, and Chromium
browser tests on every push to `master` and pull request.

## App routes

Routing uses `vue-router` (HTML5 history mode):

- `/` — homepage
- `/country-game` — game setup
- `/country-game/solo` — solo game
- `/country-game/multiplayer` — create/join multiplayer setup
- `/country-game/multiplayer/:roomCode` — multiplayer room (rejoins using locally stored private credentials, never a player-ID query)
