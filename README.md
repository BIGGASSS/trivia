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

- Vue 3 + TypeScript
- Vite
- Custom Vite middleware in `server/multiplayer.ts` for multiplayer APIs
- Bundled GeoJSON country borders from `public/countries.geo.json`

## Map data

Country border data is bundled at `public/countries.geo.json`.

Vite serves that file at `/countries.geo.json` in development and copies it into `dist/` during production builds. The multiplayer middleware reads the same bundled file for country prompts. Every named feature in the GeoJSON must include playable Polygon or MultiPolygon geometry so the full data set is visible and guessable in-game.

To refresh the map data, replace `public/countries.geo.json` with an updated GeoJSON feature collection.

## Project setup

```sh
pnpm install
```

## Development

```sh
pnpm dev
```

The Vite dev server also provides:

- `GET /countries.geo.json`
- `POST /api/multiplayer/rooms`
- `GET /api/multiplayer/rooms/:roomCode`
- `GET /api/multiplayer/rooms/:roomCode/events`
- `POST /api/multiplayer/rooms/:roomCode/join`
- `POST /api/multiplayer/rooms/:roomCode/start`
- `POST /api/multiplayer/rooms/:roomCode/guess`
- `POST /api/multiplayer/rooms/:roomCode/skip`
- `POST /api/multiplayer/rooms/:roomCode/leave`

Multiplayer rooms are kept in memory, so restarting the server clears active rooms.

## Build and checks

```sh
pnpm build
pnpm test:unit
pnpm lint
```

## App routes

- `/` — homepage
- `/country-game` — game setup
- `/country-game/solo` — solo game
- `/country-game/multiplayer` — create/join multiplayer setup
- `/country-game/multiplayer/:roomCode` — multiplayer room
