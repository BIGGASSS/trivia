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
  sessionToken: string;
  playerName: string;
  roomCode: string;
  updatedAt: number;
}

const multiplayerSessionStorageKey = "world-trivia.multiplayer-sessions";
export const sessionTtlMilliseconds = 24 * 60 * 60 * 1000;

type SessionRecord = Record<string, StoredMultiplayerSession>;

const isSessionFresh = (session: StoredMultiplayerSession | undefined, now: number) =>
  session != null &&
  typeof session.playerId === "string" &&
  typeof session.sessionToken === "string" &&
  session.sessionToken.length > 0 &&
  typeof session.playerName === "string" &&
  typeof session.roomCode === "string" &&
  typeof session.updatedAt === "number" &&
  Number.isFinite(session.updatedAt) &&
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

  const roomCode = normalizeRoomCode(session.roomCode);
  sessions[roomCode] = { ...session, roomCode };
  writeSessions(sessions);
};

export const removeMultiplayerSession = (roomCode: string, expectedSessionToken?: string) => {
  const sessions = getStoredMultiplayerSessions();
  const key = normalizeRoomCode(roomCode);
  // An older tab/request must not delete a replacement credential from another tab.
  if (expectedSessionToken !== undefined && sessions[key]?.sessionToken !== expectedSessionToken)
    return;

  delete sessions[key];
  writeSessions(sessions);
};
