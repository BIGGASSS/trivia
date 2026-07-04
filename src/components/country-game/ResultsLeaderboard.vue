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
  timeout: { label: "Timed out", symbol: "⏱" },
  empty: { label: "No result", symbol: "·" },
};

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
    <div class="results-copy">
      <p class="eyebrow">Final leaderboard</p>
      <h2 id="leaderboard-heading">Game over</h2>
      <p>
        {{ players.length }}
        {{ players.length === 1 ? "player" : "players" }} completed {{ roundCount }} timed rounds
        with {{ roundDurationSeconds }} seconds on the clock.
      </p>
    </div>

    <ol class="leaderboard" aria-label="Final player scores">
      <li
        v-for="(player, index) in leaderboard"
        :key="player.id"
        class="leaderboard-row"
        :class="{ 'leaderboard-row--winner': index === 0 }"
      >
        <span class="leaderboard-rank">#{{ index + 1 }}</span>
        <span class="leaderboard-player">
          <strong>{{ player.name }}</strong>
          <small>
            {{ player.attempts }} turns · {{ player.accuracyLabel }} accuracy
            <template v-if="player.isHost"> · Host</template>
          </small>
        </span>
        <span class="leaderboard-score">
          {{ player.score }}
          <small>points</small>
        </span>
      </li>
    </ol>

    <section class="performance-chart" aria-labelledby="performance-chart-heading">
      <div class="performance-chart-header">
        <div>
          <p class="eyebrow">Round-by-round</p>
          <h3 id="performance-chart-heading">Performance chart</h3>
        </div>
        <ul class="performance-legend" aria-label="Performance legend">
          <li>
            <span
              class="performance-legend-dot performance-cell--correct"
              aria-hidden="true"
            ></span>
            Correct
          </li>
          <li>
            <span
              class="performance-legend-dot performance-cell--incorrect"
              aria-hidden="true"
            ></span>
            Wrong
          </li>
          <li>
            <span
              class="performance-legend-dot performance-cell--skipped"
              aria-hidden="true"
            ></span>
            Skipped
          </li>
          <li>
            <span
              class="performance-legend-dot performance-cell--timeout"
              aria-hidden="true"
            ></span>
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
        type="button"
        :disabled="isBusy"
        @click="emit('playAgain')"
      >
        {{ isMultiplayer ? "Restart room" : "Play again" }}
      </button>
      <span v-else class="waiting-pill">Waiting for host to restart</span>
      <button class="secondary-button" type="button" @click="emit('changeSetup')">
        {{ isMultiplayer ? "Leave room" : "Change setup" }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.leaderboard {
  display: grid;
  gap: 0.75rem;
  padding: 0;
  list-style: none;
}

.leaderboard-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 1rem;
  align-items: center;
  padding: 1rem;
}

.leaderboard-row--winner {
  border-color: rgba(234, 88, 12, 0.55);
  background:
    linear-gradient(135deg, rgba(255, 247, 237, 0.92), rgba(255, 255, 255, 0.88)),
    rgba(255, 255, 255, 0.82);
}

.leaderboard-rank {
  display: grid;
  min-width: 3rem;
  height: 3rem;
  place-items: center;
  border-radius: 50%;
  color: var(--color-surface);
  background: var(--color-primary);
  font-weight: 950;
}

.leaderboard-row--winner .leaderboard-rank {
  background: var(--color-accent);
}

.leaderboard-player {
  display: grid;
  gap: 0.2rem;
}

.leaderboard-player strong {
  color: var(--color-ink);
  font-size: 1.2rem;
  font-weight: 950;
}

.leaderboard-player small,
.leaderboard-score small {
  color: var(--color-slate-muted);
  font-weight: 800;
}

.leaderboard-score {
  display: grid;
  justify-items: end;
  color: var(--color-ink);
  font-size: 2rem;
  font-weight: 950;
  line-height: 1;
}

.performance-chart {
  display: grid;
  gap: 1rem;
}

.performance-chart-header {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
}

.performance-chart h3 {
  color: var(--color-ink);
  font-size: clamp(1.35rem, 2.5vw, 2rem);
  font-weight: 950;
  line-height: 1;
}

.performance-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem 0.85rem;
  margin: 0;
  padding: 0;
  color: var(--color-slate);
  font-size: 0.85rem;
  font-weight: 900;
  list-style: none;
}

.performance-legend li {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.performance-legend-dot {
  display: inline-block;
  width: 0.85rem;
  height: 0.85rem;
  border: 1px solid currentColor;
  border-radius: 50%;
}

.performance-table-wrap {
  overflow-x: auto;
  padding-bottom: 0.25rem;
}

.performance-table {
  width: 100%;
  min-width: 52rem;
  border-collapse: separate;
  border-spacing: 0.35rem;
}

.performance-table th,
.performance-table td {
  text-align: center;
  vertical-align: middle;
}

.performance-table thead th {
  color: var(--color-slate-muted);
  font-size: 0.72rem;
  font-weight: 950;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.performance-table thead th:not(:first-child) {
  min-width: 7rem;
  max-width: 10rem;
  color: var(--color-slate-strong);
  font-size: 0.78rem;
  letter-spacing: 0;
  line-height: 1.15;
  text-transform: none;
}

.performance-country-label {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.performance-table tbody th {
  position: sticky;
  left: 0;
  z-index: 1;
  display: grid;
  gap: 0.2rem;
  min-width: 10rem;
  border-radius: 12px;
  padding: 0.65rem 0.8rem;
  background: var(--color-surface);
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.08);
  text-align: left;
}

.performance-player-name {
  color: var(--color-ink);
  font-weight: 950;
}

.performance-table tbody small {
  color: var(--color-slate-muted);
  font-weight: 800;
}

.performance-cell {
  display: inline-grid;
  width: 2.15rem;
  height: 2.15rem;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 50%;
  font-size: 1rem;
  font-weight: 950;
  line-height: 1;
}

.performance-cell--correct {
  color: var(--color-success-dim);
  background: #dcfce7;
}

.performance-cell--incorrect {
  color: var(--color-danger-dim);
  background: #fee2e2;
}

.performance-cell--skipped {
  color: var(--color-warning-dim);
  background: #fef3c7;
}

.performance-cell--timeout {
  color: var(--color-slate);
  background: var(--color-surface-muted);
}

.performance-cell--empty {
  color: var(--color-slate-faint);
  background: var(--color-surface-soft);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

@media (max-width: 560px) {
  .leaderboard-row {
    grid-template-columns: auto 1fr;
  }

  .leaderboard-score {
    grid-column: 2;
    justify-items: start;
  }
}
</style>
