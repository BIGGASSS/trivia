<script setup lang="ts">
import { computed } from "vue";
import type { RoundCountry, RoundPerformanceOutcome } from "@shared/multiplayer-types";
import type { MultiplayerPlayer, Player } from "@/types/game";

type RoundPerformanceDisplayState = RoundPerformanceOutcome | "empty";

interface LeaderboardPlayer extends Player {
  accuracyLabel: string;
  accuracyValue: number;
  connected?: boolean;
  hasAnswered?: boolean;
  isHost?: boolean;
  originalIndex: number;
}

const props = defineProps<{
  players: Player[];
  roundCount: number;
  roundDurationSeconds: number;
  roundCountries: RoundCountry[];
  isMultiplayer: boolean;
  isHost: boolean;
  isBusy: boolean;
  errorMessage: string;
  connectionMessage: string;
}>();

const emit = defineEmits<{
  playAgain: [];
  changeSetup: [];
}>();

const leaderboard = computed<LeaderboardPlayer[]>(() =>
  props.players
    .map((player, originalIndex) => {
      const multiplayerPlayer = player as Partial<MultiplayerPlayer>;
      const accuracyValue = player.attempts === 0 ? 0 : player.score / player.attempts;

      return {
        ...player,
        accuracyLabel: `${Math.round(accuracyValue * 100)}%`,
        accuracyValue,
        connected: multiplayerPlayer.connected,
        hasAnswered: multiplayerPlayer.hasAnswered,
        isHost: multiplayerPlayer.isHost,
        originalIndex,
      };
    })
    .sort((firstPlayer, secondPlayer) => {
      if (secondPlayer.score !== firstPlayer.score) {
        return secondPlayer.score - firstPlayer.score;
      }

      if (secondPlayer.accuracyValue !== firstPlayer.accuracyValue) {
        return secondPlayer.accuracyValue - firstPlayer.accuracyValue;
      }

      return firstPlayer.originalIndex - secondPlayer.originalIndex;
    }),
);

const performanceColumns = computed(() =>
  Array.from({ length: props.roundCount }, (_, index) => {
    const round = index + 1;
    const roundCountry = props.roundCountries.find((country) => country.round === round);
    const countryName = roundCountry?.countryName ?? `Round ${round}`;

    return {
      round,
      countryName,
      ariaLabel: roundCountry ? `Round ${round}: ${countryName}` : `Round ${round}`,
    };
  }),
);

const roundPerformanceMeta: Record<
  RoundPerformanceDisplayState,
  { label: string; symbol: string }
> = {
  correct: { label: "Correct", symbol: "✓" },
  incorrect: { label: "Wrong", symbol: "×" },
  skipped: { label: "Skipped", symbol: "–" },
  timeout: { label: "Timed out", symbol: "○" },
  empty: { label: "No result", symbol: "" },
};

const winner = computed(() => leaderboard.value[0] ?? null);
const isTie = computed(
  () => leaderboard.value.length > 1 && leaderboard.value[1]?.score === leaderboard.value[0]?.score,
);

const headline = computed(() => {
  const top = winner.value;

  if (!top) {
    return "Game over";
  }

  if (!props.isMultiplayer) {
    return `${top.score} of ${props.roundCount} found`;
  }

  return isTie.value ? "It's a tie" : `${top.name} wins`;
});

const summary = computed(() => {
  const top = winner.value;

  if (!top) {
    return "";
  }

  if (!props.isMultiplayer) {
    return `${top.accuracyLabel} accuracy over ${props.roundCount} rounds of ${props.roundDurationSeconds} seconds.`;
  }

  return `${top.score} of ${props.roundCount} countries found. ${props.players.length} players, ${props.roundDurationSeconds} seconds a round.`;
});

const getRoundPerformance = (player: Player, round: number) => {
  const outcome =
    player.roundPerformance?.find((performance) => performance.round === round)?.outcome ?? "empty";
  const meta = roundPerformanceMeta[outcome];

  return {
    ...meta,
    outcome,
    ariaLabel: `${player.name}, round ${round}: ${meta.label}`,
  };
};
</script>

<template>
  <section class="results-panel" aria-labelledby="leaderboard-heading">
    <header class="results-copy">
      <p class="results-kicker">Game over</p>
      <h2 id="leaderboard-heading">{{ headline }}</h2>
      <p>{{ summary }}</p>
    </header>

    <ol v-if="isMultiplayer" class="leaderboard" aria-label="Final player scores">
      <li
        v-for="(player, index) in leaderboard"
        :key="player.id"
        class="leaderboard-row"
        :class="{ 'leaderboard-row--winner': index === 0 }"
      >
        <span class="leaderboard-rank">{{ index + 1 }}</span>
        <span class="leaderboard-player">
          <strong>{{ player.name }}</strong>
          <small>
            {{ player.accuracyLabel }} accuracy over {{ player.attempts }} turns<template
              v-if="player.isHost"
              >, host</template
            >
          </small>
        </span>
        <span class="leaderboard-score">
          {{ player.score }}
          <small>{{ player.score === 1 ? "point" : "points" }}</small>
        </span>
      </li>
    </ol>

    <section class="performance-chart" aria-labelledby="performance-chart-heading">
      <div class="performance-chart-header">
        <h3 id="performance-chart-heading">Round by round</h3>
        <ul class="performance-legend" aria-label="Performance legend">
          <li>
            <span class="performance-cell performance-cell--correct" aria-hidden="true">✓</span>
            Correct
          </li>
          <li>
            <span class="performance-cell performance-cell--incorrect" aria-hidden="true">×</span>
            Wrong
          </li>
          <li>
            <span class="performance-cell performance-cell--skipped" aria-hidden="true">–</span>
            Skipped
          </li>
          <li>
            <span class="performance-cell performance-cell--timeout" aria-hidden="true">○</span>
            Timed out
          </li>
        </ul>
      </div>

      <div class="performance-table-wrap">
        <table class="performance-table">
          <caption class="sr-only">
            Each player's result on every round.
          </caption>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th
                v-for="column in performanceColumns"
                :key="column.round"
                scope="col"
                :title="column.ariaLabel"
              >
                <span class="performance-country-label">
                  {{ column.countryName }}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="player in leaderboard" :key="player.id">
              <th scope="row">
                <span class="performance-player-name">
                  {{ player.name }}
                </span>
                <small>{{ player.score }}/{{ roundCount }}</small>
              </th>
              <td v-for="column in performanceColumns" :key="`${player.id}-${column.round}`">
                <span
                  class="performance-cell"
                  :class="`performance-cell--${getRoundPerformance(player, column.round).outcome}`"
                  :title="getRoundPerformance(player, column.round).ariaLabel"
                  :aria-label="getRoundPerformance(player, column.round).ariaLabel"
                >
                  {{ getRoundPerformance(player, column.round).symbol }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <p v-if="errorMessage" class="server-error" role="alert">
      {{ errorMessage }}
    </p>
    <p v-if="connectionMessage" class="server-warning" role="status">
      {{ connectionMessage }}
    </p>

    <div class="results-actions">
      <button
        v-if="!isMultiplayer || isHost"
        class="btn btn--large"
        type="button"
        :disabled="isBusy"
        @click="emit('playAgain')"
      >
        {{ isMultiplayer ? "Restart room" : "Play again" }}
      </button>
      <span v-else class="waiting-pill">Waiting for the host to restart</span>
      <button class="btn btn--quiet btn--large" type="button" @click="emit('changeSetup')">
        {{ isMultiplayer ? "Leave room" : "Change setup" }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.results-panel {
  display: grid;
  gap: clamp(1.5rem, 3vw, 2.25rem);
  width: 100%;
}

.results-copy {
  display: grid;
  gap: 0.5rem;
  max-width: 48rem;
}

.results-kicker {
  color: var(--text-muted);
  font-size: var(--step-1);
}

.results-copy h2 {
  font-size: clamp(2.5rem, 7vw, 5rem);
  font-stretch: 80%;
  font-variation-settings: "opsz" 96;
  font-weight: 740;
  letter-spacing: -0.02em;
  line-height: 0.95;
}

.results-copy p:last-child {
  color: var(--text-muted);
  font-size: 1.125rem;
}

.leaderboard {
  display: grid;
  max-width: 48rem;
  padding: 0;
  border-top: 1px solid var(--rule);
  list-style: none;
}

.leaderboard-row {
  display: grid;
  grid-template-columns: 2.5rem minmax(0, 1fr) auto;
  gap: 1rem;
  align-items: center;
  padding-block: 0.9rem;
  border-bottom: 1px solid var(--rule);
}

.leaderboard-rank {
  color: var(--text-muted);
  font-size: var(--step-2);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.leaderboard-row--winner .leaderboard-rank,
.leaderboard-row--winner .leaderboard-player strong {
  color: var(--paper);
}

.leaderboard-player {
  display: grid;
  gap: 0.1rem;
}

.leaderboard-player strong {
  color: var(--paper-dim);
  font-size: var(--step-1);
  font-weight: 650;
}

.leaderboard-player small {
  color: var(--text-muted);
  font-size: var(--step--1);
}

.leaderboard-score {
  display: grid;
  justify-items: end;
  color: var(--paper);
  font-size: var(--step-3);
  font-stretch: 80%;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  line-height: 1;
}

.leaderboard-score small {
  color: var(--text-muted);
  font-size: var(--step--1);
  font-stretch: 100%;
  font-weight: 400;
}

.performance-chart {
  display: grid;
  gap: 1rem;
}

.performance-chart-header {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 2rem;
  align-items: baseline;
}

.performance-chart h3 {
  color: var(--paper);
  font-size: var(--step-2);
  font-weight: 650;
}

.performance-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  margin: 0;
  padding: 0;
  color: var(--text-muted);
  font-size: var(--step--1);
  list-style: none;
}

.performance-legend li {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.performance-legend .performance-cell {
  width: 1.35rem;
  height: 1.35rem;
  font-size: 0.75rem;
}

.performance-table-wrap {
  width: fit-content;
  max-width: 100%;
  overflow-x: auto;
  border: 1px solid var(--rule);
  border-radius: var(--radius-surface);
  background: var(--cyan-900);
}

.performance-table {
  border-collapse: collapse;
}

.performance-table th,
.performance-table td {
  padding: 0.6rem 0.4rem;
  text-align: center;
  vertical-align: bottom;
}

.performance-table thead th {
  border-bottom: 1px solid var(--rule);
  color: var(--text-muted);
  font-size: var(--step--1);
  font-weight: 500;
}

.performance-table thead th:first-child {
  text-align: left;
}

/* Country names read upward like labels on a chart axis. */
.performance-table thead th:not(:first-child) {
  height: 9rem;
  min-width: 2.75rem;
  color: var(--paper-dim);
}

.performance-country-label {
  display: inline-block;
  max-height: 8.5rem;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  writing-mode: vertical-rl;
  transform: rotate(180deg);
}

.performance-table tbody tr + tr {
  border-top: 1px solid var(--rule);
}

.performance-table tbody th {
  position: sticky;
  left: 0;
  z-index: 1;
  min-width: 9rem;
  padding-inline: 1rem;
  background: var(--cyan-900);
  text-align: left;
  vertical-align: middle;
}

.performance-table thead th:first-child {
  position: sticky;
  left: 0;
  z-index: 1;
  padding-inline: 1rem;
  background: var(--cyan-900);
}

.performance-table td {
  vertical-align: middle;
}

.performance-player-name {
  display: block;
  color: var(--paper);
  font-weight: 600;
}

.performance-table tbody small {
  color: var(--text-muted);
  font-size: var(--step--1);
  font-variant-numeric: tabular-nums;
}

.performance-cell {
  display: inline-grid;
  width: 1.85rem;
  height: 1.85rem;
  place-items: center;
  border-radius: 4px;
  font-size: 0.9rem;
  font-weight: 700;
  line-height: 1;
}

.performance-cell--correct {
  color: var(--cyan-950);
  background: var(--correct);
}

.performance-cell--incorrect {
  color: var(--cyan-950);
  background: var(--wrong);
}

.performance-cell--skipped {
  border: 1px solid var(--rule-strong);
  color: var(--paper-dim);
}

.performance-cell--timeout {
  border: 1px dashed var(--rule-strong);
  color: var(--text-muted);
}

.performance-cell--empty {
  border: 1px dotted var(--rule);
}

.results-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
}

@media (max-width: 560px) {
  .leaderboard-row {
    grid-template-columns: 2rem minmax(0, 1fr) auto;
    gap: 0.6rem;
  }
}
</style>
