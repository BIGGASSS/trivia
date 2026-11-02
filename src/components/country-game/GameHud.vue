<script setup lang="ts">
import type { AnswerState, PublicRoomState } from "@shared/multiplayer-types";
import type { Player } from "@/types/game";

const props = defineProps<{
  isMultiplayer: boolean;
  selfName: string | null;
  targetCountryName: string | null;
  roundSummary: string;
  answeredSummary: string;
  timeLeft: number;
  timerPercent: string;
  timerIsLow: boolean;
  answerState: AnswerState;
  feedbackMessage: string;
  errorMessage: string;
  connectionMessage: string;
  scoreboardPlayer: Player;
  accuracy: string;
  guessingDisabled: boolean;
  isSyncing: boolean;
  room: PublicRoomState | null;
  currentRoundNumber: number;
}>();

const emit = defineEmits<{
  skip: [];
  reset: [];
  resync: [];
  leave: [];
}>();

const getPlayerRoundGlintClass = (player: Player) => {
  const outcome = player.roundPerformance?.find(
    (performance) => performance.round === props.currentRoundNumber,
  )?.outcome;

  if (!outcome) {
    return "";
  }

  return outcome === "correct"
    ? "player-name-tag--correct-glint"
    : "player-name-tag--incorrect-glint";
};

const getPlayerStatus = (player: PublicRoomState["players"][number], selfId: string) => {
  if (!player.active) return "Left";
  if (player.id === selfId) return "You";
  if (player.hasAnswered) return "Answered";
  return player.connected ? "Guessing" : "Disconnected";
};
</script>

<template>
  <header class="game-header">
    <div class="prompt-card" aria-live="polite">
      <p class="round-meta">{{ roundSummary }}</p>
      <h2 class="prompt-heading">
        <span class="prompt-verb">Find</span>
        <span class="target-country">
          {{ targetCountryName ?? "the highlighted country" }}
        </span>
      </h2>

      <div
        class="timer"
        :class="{ 'timer--low': timerIsLow }"
        role="timer"
        :aria-label="`${timeLeft} seconds left`"
      >
        <div class="timer-track" aria-hidden="true">
          <span :style="{ width: timerPercent }"></span>
        </div>
        <strong class="timer-value" :class="{ 'timer-value--low': timerIsLow }" aria-hidden="true">
          {{ timeLeft }}<small>s</small>
        </strong>
      </div>

      <p
        class="feedback"
        :class="{
          'feedback--correct': answerState === 'correct',
          'feedback--incorrect': answerState === 'incorrect',
        }"
      >
        {{ feedbackMessage }}
      </p>
      <p v-if="answeredSummary" class="answered-meta">{{ answeredSummary }}</p>
      <p v-if="errorMessage" class="server-error" role="alert">
        {{ errorMessage }}
      </p>
      <p v-if="connectionMessage" class="server-warning" role="status">
        {{ connectionMessage }}
      </p>
    </div>

    <dl class="scoreboard" :aria-label="selfName ? `${selfName}'s score` : 'Your score'">
      <div>
        <dt>Score</dt>
        <dd>{{ scoreboardPlayer.score }}</dd>
      </div>
      <div>
        <dt>Attempts</dt>
        <dd>{{ scoreboardPlayer.attempts }}</dd>
      </div>
      <div>
        <dt>Accuracy</dt>
        <dd>{{ accuracy }}</dd>
      </div>
      <div>
        <dt>Streak</dt>
        <dd>{{ scoreboardPlayer.streak }}</dd>
      </div>
    </dl>

    <div class="game-actions">
      <button
        class="btn game-action--primary"
        type="button"
        :disabled="guessingDisabled"
        @click="emit('skip')"
      >
        {{ isMultiplayer ? "Skip round" : "Skip" }}
      </button>
      <button v-if="!isMultiplayer" class="btn btn--quiet" type="button" @click="emit('reset')">
        Restart
      </button>
      <button
        v-if="isMultiplayer"
        class="btn btn--quiet"
        type="button"
        :disabled="isSyncing"
        @click="emit('resync')"
      >
        {{ isSyncing ? "Syncing…" : "Resync" }}
      </button>
      <button class="btn btn--quiet" type="button" @click="emit('leave')">
        {{ isMultiplayer ? "Leave room" : "Back to setup" }}
      </button>
    </div>
  </header>

  <aside v-if="isMultiplayer && room" class="player-strip" aria-label="Player scores">
    <article
      v-for="player in room.players"
      :key="player.id"
      class="player-score-card"
      :class="{
        'player-score-card--active': player.id === room.playerId,
        'player-score-card--answered': player.hasAnswered,
        'player-score-card--left': !player.active,
      }"
    >
      <strong class="player-name-tag" :class="getPlayerRoundGlintClass(player)">
        {{ player.name }}
      </strong>
      <span class="player-turn-label">{{ getPlayerStatus(player, room.playerId) }}</span>
      <span class="player-points"
        >{{ player.score }} {{ player.score === 1 ? "point" : "points" }}</span
      >
    </article>
  </aside>
</template>

<style scoped>
.game-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 1rem;
  align-items: stretch;
}

.prompt-card {
  display: grid;
  align-content: start;
  gap: 0.75rem;
}

.round-meta {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.prompt-heading {
  display: grid;
  gap: 0.15rem;
  color: var(--paper);
  font-weight: 400;
  line-height: 1;
}

.prompt-verb {
  color: var(--text-muted);
  font-size: var(--step-1);
  font-stretch: 100%;
  font-variation-settings: normal;
  font-weight: 500;
  letter-spacing: 0;
}

/* The prompt: the one thing set big and in the target ink. */
.target-country {
  color: var(--signal);
  font-size: clamp(2.25rem, 4vw, 4rem);
  font-stretch: 78%;
  font-variation-settings: "opsz" 96;
  font-weight: 740;
  letter-spacing: -0.015em;
  line-height: 0.95;
  overflow-wrap: anywhere;
  text-wrap: balance;
}

.timer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.85rem;
  align-items: center;
}

.timer-track {
  overflow: hidden;
  height: 4px;
  border-radius: 2px;
  background: var(--rule);
}

.timer-track span {
  display: block;
  height: 100%;
  background: var(--paper);
  transition:
    width 200ms linear,
    background-color 200ms ease;
}

.timer--low .timer-track span {
  background: var(--wrong);
}

.timer-value {
  min-width: 3ch;
  color: var(--paper);
  font-size: var(--step-2);
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  line-height: 1;
  text-align: right;
}

.timer-value small {
  margin-left: 0.05em;
  color: var(--text-muted);
  font-size: 0.6em;
  font-weight: 500;
}

.timer-value.timer-value--low {
  color: var(--wrong);
}

.feedback {
  min-height: 3em;
  color: var(--text-muted);
  font-size: 1.0625rem;
  line-height: 1.45;
}

.feedback--correct {
  color: var(--correct);
}

.feedback--incorrect {
  color: var(--wrong);
}

.answered-meta {
  color: var(--text-muted);
  font-size: var(--step--1);
  font-variant-numeric: tabular-nums;
}

.scoreboard {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  padding-block: 0.85rem;
  border-block: 1px solid var(--rule);
}

.scoreboard div {
  display: grid;
  gap: 0.25rem;
}

.scoreboard div + div {
  padding-left: 0.75rem;
  border-left: 1px solid var(--rule);
}

.scoreboard dt {
  color: var(--text-muted);
  font-size: var(--step--1);
}

.scoreboard dd {
  color: var(--paper);
  font-size: var(--step-2);
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  line-height: 1;
}

.game-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.game-action--primary {
  flex: 1 1 100%;
}

.game-actions .btn--quiet {
  flex: 1 1 0;
}

.player-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 0.5rem;
}

.player-score-card--left {
  opacity: 0.55;
}

.player-points {
  color: var(--paper);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.player-name-tag {
  position: relative;
  display: inline-flex;
  width: fit-content;
  max-width: 100%;
  align-items: center;
  overflow: hidden;
  border-radius: 4px;
  margin-inline: -0.3rem;
  padding: 0.05rem 0.3rem;
  isolation: isolate;
}

/* A player's name flashes once in the outcome colour when their round
 * result arrives: motion that confirms what just changed. */
.player-name-tag::after {
  position: absolute;
  inset: -45% auto -45% -80%;
  width: 58%;
  content: "";
  opacity: 0;
  pointer-events: none;
  transform: skewX(-24deg);
}

.player-name-tag.player-name-tag--correct-glint {
  color: var(--cyan-900);
  background: var(--correct);
}

.player-name-tag.player-name-tag--incorrect-glint {
  color: var(--cyan-900);
  background: var(--wrong);
}

.player-name-tag--correct-glint::after,
.player-name-tag--incorrect-glint::after {
  background: linear-gradient(90deg, transparent, rgb(255 255 255 / 0.85), transparent);
  animation: player-name-glint 0.9s ease-out both;
}

@keyframes player-name-glint {
  0% {
    opacity: 0;
    transform: translateX(0) skewX(-24deg);
  }

  18% {
    opacity: 0.95;
  }

  100% {
    opacity: 0;
    transform: translateX(360%) skewX(-24deg);
  }
}

@media (max-width: 980px) {
  .game-header {
    grid-template-columns: 1fr;
  }
}
</style>
