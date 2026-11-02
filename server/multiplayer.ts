/**
 * Multiplayer HTTP/SSE middleware. Vite dev/preview use the shared manager;
 * tests can inject a manager into an ordinary Node HTTP server (no Vite server).
 * Country path assets are still served by Vite's static file handling.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite-plus";
import { createRoomManager, HttpError } from "./room-manager";
import type { CountrySummary, MultiplayerRoom, RoomManager } from "./room-manager";
import { readJsonBody, sendCaughtError, sendError, sendJson } from "./http-utils";

const sseHeartbeatMilliseconds = 3000;
const roomSweepIntervalMilliseconds = 5 * 60 * 1000;
const countriesMapPath = fileURLToPath(new URL("../public/countries.paths.json", import.meta.url));

interface CountryPathPayload {
  countries?: Array<Partial<CountrySummary>>;
}

/**
 * Lazily reads and caches country summaries from a `countries.paths.json` file.
 * A failed read is not cached, so the next request retries.
 */
export const createCountriesLoader = (filePath: string) => {
  let countriesPromise: Promise<CountrySummary[]> | null = null;
  return async () => {
    countriesPromise ??= readFile(filePath, "utf8")
      .then((contents) => {
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
      })
      .catch((error: unknown) => {
        countriesPromise = null;
        throw error;
      });
    return countriesPromise;
  };
};

/** Periodically drops idle rooms. Returns a function that stops the sweep. */
export const startRoomSweep = (manager: RoomManager) => {
  const interval = setInterval(() => manager.sweepStaleRooms(), roomSweepIntervalMilliseconds);
  interval.unref();
  return () => clearInterval(interval);
};

const handleRoomEvents = (
  manager: RoomManager,
  response: ServerResponse,
  room: MultiplayerRoom,
  playerId: string,
) => {
  manager.assertClientCapacity(room, playerId);
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unregister = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    heartbeat = undefined;
    unregister();
    response.end();
  };
  // The response, not the consumed request body, owns the SSE lifetime.
  response.on("close", close);
  response.on("error", close);
  // Never queue another frame once Node signals backpressure. Destroy rather
  // than end: end() could retain the already-buffered frame indefinitely.
  const writeFrame = (frame: string) => {
    if (closed) return false;
    try {
      if (!response.destroyed && !response.writableEnded && response.write(frame)) {
        // A synchronous terminal event during write must not start new resources.
        return !closed;
      }
    } catch {
      // Treat write failures the same as a transport that cannot keep up.
    }
    response.destroy();
    return false;
  };
  if (!writeFrame("retry: 1000\n\n")) {
    close();
    return;
  }
  heartbeat = setInterval(() => {
    if (!writeFrame(`event: heartbeat\ndata: ${Date.now()}\n\n`)) close();
  }, sseHeartbeatMilliseconds);

  unregister = manager.registerClient(room, {
    playerId,
    sendState: (state) => {
      if (!writeFrame(`event: state\ndata: ${JSON.stringify(state)}\n\n`)) {
        // Let the manager remove this subscription before invoking close(), so
        // cleanup cannot recursively publish while the current broadcast runs.
        throw new Error("SSE transport is closed or backpressured.");
      }
    },
    close,
  });
  // registerClient sends the initial state; do not send a duplicate revision.
  if (closed) unregister();
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
    if (resource !== "rooms" || segments.length > 5) {
      sendError(response, 404, "Multiplayer route not found.");
      return;
    }

    if (request.method === "GET" && roomCode && (!action || action === "events")) {
      const room = manager.getRoom(roomCode);
      if (!room) throw new HttpError(404, "Room not found.");
      // Public player IDs are display data, never credentials (even if supplied).
      const player = manager.authenticatePlayer(room, url.searchParams.get("sessionToken"));
      if (action === "events") {
        handleRoomEvents(manager, response, room, player.id);
      } else {
        sendJson(response, 200, { room: manager.serializeRoom(room, player.id) });
      }
      return;
    }

    if (request.method !== "POST") {
      sendError(response, 405, "Method not allowed.");
      return;
    }
    const body = await readJsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Expected a JSON object.");
    }

    if (!roomCode) {
      const { room, playerId, sessionToken } = await manager.createRoom(body);
      sendJson(response, 201, {
        playerId,
        sessionToken,
        room: manager.serializeRoom(room, playerId),
      });
      return;
    }

    // Resolve/authenticate only after the complete body is read. The room may
    // have been deleted, or the session revoked, while the request was arriving.
    const room = manager.getRoom(roomCode);
    if (!room) throw new HttpError(404, "Room not found.");
    if (action === "join") {
      const { playerId, sessionToken } = manager.joinRoom(room, body);
      sendJson(response, 200, {
        playerId,
        sessionToken,
        room: manager.serializeRoom(room, playerId),
      });
      return;
    }
    if (action !== "start" && action !== "leave" && action !== "guess" && action !== "skip") {
      sendError(response, 405, "Method not allowed.");
      return;
    }

    const player = manager.authenticatePlayer(room, body.sessionToken);
    if (action === "leave") {
      manager.leaveRoom(room, player.id);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (action === "start") {
      if (player.id !== room.hostId) throw new HttpError(403, "Only the host can start this room.");
      manager.startRoom(room);
    } else {
      if (
        typeof body.matchId !== "string" ||
        !body.matchId ||
        typeof body.roundId !== "string" ||
        !body.roundId
      ) {
        throw new HttpError(400, "Answers require matchId and roundId.");
      }
      if (action === "guess" && (typeof body.countryId !== "string" || !body.countryId)) {
        throw new HttpError(400, "A guess requires countryId.");
      }
      const countryId = action === "guess" ? (body.countryId as string) : null;
      manager.submitAnswer(room, player.id, countryId, body.matchId, body.roundId);
    }
    sendJson(response, 200, { room: manager.serializeRoom(room, player.id) });
  } catch (error) {
    sendCaughtError(response, error, "Multiplayer request failed.");
  }
};

/** Injectable HTTP adapter, usable without starting the Vite dev server. */
export const createMultiplayerMiddleware =
  (manager: RoomManager) =>
  (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    // Raw request targets like `//[` are not valid URLs; `new URL` would throw
    // synchronously, outside routeRequest's error handling.
    const url = URL.parse(request.url ?? "/", "http://localhost");
    if (!url) {
      sendError(response, 400, "Malformed request URL.");
      return;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "api" || segments[1] !== "multiplayer") {
      next();
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    void routeRequest(manager, request, response, segments, url);
  };

// Module-level singletons keep Vite reconfiguration from duplicating managers
// or sweep intervals. Tests inject their own manager and explicitly dispose it.
let sharedManager: RoomManager | null = null;

const getSharedManager = () => {
  if (!sharedManager) {
    sharedManager = createRoomManager({ loadCountries: createCountriesLoader(countriesMapPath) });
    startRoomSweep(sharedManager);
  }
  return sharedManager;
};

export const multiplayerPlugin = (): Plugin => ({
  name: "country-game-multiplayer-server",
  configureServer(server) {
    server.middlewares.use(createMultiplayerMiddleware(getSharedManager()));
  },
  configurePreviewServer(server) {
    server.middlewares.use(createMultiplayerMiddleware(getSharedManager()));
  },
});
