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

> **Note:** the multiplayer backend is implemented as Vite middleware
> (`server/multiplayer.ts`), so it only runs inside `vp dev` and
> `vp preview`. There is no standalone production server —
> deploying only the static `dist/` output ships a working solo game but no
> multiplayer. Rooms are kept in memory, so restarting the server clears
> active rooms; idle rooms are swept automatically after 30 minutes.

The dev and preview servers provide:

- `GET /countries.paths.json` (static map data)
- `POST /api/multiplayer/rooms`
- `GET /api/multiplayer/rooms/:roomCode`
- `GET /api/multiplayer/rooms/:roomCode/events` (SSE)
- `POST /api/multiplayer/rooms/:roomCode/join`
- `POST /api/multiplayer/rooms/:roomCode/start`
- `POST /api/multiplayer/rooms/:roomCode/guess`
- `POST /api/multiplayer/rooms/:roomCode/skip`
- `POST /api/multiplayer/rooms/:roomCode/leave`

## Build and checks

```sh
vp run build  # build:map + type-check + Vite build
vp test       # unit tests
vp check      # format, lint, and type checks
vp fmt        # format files
```

Unit tests cover the shared utilities, the server room engine, the solo game
engine, the map data build script, and app routing. Browser end-to-end tests
are a possible follow-up.

CI (`.github/workflows/ci.yml`) uses `setup-vp` to resolve the same pinned Node.js
and pnpm versions, then runs `vp check`, `vp test`, and `vp run build` on every
push to `master` and pull request.

## App routes

Routing uses `vue-router` (HTML5 history mode):

- `/` — homepage
- `/country-game` — game setup
- `/country-game/solo` — solo game
- `/country-game/multiplayer` — create/join multiplayer setup
- `/country-game/multiplayer/:roomCode` — multiplayer room (an optional `?playerId=…` query rejoins a stored session)
