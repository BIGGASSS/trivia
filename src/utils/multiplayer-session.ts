/**
 * Persistent multiplayer session store backed by localStorage.
 *
 * All storage access is wrapped in try/catch so private-browsing modes,
 * disabled storage, or full quotas degrade gracefully instead of throwing.
 * Sessions expire after `sessionTtlMilliseconds` and are pruned on read.
 */
import { normalizeRoomCode } from "@shared/game-utils";

export interface StoredMultiplayerSession {
  playerId: string;
  playerName: string;
  roomCode: string;
  updatedAt: number;
}

const multiplayerSessionStorageKey = "world-trivia.multiplayer-sessions";
export const sessionTtlMilliseconds = 24 * 60 * 60 * 1000;

type SessionRecord = Record<string, StoredMultiplayerSession>;

const isSessionFresh = (session: StoredMultiplayerSession | undefined, now: number) =>
  session !== undefined &&
  typeof session.updatedAt === "number" &&
  now - session.updatedAt <= sessionTtlMilliseconds;

const writeSessions = (sessions: SessionRecord) => {
  try {
    window.localStorage.setItem(multiplayerSessionStorageKey, JSON.stringify(sessions));
  } catch {
    // Storage may be unavailable (private mode) or full; sessions are a
    // convenience only, so losing them is acceptable.
  }
};

export const getStoredMultiplayerSessions = (): SessionRecord => {
  try {
    const storedValue = window.localStorage.getItem(multiplayerSessionStorageKey);

    if (!storedValue) {
      return {};
    }

    const parsedValue = JSON.parse(storedValue) as SessionRecord;

    if (!parsedValue || typeof parsedValue !== "object") {
      return {};
    }

    const now = Date.now();
    const freshEntries = Object.entries(parsedValue).filter(([, session]) =>
      isSessionFresh(session, now),
    );

    if (freshEntries.length !== Object.keys(parsedValue).length) {
      writeSessions(Object.fromEntries(freshEntries));
    }

    return Object.fromEntries(freshEntries);
  } catch {
    return {};
  }
};

export const getStoredMultiplayerSession = (roomCode: string) =>
  getStoredMultiplayerSessions()[normalizeRoomCode(roomCode)] ?? null;

export const saveMultiplayerSession = (session: StoredMultiplayerSession) => {
  const sessions = getStoredMultiplayerSessions();

  sessions[normalizeRoomCode(session.roomCode)] = session;
  writeSessions(sessions);
};

export const removeMultiplayerSession = (roomCode: string) => {
  const sessions = getStoredMultiplayerSessions();

  delete sessions[normalizeRoomCode(roomCode)];
  writeSessions(sessions);
};
