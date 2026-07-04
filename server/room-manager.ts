/**
 * Multiplayer room engine.
 *
 * All game state lives inside a `RoomManager` instance so the logic can be
 * unit-tested without HTTP. The Vite middleware in `multiplayer.ts` owns a
 * single default instance and adapts HTTP/SSE requests onto this API.
 */
import { randomUUID } from "node:crypto";
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
  connected: boolean;
  lastFeedback: PlayerFeedback | null;
  roundPerformance: RoundPerformance[];
}

export interface MultiplayerRoom {
  code: string;
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
}

export type RequestBody = Record<string, unknown>;

export interface RoomManagerOptions {
  loadCountries: () => Promise<CountrySummary[]>;
  /** Delay between the round reveal and the next round. */
  revealDelayMilliseconds?: number;
  /** Rooms idle longer than this (with no connected clients) are swept. */
  roomTtlMilliseconds?: number;
  /** Hard cap on concurrent rooms to bound server memory. */
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

  const deleteRoom = (room: MultiplayerRoom) => {
    clearRoomTimers(room);
    rooms.delete(room.code);
    roomClients.delete(room.code);
  };

  const recordRoundPerformance = (
    player: RoomPlayer,
    round: number,
    outcome: RoundPerformanceOutcome,
  ) => {
    player.roundPerformance ??= [];

    const existingIndex = player.roundPerformance.findIndex(
      (performance) => performance.round === round,
    );
    const roundPerformance = { round, outcome } satisfies RoundPerformance;

    if (existingIndex >= 0) {
      player.roundPerformance[existingIndex] = roundPerformance;
      return;
    }

    player.roundPerformance.push(roundPerformance);
    player.roundPerformance.sort((firstRound, secondRound) => firstRound.round - secondRound.round);
  };

  const recordRoundCountry = (room: MultiplayerRoom, country: CountrySummary) => {
    room.roundCountries ??= [];

    const existingIndex = room.roundCountries.findIndex(
      (roundCountry) => roundCountry.round === room.currentRound,
    );
    const roundCountry = {
      round: room.currentRound,
      countryName: country.name,
    } satisfies RoundCountry;

    if (existingIndex >= 0) {
      room.roundCountries[existingIndex] = roundCountry;
      return;
    }

    room.roundCountries.push(roundCountry);
    room.roundCountries.sort((firstRound, secondRound) => firstRound.round - secondRound.round);
  };

  const serializeRoom = (room: MultiplayerRoom, playerId: string): PublicRoomState => {
    const isRoundLocked = room.status === "playing" && room.revealCountryId !== null;
    const ownPlayer = getPlayer(room, playerId);

    return {
      roomCode: room.code,
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
        room.players.length >= minimumMultiplayerPlayerCount,
      roundCountries: room.roundCountries ?? [],
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        score: player.score,
        attempts: player.attempts,
        streak: player.streak,
        isHost: player.id === room.hostId,
        connected: player.connected,
        hasAnswered: player.answeredThisRound,
        roundPerformance: player.roundPerformance,
      })),
      ownFeedback: ownPlayer?.lastFeedback ?? null,
    };
  };

  const updateConnectionFlags = (room: MultiplayerRoom) => {
    const clients = roomClients.get(room.code) ?? new Set<RoomClientConnection>();

    for (const player of room.players) {
      player.connected = Array.from(clients).some((client) => client.playerId === player.id);
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
      client.sendState(serializeRoom(room, client.playerId));
    }
  };

  const chooseCountry = async (room: MultiplayerRoom) => {
    const countries = await loadCountries();

    if (countries.length === 0) {
      throw new Error("No country data is available for multiplayer games.");
    }

    let availableCountries = countries.filter((country) => !room.usedCountryIds.has(country.id));

    if (availableCountries.length === 0) {
      room.usedCountryIds.clear();
      availableCountries = countries;
    }

    const randomIndex = Math.floor(Math.random() * availableCountries.length);
    const country = availableCountries[randomIndex] ?? countries[0];

    if (!country) {
      throw new Error("No country data is available for multiplayer games.");
    }

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
    recordRoundCountry(room, room.currentCountry);
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
      recordRoundPerformance(player, room.currentRound, "timeout");
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

  /**
   * End the round early once every *connected* player has answered so a
   * disconnected tab can not force the room to wait for the full timer.
   * When nobody is connected (e.g. a brief total dropout) fall back to
   * requiring every player, matching the timeout-driven flow.
   */
  const maybeFinishRoundEarly = (room: MultiplayerRoom) => {
    if (room.status !== "playing" || !room.currentCountry || room.revealCountryId !== null) {
      return;
    }

    const connectedPlayers = room.players.filter((player) => player.connected);
    const requiredPlayers = connectedPlayers.length > 0 ? connectedPlayers : room.players;

    if (requiredPlayers.every((player) => player.answeredThisRound)) {
      finishRound(room);
    }
  };

  const startRoom = async (room: MultiplayerRoom) => {
    if (room.status === "playing") {
      throw new HttpError(409, "This room is already playing a match.");
    }

    if (room.players.length < minimumMultiplayerPlayerCount) {
      throw new HttpError(400, "At least two players are required.");
    }

    clearRoomTimers(room);
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

    await startNextRound(room);
  };

  const createPlayer = (id: string, name: string): RoomPlayer => ({
    id,
    name,
    score: 0,
    attempts: 0,
    streak: 0,
    answeredThisRound: false,
    connected: false,
    lastFeedback: null,
    roundPerformance: [],
  });

  const createRoom = async (body: RequestBody) => {
    if (rooms.size >= maximumRoomCount) {
      throw new HttpError(503, "Too many active rooms right now. Try again in a few minutes.");
    }

    const countries = await loadCountries();
    const hostName = sanitizePlayerName(body.playerName, "Host");
    const hostId = randomUUID();
    const room: MultiplayerRoom = {
      code: generateRoomCode(),
      hostId,
      status: "lobby",
      roundCount: parseRoundCount(body.rounds, countries.length),
      currentRound: 0,
      currentCountry: null,
      revealCountryId: null,
      roundEndsAt: null,
      roundCountries: [],
      players: [createPlayer(hostId, hostName)],
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
      throw new HttpError(400, "This room is already in a game.");
    }

    if (room.players.length >= maximumPlayerCount) {
      throw new HttpError(400, "This room is full.");
    }

    const playerId = randomUUID();
    const playerName = sanitizePlayerName(body.playerName, `Player ${room.players.length + 1}`);

    room.players.push(createPlayer(playerId, playerName));
    broadcastRoom(room);

    return playerId;
  };

  const leaveRoom = (room: MultiplayerRoom, playerId: string) => {
    const player = getPlayer(room, playerId);

    if (!player) {
      throw new HttpError(400, "Player not found in this room.");
    }

    if (room.status === "lobby") {
      room.players = room.players.filter((roomPlayer) => roomPlayer.id !== playerId);

      if (room.players.length === 0) {
        deleteRoom(room);
        return;
      }
    } else {
      player.connected = false;
    }

    if (room.hostId === playerId) {
      room.hostId =
        room.players.find((roomPlayer) => roomPlayer.id !== playerId)?.id ?? room.hostId;
    }

    broadcastRoom(room);
  };

  const submitAnswer = async (
    room: MultiplayerRoom,
    playerId: string,
    countryId: string | null,
  ) => {
    if (room.status !== "playing" || !room.currentCountry) {
      throw new HttpError(400, "This room is not currently accepting guesses.");
    }

    if (room.revealCountryId !== null) {
      throw new HttpError(400, "This round is already complete.");
    }

    const player = getPlayer(room, playerId);

    if (!player) {
      throw new HttpError(400, "Player not found in this room.");
    }

    if (player.answeredThisRound) {
      throw new HttpError(400, "You already answered this round.");
    }

    const isCorrect = countryId === room.currentCountry.id;
    const roundOutcome: RoundPerformanceOutcome = isCorrect
      ? "correct"
      : countryId === null
        ? "skipped"
        : "incorrect";
    const countries = await loadCountries();
    const selectedCountry = countries.find((country) => country.id === countryId);
    const selectedCountryName = selectedCountry?.name ?? "your selection";

    player.attempts += 1;
    player.answeredThisRound = true;
    recordRoundPerformance(player, room.currentRound, roundOutcome);

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
    maybeFinishRoundEarly(room);
  };

  const registerClient = (room: MultiplayerRoom, client: RoomClientConnection) => {
    const clients = roomClients.get(room.code) ?? new Set<RoomClientConnection>();

    clients.add(client);
    roomClients.set(room.code, clients);
    broadcastRoom(room);

    return () => {
      clients.delete(client);

      if (clients.size === 0) {
        roomClients.delete(room.code);
      }

      if (rooms.has(room.code)) {
        broadcastRoom(room);
        maybeFinishRoundEarly(room);
      }
    };
  };

  /** Delete rooms that have been idle past the TTL with no connected clients. */
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

  /** Clear every pending timer. Intended for tests and shutdown. */
  const dispose = () => {
    for (const room of rooms.values()) {
      clearRoomTimers(room);
    }

    rooms.clear();
    roomClients.clear();
  };

  return {
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
