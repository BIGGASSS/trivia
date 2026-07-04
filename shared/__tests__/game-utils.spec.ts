import { describe, expect, it } from "vite-plus/test";
import {
  defaultRoundCount,
  maximumPlayerCount,
  minimumMultiplayerPlayerCount,
  roomCodeCharacters,
  roomCodeLength,
  roundDurationSeconds,
} from "../game-constants";
import { clamp, normalizeRoomCode, parseRoundCount, sanitizePlayerName } from "../game-utils";

describe("game constants", () => {
  // Client and server both import these values from this shared module, so
  // pinning them here guards against accidental drift on either side.
  it("matches the documented game rules", () => {
    expect(maximumPlayerCount).toBe(5);
    expect(minimumMultiplayerPlayerCount).toBe(2);
    expect(defaultRoundCount).toBe(10);
    expect(roundDurationSeconds).toBe(10);
    expect(roomCodeLength).toBe(6);
  });

  it("uses unambiguous room code characters", () => {
    expect(roomCodeCharacters).not.toMatch(/[01IO]/);
    expect(new Set(roomCodeCharacters).size).toBe(roomCodeCharacters.length);
  });
});

describe("clamp", () => {
  it("clamps values into the inclusive range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe("normalizeRoomCode", () => {
  it("uppercases and strips non-alphanumerics", () => {
    expect(normalizeRoomCode(" ab-c1 23 ")).toBe("ABC123");
    expect(normalizeRoomCode("abc123")).toBe("ABC123");
    expect(normalizeRoomCode("!@#$")).toBe("");
    expect(normalizeRoomCode("")).toBe("");
  });
});

describe("sanitizePlayerName", () => {
  it("falls back for non-strings and blank names", () => {
    expect(sanitizePlayerName(undefined, "Host")).toBe("Host");
    expect(sanitizePlayerName(42, "Host")).toBe("Host");
    expect(sanitizePlayerName("   ", "Host")).toBe("Host");
  });

  it("trims, collapses whitespace, and caps at 24 characters", () => {
    expect(sanitizePlayerName("  Ada   Lovelace  ", "x")).toBe("Ada Lovelace");
    expect(sanitizePlayerName("a".repeat(40), "x")).toBe("a".repeat(24));
  });
});

describe("parseRoundCount", () => {
  it("defaults invalid input to the default round count", () => {
    expect(parseRoundCount(undefined, 100)).toBe(defaultRoundCount);
    expect(parseRoundCount("not a number", 100)).toBe(defaultRoundCount);
    expect(parseRoundCount(0, 100)).toBe(defaultRoundCount);
  });

  it("clamps to [1, countryCount]", () => {
    expect(parseRoundCount(3, 100)).toBe(3);
    expect(parseRoundCount(-5, 100)).toBe(1);
    expect(parseRoundCount(500, 100)).toBe(100);
    expect(parseRoundCount(5, 0)).toBe(1);
  });

  it("rounds fractional values", () => {
    expect(parseRoundCount(2.6, 100)).toBe(3);
    expect(parseRoundCount(2.4, 100)).toBe(2);
  });
});
