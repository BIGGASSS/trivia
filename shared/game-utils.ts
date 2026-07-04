/**
 * Pure helpers shared between the browser client and the multiplayer
 * server middleware. Keep this module isomorphic: no Node or DOM APIs.
 */
import { defaultRoundCount } from "./game-constants";

export const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

export const normalizeRoomCode = (roomCode: string) =>
  roomCode
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

export const sanitizePlayerName = (name: unknown, fallback: string) => {
  if (typeof name !== "string") {
    return fallback;
  }

  const trimmedName = name.trim().replace(/\s+/g, " ").slice(0, 24);

  return trimmedName || fallback;
};

export const parseRoundCount = (rounds: unknown, countryCount: number) => {
  const numericRoundCount = Number(rounds) || defaultRoundCount;
  const maximumRoundCount = Math.max(1, countryCount);

  return clamp(Math.round(numericRoundCount), 1, maximumRoundCount);
};
