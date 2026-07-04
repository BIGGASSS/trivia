/**
 * Client-side game types shared by the solo engine, multiplayer client, and
 * presentation components.
 */
import type { PublicPlayer, RoundPerformance } from "@shared/multiplayer-types";

export type GameMode = "solo" | "multiplayer";
export type GamePhase = "setup" | "playing" | "results";
export type MultiplayerSetupAction = "create" | "join";

export interface CountryPath {
  id: string;
  name: string;
  path: string;
}

/** Minimal player shape used for both the solo player and room players. */
export interface Player {
  id: string;
  name: string;
  score: number;
  attempts: number;
  streak: number;
  roundPerformance: RoundPerformance[];
}

export type MultiplayerPlayer = PublicPlayer;
