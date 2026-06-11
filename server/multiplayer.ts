import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const maximumPlayerCount = 5;
const minimumPlayerCount = 2;
const defaultRoundCount = 10;
const maximumRoundCount = 50;
const roundDurationSeconds = 10;
const revealDelayMilliseconds = 1800;
const sseHeartbeatMilliseconds = 3000;
const roomCodeCharacters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const countriesGeoJsonRoute = "/countries.geo.json";
const countriesGeoJsonPath = fileURLToPath(
  new URL("../public/countries.geo.json", import.meta.url),
);

interface CountrySummary {
  id: string;
  name: string;
}

interface CountryFeature {
  id?: string | number;
  properties?: {
    name?: string;
  };
}

interface CountryFeatureCollection {
  features?: CountryFeature[];
}

type RoomStatus = "lobby" | "playing" | "results";
type AnswerState = "idle" | "correct" | "incorrect";

interface PlayerFeedback {
  state: AnswerState;
  message: string;
  selectedCountryId: string | null;
}

interface RoomPlayer {
  id: string;
  name: string;
  score: number;
  attempts: number;
  streak: number;
  answeredThisRound: boolean;
  connected: boolean;
  lastFeedback: PlayerFeedback | null;
}

interface MultiplayerRoom {
  code: string;
  hostId: string;
  status: RoomStatus;
  roundCount: number;
  currentRound: number;
  currentCountry: CountrySummary | null;
  revealCountryId: string | null;
  roundEndsAt: number | null;
  players: RoomPlayer[];
  usedCountryIds: Set<string>;
  roundTimer: ReturnType<typeof setTimeout> | null;
  nextRoundTimer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
  updatedAt: number;
}

interface PublicPlayer {
  id: string;
  name: string;
  score: number;
  attempts: number;
  streak: number;
  isHost: boolean;
  connected: boolean;
  hasAnswered: boolean;
}

interface PublicRoomState {
  roomCode: string;
  status: RoomStatus;
  hostId: string;
  playerId: string;
  maxPlayers: number;
  minPlayers: number;
  roundCount: number;
  currentRound: number;
  roundDurationSeconds: number;
  roundEndsAt: number | null;
  currentCountryName: string | null;
  revealCountryId: string | null;
  roundLocked: boolean;
  canStart: boolean;
  players: PublicPlayer[];
  ownFeedback: PlayerFeedback | null;
}

interface RoomClient {
  playerId: string;
  response: ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
}

type RequestBody = Record<string, unknown>;

type RouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  segments: string[],
  url: URL,
) => Promise<void>;

const rooms = new Map<string, MultiplayerRoom>();
const roomClients = new Map<string, Set<RoomClient>>();
let countriesPromise: Promise<CountrySummary[]> | null = null;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

const readCountriesGeoJson = () => readFile(countriesGeoJsonPath, "utf8");

const loadCountries = async () => {
  if (!countriesPromise) {
    countriesPromise = readCountriesGeoJson().then((contents) => {
      const data = JSON.parse(contents) as CountryFeatureCollection;

      return (data.features ?? [])
        .map((feature, index) => {
          const name = feature.properties?.name ?? `Country ${index + 1}`;
          const id = String(feature.id ?? name);

          return { id, name };
        })
        .filter((country) => country.name.trim().length > 0);
    });
  }

  return countriesPromise;
};

const sanitizePlayerName = (name: unknown, fallback: string) => {
  if (typeof name !== "string") {
    return fallback;
  }

  const trimmedName = name.trim().replace(/\s+/g, " ").slice(0, 24);

  return trimmedName || fallback;
};

const normalizeRoomCode = (code: string) =>
  code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

const generateRoomCode = () => {
  let code = "";

  do {
    code = Array.from({ length: 6 }, () => {
      const index = Math.floor(Math.random() * roomCodeCharacters.length);

      return roomCodeCharacters[index] ?? "A";
    }).join("");
  } while (rooms.has(code));

  return code;
};

const parseRoundCount = (rounds: unknown) => {
  const numericRoundCount = Number(rounds) || defaultRoundCount;

  return clamp(Math.round(numericRoundCount), 1, maximumRoundCount);
};

const readJsonBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} satisfies RequestBody;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
  } catch {
    throw new Error("Invalid JSON request body.");
  }
};

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
) => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(payload));
};

const sendError = (
  response: ServerResponse,
  statusCode: number,
  message: string,
) => {
  sendJson(response, statusCode, { error: message });
};

const handleCountriesGeoJsonMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method !== "GET" || url.pathname !== countriesGeoJsonRoute) {
    next();
    return;
  }

  void readCountriesGeoJson()
    .then((contents) => {
      response.writeHead(200, {
        "Content-Type": "application/geo+json; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      response.end(contents);
    })
    .catch((error) => {
      sendError(
        response,
        500,
        error instanceof Error ? error.message : "Could not load map data.",
      );
    });
};

const getRoom = (roomCode: string) => rooms.get(normalizeRoomCode(roomCode));

const getPlayer = (room: MultiplayerRoom, playerId: string) =>
  room.players.find((player) => player.id === playerId) ?? null;

const touchRoom = (room: MultiplayerRoom) => {
  room.updatedAt = Date.now();
};

const clearRoomTimers = (room: MultiplayerRoom) => {
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }

  if (room.nextRoundTimer) {
    clearTimeout(room.nextRoundTimer);
    room.nextRoundTimer = null;
  }
};

const serializeRoom = (
  room: MultiplayerRoom,
  playerId: string,
): PublicRoomState => {
  const isRoundLocked =
    room.status === "playing" && room.revealCountryId !== null;
  const ownPlayer = getPlayer(room, playerId);

  return {
    roomCode: room.code,
    status: room.status,
    hostId: room.hostId,
    playerId,
    maxPlayers: maximumPlayerCount,
    minPlayers: minimumPlayerCount,
    roundCount: room.roundCount,
    currentRound: room.currentRound,
    roundDurationSeconds,
    roundEndsAt:
      room.status === "playing" && !isRoundLocked ? room.roundEndsAt : null,
    currentCountryName:
      room.status === "playing" ? (room.currentCountry?.name ?? null) : null,
    revealCountryId: isRoundLocked ? room.revealCountryId : null,
    roundLocked: isRoundLocked,
    canStart:
      (room.status === "lobby" || room.status === "results") &&
      room.players.length >= minimumPlayerCount,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      attempts: player.attempts,
      streak: player.streak,
      isHost: player.id === room.hostId,
      connected: player.connected,
      hasAnswered: player.answeredThisRound,
    })),
    ownFeedback: ownPlayer?.lastFeedback ?? null,
  };
};

const sendSseState = (client: RoomClient, room: MultiplayerRoom) => {
  client.response.write("event: state\n");
  client.response.write(
    `data: ${JSON.stringify(serializeRoom(room, client.playerId))}\n\n`,
  );
};

const sendSseHeartbeat = (response: ServerResponse) => {
  response.write("event: heartbeat\n");
  response.write(`data: ${Date.now()}\n\n`);
};

const updateConnectionFlags = (room: MultiplayerRoom) => {
  const clients = roomClients.get(room.code) ?? new Set<RoomClient>();

  for (const player of room.players) {
    player.connected = Array.from(clients).some(
      (client) => client.playerId === player.id,
    );
  }
};

const broadcastRoom = (room: MultiplayerRoom) => {
  touchRoom(room);
  updateConnectionFlags(room);

  const clients = roomClients.get(room.code);

  if (!clients) {
    return;
  }

  for (const client of clients) {
    sendSseState(client, room);
  }
};

const chooseCountry = async (room: MultiplayerRoom) => {
  const countries = await loadCountries();

  if (countries.length === 0) {
    throw new Error("No country data is available for multiplayer games.");
  }

  let availableCountries = countries.filter(
    (country) => !room.usedCountryIds.has(country.id),
  );

  if (availableCountries.length === 0) {
    room.usedCountryIds.clear();
    availableCountries = countries;
  }

  const randomIndex = Math.floor(Math.random() * availableCountries.length);
  const country = availableCountries[randomIndex] ?? countries[0];

  room.usedCountryIds.add(country.id);

  return country;
};

const finishRoom = (room: MultiplayerRoom) => {
  clearRoomTimers(room);
  room.status = "results";
  room.currentCountry = null;
  room.revealCountryId = null;
  room.roundEndsAt = null;

  for (const player of room.players) {
    player.answeredThisRound = false;
    player.lastFeedback = null;
  }

  broadcastRoom(room);
};

async function startNextRound(room: MultiplayerRoom) {
  clearRoomTimers(room);

  if (room.currentRound >= room.roundCount) {
    finishRoom(room);
    return;
  }

  room.status = "playing";
  room.currentRound += 1;
  room.currentCountry = await chooseCountry(room);
  room.revealCountryId = null;
  room.roundEndsAt = Date.now() + roundDurationSeconds * 1000;

  for (const player of room.players) {
    player.answeredThisRound = false;
    player.lastFeedback = null;
  }

  broadcastRoom(room);

  room.roundTimer = setTimeout(
    () => {
      finishRound(room);
    },
    roundDurationSeconds * 1000 + 50,
  );
}

function finishRound(room: MultiplayerRoom) {
  if (room.status !== "playing" || !room.currentCountry) {
    return;
  }

  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }

  room.revealCountryId = room.currentCountry.id;
  room.roundEndsAt = null;

  for (const player of room.players) {
    if (player.answeredThisRound) {
      continue;
    }

    player.attempts += 1;
    player.streak = 0;
    player.answeredThisRound = true;
    player.lastFeedback = {
      state: "incorrect",
      message: `Time's up! The correct answer was ${room.currentCountry.name}.`,
      selectedCountryId: null,
    };
  }

  broadcastRoom(room);

  room.nextRoundTimer = setTimeout(() => {
    if (room.currentRound >= room.roundCount) {
      finishRoom(room);
      return;
    }

    void startNextRound(room);
  }, revealDelayMilliseconds);
}

const startRoom = async (room: MultiplayerRoom) => {
  clearRoomTimers(room);
  room.status = "playing";
  room.currentRound = 0;
  room.currentCountry = null;
  room.revealCountryId = null;
  room.roundEndsAt = null;
  room.usedCountryIds.clear();

  for (const player of room.players) {
    player.score = 0;
    player.attempts = 0;
    player.streak = 0;
    player.answeredThisRound = false;
    player.lastFeedback = null;
  }

  await startNextRound(room);
};

const createRoom = async (body: RequestBody) => {
  await loadCountries();

  const hostName = sanitizePlayerName(body.playerName, "Host");
  const hostId = randomUUID();
  const room: MultiplayerRoom = {
    code: generateRoomCode(),
    hostId,
    status: "lobby",
    roundCount: parseRoundCount(body.rounds),
    currentRound: 0,
    currentCountry: null,
    revealCountryId: null,
    roundEndsAt: null,
    players: [
      {
        id: hostId,
        name: hostName,
        score: 0,
        attempts: 0,
        streak: 0,
        answeredThisRound: false,
        connected: false,
        lastFeedback: null,
      },
    ],
    usedCountryIds: new Set<string>(),
    roundTimer: null,
    nextRoundTimer: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  rooms.set(room.code, room);

  return { room, playerId: hostId };
};

const joinRoom = (room: MultiplayerRoom, body: RequestBody) => {
  if (room.status !== "lobby") {
    throw new Error("This room is already in a game.");
  }

  if (room.players.length >= maximumPlayerCount) {
    throw new Error("This room is full.");
  }

  const playerId = randomUUID();
  const playerName = sanitizePlayerName(
    body.playerName,
    `Player ${room.players.length + 1}`,
  );

  room.players.push({
    id: playerId,
    name: playerName,
    score: 0,
    attempts: 0,
    streak: 0,
    answeredThisRound: false,
    connected: false,
    lastFeedback: null,
  });

  broadcastRoom(room);

  return playerId;
};

const leaveRoom = (room: MultiplayerRoom, playerId: string) => {
  const player = getPlayer(room, playerId);

  if (!player) {
    throw new Error("Player not found in this room.");
  }

  if (room.status === "lobby") {
    room.players = room.players.filter(
      (roomPlayer) => roomPlayer.id !== playerId,
    );

    if (room.players.length === 0) {
      clearRoomTimers(room);
      rooms.delete(room.code);
      roomClients.delete(room.code);
      return;
    }
  } else {
    player.connected = false;
  }

  if (room.hostId === playerId) {
    room.hostId =
      room.players.find((roomPlayer) => roomPlayer.id !== playerId)?.id ??
      room.hostId;
  }

  broadcastRoom(room);
};

const submitAnswer = async (
  room: MultiplayerRoom,
  playerId: string,
  countryId: string | null,
) => {
  if (room.status !== "playing" || !room.currentCountry) {
    throw new Error("This room is not currently accepting guesses.");
  }

  if (room.revealCountryId !== null) {
    throw new Error("This round is already complete.");
  }

  const player = getPlayer(room, playerId);

  if (!player) {
    throw new Error("Player not found in this room.");
  }

  if (player.answeredThisRound) {
    throw new Error("You already answered this round.");
  }

  const isCorrect = countryId === room.currentCountry.id;
  const countries = await loadCountries();
  const selectedCountry = countries.find((country) => country.id === countryId);
  const selectedCountryName = selectedCountry?.name ?? "your selection";

  player.attempts += 1;
  player.answeredThisRound = true;

  if (isCorrect) {
    player.score += 1;
    player.streak += 1;
    player.lastFeedback = {
      state: "correct",
      message: `Correct! That was ${room.currentCountry.name}.`,
      selectedCountryId: countryId,
    };
  } else {
    player.streak = 0;
    player.lastFeedback = {
      state: "incorrect",
      message:
        countryId === null
          ? `Skipped. The correct answer was ${room.currentCountry.name}.`
          : `Not quite — that was ${selectedCountryName}. Keep watching for the reveal.`,
      selectedCountryId: countryId,
    };
  }

  broadcastRoom(room);

  if (room.players.every((roomPlayer) => roomPlayer.answeredThisRound)) {
    finishRound(room);
  }
};

const handleCreateRoom = async (
  request: IncomingMessage,
  response: ServerResponse,
) => {
  const body = await readJsonBody(request);
  const { room, playerId } = await createRoom(body);

  sendJson(response, 201, {
    playerId,
    room: serializeRoom(room, playerId),
  });
};

const handleJoinRoom = async (
  request: IncomingMessage,
  response: ServerResponse,
  roomCode: string,
) => {
  const room = getRoom(roomCode);

  if (!room) {
    sendError(response, 404, "Room not found.");
    return;
  }

  const body = await readJsonBody(request);

  try {
    const playerId = joinRoom(room, body);

    sendJson(response, 200, {
      playerId,
      room: serializeRoom(room, playerId),
    });
  } catch (error) {
    sendError(
      response,
      400,
      error instanceof Error ? error.message : "Could not join room.",
    );
  }
};

const handleStartRoom = async (
  request: IncomingMessage,
  response: ServerResponse,
  roomCode: string,
) => {
  const room = getRoom(roomCode);

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

  if (room.players.length < minimumPlayerCount) {
    sendError(response, 400, "At least two players are required.");
    return;
  }

  try {
    await startRoom(room);
    sendJson(response, 200, { room: serializeRoom(room, playerId) });
  } catch (error) {
    sendError(
      response,
      500,
      error instanceof Error ? error.message : "Could not start the room.",
    );
  }
};

const handleLeaveRoom = async (
  request: IncomingMessage,
  response: ServerResponse,
  roomCode: string,
) => {
  const room = getRoom(roomCode);

  if (!room) {
    sendJson(response, 200, { ok: true });
    return;
  }

  const body = await readJsonBody(request);
  const playerId = typeof body.playerId === "string" ? body.playerId : "";

  try {
    leaveRoom(room, playerId);
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendError(
      response,
      400,
      error instanceof Error ? error.message : "Could not leave room.",
    );
  }
};

const handleSubmitGuess = async (
  request: IncomingMessage,
  response: ServerResponse,
  roomCode: string,
  isSkip: boolean,
) => {
  const room = getRoom(roomCode);

  if (!room) {
    sendError(response, 404, "Room not found.");
    return;
  }

  const body = await readJsonBody(request);
  const playerId = typeof body.playerId === "string" ? body.playerId : "";
  const countryId =
    !isSkip && typeof body.countryId === "string" ? body.countryId : null;

  try {
    await submitAnswer(room, playerId, countryId);
    sendJson(response, 200, { room: serializeRoom(room, playerId) });
  } catch (error) {
    sendError(
      response,
      400,
      error instanceof Error ? error.message : "Could not submit answer.",
    );
  }
};

const handleRoomState = (
  response: ServerResponse,
  roomCode: string,
  url: URL,
) => {
  const room = getRoom(roomCode);

  if (!room) {
    sendError(response, 404, "Room not found.");
    return;
  }

  const playerId = url.searchParams.get("playerId") ?? "";

  if (!getPlayer(room, playerId)) {
    sendError(response, 404, "Player not found in this room.");
    return;
  }

  sendJson(response, 200, { room: serializeRoom(room, playerId) });
};

const handleRoomEvents = (
  request: IncomingMessage,
  response: ServerResponse,
  roomCode: string,
  url: URL,
) => {
  const room = getRoom(roomCode);

  if (!room) {
    sendError(response, 404, "Room not found.");
    return;
  }

  const playerId = url.searchParams.get("playerId") ?? "";

  if (!getPlayer(room, playerId)) {
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

  const client: RoomClient = {
    playerId,
    response,
    heartbeat: setInterval(() => {
      sendSseHeartbeat(response);
    }, sseHeartbeatMilliseconds),
  };

  const clients = roomClients.get(room.code) ?? new Set<RoomClient>();
  clients.add(client);
  roomClients.set(room.code, clients);

  broadcastRoom(room);
  sendSseState(client, room);

  request.on("close", () => {
    clearInterval(client.heartbeat);
    clients.delete(client);

    if (clients.size === 0) {
      roomClients.delete(room.code);
    }

    broadcastRoom(room);
  });
};

const routeRequest: RouteHandler = async (request, response, segments, url) => {
  const [, , resource, roomCode, action] = segments;

  try {
    if (request.method === "POST" && resource === "rooms" && !roomCode) {
      await handleCreateRoom(request, response);
      return;
    }

    if (resource !== "rooms" || !roomCode) {
      sendError(response, 404, "Multiplayer route not found.");
      return;
    }

    if (request.method === "GET" && !action) {
      handleRoomState(response, roomCode, url);
      return;
    }

    if (request.method === "GET" && action === "events") {
      handleRoomEvents(request, response, roomCode, url);
      return;
    }

    if (request.method === "POST" && action === "join") {
      await handleJoinRoom(request, response, roomCode);
      return;
    }

    if (request.method === "POST" && action === "start") {
      await handleStartRoom(request, response, roomCode);
      return;
    }

    if (request.method === "POST" && action === "leave") {
      await handleLeaveRoom(request, response, roomCode);
      return;
    }

    if (request.method === "POST" && action === "guess") {
      await handleSubmitGuess(request, response, roomCode, false);
      return;
    }

    if (request.method === "POST" && action === "skip") {
      await handleSubmitGuess(request, response, roomCode, true);
      return;
    }

    sendError(response, 405, "Method not allowed.");
  } catch (error) {
    sendError(
      response,
      400,
      error instanceof Error ? error.message : "Multiplayer request failed.",
    );
  }
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

  void routeRequest(request, response, segments, url);
};

export const multiplayerPlugin = (): Plugin => ({
  name: "country-game-multiplayer-server",
  configureServer(server) {
    server.middlewares.use(handleCountriesGeoJsonMiddleware);
    server.middlewares.use(handleMultiplayerMiddleware);
  },
  configurePreviewServer(server) {
    server.middlewares.use(handleCountriesGeoJsonMiddleware);
    server.middlewares.use(handleMultiplayerMiddleware);
  },
});
