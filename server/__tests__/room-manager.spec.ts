import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createRoomManager, HttpError } from "../room-manager";
import type { CountrySummary, MultiplayerRoom, RoomManager } from "../room-manager";
import type { PublicRoomState } from "../../shared/multiplayer-types";

const testCountries = [
  { id: "0-France", name: "France" },
  { id: "1-Japan", name: "Japan" },
  { id: "2-Brazil", name: "Brazil" },
  { id: "3-Kenya", name: "Kenya" },
];

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const latest = <T>(items: T[]) => items[items.length - 1];

const createManager = (overrides: Partial<Parameters<typeof createRoomManager>[0]> = {}) =>
  createRoomManager({ loadCountries: () => Promise.resolve(testCountries), ...overrides });

const createStartedRoom = async (manager: RoomManager, rounds = 2) => {
  const {
    room,
    playerId: hostId,
    sessionToken: hostToken,
  } = await manager.createRoom({
    playerName: "Host",
    rounds,
  });
  const { playerId: guestId, sessionToken: guestToken } = manager.joinRoom(room, {
    playerName: "Guest",
  });
  manager.startRoom(room);
  return { room, hostId, guestId, hostToken, guestToken };
};

const answer = (
  manager: RoomManager,
  room: MultiplayerRoom,
  playerId: string,
  countryId: string | null = null,
) => manager.submitAnswer(room, playerId, countryId, room.matchId, room.roundId);

const connect = (manager: RoomManager, room: MultiplayerRoom, playerId: string) => {
  const states: PublicRoomState[] = [];
  const close = vi.fn<() => void>();
  const unregister = manager.registerClient(room, {
    playerId,
    close,
    sendState: (state) => states.push(state),
  });
  return { states, close, unregister };
};

describe("createRoomManager", () => {
  let manager: RoomManager;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    manager = createManager();
  });
  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  describe("creation and credentials", () => {
    it("creates a lobby with a private host credential and versioned public state", async () => {
      const { room, playerId, sessionToken } = await manager.createRoom({
        playerName: "Ada",
        rounds: 3,
      });
      expect(room.code).toMatch(/^[A-Z0-9]{6}$/);
      expect(manager.getRoom(room.code.toLowerCase())).toBe(room);
      expect(room.players).toHaveLength(1);
      expect(manager.authenticatePlayer(room, sessionToken)).toBe(room.players[0]);
      expect(sessionToken).not.toBe(playerId);
      expect(manager.serializeRoom(room, playerId)).toMatchObject({
        status: "lobby",
        hostId: playerId,
        playerId,
        roundCount: 3,
        revision: 1,
        matchId: null,
        roundId: null,
        canStart: false,
        players: [{ id: playerId, name: "Ada", active: true, connected: false }],
      });
    });

    it("never authenticates public IDs or exposes either player's credentials", async () => {
      const { room, playerId, sessionToken } = await manager.createRoom({});
      const guest = manager.joinRoom(room, {});
      const otherRoom = await manager.createRoom({});
      expect(guest.sessionToken).not.toBe(sessionToken);
      for (const token of [undefined, "", playerId, guest.playerId, otherRoom.sessionToken]) {
        expect(() => manager.authenticatePlayer(room, token)).toThrow(HttpError);
      }
      expect(manager.authenticatePlayer(room, guest.sessionToken).id).toBe(guest.playerId);
      const stream = connect(manager, room, playerId);
      const payload = JSON.stringify([manager.serializeRoom(room, guest.playerId), stream.states]);
      expect(payload).not.toContain(sessionToken);
      expect(payload).not.toContain(guest.sessionToken);
      expect(payload).not.toContain("sessionToken");
    });

    it("clamps rounds to the cached country count", async () => {
      const { room } = await manager.createRoom({ rounds: 999 });
      expect(room.roundCount).toBe(testCountries.length);
    });

    it("reserves capacity before an asynchronous country load", async () => {
      const countries = deferred<CountrySummary[]>();
      const loadCountries = vi.fn<() => Promise<CountrySummary[]>>(() => countries.promise);
      manager = createManager({ maximumRoomCount: 1, loadCountries });
      const first = manager.createRoom({ playerName: "A" });
      await expect(manager.createRoom({ playerName: "B" })).rejects.toMatchObject({
        statusCode: 503,
      });
      expect(loadCountries).toHaveBeenCalledTimes(1);
      countries.resolve(testCountries);
      const { room, playerId } = await first;
      expect(manager.getRoomCount()).toBe(1);
      await expect(manager.createRoom({})).rejects.toMatchObject({ statusCode: 503 });
      manager.leaveRoom(room, playerId);
      await manager.createRoom({});
      expect(manager.getRoomCount()).toBe(1);
    });

    it("rejects empty data and releases reservations after empty/failed loads", async () => {
      const loadCountries = vi
        .fn<() => Promise<CountrySummary[]>>()
        .mockRejectedValueOnce(new Error("load failed"))
        .mockResolvedValueOnce([])
        .mockResolvedValue(testCountries);
      manager = createManager({ maximumRoomCount: 1, loadCountries });
      await expect(manager.createRoom({})).rejects.toThrow("load failed");
      await expect(manager.createRoom({})).rejects.toMatchObject({ statusCode: 503 });
      expect(manager.getRoomCount()).toBe(0);
      await manager.createRoom({});
      expect(manager.getRoomCount()).toBe(1);
    });

    it("does not resurrect rooms when an in-flight create resolves after dispose", async () => {
      const countries = deferred<CountrySummary[]>();
      manager = createManager({ loadCountries: () => countries.promise });
      const creation = manager.createRoom({});
      manager.dispose();
      countries.resolve(testCountries);
      await expect(creation).rejects.toMatchObject({ statusCode: 503 });
      await expect(manager.createRoom({})).rejects.toMatchObject({ statusCode: 503 });
      expect(manager.getRoomCount()).toBe(0);
    });
  });

  describe("join and start", () => {
    it("sanitizes joining names, issues distinct sessions, and publishes the joined revision", async () => {
      const { room, playerId } = await manager.createRoom({});
      const stream = connect(manager, room, playerId);
      const before = room.revision;
      const guest = manager.joinRoom(room, { playerName: "  Grace   Hopper  " });
      expect(room.players).toHaveLength(2);
      expect(manager.getPlayer(room, guest.playerId)?.name).toBe("Grace Hopper");
      expect(room.revision).toBe(before + 1);
      expect(latest(stream.states)).toEqual(manager.serializeRoom(room, playerId));
    });

    it("rejects joining full or playing rooms", async () => {
      const { room } = await manager.createRoom({});
      for (let index = 0; index < 4; index += 1) manager.joinRoom(room, {});
      expect(() => manager.joinRoom(room, {})).toThrow("This room is full.");
      manager.startRoom(room);
      expect(() => manager.joinRoom(room, {})).toThrow("This room is already in a game.");
    });

    it("requires two active players and starts with match/round IDs and a deadline", async () => {
      const { room } = await manager.createRoom({});
      expect(() => manager.startRoom(room)).toThrow("At least two players are required.");
      manager.joinRoom(room, {});
      manager.startRoom(room);
      expect(room.status).toBe("playing");
      expect(room.currentRound).toBe(1);
      expect(room.matchId).toEqual(expect.any(String));
      expect(room.roundId).toEqual(expect.any(String));
      expect(room.roundEndsAt).toBe(Date.now() + 10_000);
      expect(room.roundCountries).toHaveLength(1);
      const revision = room.revision;
      expect(() => manager.startRoom(room)).toThrow("This room is already playing a match.");
      expect(room.revision).toBe(revision);
      expect(room.currentRound).toBe(1);
    });

    it("resets scores and generates new IDs on rematch", async () => {
      const { room, hostId } = await createStartedRoom(manager, 1);
      const { matchId, roundId } = room;
      answer(manager, room, hostId, room.currentCountry!.id);
      manager.finishRound(room);
      vi.advanceTimersByTime(2600);
      expect(room.status).toBe("results");
      expect(room.roundId).toBeNull();
      expect(room.matchId).toBe(matchId);
      manager.startRoom(room);
      expect(room.matchId).not.toBe(matchId);
      expect(room.roundId).not.toBe(roundId);
      expect(room.currentRound).toBe(1);
      expect(room.players.every((player) => player.score === 0 && player.attempts === 0)).toBe(
        true,
      );
    });

    it("uses only the creation-time country cache during all gameplay", async () => {
      const loadCountries = vi.fn<() => Promise<CountrySummary[]>>(() =>
        Promise.resolve(testCountries.map((country) => ({ ...country }))),
      );
      manager = createManager({ loadCountries });
      const { room, hostId, guestId } = await createStartedRoom(manager, 4);
      loadCountries.mockRejectedValue(new Error("must not load during gameplay"));
      const countries = new Set<string>();
      for (let round = 1; round <= 4; round += 1) {
        countries.add(room.currentCountry!.id);
        answer(manager, room, hostId);
        answer(manager, room, guestId);
        vi.advanceTimersByTime(2600);
      }
      expect(room.status).toBe("results");
      expect(countries.size).toBe(4);
      manager.startRoom(room);
      expect(loadCountries).toHaveBeenCalledTimes(1);
    });
  });

  describe("atomic answers and deadlines", () => {
    it("scores correct guesses and records wrong guesses and skips", async () => {
      const { room, hostId, guestId } = await createStartedRoom(manager);
      const host = manager.getPlayer(room, hostId)!;
      const guest = manager.getPlayer(room, guestId)!;
      const wrong = testCountries.find((country) => country.id !== room.currentCountry!.id)!;
      answer(manager, room, hostId, room.currentCountry!.id);
      answer(manager, room, guestId, wrong.id);
      expect(host).toMatchObject({
        score: 1,
        streak: 1,
        attempts: 1,
        roundPerformance: [{ round: 1, outcome: "correct" }],
      });
      expect(guest).toMatchObject({
        score: 0,
        streak: 0,
        attempts: 1,
        roundPerformance: [{ round: 1, outcome: "incorrect" }],
      });
      expect(guest.lastFeedback?.message).toContain(wrong.name);
      vi.advanceTimersByTime(2600);
      answer(manager, room, hostId);
      expect(host.streak).toBe(0);
      expect(latest(host.roundPerformance)).toEqual({ round: 2, outcome: "skipped" });
    });

    it("accepts only one of concurrent duplicate answers", async () => {
      const { room, hostId } = await createStartedRoom(manager);
      const revision = room.revision;
      const submissions = await Promise.allSettled([
        Promise.resolve().then(() => answer(manager, room, hostId, room.currentCountry!.id)),
        Promise.resolve().then(() => answer(manager, room, hostId, room.currentCountry!.id)),
      ]);
      expect(submissions.map((submission) => submission.status)).toEqual(["fulfilled", "rejected"]);
      expect(manager.getPlayer(room, hostId)).toMatchObject({ score: 1, attempts: 1 });
      expect(room.revision).toBe(revision + 1);
      expect(() => answer(manager, room, hostId)).toThrow("You already answered this round.");
    });

    it.each([0, 1, 500])(
      "rejects guesses %i ms past the deadline even before the timer runs",
      async (delay) => {
        const { room, hostId } = await createStartedRoom(manager);
        vi.setSystemTime(room.roundEndsAt! + delay);
        expect(room.revealCountryId).toBeNull();
        expect(() => answer(manager, room, hostId, room.currentCountry!.id)).toThrow(
          "The answer deadline has passed.",
        );
        expect(room.revealCountryId).toBe(room.currentCountry!.id);
        expect(manager.getPlayer(room, hostId)).toMatchObject({
          score: 0,
          attempts: 1,
          roundPerformance: [{ round: 1, outcome: "timeout" }],
        });
      },
    );

    it("accepts an answer just before the deadline", async () => {
      const { room, hostId } = await createStartedRoom(manager);
      vi.setSystemTime(room.roundEndsAt! - 1);
      answer(manager, room, hostId, room.currentCountry!.id);
      expect(manager.getPlayer(room, hostId)?.score).toBe(1);
    });

    it("rejects missing, stale-round and previous-match tokens without touching state", async () => {
      const { room, hostId } = await createStartedRoom(manager, 2);
      const firstMatch = room.matchId;
      const firstRound = room.roundId;
      expect(() => manager.submitAnswer(room, hostId, null, null, null)).toThrow(HttpError);
      manager.finishRound(room);
      vi.advanceTimersByTime(2600);
      const revision = room.revision;
      expect(room.roundId).not.toBe(firstRound);
      expect(() => manager.submitAnswer(room, hostId, null, firstMatch, firstRound)).toThrow(
        "different match or round",
      );
      expect(room.revision).toBe(revision);
      expect(manager.getPlayer(room, hostId)?.answeredThisRound).toBe(false);
      manager.finishRound(room);
      vi.advanceTimersByTime(2600);
      manager.startRoom(room);
      expect(() => manager.submitAnswer(room, hostId, null, firstMatch, room.roundId)).toThrow(
        "different match or round",
      );
      expect(manager.getPlayer(room, hostId)?.attempts).toBe(0);
    });

    it("locks the round exactly once and does not restart the reveal timer", async () => {
      const { room, hostId, guestId } = await createStartedRoom(manager);
      answer(manager, room, hostId);
      expect(room.revealCountryId).toBeNull();
      answer(manager, room, guestId);
      expect(room.roundEndsAt).toBeNull();
      const revision = room.revision;
      vi.advanceTimersByTime(1000);
      manager.finishRound(room);
      expect(room.revision).toBe(revision);
      expect(room.players.every((player) => player.attempts === 1)).toBe(true);
      expect(() => answer(manager, room, hostId)).toThrow("This round is already complete.");
      vi.advanceTimersByTime(1600);
      expect(room.currentRound).toBe(2);
      expect(room.revealCountryId).toBeNull();
    });

    it("times out unanswered active players at the deadline and reaches results", async () => {
      const { room, hostId, guestId } = await createStartedRoom(manager, 1);
      answer(manager, room, hostId, room.currentCountry!.id);
      vi.advanceTimersByTime(10_000);
      expect(manager.getPlayer(room, guestId)?.roundPerformance).toEqual([
        { round: 1, outcome: "timeout" },
      ]);
      expect(room.revealCountryId).not.toBeNull();
      vi.advanceTimersByTime(2600);
      expect(room.status).toBe("results");
      expect(room.currentCountry).toBeNull();
      expect(room.roundTimer).toBeNull();
      expect(room.nextRoundTimer).toBeNull();
    });

    it("finishes early for connected active players and times out disconnected members", async () => {
      const { room, hostId, guestId } = await createStartedRoom(manager);
      connect(manager, room, hostId);
      answer(manager, room, hostId, room.currentCountry!.id);
      expect(room.revealCountryId).toBe(room.currentCountry!.id);
      expect(manager.getPlayer(room, guestId)?.roundPerformance).toEqual([
        { round: 1, outcome: "timeout" },
      ]);
    });
  });

  describe("active membership and revocation", () => {
    it("removes lobby leavers, revokes all their streams, and migrates the host", async () => {
      const { room, playerId: hostId, sessionToken } = await manager.createRoom({});
      const guest = manager.joinRoom(room, {});
      const first = connect(manager, room, hostId);
      const second = connect(manager, room, hostId);
      manager.leaveRoom(room, hostId);
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(second.close).toHaveBeenCalledTimes(1);
      expect(room.players).toHaveLength(1);
      expect(room.hostId).toBe(guest.playerId);
      expect(() => manager.authenticatePlayer(room, sessionToken)).toThrow(HttpError);
      const revision = room.revision;
      first.unregister();
      second.unregister();
      expect(room.revision).toBe(revision);
      const count = first.states.length;
      manager.joinRoom(room, {});
      expect(first.states).toHaveLength(count);
    });

    it("retains departed match history but excludes leavers from answers, timeouts and future matches", async () => {
      const { room, playerId: hostId } = await manager.createRoom({ rounds: 2 });
      const guest = manager.joinRoom(room, {});
      const third = manager.joinRoom(room, {});
      manager.startRoom(room);
      answer(manager, room, guest.playerId, room.currentCountry!.id);
      const stream = connect(manager, room, guest.playerId);
      manager.leaveRoom(room, guest.playerId);
      const leaver = manager.getPlayer(room, guest.playerId)!;
      expect(leaver).toMatchObject({ active: false, connected: false, score: 1, attempts: 1 });
      expect(stream.close).toHaveBeenCalledTimes(1);
      expect(() => answer(manager, room, guest.playerId)).toThrow(HttpError);
      expect(() => manager.authenticatePlayer(room, guest.sessionToken)).toThrow(HttpError);
      expect(() => connect(manager, room, guest.playerId)).toThrow(HttpError);
      answer(manager, room, hostId);
      answer(manager, room, third.playerId);
      vi.advanceTimersByTime(2600);
      manager.finishRound(room);
      vi.advanceTimersByTime(2600);
      expect(leaver.attempts).toBe(1);
      expect(
        manager.serializeRoom(room, hostId).players.find((player) => player.id === guest.playerId)
          ?.active,
      ).toBe(false);
      expect(manager.serializeRoom(room, hostId).canStart).toBe(true);
      manager.startRoom(room);
      expect(room.players.map((player) => player.id)).toEqual([hostId, third.playerId]);
    });

    it("only transfers host to active players and does not count departed players toward canStart", async () => {
      const { room, playerId: hostId } = await manager.createRoom({ rounds: 1 });
      const guest = manager.joinRoom(room, {});
      const third = manager.joinRoom(room, {});
      manager.startRoom(room);
      manager.leaveRoom(room, guest.playerId);
      manager.leaveRoom(room, hostId);
      expect(room.hostId).toBe(third.playerId);
      manager.finishRound(room);
      vi.advanceTimersByTime(2600);
      expect(manager.serializeRoom(room, third.playerId).canStart).toBe(false);
      expect(() => manager.startRoom(room)).toThrow("At least two players are required.");
    });

    it("finishes the round when the last required unanswered player leaves", async () => {
      const { room, hostId, guestId } = await createStartedRoom(manager);
      answer(manager, room, hostId);
      manager.leaveRoom(room, guestId);
      expect(room.revealCountryId).not.toBeNull();
      expect(manager.getPlayer(room, guestId)?.attempts).toBe(0);
    });

    it.each(["lobby", "playing", "results"] as const)(
      "deletes %s rooms when the last active player leaves",
      async (status) => {
        const { room, playerId: hostId, sessionToken } = await manager.createRoom({ rounds: 1 });
        const guest = manager.joinRoom(room, {});
        if (status !== "lobby") manager.startRoom(room);
        if (status === "results") {
          manager.finishRound(room);
          vi.advanceTimersByTime(2600);
        }
        const hostStream = connect(manager, room, hostId);
        manager.leaveRoom(room, guest.playerId);
        manager.leaveRoom(room, hostId);
        expect(manager.getRoomCount()).toBe(0);
        expect(hostStream.close).toHaveBeenCalledTimes(1);
        expect(() => manager.authenticatePlayer(room, sessionToken)).toThrow(HttpError);
        expect(() => manager.joinRoom(room, {})).toThrow(HttpError);
        expect(() => manager.startRoom(room)).toThrow(HttpError);
        expect(room.roundTimer).toBeNull();
        expect(room.nextRoundTimer).toBeNull();
        vi.advanceTimersByTime(30_000);
        expect(manager.getRoom(room.code)).toBeUndefined();
      },
    );

    it("rejects unknown and already-departed players", async () => {
      const { room, guestId } = await createStartedRoom(manager);
      expect(() => manager.leaveRoom(room, "nope")).toThrow(HttpError);
      manager.leaveRoom(room, guestId);
      expect(() => manager.leaveRoom(room, guestId)).toThrow(HttpError);
    });
  });

  describe("snapshots, subscriptions and cleanup", () => {
    it("publishes monotonically increasing immutable snapshots matching HTTP serialization", async () => {
      const { room, hostId, guestId } = await createStartedRoom(manager);
      const hostStream = connect(manager, room, hostId);
      const guestStream = connect(manager, room, guestId);
      const initial = latest(hostStream.states)!;
      const initialJson = JSON.stringify(initial);
      answer(manager, room, hostId);
      expect(latest(hostStream.states)).toEqual(manager.serializeRoom(room, hostId));
      answer(manager, room, guestId);
      expect(latest(hostStream.states)).toMatchObject({ roundLocked: true, roundEndsAt: null });
      expect(latest(hostStream.states)?.revision).toBe(latest(guestStream.states)?.revision);
      vi.advanceTimersByTime(2600);
      expect(JSON.stringify(initial)).toBe(initialJson);
      expect(initial.roundCountries).toHaveLength(1);
      expect(initial.players[0]?.roundPerformance).toEqual([]);
      const revisions = hostStream.states.map((state) => state.revision);
      expect(
        revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!),
      ).toBe(true);
      const revision = room.revision;
      manager.serializeRoom(room, hostId);
      expect(room.revision).toBe(revision);
    });

    it("tracks multiple tabs without marking an active player departed on disconnect", async () => {
      const { room, playerId, sessionToken } = await manager.createRoom({});
      const first = connect(manager, room, playerId);
      const second = connect(manager, room, playerId);
      first.unregister();
      expect(manager.getPlayer(room, playerId)?.connected).toBe(true);
      second.unregister();
      expect(manager.getPlayer(room, playerId)).toMatchObject({ active: true, connected: false });
      expect(manager.authenticatePlayer(room, sessionToken).id).toBe(playerId);
      const revision = room.revision;
      second.unregister();
      expect(room.revision).toBe(revision);
    });

    it("does not let a broken stream or close callback break mutations or cleanup", async () => {
      const { room, playerId } = await manager.createRoom({});
      const close = vi.fn<() => void>(() => {
        throw new Error("closed transport");
      });
      manager.registerClient(room, {
        playerId,
        sendState: () => {
          throw new Error("broken transport");
        },
        close,
      });
      expect(close).toHaveBeenCalledTimes(1);
      expect(manager.getPlayer(room, playerId)?.connected).toBe(false);
      expect(() => manager.joinRoom(room, {})).not.toThrow();
      manager.dispose();
      expect(manager.getRoomCount()).toBe(0);
    });

    it("sweeps stale unconnected rooms but protects connected rooms", async () => {
      manager = createManager({ roomTtlMilliseconds: 1000 });
      const stale = await manager.createRoom({});
      const live = await manager.createRoom({});
      const stream = connect(manager, live.room, live.playerId);
      expect(manager.sweepStaleRooms()).toBe(0);
      vi.advanceTimersByTime(1500);
      expect(manager.sweepStaleRooms()).toBe(1);
      expect(manager.getRoom(stale.room.code)).toBeUndefined();
      expect(manager.getRoom(live.room.code)).toBe(live.room);
      stream.unregister();
      vi.advanceTimersByTime(1500);
      expect(manager.sweepStaleRooms()).toBe(1);
    });

    it("dispose closes every subscription, revokes sessions and cancels gameplay timers", async () => {
      const { room, hostId, guestId, hostToken } = await createStartedRoom(manager);
      const host = connect(manager, room, hostId);
      const guest = connect(manager, room, guestId);
      manager.dispose();
      expect(host.close).toHaveBeenCalledTimes(1);
      expect(guest.close).toHaveBeenCalledTimes(1);
      expect(() => manager.authenticatePlayer(room, hostToken)).toThrow(HttpError);
      expect(room.roundTimer).toBeNull();
      expect(room.nextRoundTimer).toBeNull();
      const received = host.states.length;
      host.unregister();
      guest.unregister();
      vi.advanceTimersByTime(30_000);
      expect(host.states).toHaveLength(received);
      expect(manager.getRoomCount()).toBe(0);
    });
  });
});
