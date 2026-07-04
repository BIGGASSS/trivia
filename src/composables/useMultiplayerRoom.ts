/**
 * Multiplayer room client: REST calls, SSE live updates, reconnect/health
 * state machine, and session persistence. Logic moved verbatim from the
 * original WorldMap component apart from the noted hardening changes.
 */
import { computed, onUnmounted, ref, watch } from "vue";
import type { Ref } from "vue";
import { multiplayerGamePath } from "@shared/game-constants";
import { normalizeRoomCode } from "@shared/game-utils";
import type { MultiplayerApiResponse, PublicRoomState } from "@shared/multiplayer-types";
import type { GameMode, GamePhase, MultiplayerSetupAction } from "@/types/game";
import {
  getStoredMultiplayerSession,
  removeMultiplayerSession,
  saveMultiplayerSession,
} from "@/utils/multiplayer-session";

const roomConnectionStaleMilliseconds = 6500;
const roomSyncIntervalMilliseconds = 2000;
const roomReconnectCooldownMilliseconds = 4000;
const roundDeadlineSyncGraceMilliseconds = 250;
const clockTickMilliseconds = 250;

export type RoomConnectionState = "connected" | "reconnecting" | "offline";

export interface MultiplayerRoomOptions {
  gamePhase: Ref<GamePhase>;
  selectedMode: Ref<GameMode>;
  totalRounds: Ref<number>;
  getConfiguredRoundCount: () => number;
  setGamePath: (path: string, replace?: boolean) => void;
}

export const useMultiplayerRoom = (options: MultiplayerRoomOptions) => {
  const { gamePhase, selectedMode, totalRounds, getConfiguredRoundCount, setGamePath } = options;

  const multiplayerSetupAction = ref<MultiplayerSetupAction>("create");
  const multiplayerPlayerName = ref("Player 1");
  const multiplayerRoomCodeInput = ref("");
  const multiplayerErrorMessage = ref("");
  const isMultiplayerBusy = ref(false);
  const isSubmittingAnswer = ref(false);
  const roomState = ref<PublicRoomState | null>(null);
  const roomEvents = ref<EventSource | null>(null);
  const roomConnectionState = ref<RoomConnectionState>("connected");
  const lastRoomEventAt = ref(0);
  const lastRoomSyncAt = ref(0);
  const lastRoomReconnectAttemptAt = ref(0);
  const isRoomSyncInFlight = ref(false);
  const now = ref(Date.now());
  const clockTimer = ref<number | null>(null);
  let roomSyncRequestId = 0;

  const normalizedJoinRoomCode = computed(() => normalizeRoomCode(multiplayerRoomCodeInput.value));

  const buildRoomPath = (roomCode: string) =>
    `${multiplayerGamePath}/${encodeURIComponent(normalizeRoomCode(roomCode))}`;

  /**
   * Fetch JSON from the multiplayer API. Non-JSON responses (e.g. an HTML
   * 502 page from a proxy) are converted into readable errors instead of
   * throwing an opaque JSON parse failure.
   */
  const requestJson = async <T>(url: string, body?: Record<string, unknown>) => {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const contentType = response.headers.get("content-type") ?? "";
    let payload: (T & { error?: string }) | null = null;

    if (contentType.includes("application/json")) {
      try {
        payload = (await response.json()) as T & { error?: string };
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      throw new Error(
        payload?.error ??
          (response.statusText
            ? `Multiplayer request failed: ${response.statusText} (${response.status}).`
            : `Multiplayer request failed (${response.status}).`),
      );
    }

    if (!payload) {
      throw new Error("Received an unexpected response from the multiplayer server.");
    }

    return payload;
  };

  function markRoomConnectionAlive() {
    lastRoomEventAt.value = Date.now();
    lastRoomReconnectAttemptAt.value = 0;
    roomConnectionState.value = "connected";
  }

  function resetRoomConnectionState() {
    roomSyncRequestId += 1;
    roomConnectionState.value = "connected";
    lastRoomEventAt.value = 0;
    lastRoomSyncAt.value = 0;
    lastRoomReconnectAttemptAt.value = 0;
    isRoomSyncInFlight.value = false;
  }

  function applyRoomState(
    room: PublicRoomState,
    applyOptions: { replacePath?: boolean; updatePath?: boolean } = {},
  ) {
    markRoomConnectionAlive();
    roomState.value = room;
    selectedMode.value = "multiplayer";
    totalRounds.value = room.roundCount;
    gamePhase.value =
      room.status === "playing" ? "playing" : room.status === "results" ? "results" : "setup";
    multiplayerErrorMessage.value = "";

    const self = room.players.find((player) => player.id === room.playerId);

    if (self) {
      multiplayerPlayerName.value = self.name;
    }

    saveMultiplayerSession({
      playerId: room.playerId,
      playerName: self?.name ?? multiplayerPlayerName.value,
      roomCode: room.roomCode,
      updatedAt: Date.now(),
    });

    if (applyOptions.updatePath ?? true) {
      setGamePath(buildRoomPath(room.roomCode), applyOptions.replacePath ?? true);
    }
  }

  function closeRoomEvents() {
    if (roomEvents.value) {
      roomEvents.value.close();
      roomEvents.value = null;
    }
  }

  function connectRoomEvents(roomCode: string, playerId: string) {
    closeRoomEvents();

    const normalizedRoomCode = normalizeRoomCode(roomCode);
    const source = new EventSource(
      `/api/multiplayer/rooms/${encodeURIComponent(normalizedRoomCode)}/events?playerId=${encodeURIComponent(playerId)}`,
    );

    source.onopen = () => {
      markRoomConnectionAlive();
    };

    source.addEventListener("state", (event) => {
      const messageEvent = event as MessageEvent<string>;
      const nextRoomState = JSON.parse(messageEvent.data) as PublicRoomState;

      now.value = Date.now();
      markRoomConnectionAlive();
      applyRoomState(nextRoomState);
    });

    source.addEventListener("heartbeat", () => {
      markRoomConnectionAlive();
    });

    source.onerror = () => {
      if (
        roomState.value?.roomCode === normalizedRoomCode &&
        roomState.value.playerId === playerId
      ) {
        roomConnectionState.value = navigator.onLine ? "reconnecting" : "offline";
      }
    };

    if (!lastRoomEventAt.value) {
      lastRoomEventAt.value = Date.now();
    }

    roomEvents.value = source;
  }

  async function syncCurrentRoomState() {
    const room = roomState.value;

    if (!room || isRoomSyncInFlight.value) {
      return;
    }

    const roomCode = room.roomCode;
    const playerId = room.playerId;
    const syncRequestId = (roomSyncRequestId += 1);

    isRoomSyncInFlight.value = true;
    lastRoomSyncAt.value = Date.now();

    try {
      const response = await requestJson<MultiplayerApiResponse>(
        `/api/multiplayer/rooms/${encodeURIComponent(roomCode)}?playerId=${encodeURIComponent(playerId)}`,
      );

      if (roomState.value?.roomCode !== roomCode || roomState.value.playerId !== playerId) {
        return;
      }

      applyRoomState(response.room);

      if (!roomEvents.value || roomEvents.value.readyState === EventSource.CLOSED) {
        connectRoomEvents(response.room.roomCode, response.room.playerId);
      }
    } catch {
      if (roomState.value?.roomCode === roomCode && roomState.value.playerId === playerId) {
        roomConnectionState.value = navigator.onLine ? "reconnecting" : "offline";
      }
    } finally {
      if (syncRequestId === roomSyncRequestId) {
        isRoomSyncInFlight.value = false;
      }
    }
  }

  function checkRoomConnectionHealth() {
    const room = roomState.value;

    if (!room) {
      return;
    }

    const currentTime = Date.now();

    if (!navigator.onLine) {
      roomConnectionState.value = "offline";
      return;
    }

    if (!lastRoomEventAt.value) {
      lastRoomEventAt.value = currentTime;
    }

    const isConnectionStale = currentTime - lastRoomEventAt.value > roomConnectionStaleMilliseconds;
    const shouldSyncExpiredRound =
      room.status === "playing" &&
      !room.roundLocked &&
      room.roundEndsAt !== null &&
      currentTime >= room.roundEndsAt + roundDeadlineSyncGraceMilliseconds;

    if (isConnectionStale) {
      roomConnectionState.value = "reconnecting";

      if (currentTime - lastRoomReconnectAttemptAt.value > roomReconnectCooldownMilliseconds) {
        lastRoomReconnectAttemptAt.value = currentTime;
        connectRoomEvents(room.roomCode, room.playerId);
      }
    }

    if (
      (isConnectionStale || shouldSyncExpiredRound) &&
      currentTime - lastRoomSyncAt.value > roomSyncIntervalMilliseconds
    ) {
      void syncCurrentRoomState();
    }
  }

  function stopClockTimer() {
    if (clockTimer.value !== null) {
      window.clearInterval(clockTimer.value);
      clockTimer.value = null;
    }
  }

  function startClockTimer() {
    if (clockTimer.value !== null) {
      return;
    }

    now.value = Date.now();
    clockTimer.value = window.setInterval(() => {
      now.value = Date.now();
      checkRoomConnectionHealth();
    }, clockTickMilliseconds);
  }

  // The 250 ms clock only needs to tick while a multiplayer room is active;
  // solo games and the setup screen use their own 1 s round timer.
  watch(roomState, (room) => {
    if (room) {
      startClockTimer();
    } else {
      stopClockTimer();
    }
  });

  /** Drop all local room state without notifying the server. */
  function detachRoom() {
    closeRoomEvents();
    resetRoomConnectionState();
    roomState.value = null;
  }

  function showJoinRoomFromPath(roomCode: string, message?: string) {
    detachRoom();
    selectedMode.value = "multiplayer";
    multiplayerSetupAction.value = "join";
    multiplayerRoomCodeInput.value = normalizeRoomCode(roomCode);
    gamePhase.value = "setup";
    multiplayerErrorMessage.value =
      message ?? `Room ${normalizeRoomCode(roomCode)} is ready. Enter your name to join.`;
  }

  async function restoreServerRoomFromRoute(roomCode: string, explicitPlayerId: string | null) {
    const normalizedRoomCode = normalizeRoomCode(roomCode);
    const storedSession = getStoredMultiplayerSession(normalizedRoomCode);
    const playerId = explicitPlayerId ?? storedSession?.playerId ?? null;

    if (!playerId) {
      showJoinRoomFromPath(normalizedRoomCode);
      return;
    }

    if (roomState.value?.roomCode === normalizedRoomCode && roomState.value.playerId === playerId) {
      if (!roomEvents.value) {
        connectRoomEvents(normalizedRoomCode, playerId);
      }

      return;
    }

    isMultiplayerBusy.value = true;
    selectedMode.value = "multiplayer";
    multiplayerSetupAction.value = "join";
    multiplayerRoomCodeInput.value = normalizedRoomCode;
    multiplayerErrorMessage.value = "Rejoining multiplayer room…";

    try {
      const response = await requestJson<MultiplayerApiResponse>(
        `/api/multiplayer/rooms/${encodeURIComponent(normalizedRoomCode)}?playerId=${encodeURIComponent(playerId)}`,
      );

      applyRoomState(response.room, { replacePath: true });
      connectRoomEvents(response.room.roomCode, response.room.playerId);
    } catch (error) {
      removeMultiplayerSession(normalizedRoomCode);
      showJoinRoomFromPath(
        normalizedRoomCode,
        error instanceof Error
          ? `${error.message} Enter your name to join this room.`
          : "Could not rejoin that room. Enter your name to join.",
      );
    } finally {
      isMultiplayerBusy.value = false;
    }
  }

  const handleBrowserOffline = () => {
    if (roomState.value) {
      roomConnectionState.value = "offline";
    }
  };

  const handleBrowserOnline = () => {
    const room = roomState.value;

    if (!room) {
      return;
    }

    roomConnectionState.value = "reconnecting";
    connectRoomEvents(room.roomCode, room.playerId);
    void syncCurrentRoomState();
  };

  async function createServerRoom() {
    if (isMultiplayerBusy.value) {
      return;
    }

    isMultiplayerBusy.value = true;
    multiplayerErrorMessage.value = "";

    try {
      const response = await requestJson<MultiplayerApiResponse>("/api/multiplayer/rooms", {
        playerName: multiplayerPlayerName.value,
        rounds: getConfiguredRoundCount(),
      });

      applyRoomState(response.room, { replacePath: false });
      connectRoomEvents(response.room.roomCode, response.playerId ?? response.room.playerId);
    } catch (error) {
      multiplayerErrorMessage.value =
        error instanceof Error ? error.message : "Could not create a room.";
    } finally {
      isMultiplayerBusy.value = false;
    }
  }

  async function joinServerRoom() {
    if (isMultiplayerBusy.value) {
      return;
    }

    const roomCode = normalizedJoinRoomCode.value;

    if (!roomCode) {
      multiplayerErrorMessage.value = "Enter a room code to join.";
      return;
    }

    isMultiplayerBusy.value = true;
    multiplayerErrorMessage.value = "";

    try {
      const response = await requestJson<MultiplayerApiResponse>(
        `/api/multiplayer/rooms/${encodeURIComponent(roomCode)}/join`,
        {
          playerName: multiplayerPlayerName.value,
        },
      );

      applyRoomState(response.room, { replacePath: false });
      connectRoomEvents(response.room.roomCode, response.playerId ?? response.room.playerId);
    } catch (error) {
      multiplayerErrorMessage.value =
        error instanceof Error ? error.message : "Could not join the room.";
    } finally {
      isMultiplayerBusy.value = false;
    }
  }

  /** Returns true when the room was started successfully. */
  async function startServerRoom() {
    const room = roomState.value;

    if (!room || isMultiplayerBusy.value) {
      return false;
    }

    isMultiplayerBusy.value = true;
    multiplayerErrorMessage.value = "";

    try {
      const response = await requestJson<MultiplayerApiResponse>(
        `/api/multiplayer/rooms/${encodeURIComponent(room.roomCode)}/start`,
        {
          playerId: room.playerId,
        },
      );

      applyRoomState(response.room);

      return true;
    } catch (error) {
      multiplayerErrorMessage.value =
        error instanceof Error ? error.message : "Could not start the room.";

      return false;
    } finally {
      isMultiplayerBusy.value = false;
    }
  }

  async function submitServerAnswer(countryId: string | null) {
    const room = roomState.value;

    if (!room || isSubmittingAnswer.value) {
      return;
    }

    isSubmittingAnswer.value = true;
    multiplayerErrorMessage.value = "";

    try {
      const action = countryId ? "guess" : "skip";
      const response = await requestJson<MultiplayerApiResponse>(
        `/api/multiplayer/rooms/${encodeURIComponent(room.roomCode)}/${action}`,
        {
          playerId: room.playerId,
          countryId,
        },
      );

      applyRoomState(response.room);
    } catch (error) {
      multiplayerErrorMessage.value =
        error instanceof Error ? error.message : "Could not submit your answer.";
    } finally {
      isSubmittingAnswer.value = false;
    }
  }

  async function leaveServerRoom() {
    const room = roomState.value;

    detachRoom();
    multiplayerErrorMessage.value = "";
    gamePhase.value = "setup";
    setGamePath(multiplayerGamePath);

    if (!room) {
      return;
    }

    removeMultiplayerSession(room.roomCode);

    try {
      await requestJson(`/api/multiplayer/rooms/${encodeURIComponent(room.roomCode)}/leave`, {
        playerId: room.playerId,
      });
    } catch {
      // The room may already be gone; leaving is best-effort from the client.
    }
  }

  window.addEventListener("offline", handleBrowserOffline);
  window.addEventListener("online", handleBrowserOnline);

  onUnmounted(() => {
    window.removeEventListener("offline", handleBrowserOffline);
    window.removeEventListener("online", handleBrowserOnline);
    stopClockTimer();
    closeRoomEvents();
    resetRoomConnectionState();
  });

  return {
    createServerRoom,
    detachRoom,
    isMultiplayerBusy,
    isRoomSyncInFlight,
    isSubmittingAnswer,
    joinServerRoom,
    leaveServerRoom,
    multiplayerErrorMessage,
    multiplayerPlayerName,
    multiplayerRoomCodeInput,
    multiplayerSetupAction,
    now,
    restoreServerRoomFromRoute,
    roomConnectionState,
    roomState,
    startServerRoom,
    submitServerAnswer,
    syncCurrentRoomState,
  };
};
