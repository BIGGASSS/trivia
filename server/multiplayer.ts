/**
 * Multiplayer HTTP/SSE middleware for the country guessing game.
 *
 * This plugin only runs inside the Vite dev server (`vp dev`) and the Vite
 * preview server (`vp preview`); there is no standalone production server.
 * `/countries.paths.json` itself is served by Vite's regular `public/`
 * (dev) and `dist/` (preview) static file handling — this middleware only
 * handles `/api/multiplayer/*` routes. Game logic lives in `room-manager.ts`.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite-plus";
import { createRoomManager, HttpError } from "./room-manager";
import type { CountrySummary, RoomManager } from "./room-manager";
import { readJsonBody, sendCaughtError, sendError, sendJson } from "./http-utils";

const sseHeartbeatMilliseconds = 3000;
const roomSweepIntervalMilliseconds = 5 * 60 * 1000;
const countriesMapPath = fileURLToPath(new URL("../public/countries.paths.json", import.meta.url));

interface CountryPathPayload {
  countries?: Array<Partial<CountrySummary>>;
}

let countriesPromise: Promise<CountrySummary[]> | null = null;

const loadCountries = async () => {
  if (!countriesPromise) {
    countriesPromise = readFile(countriesMapPath, "utf8").then((contents) => {
      const data = JSON.parse(contents) as CountryPathPayload;

      return (data.countries ?? [])
        .map((country, index) => {
          const rawName = typeof country.name === "string" ? country.name.trim() : "";
          const name = rawName || `Country ${index + 1}`;
          const rawId = typeof country.id === "string" ? country.id.trim() : "";
          const id = rawId || `${index}-${name}`;

          return { id, name } satisfies CountrySummary;
        })
        .filter((country) => country.id && country.name);
    });
  }

  return countriesPromise;
};

const handleCreateRoom = async (
  manager: RoomManager,
  request: IncomingMessage,
  response: ServerResponse,
) => {
  const body = await readJsonBody(request);
  const { room, playerId } = await manager.createRoom(body);

  sendJson(response, 201, {
    playerId,
    room: manager.serializeRoom(room, playerId),
  });
};

const handleJoinRoom = async (
  manager: RoomManager,
  request: IncomingMessage,
  response: ServerResponse,
  roomCode: string,
) => {
  const room = manager.getRoom(roomCode);

  if (!room) {
    sendError(response, 404, "Room not found.");
    return;
  }

  const body = await readJsonBody(request);

  try {
    const playerId = manager.joinRoom(room, body);

    sendJson(response, 200, {
      playerId,
      room: manager.serializeRoom(room, playerId),
    });
  } catch (error) {
    sendCaughtError(response, error, "Could not join room.");
  }
};

const handleStartRoom = async (
  manager: RoomManager,
  request: IncomingMessage,
  response: ServerResponse,
  roomCode: string,
) => {
  const room = manager.getRoom(roomCode);

  if (!room) {
    sendError(response, 404, "Room not found.");
    return;
  }

  const body = await readJsonBody(request);
  const playerId = typeof body.playerId === "string" ? body.playerId : "";

  if (playerId !== room.hostId) {
    sendError(response, 403, "Only the host can start this room.");
    return;
  }

  try {
    await manager.startRoom(room);
    sendJson(response, 200, { room: manager.serializeRoom(room, playerId) });
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(response, error.statusCode, error.message);
      return;
    }

    sendError(response, 500, error instanceof Error ? error.message : "Could not start the room.");
  }
};

const handleLeaveRoom = async (
  manager: RoomManager,
  request: IncomingMessage,
  response: ServerResponse,
  roomCode: string,
) => {
  const room = manager.getRoom(roomCode);

  if (!room) {
    sendJson(response, 200, { ok: true });
    return;
  }

  const body = await readJsonBody(request);
  const playerId = typeof body.playerId === "string" ? body.playerId : "";

  try {
    manager.leaveRoom(room, playerId);
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendCaughtError(response, error, "Could not leave room.");
  }
};

const handleSubmitGuess = async (
  manager: RoomManager,
  request: IncomingMessage,
  response: ServerResponse,
  roomCode: string,
  isSkip: boolean,
) => {
  const room = manager.getRoom(roomCode);

  if (!room) {
    sendError(response, 404, "Room not found.");
    return;
  }

  const body = await readJsonBody(request);
  const playerId = typeof body.playerId === "string" ? body.playerId : "";
  const countryId = !isSkip && typeof body.countryId === "string" ? body.countryId : null;

  try {
    await manager.submitAnswer(room, playerId, countryId);
    sendJson(response, 200, { room: manager.serializeRoom(room, playerId) });
  } catch (error) {
    sendCaughtError(response, error, "Could not submit answer.");
  }
};

const handleRoomState = (
  manager: RoomManager,
  response: ServerResponse,
  roomCode: string,
  url: URL,
) => {
  const room = manager.getRoom(roomCode);

  if (!room) {
    sendError(response, 404, "Room not found.");
    return;
  }

  const playerId = url.searchParams.get("playerId") ?? "";

  if (!manager.getPlayer(room, playerId)) {
    sendError(response, 404, "Player not found in this room.");
    return;
  }

  sendJson(response, 200, { room: manager.serializeRoom(room, playerId) });
};

const handleRoomEvents = (
  manager: RoomManager,
  request: IncomingMessage,
  response: ServerResponse,
  roomCode: string,
  url: URL,
) => {
  const room = manager.getRoom(roomCode);

  if (!room) {
    sendError(response, 404, "Room not found.");
    return;
  }

  const playerId = url.searchParams.get("playerId") ?? "";

  if (!manager.getPlayer(room, playerId)) {
    sendError(response, 404, "Player not found in this room.");
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write("retry: 1000\n\n");

  const heartbeat = setInterval(() => {
    response.write("event: heartbeat\n");
    response.write(`data: ${Date.now()}\n\n`);
  }, sseHeartbeatMilliseconds);

  const client = {
    playerId,
    sendState: (state: unknown) => {
      response.write("event: state\n");
      response.write(`data: ${JSON.stringify(state)}\n\n`);
    },
  };

  const unregister = manager.registerClient(room, client);

  client.sendState(manager.serializeRoom(room, playerId));

  request.on("close", () => {
    clearInterval(heartbeat);
    unregister();
  });
};

const routeRequest = async (
  manager: RoomManager,
  request: IncomingMessage,
  response: ServerResponse,
  segments: string[],
  url: URL,
) => {
  const [, , resource, roomCode, action] = segments;

  try {
    if (request.method === "POST" && resource === "rooms" && !roomCode) {
      await handleCreateRoom(manager, request, response);
      return;
    }

    if (resource !== "rooms" || !roomCode) {
      sendError(response, 404, "Multiplayer route not found.");
      return;
    }

    if (request.method === "GET" && !action) {
      handleRoomState(manager, response, roomCode, url);
      return;
    }

    if (request.method === "GET" && action === "events") {
      handleRoomEvents(manager, request, response, roomCode, url);
      return;
    }

    if (request.method === "POST" && action === "join") {
      await handleJoinRoom(manager, request, response, roomCode);
      return;
    }

    if (request.method === "POST" && action === "start") {
      await handleStartRoom(manager, request, response, roomCode);
      return;
    }

    if (request.method === "POST" && action === "leave") {
      await handleLeaveRoom(manager, request, response, roomCode);
      return;
    }

    if (request.method === "POST" && action === "guess") {
      await handleSubmitGuess(manager, request, response, roomCode, false);
      return;
    }

    if (request.method === "POST" && action === "skip") {
      await handleSubmitGuess(manager, request, response, roomCode, true);
      return;
    }

    sendError(response, 405, "Method not allowed.");
  } catch (error) {
    sendCaughtError(response, error, "Multiplayer request failed.");
  }
};

// Module-level singletons so dev-server restarts (which re-run
// configureServer) never spawn duplicate managers or sweep intervals.
let sharedManager: RoomManager | null = null;
let sweepInterval: ReturnType<typeof setInterval> | null = null;

const getSharedManager = () => {
  sharedManager ??= createRoomManager({ loadCountries });

  if (!sweepInterval) {
    const manager = sharedManager;

    sweepInterval = setInterval(() => {
      manager.sweepStaleRooms();
    }, roomSweepIntervalMilliseconds);
    // Do not let the sweep interval keep the Vite process alive.
    sweepInterval.unref();
  }

  return sharedManager;
};

const handleMultiplayerMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] !== "api" || segments[1] !== "multiplayer") {
    next();
    return;
  }

  void routeRequest(getSharedManager(), request, response, segments, url);
};

export const multiplayerPlugin = (): Plugin => ({
  name: "country-game-multiplayer-server",
  configureServer(server) {
    server.middlewares.use(handleMultiplayerMiddleware);
  },
  configurePreviewServer(server) {
    server.middlewares.use(handleMultiplayerMiddleware);
  },
});
