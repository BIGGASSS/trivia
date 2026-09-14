/** Multiplayer room engine; all gameplay mutations are synchronous and atomic. */
import { randomBytes, randomUUID } from "node:crypto";
import {
  maximumPlayerCount,
  minimumMultiplayerPlayerCount,
  roomCodeCharacters,
  roomCodeLength,
  roundDurationSeconds,
} from "../shared/game-constants";
import { normalizeRoomCode, parseRoundCount, sanitizePlayerName } from "../shared/game-utils";
import type {
  PlayerFeedback,
  PublicRoomState,
  RoomStatus,
  RoundCountry,
  RoundPerformance,
  RoundPerformanceOutcome,
} from "../shared/multiplayer-types";

export class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface CountrySummary {
  id: string;
  name: string;
}

export interface RoomPlayer {
  id: string;
  name: string;
  score: number;
  attempts: number;
  streak: number;
  answeredThisRound: boolean;
  active: boolean;
  connected: boolean;
  lastFeedback: PlayerFeedback | null;
  roundPerformance: RoundPerformance[];
}

export interface MultiplayerRoom {
  code: string;
  revision: number;
  matchId: string | null;
  roundId: string | null;
  /** Loaded once before creation; gameplay never yields to load country data. */
  countries: CountrySummary[];
  hostId: string;
  status: RoomStatus;
  roundCount: number;
  currentRound: number;
  currentCountry: CountrySummary | null;
  revealCountryId: string | null;
  roundEndsAt: number | null;
  players: RoomPlayer[];
  roundCountries: RoundCountry[];
  usedCountryIds: Set<string>;
  roundTimer: ReturnType<typeof setTimeout> | null;
  nextRoundTimer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoomClientConnection {
  playerId: string;
  sendState: (state: PublicRoomState) => void;
  close: () => void;
}

export type RequestBody = Record<string, unknown>;

export interface RoomManagerOptions {
  loadCountries: () => Promise<CountrySummary[]>;
  /** Delay between the round reveal and the next round. */
  revealDelayMilliseconds?: number;
  /** Rooms idle longer than this (with no connected clients) are swept. */
  roomTtlMilliseconds?: number;
  /** Hard cap on concurrent rooms, including in-flight creates. */
  maximumRoomCount?: number;
}

const defaultRevealDelayMilliseconds = 2600;
const defaultRoomTtlMilliseconds = 30 * 60 * 1000;
const defaultMaximumRoomCount = 200;

export const createRoomManager = (options: RoomManagerOptions) => {
  const {
    loadCountries,
    revealDelayMilliseconds = defaultRevealDelayMilliseconds,
    roomTtlMilliseconds = defaultRoomTtlMilliseconds,
    maximumRoomCount = defaultMaximumRoomCount,
  } = options;

  const rooms = new Map<string, MultiplayerRoom>();
  const roomClients = new Map<string, Set<RoomClientConnection>>();
  // Credentials never live on players or in public room snapshots.
  const roomSessions = new Map<string, Map<string, string>>();
  let pendingRoomCount = 0;
  let disposed = false;

  const generateRoomCode = () => {
    let code = "";
    do {
      code = Array.from({ length: roomCodeLength }, () => {
        const index = Math.floor(Math.random() * roomCodeCharacters.length);
        return roomCodeCharacters[index] ?? "A";
      }).join("");
    } while (rooms.has(code));
    return code;
  };

  const getRoom = (roomCode: string) => rooms.get(normalizeRoomCode(roomCode));

  const getPlayer = (room: MultiplayerRoom, playerId: string) =>
    room.players.find((player) => player.id === playerId) ?? null;

  const requireRoom = (room: MultiplayerRoom) => {
    if (rooms.get(room.code) !== room) throw new HttpError(404, "Room not found.");
  };

  const requireActivePlayer = (room: MultiplayerRoom, playerId: string) => {
    requireRoom(room);
    const player = getPlayer(room, playerId);
    if (!player?.active) throw new HttpError(403, "Player is not active in this room.");
    return player;
  };

  const authenticatePlayer = (room: MultiplayerRoom, token: unknown) => {
    requireRoom(room);
    const playerId =
      typeof token === "string" ? roomSessions.get(room.code)?.get(token) : undefined;
    if (!playerId) throw new HttpError(403, "Invalid or expired player session.");
    return requireActivePlayer(room, playerId);
  };

  const issueSession = (room: MultiplayerRoom, playerId: string) => {
    const sessionToken = randomBytes(32).toString("base64url");
    const sessions = roomSessions.get(room.code) ?? new Map<string, string>();
    sessions.set(sessionToken, playerId);
    roomSessions.set(room.code, sessions);
    return sessionToken;
  };

  const clearRoomTimers = (room: MultiplayerRoom) => {
    if (room.roundTimer) clearTimeout(room.roundTimer);
    if (room.nextRoundTimer) clearTimeout(room.nextRoundTimer);
    room.roundTimer = null;
    room.nextRoundTimer = null;
  };

  const closeClient = (client: RoomClientConnection) => {
    try {
      client.close();
    } catch {
      // A broken transport must not prevent other subscriptions being revoked.
    }
  };

  const revokeClients = (room: MultiplayerRoom, playerId?: string) => {
    const clients = roomClients.get(room.code);
    if (!clients) return;
    for (const client of clients) {
      if (playerId !== undefined && client.playerId !== playerId) continue;
      // Remove first: close() may synchronously invoke the unregister callback.
      clients.delete(client);
      closeClient(client);
    }
    if (clients.size === 0) roomClients.delete(room.code);
  };

  const deleteRoom = (room: MultiplayerRoom) => {
    clearRoomTimers(room);
    rooms.delete(room.code);
    roomSessions.delete(room.code);
    for (const player of room.players) player.connected = false;
    revokeClients(room);
  };

  const recordRoundPerformance = (
    player: RoomPlayer,
    round: number,
    outcome: RoundPerformanceOutcome,
  ) => {
    const existingIndex = player.roundPerformance.findIndex((entry) => entry.round === round);
    const performance = { round, outcome } satisfies RoundPerformance;
    if (existingIndex >= 0) {
      player.roundPerformance[existingIndex] = performance;
    } else {
      player.roundPerformance.push(performance);
    }
  };

  const serializeRoom = (room: MultiplayerRoom, playerId: string): PublicRoomState => {
    const isRoundLocked = room.status === "playing" && room.revealCountryId !== null;
    const ownPlayer = getPlayer(room, playerId);
    return {
      roomCode: room.code,
      revision: room.revision,
      matchId: room.matchId,
      roundId: room.roundId,
      status: room.status,
      hostId: room.hostId,
      playerId,
      maxPlayers: maximumPlayerCount,
      minPlayers: minimumMultiplayerPlayerCount,
      roundCount: room.roundCount,
      currentRound: room.currentRound,
      roundDurationSeconds,
      roundEndsAt: room.status === "playing" && !isRoundLocked ? room.roundEndsAt : null,
      currentCountryName: room.status === "playing" ? (room.currentCountry?.name ?? null) : null,
      revealCountryId: isRoundLocked ? room.revealCountryId : null,
      roundLocked: isRoundLocked,
      canStart:
        (room.status === "lobby" || room.status === "results") &&
        room.players.filter((player) => player.active).length >= minimumMultiplayerPlayerCount,
      // Snapshots must not mutate later while retaining an older revision.
      roundCountries: room.roundCountries.map((country) => ({ ...country })),
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        score: player.score,
        attempts: player.attempts,
        streak: player.streak,
        isHost: player.active && player.id === room.hostId,
        active: player.active,
        connected: player.connected,
        hasAnswered: player.answeredThisRound,
        roundPerformance: player.roundPerformance.map((performance) => ({ ...performance })),
      })),
      ownFeedback: ownPlayer?.lastFeedback ? { ...ownPlayer.lastFeedback } : null,
    };
  };

  const updateConnectionFlags = (room: MultiplayerRoom) => {
    const clients = roomClients.get(room.code) ?? new Set<RoomClientConnection>();
    for (const player of room.players) {
      player.connected =
        player.active && Array.from(clients).some((client) => client.playerId === player.id);
    }
  };

  /** Commit a mutation before delivering the exact same revision to HTTP/SSE. */
  const broadcastRoom = (room: MultiplayerRoom) => {
    if (rooms.get(room.code) !== room) return;
    room.updatedAt = Date.now();
    updateConnectionFlags(room);
    room.revision += 1;
    const clients = roomClients.get(room.code);
    if (!clients) return;

    let removedClient = false;
    for (const client of clients) {
      try {
        client.sendState(serializeRoom(room, client.playerId));
      } catch {
        clients.delete(client);
        closeClient(client);
        removedClient = true;
      }
    }
    if (clients.size === 0) roomClients.delete(room.code);
    if (removedClient) broadcastRoom(room);
  };

  const chooseCountry = (room: MultiplayerRoom) => {
    let availableCountries = room.countries.filter(
      (country) => !room.usedCountryIds.has(country.id),
    );
    if (availableCountries.length === 0) {
      room.usedCountryIds.clear();
      availableCountries = room.countries;
    }
    const randomIndex = Math.floor(Math.random() * availableCountries.length);
    const country = availableCountries[randomIndex] ?? room.countries[0];
    if (!country) throw new Error("No country data is available for multiplayer games.");
    room.usedCountryIds.add(country.id);
    return country;
  };

  const finishRoom = (room: MultiplayerRoom) => {
    clearRoomTimers(room);
    room.status = "results";
    room.roundId = null;
    room.currentCountry = null;
    room.revealCountryId = null;
    room.roundEndsAt = null;
    for (const player of room.players) {
      player.answeredThisRound = false;
      player.lastFeedback = null;
    }
    broadcastRoom(room);
  };

  function startNextRound(room: MultiplayerRoom) {
    if (rooms.get(room.code) !== room) return;
    clearRoomTimers(room);
    if (room.currentRound >= room.roundCount) {
      finishRoom(room);
      return;
    }
    room.status = "playing";
    room.currentRound += 1;
    room.roundId = randomUUID();
    room.currentCountry = chooseCountry(room);
    room.roundCountries.push({ round: room.currentRound, countryName: room.currentCountry.name });
    room.revealCountryId = null;
    room.roundEndsAt = Date.now() + roundDurationSeconds * 1000;
    for (const player of room.players) {
      player.answeredThisRound = false;
      player.lastFeedback = null;
    }
    room.roundTimer = setTimeout(() => finishRound(room), roundDurationSeconds * 1000);
    broadcastRoom(room);
  }

  function finishRound(room: MultiplayerRoom) {
    if (
      rooms.get(room.code) !== room ||
      room.status !== "playing" ||
      !room.currentCountry ||
      room.revealCountryId !== null
    )
      return;

    if (room.roundTimer) clearTimeout(room.roundTimer);
    room.roundTimer = null;
    room.revealCountryId = room.currentCountry.id;
    room.roundEndsAt = null;
    for (const player of room.players) {
      if (!player.active || player.answeredThisRound) continue;
      player.attempts += 1;
      player.streak = 0;
      player.answeredThisRound = true;
      recordRoundPerformance(player, room.currentRound, "timeout");
      player.lastFeedback = {
        state: "incorrect",
        message: `Time's up! The correct answer was ${room.currentCountry.name}.`,
        selectedCountryId: null,
      };
    }
    room.nextRoundTimer = setTimeout(() => startNextRound(room), revealDelayMilliseconds);
    broadcastRoom(room);
  }

  /** Disconnected active players cannot stall connected players; leavers never count. */
  const maybeFinishRoundEarly = (room: MultiplayerRoom) => {
    if (room.status !== "playing" || !room.currentCountry || room.revealCountryId !== null)
      return false;
    const activePlayers = room.players.filter((player) => player.active);
    const connectedPlayers = activePlayers.filter((player) => player.connected);
    const requiredPlayers = connectedPlayers.length > 0 ? connectedPlayers : activePlayers;
    if (requiredPlayers.length > 0 && requiredPlayers.every((player) => player.answeredThisRound)) {
      finishRound(room);
      return true;
    }
    return false;
  };

  const startRoom = (room: MultiplayerRoom) => {
    requireRoom(room);
    if (room.status === "playing")
      throw new HttpError(409, "This room is already playing a match.");
    const activePlayers = room.players.filter((player) => player.active);
    if (activePlayers.length < minimumMultiplayerPlayerCount) {
      throw new HttpError(400, "At least two players are required.");
    }
    clearRoomTimers(room);
    room.players = activePlayers;
    room.matchId = randomUUID();
    room.status = "playing";
    room.currentRound = 0;
    room.currentCountry = null;
    room.revealCountryId = null;
    room.roundEndsAt = null;
    room.roundCountries = [];
    room.usedCountryIds.clear();
    for (const player of room.players) {
      player.score = 0;
      player.attempts = 0;
      player.streak = 0;
      player.answeredThisRound = false;
      player.lastFeedback = null;
      player.roundPerformance = [];
    }
    startNextRound(room);
  };

  const createPlayer = (id: string, name: string): RoomPlayer => ({
    id,
    name,
    score: 0,
    attempts: 0,
    streak: 0,
    answeredThisRound: false,
    active: true,
    connected: false,
    lastFeedback: null,
    roundPerformance: [],
  });

  const createRoom = async (body: RequestBody) => {
    if (disposed) throw new HttpError(503, "Room manager is closed.");
    if (rooms.size + pendingRoomCount >= maximumRoomCount) {
      throw new HttpError(503, "Too many active rooms right now. Try again in a few minutes.");
    }
    // Reserve capacity before yielding, and release even if loading fails.
    pendingRoomCount += 1;
    try {
      const countries = (await loadCountries()).map((country) => ({ ...country }));
      if (disposed) throw new HttpError(503, "Room manager is closed.");
      if (countries.length === 0) {
        throw new HttpError(503, "No country data is available for multiplayer games.");
      }
      const hostId = randomUUID();
      const room: MultiplayerRoom = {
        code: generateRoomCode(),
        revision: 1,
        matchId: null,
        roundId: null,
        countries,
        hostId,
        status: "lobby",
        roundCount: parseRoundCount(body.rounds, countries.length),
        currentRound: 0,
        currentCountry: null,
        revealCountryId: null,
        roundEndsAt: null,
        roundCountries: [],
        players: [createPlayer(hostId, sanitizePlayerName(body.playerName, "Host"))],
        usedCountryIds: new Set<string>(),
        roundTimer: null,
        nextRoundTimer: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      rooms.set(room.code, room);
      const sessionToken = issueSession(room, hostId);
      return { room, playerId: hostId, sessionToken };
    } finally {
      pendingRoomCount -= 1;
    }
  };

  const joinRoom = (room: MultiplayerRoom, body: RequestBody) => {
    requireRoom(room);
    if (room.status !== "lobby") throw new HttpError(400, "This room is already in a game.");
    if (room.players.length >= maximumPlayerCount) throw new HttpError(400, "This room is full.");
    const playerId = randomUUID();
    const playerName = sanitizePlayerName(body.playerName, `Player ${room.players.length + 1}`);
    room.players.push(createPlayer(playerId, playerName));
    const sessionToken = issueSession(room, playerId);
    broadcastRoom(room);
    return { playerId, sessionToken };
  };

  const leaveRoom = (room: MultiplayerRoom, playerId: string) => {
    const player = requireActivePlayer(room, playerId);
    player.active = false;
    player.connected = false;
    const sessions = roomSessions.get(room.code);
    for (const [token, id] of sessions ?? []) {
      if (id === playerId) sessions?.delete(token);
    }
    revokeClients(room, playerId);
    if (room.status === "lobby") {
      room.players = room.players.filter((roomPlayer) => roomPlayer.id !== playerId);
    }
    const remainingPlayers = room.players.filter((roomPlayer) => roomPlayer.active);
    if (remainingPlayers.length === 0) {
      deleteRoom(room);
      return;
    }
    if (room.hostId === playerId) room.hostId = remainingPlayers[0]!.id;
    if (!maybeFinishRoundEarly(room)) broadcastRoom(room);
  };

  const submitAnswer = (
    room: MultiplayerRoom,
    playerId: string,
    countryId: string | null,
    matchId: string | null,
    roundId: string | null,
  ) => {
    const player = requireActivePlayer(room, playerId);
    if (!matchId || !roundId || matchId !== room.matchId || roundId !== room.roundId) {
      throw new HttpError(409, "This answer belongs to a different match or round.");
    }
    if (room.status !== "playing" || !room.currentCountry) {
      throw new HttpError(400, "This room is not currently accepting guesses.");
    }
    if (room.revealCountryId !== null) throw new HttpError(400, "This round is already complete.");
    // Timers can run late under event-loop load. The deadline, not callback order,
    // decides acceptance; validation, scoring and round transitions never await.
    if (room.roundEndsAt === null || Date.now() >= room.roundEndsAt) {
      finishRound(room);
      throw new HttpError(409, "The answer deadline has passed.");
    }
    if (player.answeredThisRound) throw new HttpError(400, "You already answered this round.");

    const isCorrect = countryId === room.currentCountry.id;
    const outcome: RoundPerformanceOutcome = isCorrect
      ? "correct"
      : countryId === null
        ? "skipped"
        : "incorrect";
    const selectedCountry = room.countries.find((country) => country.id === countryId);
    const selectedCountryName = selectedCountry?.name ?? "your selection";
    player.attempts += 1;
    player.answeredThisRound = true;
    recordRoundPerformance(player, room.currentRound, outcome);
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
    if (!maybeFinishRoundEarly(room)) broadcastRoom(room);
  };

  const registerClient = (room: MultiplayerRoom, client: RoomClientConnection) => {
    requireActivePlayer(room, client.playerId);
    const clients = roomClients.get(room.code) ?? new Set<RoomClientConnection>();
    clients.add(client);
    roomClients.set(room.code, clients);
    broadcastRoom(room);
    return () => {
      if (!clients.delete(client)) return;
      if (clients.size === 0) roomClients.delete(room.code);
      if (rooms.get(room.code) === room) {
        updateConnectionFlags(room);
        if (!maybeFinishRoundEarly(room)) broadcastRoom(room);
      }
    };
  };

  /** Delete rooms idle past the TTL with no connected clients. */
  const sweepStaleRooms = () => {
    const staleBefore = Date.now() - roomTtlMilliseconds;
    let sweptCount = 0;
    for (const room of rooms.values()) {
      const hasConnectedClients = (roomClients.get(room.code)?.size ?? 0) > 0;
      if (!hasConnectedClients && room.updatedAt < staleBefore) {
        deleteRoom(room);
        sweptCount += 1;
      }
    }
    return sweptCount;
  };

  /** Revoke all sessions/subscriptions and cancel timers, including pending creates. */
  const dispose = () => {
    disposed = true;
    for (const room of rooms.values()) deleteRoom(room);
  };

  return {
    authenticatePlayer,
    broadcastRoom,
    createRoom,
    dispose,
    finishRound,
    getPlayer,
    getRoom,
    getRoomCount: () => rooms.size,
    joinRoom,
    leaveRoom,
    registerClient,
    serializeRoom,
    startRoom,
    submitAnswer,
    sweepStaleRooms,
  };
};

export type RoomManager = ReturnType<typeof createRoomManager>;
