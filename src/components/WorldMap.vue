<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  countryGamePath,
  multiplayerGamePath,
  roundDurationSeconds,
  soloGamePath,
} from "@shared/game-constants";
import { clamp, normalizeRoomCode } from "@shared/game-utils";
import type { AnswerState } from "@shared/multiplayer-types";
import type { CountryPath, GameMode, GamePhase, Player } from "@/types/game";
import { useCountriesData } from "@/composables/useCountriesData";
import { useMultiplayerRoom } from "@/composables/useMultiplayerRoom";
import { useSoloGame } from "@/composables/useSoloGame";
import GameHud from "@/components/country-game/GameHud.vue";
import GameSetupPanel from "@/components/country-game/GameSetupPanel.vue";
import MultiplayerLobby from "@/components/country-game/MultiplayerLobby.vue";
import ResultsLeaderboard from "@/components/country-game/ResultsLeaderboard.vue";
import WorldMapStage from "@/components/country-game/WorldMapStage.vue";
import "@/components/country-game/country-game.css";

type GameRoute =
  | { type: "setup" }
  | { type: "solo" }
  | { type: "multiplayer-setup" }
  | { type: "multiplayer-room"; roomCode: string };

const route = useRoute();
const router = useRouter();

const selectedMode = ref<GameMode>("multiplayer");
const gamePhase = ref<GamePhase>("setup");
const mapStage = ref<InstanceType<typeof WorldMapStage> | null>(null);

const { countries, isLoading, errorMessage, loadCountries } = useCountriesData();
const solo = useSoloGame(countries, gamePhase, errorMessage);
const {
  answerState,
  currentCountry,
  feedbackMessage,
  isRoundLocked,
  lastSelectedCountryId,
  maximumRoundCount,
  roundCountSetting,
  soloCurrentRound,
  soloPlayer,
  soloRoundCountries,
  soloTimeLeft,
  totalRounds,
} = solo;

// Router-backed navigation. `lastInternalPath` marks navigations that this
// component initiated so the route watcher only syncs external navigation
// (back/forward buttons, deep links).
let lastInternalPath: string | null = null;

const setGamePath = (path: string, replace = false) => {
  if (route.fullPath === path) {
    return;
  }

  lastInternalPath = path;
  void (replace ? router.replace(path) : router.push(path));
};

const multiplayer = useMultiplayerRoom({
  gamePhase,
  selectedMode,
  totalRounds: solo.totalRounds,
  getConfiguredRoundCount: solo.getConfiguredRoundCount,
  setGamePath,
});
const {
  canRetryRejoin,
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
} = multiplayer;

let isSyncingRoute = false;

const parseGameRoute = (): GameRoute => {
  const segments = route.path.split("/").filter(Boolean);

  if (segments[0] !== "country-game") {
    return { type: "setup" };
  }

  if (segments[1] === "solo") {
    return { type: "solo" };
  }

  if (segments[1] === "multiplayer") {
    const roomCode = normalizeRoomCode(segments[2] ?? "");

    if (roomCode) {
      return { type: "multiplayer-room", roomCode };
    }

    return { type: "multiplayer-setup" };
  }

  return { type: "setup" };
};

function syncRouteToState() {
  isSyncingRoute = true;

  try {
    const gameRoute = parseGameRoute();

    // Vue Router reuses this component across game routes. Abandon the solo
    // session before restoring another route, including its final reveal delay.
    if (gameRoute.type !== "multiplayer-room" || roomState.value?.roomCode !== gameRoute.roomCode) {
      solo.resetToSetup();
    }

    if (gameRoute.type === "solo") {
      detachRoom();
      selectedMode.value = "solo";
      multiplayerErrorMessage.value = "";
      return;
    }

    if (gameRoute.type === "multiplayer-room") {
      void restoreServerRoomFromRoute(gameRoute.roomCode);
      return;
    }

    if (gameRoute.type === "multiplayer-setup") {
      detachRoom();
      selectedMode.value = "multiplayer";
      multiplayerSetupAction.value = "create";
      multiplayerErrorMessage.value = "";
      return;
    }

    detachRoom();
  } finally {
    isSyncingRoute = false;
  }
}

watch(
  () => route.fullPath,
  (fullPath) => {
    if (fullPath === lastInternalPath) {
      lastInternalPath = null;
      return;
    }

    lastInternalPath = null;

    if (!route.path.startsWith(countryGamePath)) {
      return;
    }

    void syncRouteToState();
  },
);

const isServerMultiplayerActive = computed(() => roomState.value !== null);
const isPlayingGame = computed(
  () =>
    roomState.value?.status === "playing" || (!roomState.value && gamePhase.value === "playing"),
);
const multiplayerConnectionMessage = computed(() => {
  if (!roomState.value || roomConnectionState.value === "connected") {
    return "";
  }

  if (roomConnectionState.value === "offline") {
    return "You're offline. The room will resync automatically when the connection returns.";
  }

  return isRoomSyncInFlight.value
    ? "Connection hiccup detected. Resyncing room state…"
    : "Live room updates paused. Reconnecting automatically…";
});
const multiplayerSelf = computed(() => {
  const room = roomState.value;

  if (!room) {
    return null;
  }

  return room.players.find((player) => player.id === room.playerId) ?? null;
});
const isMultiplayerHost = computed(() => roomState.value?.hostId === roomState.value?.playerId);
const activeRoomPlayers = computed(
  () => roomState.value?.players.filter((player) => player.active) ?? [],
);
const answeredPlayersCount = computed(
  () => activeRoomPlayers.value.filter((player) => player.hasAnswered).length,
);
const displayPlayers = computed<Player[]>(() => {
  if (roomState.value) {
    return roomState.value.players;
  }

  return [soloPlayer.value];
});
const scoreboardPlayer = computed<Player>(() =>
  multiplayerSelf.value ? multiplayerSelf.value : soloPlayer.value,
);
const displayRoundCount = computed(() => roomState.value?.roundCount ?? totalRounds.value);
const displayRoundDurationSeconds = computed(
  () => roomState.value?.roundDurationSeconds ?? roundDurationSeconds,
);

const currentRoundNumber = computed(() => {
  if (roomState.value) {
    return Math.max(1, roomState.value.currentRound || 1);
  }

  return Math.max(1, soloCurrentRound.value || 1);
});

const targetCountryName = computed(() => {
  if (roomState.value) {
    return roomState.value.currentCountryName;
  }

  return currentCountry.value?.name ?? null;
});

const activeAccuracy = computed(() => {
  const player = scoreboardPlayer.value;

  if (player.attempts === 0) {
    return "0%";
  }

  return `${Math.round((player.score / player.attempts) * 100)}%`;
});

const roundSummary = computed(() => {
  if (roomState.value) {
    if (roomState.value.status === "lobby") {
      return `${roomState.value.players.length} of ${roomState.value.maxPlayers} players joined`;
    }

    if (roomState.value.status === "results") {
      return `${roomState.value.roundCount} rounds complete`;
    }

    return `Round ${roomState.value.currentRound} of ${roomState.value.roundCount}`;
  }

  return `Round ${currentRoundNumber.value} of ${totalRounds.value}`;
});

const answeredSummary = computed(() => {
  if (roomState.value?.status !== "playing") {
    return "";
  }

  return `${answeredPlayersCount.value} of ${activeRoomPlayers.value.length} players answered`;
});

const displayTimeLeft = computed(() => {
  const room = roomState.value;

  if (!room || room.status !== "playing") {
    return soloTimeLeft.value;
  }

  if (room.roundLocked || !room.roundEndsAt) {
    return 0;
  }

  return clamp(Math.ceil((room.roundEndsAt - now.value) / 1000), 0, room.roundDurationSeconds);
});

const timerPercent = computed(() => {
  const clampedTime = clamp(displayTimeLeft.value, 0, displayRoundDurationSeconds.value);

  return `${(clampedTime / displayRoundDurationSeconds.value) * 100}%`;
});

const timerIsLow = computed(
  () =>
    (roomState.value?.status === "playing" || gamePhase.value === "playing") &&
    !displayRoundLocked.value &&
    displayTimeLeft.value <= 3,
);

const displayAnswerState = computed<AnswerState>(() => {
  if (roomState.value) {
    return roomState.value.ownFeedback?.state ?? "idle";
  }

  return answerState.value;
});

const displayFeedbackMessage = computed(() => {
  const room = roomState.value;

  if (!room) {
    return feedbackMessage.value;
  }

  if (room.status === "lobby") {
    return isMultiplayerHost.value
      ? "Share the room code, then start when everyone has joined."
      : "Waiting for the host to start the match.";
  }

  if (room.status === "results") {
    return "Match finished. See the final standings.";
  }

  if (displayTimeLeft.value <= 0 && !room.roundLocked) {
    return "Round ended. Syncing the reveal…";
  }

  if (room.ownFeedback) {
    return room.ownFeedback.message;
  }

  if (multiplayerSelf.value?.hasAnswered) {
    return "Answer submitted. Waiting for the round reveal.";
  }

  return "Click it on the map. Drag to pan, scroll or pinch to zoom.";
});

const displaySelectedCountryId = computed(() => {
  if (roomState.value) {
    return roomState.value.ownFeedback?.selectedCountryId ?? null;
  }

  return lastSelectedCountryId.value;
});

const missedTargetCountryId = computed(() => {
  if (roomState.value) {
    return displayAnswerState.value === "incorrect" ? roomState.value.revealCountryId : null;
  }

  return displayAnswerState.value === "incorrect" ? (currentCountry.value?.id ?? null) : null;
});

const displayRoundLocked = computed(() => {
  if (roomState.value) {
    return roomState.value.roundLocked || (multiplayerSelf.value?.hasAnswered ?? false);
  }

  return isRoundLocked.value;
});

const isMapGuessingDisabled = computed(() => {
  if (roomState.value) {
    return (
      roomState.value.status !== "playing" ||
      roomState.value.roundLocked ||
      displayTimeLeft.value <= 0 ||
      (multiplayerSelf.value?.hasAnswered ?? false) ||
      isSubmittingAnswer.value
    );
  }

  return !currentCountry.value || isRoundLocked.value || gamePhase.value !== "playing";
});

const displayRoundCountries = computed(() =>
  roomState.value ? roomState.value.roundCountries : soloRoundCountries.value,
);

const revealTarget = computed(() => {
  const countryId = missedTargetCountryId.value;

  if (!countryId || gamePhase.value !== "playing") {
    return null;
  }

  const roomCode = roomState.value?.roomCode ?? "solo";
  const playerId = roomState.value?.playerId ?? "solo";

  return {
    key: `${roomCode}:${playerId}:${currentRoundNumber.value}:${countryId}`,
    countryId,
  };
});

const startSoloGame = () => {
  if (isLoading.value || errorMessage.value || countries.value.length === 0) {
    return;
  }

  setGamePath(soloGamePath);
  detachRoom();
  mapStage.value?.resetZoom();
  solo.startGame();
};

const resetSoloSetup = () => {
  setGamePath(countryGamePath);
  solo.resetToSetup();
};

const handleStartRoom = async () => {
  const started = await startServerRoom();

  if (started) {
    mapStage.value?.resetZoom();
  }
};

const handleCountryGuess = (country: CountryPath) => {
  if (roomState.value) {
    if (isMapGuessingDisabled.value) {
      return;
    }

    void submitServerAnswer(country.id);
    return;
  }

  solo.handleGuess(country);
};

const skipCountry = () => {
  if (roomState.value) {
    if (isMapGuessingDisabled.value) {
      return;
    }

    void submitServerAnswer(null);
    return;
  }

  solo.skip();
};

const resetGame = () => {
  if (roomState.value) {
    void handleStartRoom();
    return;
  }

  startSoloGame();
};

const returnToSetup = () => {
  if (roomState.value) {
    void leaveServerRoom();
    return;
  }

  resetSoloSetup();
};

watch(
  selectedMode,
  (mode) => {
    if (isSyncingRoute || roomState.value || gamePhase.value !== "setup") {
      return;
    }

    detachRoom();
    setGamePath(mode === "solo" ? soloGamePath : multiplayerGamePath);
  },
  { flush: "sync" },
);

onMounted(() => {
  void loadCountries();
  void syncRouteToState();
});

onUnmounted(() => {
  solo.teardown();
});
</script>

<template>
  <section
    class="map-panel"
    :class="{ 'map-panel--playing': isPlayingGame }"
    aria-label="Country guessing minigame"
  >
    <div v-if="isLoading" class="map-message">Loading map…</div>
    <div v-else-if="errorMessage" class="map-message map-message--error" role="alert">
      {{ errorMessage }}
    </div>

    <template v-else>
      <GameSetupPanel
        v-if="!roomState && gamePhase === 'setup'"
        v-model:selected-mode="selectedMode"
        v-model:round-count-setting="roundCountSetting"
        v-model:setup-action="multiplayerSetupAction"
        v-model:player-name="multiplayerPlayerName"
        v-model:room-code-input="multiplayerRoomCodeInput"
        :maximum-round-count="maximumRoundCount"
        :error-message="multiplayerErrorMessage"
        :is-busy="isMultiplayerBusy"
        :can-retry-rejoin="canRetryRejoin"
        @start-solo="startSoloGame"
        @create-room="createServerRoom"
        @join-room="joinServerRoom"
      />

      <MultiplayerLobby
        v-else-if="roomState?.status === 'lobby'"
        :room="roomState"
        :status-message="displayFeedbackMessage"
        :error-message="multiplayerErrorMessage"
        :connection-message="multiplayerConnectionMessage"
        :is-host="isMultiplayerHost"
        :is-busy="isMultiplayerBusy"
        @start="handleStartRoom"
        @leave="leaveServerRoom"
      />

      <template v-else-if="isPlayingGame">
        <GameHud
          :is-multiplayer="isServerMultiplayerActive"
          :self-name="multiplayerSelf?.name ?? null"
          :target-country-name="targetCountryName"
          :round-summary="roundSummary"
          :answered-summary="answeredSummary"
          :time-left="displayTimeLeft"
          :timer-percent="timerPercent"
          :timer-is-low="timerIsLow"
          :answer-state="displayAnswerState"
          :feedback-message="displayFeedbackMessage"
          :error-message="multiplayerErrorMessage"
          :connection-message="multiplayerConnectionMessage"
          :scoreboard-player="scoreboardPlayer"
          :accuracy="activeAccuracy"
          :guessing-disabled="isMapGuessingDisabled"
          :is-syncing="isRoomSyncInFlight"
          :room="roomState"
          :current-round-number="currentRoundNumber"
          @skip="skipCountry"
          @reset="resetGame"
          @resync="syncCurrentRoomState"
          @leave="returnToSetup"
        />

        <WorldMapStage
          ref="mapStage"
          :countries="countries"
          :selected-country-id="displaySelectedCountryId"
          :answer-state="displayAnswerState"
          :missed-target-country-id="missedTargetCountryId"
          :guessing-disabled="isMapGuessingDisabled"
          :reveal-target="revealTarget"
          @country-guess="handleCountryGuess"
        />
      </template>

      <ResultsLeaderboard
        v-else
        :players="displayPlayers"
        :round-count="displayRoundCount"
        :round-duration-seconds="displayRoundDurationSeconds"
        :round-countries="displayRoundCountries"
        :is-multiplayer="isServerMultiplayerActive"
        :is-host="isMultiplayerHost"
        :is-busy="isMultiplayerBusy"
        :error-message="multiplayerErrorMessage"
        :connection-message="multiplayerConnectionMessage"
        @play-again="resetGame"
        @change-setup="returnToSetup"
      />
    </template>
  </section>
</template>

<style scoped>
.map-panel {
  display: grid;
  align-content: start;
  justify-items: start;
  width: min(100%, 76rem);
  margin: 0 auto;
  padding-block: clamp(1rem, 4vh, 3rem) clamp(2rem, 6vh, 4rem);
}

.map-panel--playing {
  align-content: stretch;
  justify-items: stretch;
  width: 100%;
  grid-template-columns: minmax(17rem, 22rem) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  gap: clamp(0.75rem, 1.5vw, 1.25rem);
  height: calc(100dvh - 5rem);
  min-height: 30rem;
  padding: 0;
  overflow: hidden;
}

.map-message {
  display: grid;
  width: 100%;
  min-height: min(60vh, 32rem);
  place-items: center;
  color: var(--text-muted);
  font-size: var(--step-1);
}

.map-message--error {
  color: var(--wrong);
}

@media (max-width: 820px) {
  .map-panel--playing {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto auto;
    height: auto;
    min-height: 0;
    overflow: visible;
  }
}
</style>
