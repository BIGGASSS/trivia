import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  getStoredMultiplayerSession,
  getPendingMultiplayerJoin,
  savePendingMultiplayerJoin,
  removePendingMultiplayerJoin,
  getStoredMultiplayerSessions,
  removeMultiplayerSession,
  saveMultiplayerSession,
  sessionTtlMilliseconds,
} from "../multiplayer-session";

const storageKey = "world-trivia.multiplayer-sessions";
const session = () => ({
  playerId: "p1",
  sessionToken: "private-credential",
  playerName: "Ada",
  roomCode: "abc123",
  updatedAt: Date.now(),
});

describe("multiplayer session store", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("persists pending join credentials and conditionally removes only the matching identity", () => {
    const pending = { joinRequestId: crypto.randomUUID(), playerName: "Ada" };
    savePendingMultiplayerJoin("abc-123", pending);
    expect(getPendingMultiplayerJoin("ABC123")).toEqual(pending);
    removePendingMultiplayerJoin("ABC123", "obsolete-id");
    expect(getPendingMultiplayerJoin("ABC123")).toEqual(pending);
    removePendingMultiplayerJoin("ABC123", pending.joinRequestId);
    expect(getPendingMultiplayerJoin("ABC123")).toBeNull();
  });

  it("does not silently accept a pending identity that could not be persisted", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Full");
    });
    expect(() =>
      savePendingMultiplayerJoin("ABC123", { joinRequestId: "id", playerName: "Ada" }),
    ).toThrow("Full");
  });

  it("ignores malformed pending join data", () => {
    window.localStorage.setItem(
      "world-trivia.multiplayer-pending-join.ABC123",
      '{"joinRequestId":1}',
    );
    expect(getPendingMultiplayerJoin("ABC123")).toBeNull();
  });

  it("saves private sessions keyed by normalized room code", () => {
    saveMultiplayerSession(session());
    expect(getStoredMultiplayerSession("ABC123")?.playerId).toBe("p1");
    expect(getStoredMultiplayerSession("ABC123")?.roomCode).toBe("ABC123");
    expect(getStoredMultiplayerSession(" abc-123 ")?.sessionToken).toBe("private-credential");
  });

  it("removes sessions", () => {
    saveMultiplayerSession(session());
    removeMultiplayerSession("ABC123");
    expect(getStoredMultiplayerSession("ABC123")).toBeNull();
  });

  it("does not remove a replacement credential from another tab", () => {
    saveMultiplayerSession(session());
    removeMultiplayerSession("ABC123", "old-token");
    expect(getStoredMultiplayerSession("ABC123")?.sessionToken).toBe("private-credential");
    removeMultiplayerSession("ABC123", "private-credential");
    expect(getStoredMultiplayerSession("ABC123")).toBeNull();
  });

  it("expires sessions older than the TTL and prunes them from storage", () => {
    vi.useFakeTimers();
    saveMultiplayerSession(session());
    vi.advanceTimersByTime(sessionTtlMilliseconds + 1);
    expect(getStoredMultiplayerSession("ABC123")).toBeNull();
    expect(window.localStorage.getItem(storageKey)).toBe("{}");
  });

  it("rejects legacy ID-only credentials and malformed entries without losing valid sessions", () => {
    const { sessionToken: _token, ...legacy } = session();
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        LEGACY: legacy,
        NULL: null,
        EMPTY: { ...session(), sessionToken: "" },
        ABC123: session(),
      }),
    );
    expect(Object.keys(getStoredMultiplayerSessions())).toEqual(["ABC123"]);
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
    expect(() => saveMultiplayerSession(session())).not.toThrow();
    expect(() => removeMultiplayerSession("ABC123")).not.toThrow();
  });

  it("survives storage read failures", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(getStoredMultiplayerSessions()).toEqual({});
  });
});
