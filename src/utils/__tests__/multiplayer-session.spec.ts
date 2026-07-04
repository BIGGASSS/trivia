import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  getStoredMultiplayerSession,
  getStoredMultiplayerSessions,
  removeMultiplayerSession,
  saveMultiplayerSession,
  sessionTtlMilliseconds,
} from "../multiplayer-session";

const storageKey = "world-trivia.multiplayer-sessions";

describe("multiplayer session store", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("saves and reads sessions keyed by normalized room code", () => {
    saveMultiplayerSession({
      playerId: "p1",
      playerName: "Ada",
      roomCode: "abc123",
      updatedAt: Date.now(),
    });

    expect(getStoredMultiplayerSession("ABC123")?.playerId).toBe("p1");
    expect(getStoredMultiplayerSession(" abc-123 ")?.playerId).toBe("p1");
  });

  it("removes sessions", () => {
    saveMultiplayerSession({
      playerId: "p1",
      playerName: "Ada",
      roomCode: "ABC123",
      updatedAt: Date.now(),
    });
    removeMultiplayerSession("ABC123");

    expect(getStoredMultiplayerSession("ABC123")).toBeNull();
  });

  it("expires sessions older than the TTL and prunes them from storage", () => {
    vi.useFakeTimers();
    saveMultiplayerSession({
      playerId: "p1",
      playerName: "Ada",
      roomCode: "ABC123",
      updatedAt: Date.now(),
    });

    vi.advanceTimersByTime(sessionTtlMilliseconds + 1);

    expect(getStoredMultiplayerSession("ABC123")).toBeNull();
    expect(window.localStorage.getItem(storageKey)).toBe("{}");
  });

  it("survives corrupted storage contents", () => {
    window.localStorage.setItem(storageKey, "not json");

    expect(getStoredMultiplayerSessions()).toEqual({});
    expect(getStoredMultiplayerSession("ABC123")).toBeNull();
  });

  it("survives storage write failures (quota / private mode)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    expect(() =>
      saveMultiplayerSession({
        playerId: "p1",
        playerName: "Ada",
        roomCode: "ABC123",
        updatedAt: Date.now(),
      }),
    ).not.toThrow();
    expect(() => removeMultiplayerSession("ABC123")).not.toThrow();
  });

  it("survives storage read failures", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(getStoredMultiplayerSessions()).toEqual({});
  });
});
