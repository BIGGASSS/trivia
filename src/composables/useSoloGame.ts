/**
 * Solo game engine: round lifecycle, timers, scoring, and streaks. Logic
 * moved verbatim from the original WorldMap component. Cross-cutting
 * concerns (routing, multiplayer teardown, map zoom reset) stay in the
 * orchestrating component.
 */
import { computed, ref } from "vue";
import type { Ref, ShallowRef } from "vue";
import { defaultRoundCount, roundDurationSeconds } from "@shared/game-constants";
import { clamp } from "@shared/game-utils";
import type {
  RoundCountry,
  RoundPerformance,
  RoundPerformanceOutcome,
} from "@shared/multiplayer-types";
import type { AnswerState } from "@shared/multiplayer-types";
import type { CountryPath, GamePhase, Player } from "@/types/game";
import { missedCountryRevealRoundDelayMilliseconds } from "@/composables/useRevealZoom";

export const useSoloGame = (
  countries: ShallowRef<CountryPath[]>,
  gamePhase: Ref<GamePhase>,
  errorMessage: Ref<string>,
) => {
  const maximumRoundCount = computed(() => Math.max(1, countries.value.length));
  const currentCountry = ref<CountryPath | null>(null);
  const roundCountSetting = ref(defaultRoundCount);
  const totalRounds = ref(defaultRoundCount);
  const soloCurrentRound = ref(0);
  const soloRoundCountries = ref<RoundCountry[]>([]);
  const soloUsedCountryIds = ref<Set<string>>(new Set());
  const soloPlayer = ref<Player>({
    id: "solo-player",
    name: "Solo Player",
    score: 0,
    attempts: 0,
    streak: 0,
    roundPerformance: [],
  });
  const soloTimeLeft = ref(roundDurationSeconds);
  const feedbackMessage = ref("Configure a game to begin.");
  const answerState = ref<AnswerState>("idle");
  const lastSelectedCountryId = ref<string | null>(null);
  const isRoundLocked = ref(false);
  const nextRoundTimeout = ref<number | null>(null);
  const roundTimer = ref<number | null>(null);

  function clearPendingRound() {
    if (nextRoundTimeout.value !== null) {
      window.clearTimeout(nextRoundTimeout.value);
      nextRoundTimeout.value = null;
    }
  }

  function clearRoundTimer() {
    if (roundTimer.value !== null) {
      window.clearInterval(roundTimer.value);
      roundTimer.value = null;
    }
  }

  const getRandomCountry = (excludedCountryId?: string) => {
    let availableChoices = countries.value.filter(
      (country) => !soloUsedCountryIds.value.has(country.id),
    );

    if (availableChoices.length === 0) {
      soloUsedCountryIds.value = new Set();
      availableChoices = excludedCountryId
        ? countries.value.filter((country) => country.id !== excludedCountryId)
        : countries.value;
    }

    if (availableChoices.length === 0) {
      availableChoices = countries.value;
    }

    const randomIndex = Math.floor(Math.random() * availableChoices.length);
    const country = availableChoices[randomIndex];

    if (country) {
      soloUsedCountryIds.value.add(country.id);
    }

    return country ?? null;
  };

  const getConfiguredRoundCount = () => {
    const numericRoundCount = Number(roundCountSetting.value) || defaultRoundCount;
    const clampedRoundCount = clamp(Math.round(numericRoundCount), 1, maximumRoundCount.value);

    roundCountSetting.value = clampedRoundCount;

    return clampedRoundCount;
  };

  function resetSoloPlayer() {
    soloPlayer.value = {
      id: "solo-player",
      name: "Solo Player",
      score: 0,
      attempts: 0,
      streak: 0,
      roundPerformance: [],
    };
  }

  function finishSoloGame() {
    clearPendingRound();
    clearRoundTimer();
    gamePhase.value = "results";
    currentCountry.value = null;
    isRoundLocked.value = true;
    answerState.value = "idle";
    feedbackMessage.value = "Game over! Check the leaderboard.";
  }

  function scheduleNextSoloRound(delay: number) {
    clearPendingRound();

    nextRoundTimeout.value = window.setTimeout(() => {
      if (soloCurrentRound.value >= totalRounds.value) {
        finishSoloGame();
        return;
      }

      startSoloRound();
    }, delay);
  }

  function recordSoloRoundPerformance(outcome: RoundPerformanceOutcome) {
    const existingIndex = soloPlayer.value.roundPerformance.findIndex(
      (performance) => performance.round === soloCurrentRound.value,
    );
    const roundPerformance = {
      round: soloCurrentRound.value,
      outcome,
    } satisfies RoundPerformance;

    if (existingIndex >= 0) {
      soloPlayer.value.roundPerformance[existingIndex] = roundPerformance;
      return;
    }

    soloPlayer.value.roundPerformance.push(roundPerformance);
  }

  function recordSoloRoundCountry(round: number, country: CountryPath) {
    const existingIndex = soloRoundCountries.value.findIndex(
      (roundCountry) => roundCountry.round === round,
    );
    const roundCountry = {
      round,
      countryName: country.name,
    } satisfies RoundCountry;

    if (existingIndex >= 0) {
      soloRoundCountries.value[existingIndex] = roundCountry;
      return;
    }

    soloRoundCountries.value.push(roundCountry);
    soloRoundCountries.value.sort(
      (firstRound, secondRound) => firstRound.round - secondRound.round,
    );
  }

  function resolveSoloRound(
    isCorrect: boolean,
    feedback: string,
    delay: number,
    outcome: RoundPerformanceOutcome = isCorrect ? "correct" : "incorrect",
  ) {
    if (!currentCountry.value || isRoundLocked.value || gamePhase.value !== "playing") {
      return;
    }

    clearRoundTimer();
    isRoundLocked.value = true;
    answerState.value = isCorrect ? "correct" : "incorrect";
    feedbackMessage.value = feedback;
    soloPlayer.value.attempts += 1;
    recordSoloRoundPerformance(outcome);

    if (isCorrect) {
      soloPlayer.value.score += 1;
      soloPlayer.value.streak += 1;
    } else {
      soloPlayer.value.streak = 0;
    }

    scheduleNextSoloRound(delay);
  }

  function handleSoloRoundTimeout() {
    if (!currentCountry.value || isRoundLocked.value || gamePhase.value !== "playing") {
      return;
    }

    lastSelectedCountryId.value = null;
    resolveSoloRound(
      false,
      `Time's up! The correct answer was ${currentCountry.value.name}.`,
      missedCountryRevealRoundDelayMilliseconds,
      "timeout",
    );
  }

  function startSoloRoundTimer() {
    clearRoundTimer();
    soloTimeLeft.value = roundDurationSeconds;

    roundTimer.value = window.setInterval(() => {
      if (gamePhase.value !== "playing" || isRoundLocked.value) {
        return;
      }

      soloTimeLeft.value = Math.max(0, soloTimeLeft.value - 1);

      if (soloTimeLeft.value === 0) {
        handleSoloRoundTimeout();
      }
    }, 1000);
  }

  function startSoloRound() {
    clearPendingRound();
    clearRoundTimer();

    if (soloCurrentRound.value >= totalRounds.value) {
      finishSoloGame();
      return;
    }

    const country = getRandomCountry(currentCountry.value?.id);

    if (!country) {
      errorMessage.value = "No country data is available for this game.";
      gamePhase.value = "setup";
      return;
    }

    soloCurrentRound.value += 1;
    currentCountry.value = country;
    recordSoloRoundCountry(soloCurrentRound.value, country);
    answerState.value = "idle";
    lastSelectedCountryId.value = null;
    isRoundLocked.value = false;
    soloTimeLeft.value = roundDurationSeconds;
    feedbackMessage.value = `Click ${country.name} before the timer runs out.`;
    startSoloRoundTimer();
  }

  /** Start a fresh solo game. The caller is responsible for route changes,
   *  multiplayer teardown, and resetting the map zoom. */
  function startGame() {
    clearPendingRound();
    clearRoundTimer();
    resetSoloPlayer();
    totalRounds.value = getConfiguredRoundCount();
    soloCurrentRound.value = 0;
    soloRoundCountries.value = [];
    soloUsedCountryIds.value = new Set();
    currentCountry.value = null;
    answerState.value = "idle";
    lastSelectedCountryId.value = null;
    isRoundLocked.value = false;
    soloTimeLeft.value = roundDurationSeconds;
    feedbackMessage.value = "Click the prompted country on the map.";
    gamePhase.value = "playing";
    startSoloRound();
  }

  /** Reset back to the setup screen. The caller handles route changes. */
  function resetToSetup() {
    clearPendingRound();
    clearRoundTimer();
    gamePhase.value = "setup";
    soloCurrentRound.value = 0;
    soloRoundCountries.value = [];
    soloUsedCountryIds.value = new Set();
    currentCountry.value = null;
    answerState.value = "idle";
    lastSelectedCountryId.value = null;
    isRoundLocked.value = false;
    soloTimeLeft.value = roundDurationSeconds;
    feedbackMessage.value = "Configure a game to begin.";
  }

  const handleGuess = (country: CountryPath) => {
    if (!currentCountry.value || isRoundLocked.value || gamePhase.value !== "playing") {
      return;
    }

    lastSelectedCountryId.value = country.id;

    if (country.id === currentCountry.value.id) {
      resolveSoloRound(true, `Correct! That was ${country.name}.`, 900);
      return;
    }

    resolveSoloRound(
      false,
      `Not quite — that was ${country.name}. The correct answer was ${currentCountry.value.name}.`,
      missedCountryRevealRoundDelayMilliseconds,
    );
  };

  const skip = () => {
    if (!currentCountry.value || isRoundLocked.value || gamePhase.value !== "playing") {
      return;
    }

    lastSelectedCountryId.value = null;
    resolveSoloRound(
      false,
      `Skipped. The correct answer was ${currentCountry.value.name}.`,
      missedCountryRevealRoundDelayMilliseconds,
      "skipped",
    );
  };

  const teardown = () => {
    clearPendingRound();
    clearRoundTimer();
  };

  return {
    answerState,
    currentCountry,
    feedbackMessage,
    getConfiguredRoundCount,
    handleGuess,
    isRoundLocked,
    lastSelectedCountryId,
    maximumRoundCount,
    resetToSetup,
    roundCountSetting,
    skip,
    soloCurrentRound,
    soloPlayer,
    soloRoundCountries,
    soloTimeLeft,
    startGame,
    teardown,
    totalRounds,
  };
};
