import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createRoomManager } from "../room-manager";
import type { MultiplayerRoom, RoomManager } from "../room-manager";
import { HttpError } from "../room-manager";

const testCountries = [
  { id: "0-France", name: "France" },
  { id: "1-Japan", name: "Japan" },
  { id: "2-Brazil", name: "Brazil" },
  { id: "3-Kenya", name: "Kenya" },
];

const createManager = (overrides: Partial<Parameters<typeof createRoomManager>[0]> = {}) =>
  createRoomManager({
    loadCountries: () => Promise.resolve(testCountries),
    ...overrides,
  });

const createStartedRoom = async (manager: RoomManager, rounds = 2) => {
  const { room, playerId: hostId } = await manager.createRoom({
    playerName: "Host",
    rounds,
  });
  const guestId = manager.joinRoom(room, { playerName: "Guest" });

  await manager.startRoom(room);

  return { room, hostId, guestId };
};

describe("createRoomManager", () => {
  let manager: RoomManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = createManager();
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  describe("createRoom", () => {
    it("creates a lobby room with the host as only player", async () => {
      const { room, playerId } = await manager.createRoom({ playerName: "Ada", rounds: 3 });

      expect(room.status).toBe("lobby");
      expect(room.roundCount).toBe(3);
      expect(room.hostId).toBe(playerId);
      expect(room.players).toHaveLength(1);
      expect(room.players[0]?.name).toBe("Ada");
      expect(room.code).toMatch(/^[A-Z0-9]{6}$/);
      expect(manager.getRoom(room.code)).toBe(room);
    });

    it("clamps the requested round count to the loaded country count", async () => {
      const { room } = await manager.createRoom({ playerName: "Ada", rounds: 999 });

      expect(room.roundCount).toBe(testCountries.length);
    });

    it("rejects creation when the room cap is reached", async () => {
      const cappedManager = createManager({ maximumRoomCount: 1 });

      await cappedManager.createRoom({ playerName: "A" });
      await expect(cappedManager.createRoom({ playerName: "B" })).rejects.toMatchObject({
        statusCode: 503,
      });
      cappedManager.dispose();
    });
  });

  describe("joinRoom", () => {
    it("adds players with sanitized names and broadcasts", async () => {
      const { room } = await manager.createRoom({ playerName: "Host" });
      const playerId = manager.joinRoom(room, { playerName: "  Grace   Hopper  " });

      expect(room.players).toHaveLength(2);
      expect(room.players[1]?.id).toBe(playerId);
      expect(room.players[1]?.name).toBe("Grace Hopper");
    });

    it("rejects joining a full room", async () => {
      const { room } = await manager.createRoom({ playerName: "Host" });

      for (let index = 0; index < 4; index += 1) {
        manager.joinRoom(room, { playerName: `P${index}` });
      }

      expect(() => manager.joinRoom(room, { playerName: "Late" })).toThrow("This room is full.");
    });

    it("rejects joining a room that is already playing", async () => {
      const { room } = await createStartedRoom(manager);

      expect(() => manager.joinRoom(room, { playerName: "Late" })).toThrow(
        "This room is already in a game.",
      );
    });
  });

  describe("startRoom", () => {
    it("requires at least two players", async () => {
      const { room } = await manager.createRoom({ playerName: "Host" });

      await expect(manager.startRoom(room)).rejects.toMatchObject({ statusCode: 400 });
    });

    it("starts round one with a country and a deadline", async () => {
      const { room } = await createStartedRoom(manager);

      expect(room.status).toBe("playing");
      expect(room.currentRound).toBe(1);
      expect(room.currentCountry).not.toBeNull();
      expect(room.roundEndsAt).toBeGreaterThan(Date.now());
      expect(room.roundCountries).toHaveLength(1);
    });

    it("rejects starting a room that is already playing", async () => {
      const { room } = await createStartedRoom(manager);

      await expect(manager.startRoom(room)).rejects.toMatchObject({ statusCode: 409 });
      expect(room.currentRound).toBe(1);
    });

    it("allows restarting from the results screen and resets scores", async () => {
      const { room, hostId } = await createStartedRoom(manager, 1);

      await manager.submitAnswer(room, hostId, room.currentCountry?.id ?? null);
      manager.finishRound(room);
      vi.advanceTimersByTime(3000);
      expect(room.status).toBe("results");

      await manager.startRoom(room);
      expect(room.status).toBe("playing");
      expect(room.currentRound).toBe(1);
      expect(room.players.every((player) => player.score === 0)).toBe(true);
    });
  });

  describe("submitAnswer", () => {
    it("scores a correct guess and increments the streak", async () => {
      const { room, hostId } = await createStartedRoom(manager);
      const host = room.players.find((player) => player.id === hostId);

      await manager.submitAnswer(room, hostId, room.currentCountry?.id ?? null);

      expect(host?.score).toBe(1);
      expect(host?.streak).toBe(1);
      expect(host?.attempts).toBe(1);
      expect(host?.lastFeedback?.state).toBe("correct");
      expect(host?.roundPerformance).toEqual([{ round: 1, outcome: "correct" }]);
    });

    it("records an incorrect guess and resets the streak", async () => {
      const { room, hostId } = await createStartedRoom(manager);
      const host = room.players.find((player) => player.id === hostId);
      const wrongCountry = testCountries.find((country) => country.id !== room.currentCountry?.id);

      await manager.submitAnswer(room, hostId, wrongCountry?.id ?? null);

      expect(host?.score).toBe(0);
      expect(host?.streak).toBe(0);
      expect(host?.lastFeedback?.state).toBe("incorrect");
      expect(host?.roundPerformance).toEqual([{ round: 1, outcome: "incorrect" }]);
    });

    it("records a skip", async () => {
      const { room, hostId } = await createStartedRoom(manager);
      const host = room.players.find((player) => player.id === hostId);

      await manager.submitAnswer(room, hostId, null);

      expect(host?.roundPerformance).toEqual([{ round: 1, outcome: "skipped" }]);
    });

    it("rejects double answers", async () => {
      const { room, hostId } = await createStartedRoom(manager);

      await manager.submitAnswer(room, hostId, null);
      await expect(manager.submitAnswer(room, hostId, null)).rejects.toThrow(
        "You already answered this round.",
      );
    });

    it("ends the round once every player has answered", async () => {
      const { room, hostId, guestId } = await createStartedRoom(manager);

      await manager.submitAnswer(room, hostId, room.currentCountry?.id ?? null);
      expect(room.revealCountryId).toBeNull();

      await manager.submitAnswer(room, guestId, null);
      expect(room.revealCountryId).toBe(room.currentCountry?.id);
      expect(room.roundEndsAt).toBeNull();
    });

    it("ends the round early when all connected players have answered", async () => {
      const { room, hostId, guestId } = await createStartedRoom(manager);
      const hostUnregister = manager.registerClient(room, {
        playerId: hostId,
        sendState: () => {},
      });

      // The guest is disconnected (no SSE client); only the host is
      // connected, so the host's answer should complete the round even
      // though the guest never answered.
      await manager.submitAnswer(room, hostId, room.currentCountry?.id ?? null);

      expect(room.revealCountryId).toBe(room.currentCountry?.id);

      const guest = room.players.find((player) => player.id === guestId);

      expect(guest?.roundPerformance).toEqual([{ round: 1, outcome: "timeout" }]);
      hostUnregister();
    });

    it("marks unanswered players as timed out when the timer expires", async () => {
      const { room, hostId, guestId } = await createStartedRoom(manager);

      await manager.submitAnswer(room, hostId, room.currentCountry?.id ?? null);
      vi.advanceTimersByTime(10_050);

      const guest = room.players.find((player) => player.id === guestId);

      expect(room.revealCountryId).not.toBeNull();
      expect(guest?.roundPerformance).toEqual([{ round: 1, outcome: "timeout" }]);
      expect(guest?.streak).toBe(0);
      expect(guest?.lastFeedback?.state).toBe("incorrect");
    });

    it("advances to the next round after the reveal delay and finishes the game", async () => {
      const { room, hostId, guestId } = await createStartedRoom(manager, 2);

      await manager.submitAnswer(room, hostId, room.currentCountry?.id ?? null);
      await manager.submitAnswer(room, guestId, null);
      await vi.advanceTimersByTimeAsync(2600);

      expect(room.status).toBe("playing");
      expect(room.currentRound).toBe(2);

      await manager.submitAnswer(room, hostId, null);
      await manager.submitAnswer(room, guestId, null);
      await vi.advanceTimersByTimeAsync(2600);

      expect(room.status).toBe("results");
      expect(room.currentCountry).toBeNull();
    });
  });

  describe("leaveRoom", () => {
    it("removes lobby players and deletes an empty room", async () => {
      const { room, playerId } = await manager.createRoom({ playerName: "Host" });

      manager.leaveRoom(room, playerId);

      expect(manager.getRoom(room.code)).toBeUndefined();
      expect(manager.getRoomCount()).toBe(0);
    });

    it("migrates the host when the host leaves", async () => {
      const { room, playerId: hostId } = await manager.createRoom({ playerName: "Host" });
      const guestId = manager.joinRoom(room, { playerName: "Guest" });

      manager.leaveRoom(room, hostId);

      expect(room.hostId).toBe(guestId);
      expect(room.players).toHaveLength(1);
    });

    it("keeps mid-game leavers in the room as disconnected", async () => {
      const { room, guestId } = await createStartedRoom(manager);

      manager.leaveRoom(room, guestId);

      const guest = room.players.find((player) => player.id === guestId);

      expect(room.players).toHaveLength(2);
      expect(guest?.connected).toBe(false);
    });

    it("throws for unknown players", async () => {
      const { room } = await manager.createRoom({ playerName: "Host" });

      expect(() => manager.leaveRoom(room, "nope")).toThrow(HttpError);
    });
  });

  describe("serializeRoom", () => {
    it("produces the public room state shape", async () => {
      const { room, hostId, guestId } = await createStartedRoom(manager, 2);
      const state = manager.serializeRoom(room, hostId);

      expect(state).toMatchObject({
        roomCode: room.code,
        status: "playing",
        hostId,
        playerId: hostId,
        maxPlayers: 5,
        minPlayers: 2,
        roundCount: 2,
        currentRound: 1,
        roundDurationSeconds: 10,
        currentCountryName: room.currentCountry?.name,
        revealCountryId: null,
        roundLocked: false,
        canStart: false,
        ownFeedback: null,
      });
      expect(state.roundEndsAt).toBe(room.roundEndsAt);
      expect(state.roundCountries).toEqual(room.roundCountries);
      expect(state.players.map((player) => player.id)).toEqual([hostId, guestId]);
      expect(state.players[0]).toMatchObject({
        isHost: true,
        connected: false,
        hasAnswered: false,
      });
    });

    it("hides the deadline and includes the reveal when the round is locked", async () => {
      const { room, hostId, guestId } = await createStartedRoom(manager);

      await manager.submitAnswer(room, hostId, null);
      await manager.submitAnswer(room, guestId, null);

      const state = manager.serializeRoom(room, hostId);

      expect(state.roundLocked).toBe(true);
      expect(state.roundEndsAt).toBeNull();
      expect(state.revealCountryId).toBe(room.currentCountry?.id);
      expect(state.ownFeedback?.state).toBe("incorrect");
    });
  });

  describe("sweepStaleRooms", () => {
    it("removes idle rooms past the TTL and clears their timers", async () => {
      const ttlManager = createManager({ roomTtlMilliseconds: 1000 });
      const { room } = await ttlManager.createRoom({ playerName: "Host" });

      expect(ttlManager.sweepStaleRooms()).toBe(0);

      vi.advanceTimersByTime(1500);
      expect(ttlManager.sweepStaleRooms()).toBe(1);
      expect(ttlManager.getRoom(room.code)).toBeUndefined();
      ttlManager.dispose();
    });

    it("keeps rooms with connected clients alive", async () => {
      const ttlManager = createManager({ roomTtlMilliseconds: 1000 });
      const { room, playerId } = await ttlManager.createRoom({ playerName: "Host" });
      const unregister = ttlManager.registerClient(room, { playerId, sendState: () => {} });

      vi.advanceTimersByTime(1500);
      expect(ttlManager.sweepStaleRooms()).toBe(0);
      expect(ttlManager.getRoom(room.code)).toBe(room);

      unregister();
      ttlManager.dispose();
    });
  });

  describe("registerClient", () => {
    it("tracks connection flags and pushes state updates", async () => {
      const { room, playerId } = await manager.createRoom({ playerName: "Host" });
      const received: unknown[] = [];
      const unregister = manager.registerClient(room, {
        playerId,
        sendState: (state) => received.push(state),
      });

      expect(room.players[0]?.connected).toBe(true);
      expect(received.length).toBeGreaterThan(0);

      unregister();
      expect(room.players[0]?.connected).toBe(false);
    });
  });

  it("reuses countries only after the pool is exhausted", async () => {
    const { room, hostId, guestId } = await createStartedRoom(manager, 4);
    const seenCountries: string[] = [];

    for (let round = 1; round <= 4; round += 1) {
      seenCountries.push((room as MultiplayerRoom).currentCountry?.id ?? "");
      await manager.submitAnswer(room, hostId, null);
      await manager.submitAnswer(room, guestId, null);
      await vi.advanceTimersByTimeAsync(2600);
    }

    expect(new Set(seenCountries).size).toBe(4);
  });
});
