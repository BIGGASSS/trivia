/** Multiplayer REST/SSE client with private sessions and ordered, cancellable state updates. */
import { computed, onUnmounted, ref, shallowRef, watch } from "vue";
import type { Ref } from "vue";
import { multiplayerGamePath } from "@shared/game-constants";
import { normalizeRoomCode } from "@shared/game-utils";
import type { MultiplayerApiResponse, PublicRoomState } from "@shared/multiplayer-types";
import type { GameMode, GamePhase, MultiplayerSetupAction } from "@/types/game";
import {
  getStoredMultiplayerSession,
  getPendingMultiplayerJoin,
  savePendingMultiplayerJoin,
  removePendingMultiplayerJoin,
  removeMultiplayerSession,
  saveMultiplayerSession,
} from "@/utils/multiplayer-session";

const roomConnectionStaleMilliseconds = 6500;
const roomSyncIntervalMilliseconds = 2000;
const roomReconnectCooldownMilliseconds = 4000;
const roundDeadlineSyncGraceMilliseconds = 250;
const clockTickMilliseconds = 250;

export type RoomConnectionState = "connected" | "reconnecting" | "offline";

class MultiplayerStateError extends Error {}

class MultiplayerRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const isInvalidSession = (error: unknown): error is MultiplayerRequestError =>
  error instanceof MultiplayerRequestError && [401, 403, 404, 410].includes(error.status);

export interface MultiplayerRoomOptions {
  gamePhase: Ref<GamePhase>;
  selectedMode: Ref<GameMode>;
  totalRounds: Ref<number>;
  getConfiguredRoundCount: () => number;
  setGamePath: (path: string, replace?: boolean) => void;
}

interface RoomSession {
  roomCode: string;
  playerId: string;
  sessionToken: string;
}

export const useMultiplayerRoom = (options: MultiplayerRoomOptions) => {
  const { gamePhase, selectedMode, totalRounds, getConfiguredRoundCount, setGamePath } = options;
  const multiplayerSetupAction = ref<MultiplayerSetupAction>("create");
  const multiplayerPlayerName = ref("Player 1");
  const multiplayerRoomCodeInput = ref("");
  const multiplayerErrorMessage = ref("");
  const isMultiplayerBusy = ref(false);
  const isSubmittingAnswer = ref(false);
  const canRetryLeave = ref(false);
  const roomState = ref<PublicRoomState | null>(null);
  const roomEvents = shallowRef<EventSource | null>(null);
  const roomConnectionState = ref<RoomConnectionState>("connected");
  const isRoomSyncInFlight = ref(false);
  const now = ref(Date.now());
  const retryRoomCode = ref<string | null>(null);
  const normalizedJoinRoomCode = computed(() => normalizeRoomCode(multiplayerRoomCodeInput.value));
  const canRetryRejoin = computed(() => retryRoomCode.value === normalizedJoinRoomCode.value);
  let session: RoomSession | null = null;
  let generation = 0;
  let isLeavingRoom = false;
  let answerRequestId = 0;
  const requests = new Set<AbortController>();
  let clockTimer: number | null = null;
  let lastRoomEventAt = 0;
  let lastRoomSyncAt = 0;
  let lastRoomReconnectAttemptAt = 0;
  let needsRoomResync = false;
  let serverClockAnchor: { time: number; receivedAt: number } | null = null;
  const adjustedNow = () =>
    serverClockAnchor
      ? serverClockAnchor.time + performance.now() - serverClockAnchor.receivedAt
      : Date.now();
  function updateServerClock(serverNow: number) {
    if (!Number.isFinite(serverNow)) throw new Error("Invalid multiplayer server timestamp.");
    serverClockAnchor = { time: serverNow, receivedAt: performance.now() };
    now.value = adjustedNow();
  }

  const roomApiPath = (roomCode: string) =>
    `/api/multiplayer/rooms/${encodeURIComponent(normalizeRoomCode(roomCode))}`;
  const sessionQuery = () => `sessionToken=${encodeURIComponent(session?.sessionToken ?? "")}`;

  /** Track the entire fetch/body lifetime, not just receipt of HTTP headers. */
  const requestJson = async <T>(url: string, body?: Record<string, unknown>) => {
    const requestGeneration = generation;
    const controller = new AbortController();
    requests.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    controller.signal.addEventListener("abort", () => window.clearTimeout(timeout), { once: true });
    try {
      const response = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      let payload: (T & { error?: string }) | null = null;
      if ((response.headers.get("content-type") ?? "").includes("application/json")) {
        try {
          payload = (await response.json()) as T & { error?: string };
        } catch {
          payload = null;
        }
      }
      // Abort may race with a completed response, or be ignored by a transport.
      if (requestGeneration !== generation || controller.signal.aborted) {
        throw new DOMException("Room request cancelled.", "AbortError");
      }
      if (!response.ok) {
        throw new MultiplayerRequestError(
          response.status,
          payload?.error ?? `Multiplayer request failed (${response.status}).`,
        );
      }
      if (!payload)
        throw new MultiplayerStateError(
          "Received an unexpected response from the multiplayer server.",
        );
      return payload;
    } finally {
      window.clearTimeout(timeout);
      requests.delete(controller);
    }
  };

  function markRoomConnectionAlive() {
    lastRoomEventAt = Date.now();
    lastRoomReconnectAttemptAt = 0;
    roomConnectionState.value = "connected";
  }

  function applyRoomState(room: PublicRoomState, replacePath = true) {
    try {
      return applyValidatedRoomState(room, replacePath);
    } catch (error) {
      needsRoomResync = true;
      throw new MultiplayerStateError(
        error instanceof Error ? error.message : "Could not apply room state.",
      );
    }
  }

  function applyValidatedRoomState(room: PublicRoomState, replacePath: boolean) {
    if (
      !session ||
      !room ||
      room.roomCode !== session.roomCode ||
      room.playerId !== session.playerId ||
      !Number.isSafeInteger(room.revision) ||
      !Number.isFinite(room.serverNow) ||
      !["lobby", "playing", "results"].includes(room.status) ||
      ![
        room.roundCount,
        room.currentRound,
        room.roundDurationSeconds,
        room.maxPlayers,
        room.minPlayers,
      ].every(Number.isFinite) ||
      ![room.roundLocked, room.canStart].every((value) => typeof value === "boolean") ||
      ![room.matchId, room.roundId, room.currentCountryName, room.revealCountryId].every(
        (value) => value === null || typeof value === "string",
      ) ||
      !(room.roundEndsAt === null || Number.isFinite(room.roundEndsAt)) ||
      !Array.isArray(room.players) ||
      !room.players.every(
        (player) =>
          player &&
          typeof player.id === "string" &&
          typeof player.name === "string" &&
          [player.score, player.attempts, player.streak].every(Number.isFinite) &&
          [player.active, player.connected, player.isHost, player.hasAnswered].every(
            (value) => typeof value === "boolean",
          ) &&
          Array.isArray(player.roundPerformance) &&
          player.roundPerformance.every(
            (result) =>
              result &&
              Number.isFinite(result.round) &&
              ["correct", "incorrect", "skipped", "timeout"].includes(result.outcome),
          ),
      ) ||
      !room.players.some((player) => player.id === session?.playerId) ||
      !Array.isArray(room.roundCountries) ||
      !room.roundCountries.every(
        (country) =>
          country && Number.isFinite(country.round) && typeof country.countryName === "string",
      ) ||
      !(
        room.ownFeedback === null ||
        (room.ownFeedback &&
          ["idle", "correct", "incorrect"].includes(room.ownFeedback.state) &&
          typeof room.ownFeedback.message === "string" &&
          (room.ownFeedback.selectedCountryId === null ||
            typeof room.ownFeedback.selectedCountryId === "string"))
      )
    )
      throw new MultiplayerStateError("Received an invalid multiplayer room snapshot.");
    // HTTP snapshots and SSE can arrive in either order, including after results.
    if (roomState.value && room.revision < roomState.value.revision) return;
    updateServerClock(room.serverNow);
    if (roomState.value && room.revision === roomState.value.revision && !needsRoomResync) {
      markRoomConnectionAlive();
      return;
    }
    if (room.roundId !== roomState.value?.roundId || room.matchId !== roomState.value?.matchId) {
      answerRequestId += 1;
      isSubmittingAnswer.value = false;
    }
    roomState.value = room;
    selectedMode.value = "multiplayer";
    totalRounds.value = room.roundCount;
    gamePhase.value =
      room.status === "playing" ? "playing" : room.status === "results" ? "results" : "setup";
    if (!canRetryLeave.value) multiplayerErrorMessage.value = "";
    retryRoomCode.value = null;
    const self = room.players.find((player) => player.id === room.playerId);
    if (self) multiplayerPlayerName.value = self.name;
    saveMultiplayerSession({
      ...session,
      playerName: self?.name ?? multiplayerPlayerName.value,
      updatedAt: Date.now(),
    });
    setGamePath(`${multiplayerGamePath}/${encodeURIComponent(room.roomCode)}`, replacePath);
    needsRoomResync = false;
    markRoomConnectionAlive();
    return true;
  }

  function closeRoomEvents() {
    const source = roomEvents.value;
    roomEvents.value = null;
    source?.close();
  }

  function connectRoomEvents() {
    if (!session || isLeavingRoom) return;
    closeRoomEvents();
    const eventGeneration = generation;
    const source = new EventSource(`${roomApiPath(session.roomCode)}/events?${sessionQuery()}`);
    roomEvents.value = source;
    const isCurrent = () => eventGeneration === generation && roomEvents.value === source;
    // Opening a stream does not prove that its snapshots can be decoded/applied.
    source.addEventListener("state", (event) => {
      if (!isCurrent()) return;
      try {
        const room = JSON.parse((event as MessageEvent<string>).data) as PublicRoomState;
        applyRoomState(room);
      } catch (error) {
        recoverRoomState(error);
      }
    });
    source.addEventListener("heartbeat", (event) => {
      if (!isCurrent() || needsRoomResync) return;
      try {
        updateServerClock(JSON.parse((event as MessageEvent<string>).data));
        markRoomConnectionAlive();
      } catch (error) {
        recoverRoomState(error);
      }
    });
    source.onerror = () => {
      if (!isCurrent()) return;
      roomConnectionState.value = navigator.onLine ? "reconnecting" : "offline";
      // EventSource hides HTTP status. Confirm revoked sessions over HTTP.
      void syncCurrentRoomState();
    };
    if (!lastRoomEventAt) lastRoomEventAt = Date.now();
  }

  function recoverRoomState(error: unknown) {
    needsRoomResync = true;
    closeRoomEvents();
    roomConnectionState.value = navigator.onLine ? "reconnecting" : "offline";
    multiplayerErrorMessage.value =
      error instanceof Error ? error.message : "Could not decode room state.";
    void syncCurrentRoomState();
  }

  async function syncCurrentRoomState() {
    if (!session || isLeavingRoom || isRoomSyncInFlight.value) return;
    const roomCode = session.roomCode;
    const requestGeneration = generation;
    isRoomSyncInFlight.value = true;
    lastRoomSyncAt = Date.now();
    try {
      const response = await requestJson<MultiplayerApiResponse>(
        `${roomApiPath(roomCode)}?${sessionQuery()}`,
      );
      if (requestGeneration !== generation) return;
      applyRoomState(response.room);
      if (!roomEvents.value || roomEvents.value.readyState === EventSource.CLOSED)
        connectRoomEvents();
    } catch (error) {
      if (requestGeneration !== generation) return;
      if (isInvalidSession(error)) {
        invalidateSession(roomCode, error);
      } else {
        needsRoomResync = true;
        closeRoomEvents();
        roomConnectionState.value = navigator.onLine ? "reconnecting" : "offline";
        multiplayerErrorMessage.value =
          error instanceof Error ? error.message : "Could not sync room state.";
      }
    } finally {
      if (requestGeneration === generation) isRoomSyncInFlight.value = false;
    }
  }

  function checkRoomConnectionHealth() {
    const room = roomState.value;
    if (!room || isLeavingRoom) return;
    const currentTime = Date.now();
    if (!navigator.onLine) {
      roomConnectionState.value = "offline";
      return;
    }
    if (!lastRoomEventAt) lastRoomEventAt = currentTime;
    const isConnectionStale = currentTime - lastRoomEventAt > roomConnectionStaleMilliseconds;
    const shouldSyncExpiredRound =
      room.status === "playing" &&
      !room.roundLocked &&
      room.roundEndsAt !== null &&
      adjustedNow() >= room.roundEndsAt + roundDeadlineSyncGraceMilliseconds;
    if (isConnectionStale) {
      roomConnectionState.value = "reconnecting";
      if (currentTime - lastRoomReconnectAttemptAt > roomReconnectCooldownMilliseconds) {
        lastRoomReconnectAttemptAt = currentTime;
        connectRoomEvents();
      }
    }
    if (
      (needsRoomResync || isConnectionStale || shouldSyncExpiredRound) &&
      currentTime - lastRoomSyncAt > roomSyncIntervalMilliseconds
    ) {
      void syncCurrentRoomState();
    }
  }

  function stopClockTimer() {
    if (clockTimer !== null) window.clearInterval(clockTimer);
    clockTimer = null;
  }

  watch(roomState, (room) => {
    if (!room) {
      stopClockTimer();
    } else if (clockTimer === null) {
      now.value = adjustedNow();
      clockTimer = window.setInterval(() => {
        now.value = adjustedNow();
        checkRoomConnectionHealth();
      }, clockTickMilliseconds);
    }
  });

  /** Navigation/unmount is disconnection, not an explicit membership departure. */
  function detachRoom() {
    generation += 1;
    for (const controller of requests) controller.abort();
    requests.clear();
    closeRoomEvents();
    stopClockTimer();
    session = null;
    isLeavingRoom = false;
    canRetryLeave.value = false;
    needsRoomResync = false;
    serverClockAnchor = null;
    retryRoomCode.value = null;
    roomState.value = null;
    isMultiplayerBusy.value = false;
    isSubmittingAnswer.value = false;
    isRoomSyncInFlight.value = false;
    roomConnectionState.value = "connected";
    lastRoomEventAt = 0;
    lastRoomSyncAt = 0;
    lastRoomReconnectAttemptAt = 0;
  }

  function showJoinRoomFromPath(roomCode: string, message?: string) {
    selectedMode.value = "multiplayer";
    multiplayerSetupAction.value = "join";
    multiplayerRoomCodeInput.value = normalizeRoomCode(roomCode);
    gamePhase.value = "setup";
    multiplayerErrorMessage.value =
      message ?? `Room ${normalizeRoomCode(roomCode)} is ready. Enter your name to join.`;
  }

  function invalidateSession(roomCode: string, error: Error) {
    removeMultiplayerSession(roomCode, session?.sessionToken);
    detachRoom();
    showJoinRoomFromPath(roomCode, `${error.message} Enter your name to join this room.`);
  }

  async function restoreServerRoomFromRoute(roomCode: string) {
    const normalizedRoomCode = normalizeRoomCode(roomCode);
    if (session?.roomCode === normalizedRoomCode && roomState.value) {
      if (!roomEvents.value) connectRoomEvents();
      return;
    }
    detachRoom();
    const storedSession = getStoredMultiplayerSession(normalizedRoomCode);
    showJoinRoomFromPath(normalizedRoomCode);
    if (!storedSession) {
      const pending = getPendingMultiplayerJoin(normalizedRoomCode);
      if (pending) {
        multiplayerPlayerName.value = pending.playerName;
        await enterRoom(normalizedRoomCode);
      }
      return;
    }
    session = { ...storedSession, roomCode: normalizedRoomCode };
    multiplayerPlayerName.value = storedSession.playerName;
    const requestGeneration = generation;
    isMultiplayerBusy.value = true;
    multiplayerErrorMessage.value = "Rejoining multiplayer room…";
    try {
      const response = await requestJson<MultiplayerApiResponse>(
        `${roomApiPath(normalizedRoomCode)}?${sessionQuery()}`,
      );
      if (requestGeneration !== generation) return;
      applyRoomState(response.room);
      connectRoomEvents();
    } catch (error) {
      if (requestGeneration !== generation) return;
      if (isInvalidSession(error)) {
        invalidateSession(normalizedRoomCode, error);
      } else {
        // Offline, proxy errors, malformed responses: keep the only credential.
        retryRoomCode.value = normalizedRoomCode;
        roomConnectionState.value = navigator.onLine ? "reconnecting" : "offline";
        multiplayerErrorMessage.value = `${error instanceof Error ? error.message : "Could not rejoin."} Your session is saved. Retry rejoining when the connection returns.`;
      }
    } finally {
      if (requestGeneration === generation) isMultiplayerBusy.value = false;
    }
  }

  const handleBrowserOffline = () => {
    if (session) roomConnectionState.value = "offline";
  };
  const handleBrowserOnline = () => {
    if (
      retryRoomCode.value &&
      canRetryRejoin.value &&
      multiplayerSetupAction.value === "join" &&
      !isMultiplayerBusy.value
    ) {
      void restoreServerRoomFromRoute(retryRoomCode.value);
    } else if (roomState.value) {
      roomConnectionState.value = "reconnecting";
      connectRoomEvents();
      void syncCurrentRoomState();
    }
  };

  async function enterRoom(roomCode?: string) {
    if (isMultiplayerBusy.value) return;
    detachRoom();
    const requestGeneration = generation;
    isMultiplayerBusy.value = true;
    multiplayerErrorMessage.value = "";
    let pendingJoin = roomCode ? getPendingMultiplayerJoin(roomCode) : null;
    try {
      if (roomCode) {
        pendingJoin ??= {
          joinRequestId: crypto.randomUUID(),
          playerName: multiplayerPlayerName.value,
        };
        savePendingMultiplayerJoin(roomCode, pendingJoin);
      }
      const response = await requestJson<MultiplayerApiResponse>(
        roomCode ? `${roomApiPath(roomCode)}/join` : "/api/multiplayer/rooms",
        {
          playerName: pendingJoin?.playerName ?? multiplayerPlayerName.value,
          ...(pendingJoin
            ? { joinRequestId: pendingJoin.joinRequestId }
            : { rounds: getConfiguredRoundCount() }),
        },
      );
      if (requestGeneration !== generation) return;
      if (!response.sessionToken)
        throw new Error("The server did not return a private player session.");
      session = {
        roomCode: response.room.roomCode,
        playerId: response.room.playerId,
        sessionToken: response.sessionToken,
      };
      // Save the credential before applying state/navigation, which can itself fail.
      saveMultiplayerSession({
        ...session,
        playerName: pendingJoin?.playerName ?? multiplayerPlayerName.value,
        updatedAt: Date.now(),
      });
      if (
        roomCode &&
        pendingJoin &&
        getStoredMultiplayerSession(roomCode)?.sessionToken === session.sessionToken
      )
        removePendingMultiplayerJoin(roomCode, pendingJoin.joinRequestId);
      applyRoomState(response.room, false);
      connectRoomEvents();
    } catch (error) {
      if (requestGeneration !== generation) return;
      if (
        roomCode &&
        pendingJoin &&
        error instanceof MultiplayerRequestError &&
        [400, 401, 403, 404, 410].includes(error.status)
      )
        removePendingMultiplayerJoin(roomCode, pendingJoin.joinRequestId);
      if (session && error instanceof MultiplayerStateError) {
        // Admission succeeded: recover with the credential, never create another player.
        showJoinRoomFromPath(session.roomCode);
        retryRoomCode.value = session.roomCode;
        recoverRoomState(error);
      } else {
        multiplayerErrorMessage.value =
          error instanceof Error ? error.message : "Could not enter the room.";
      }
    } finally {
      if (requestGeneration === generation) isMultiplayerBusy.value = false;
    }
  }

  const createServerRoom = () => enterRoom();
  async function joinServerRoom() {
    if (isMultiplayerBusy.value) return;
    const roomCode = normalizedJoinRoomCode.value;
    if (!roomCode) {
      multiplayerErrorMessage.value = "Enter a room code to join.";
      return;
    }
    // Never create a duplicate player when a recoverable session already exists.
    if (getStoredMultiplayerSession(roomCode)) {
      await restoreServerRoomFromRoute(roomCode);
    } else {
      await enterRoom(roomCode);
    }
  }

  async function startServerRoom() {
    const room = roomState.value;
    if (!room || !session || isMultiplayerBusy.value) return false;
    const requestGeneration = generation;
    isMultiplayerBusy.value = true;
    multiplayerErrorMessage.value = "";
    try {
      const response = await requestJson<MultiplayerApiResponse>(
        `${roomApiPath(room.roomCode)}/start`,
        { sessionToken: session.sessionToken },
      );
      if (requestGeneration !== generation) return false;
      // Do not let a late start response reset a newer round's reveal viewport.
      return applyRoomState(response.room) ?? false;
    } catch (error) {
      if (requestGeneration === generation) {
        if (error instanceof MultiplayerStateError) recoverRoomState(error);
        multiplayerErrorMessage.value =
          error instanceof Error ? error.message : "Could not start the room.";
      }
      return false;
    } finally {
      if (requestGeneration === generation) isMultiplayerBusy.value = false;
    }
  }

  async function submitServerAnswer(countryId: string | null) {
    const room = roomState.value;
    if (!room || !session || isLeavingRoom || isSubmittingAnswer.value) return;
    const requestGeneration = generation;
    const submissionId = ++answerRequestId;
    isSubmittingAnswer.value = true;
    multiplayerErrorMessage.value = "";
    try {
      const response = await requestJson<MultiplayerApiResponse>(
        `${roomApiPath(room.roomCode)}/${countryId === null ? "skip" : "guess"}`,
        {
          sessionToken: session.sessionToken,
          matchId: room.matchId,
          roundId: room.roundId,
          countryId,
        },
      );
      if (requestGeneration === generation) applyRoomState(response.room);
    } catch (error) {
      if (
        requestGeneration === generation &&
        submissionId === answerRequestId &&
        roomState.value?.roundId === room.roundId &&
        roomState.value?.matchId === room.matchId
      ) {
        if (error instanceof MultiplayerStateError) recoverRoomState(error);
        multiplayerErrorMessage.value =
          error instanceof Error ? error.message : "Could not submit your answer.";
      }
    } finally {
      if (requestGeneration === generation && submissionId === answerRequestId)
        isSubmittingAnswer.value = false;
    }
  }

  async function leaveServerRoom() {
    if (isMultiplayerBusy.value) return false;
    const leavingSession = session;
    const leavingJoin = leavingSession ? getPendingMultiplayerJoin(leavingSession.roomCode) : null;
    // Revocation closes SSE before the leave response arrives. Retire existing work so
    // its resulting 403 cannot detach this generation and cancel the departure.
    generation += 1;
    for (const controller of requests) controller.abort();
    requests.clear();
    closeRoomEvents();
    isRoomSyncInFlight.value = false;
    isSubmittingAnswer.value = false;
    isLeavingRoom = true;
    const requestGeneration = generation;
    isMultiplayerBusy.value = true;
    multiplayerErrorMessage.value = "";
    try {
      if (leavingSession) {
        try {
          await requestJson(`${roomApiPath(leavingSession.roomCode)}/leave`, {
            sessionToken: leavingSession.sessionToken,
          });
        } catch (error) {
          if (!isInvalidSession(error)) throw error;
        }
      }
      if (requestGeneration !== generation) return false;
      if (leavingSession) {
        removeMultiplayerSession(leavingSession.roomCode, leavingSession.sessionToken);
        if (leavingJoin)
          removePendingMultiplayerJoin(leavingSession.roomCode, leavingJoin.joinRequestId);
      }
      detachRoom();
      gamePhase.value = "setup";
      setGamePath(multiplayerGamePath);
      return true;
    } catch (error) {
      if (requestGeneration === generation) {
        canRetryLeave.value = true;
        multiplayerErrorMessage.value = `${error instanceof Error ? error.message : "Could not leave room."} Your session is saved. Retry leaving the room.`;
      }
      return false;
    } finally {
      if (requestGeneration === generation) {
        isMultiplayerBusy.value = false;
        isLeavingRoom = false;
        connectRoomEvents();
      }
    }
  }

  window.addEventListener("offline", handleBrowserOffline);
  window.addEventListener("online", handleBrowserOnline);
  onUnmounted(() => {
    window.removeEventListener("offline", handleBrowserOffline);
    window.removeEventListener("online", handleBrowserOnline);
    detachRoom();
  });

  return {
    canRetryRejoin,
    canRetryLeave,
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
