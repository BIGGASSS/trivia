/**
 * Multiplayer wire types shared between the browser client and the
 * multiplayer server middleware. `PublicRoomState` is the canonical shape
 * serialized by the server and consumed verbatim by the client.
 */
export type RoomStatus = "lobby" | "playing" | "results";
export type AnswerState = "idle" | "correct" | "incorrect";
export type RoundPerformanceOutcome = "correct" | "incorrect" | "skipped" | "timeout";

export interface RoundPerformance {
  round: number;
  outcome: RoundPerformanceOutcome;
}

export interface RoundCountry {
  round: number;
  countryName: string;
}

export interface PlayerFeedback {
  state: AnswerState;
  message: string;
  selectedCountryId: string | null;
}

export interface PublicPlayer {
  id: string;
  name: string;
  score: number;
  attempts: number;
  streak: number;
  isHost: boolean;
  connected: boolean;
  hasAnswered: boolean;
  roundPerformance: RoundPerformance[];
}

export interface PublicRoomState {
  roomCode: string;
  status: RoomStatus;
  hostId: string;
  playerId: string;
  maxPlayers: number;
  minPlayers: number;
  roundCount: number;
  currentRound: number;
  roundDurationSeconds: number;
  roundEndsAt: number | null;
  currentCountryName: string | null;
  revealCountryId: string | null;
  roundLocked: boolean;
  canStart: boolean;
  players: PublicPlayer[];
  roundCountries: RoundCountry[];
  ownFeedback: PlayerFeedback | null;
}

export interface MultiplayerApiResponse {
  playerId?: string;
  room: PublicRoomState;
}
