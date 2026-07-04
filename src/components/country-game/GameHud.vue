<script setup lang="ts">
import type { AnswerState, PublicRoomState } from "@shared/multiplayer-types";
import type { Player } from "@/types/game";

const props = defineProps<{
  isMultiplayer: boolean;
  selfName: string | null;
  targetCountryName: string | null;
  roundSummary: string;
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
</script>

<template>
  <header class="game-header">
    <div class="prompt-card" aria-live="polite">
      <p class="eyebrow">
        {{ isMultiplayer ? "Multiplayer challenge" : "World map challenge" }}
      </p>
      <h2>
        <span v-if="isMultiplayer && selfName" class="active-player-name"> {{ selfName }}: </span>
        Click
        <span class="target-country">
          {{ targetCountryName ?? "the highlighted country" }}
        </span>
      </h2>
      <p class="round-meta">{{ roundSummary }}</p>

      <div class="timer" aria-label="Round timer">
        <div class="timer-header">
          <span>Time left</span>
          <strong :class="{ 'timer-value--low': timerIsLow }"> {{ timeLeft }}s </strong>
        </div>
        <div class="timer-track" aria-hidden="true">
          <span :style="{ width: timerPercent }"></span>
        </div>
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
      <p v-if="errorMessage" class="server-error" role="alert">
        {{ errorMessage }}
      </p>
      <p v-if="connectionMessage" class="server-warning" role="status">
        {{ connectionMessage }}
      </p>
    </div>

    <dl class="scoreboard" aria-label="Your score">
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
      <button type="button" :disabled="guessingDisabled" @click="emit('skip')">
        {{ isMultiplayer ? "Skip round" : "Skip" }}
      </button>
      <button v-if="!isMultiplayer" type="button" @click="emit('reset')">Reset</button>
      <button
        v-if="isMultiplayer"
        class="secondary-button"
        type="button"
        :disabled="isSyncing"
        @click="emit('resync')"
      >
        {{ isSyncing ? "Syncing…" : "Resync" }}
      </button>
      <button class="secondary-button" type="button" @click="emit('leave')">
        {{ isMultiplayer ? "Leave room" : "Setup" }}
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
      }"
    >
      <span class="player-turn-label">
        {{ player.id === room.playerId ? "You" : player.hasAnswered ? "Answered" : "Guessing" }}
      </span>
      <strong class="player-name-tag" :class="getPlayerRoundGlintClass(player)">
        {{ player.name }}
      </strong>
      <span>{{ player.score }} pts</span>
    </article>
  </aside>
</template>

<style scoped>
.game-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: clamp(0.75rem, 2vw, 1.25rem);
  align-items: stretch;
  margin-bottom: clamp(0.75rem, 2vw, 1.5rem);
}

.active-player-name,
.target-country {
  color: var(--color-accent);
  font-weight: inherit;
}

.round-meta {
  margin-top: 0.55rem;
  color: var(--color-slate-strong);
  font-weight: 900;
}

.timer {
  display: grid;
  gap: 0.4rem;
  margin-top: 0.85rem;
}

.timer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  color: var(--color-slate);
  font-size: 0.85rem;
  font-weight: 900;
  text-transform: uppercase;
}

.timer-header strong {
  color: var(--color-ink);
  font-size: 1rem;
}

.timer-value--low {
  color: var(--color-danger-strong) !important;
}

.timer-track {
  overflow: hidden;
  height: 0.7rem;
  border-radius: 999px;
  background: var(--color-surface-muted);
}

.timer-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #22c55e, #f97316);
  transition: width 200ms linear;
}

.feedback {
  min-height: 1.6em;
  margin-top: 0.75rem;
  color: var(--color-slate);
  font-weight: 700;
}

.feedback--correct {
  color: var(--color-success-strong);
}

.feedback--incorrect {
  color: var(--color-danger-strong);
}

.scoreboard {
  display: grid;
  grid-template-columns: repeat(2, minmax(5.5rem, 1fr));
  gap: 0.75rem;
  min-width: 18rem;
  padding: 1rem;
}

.scoreboard div {
  display: grid;
  gap: 0.15rem;
}

.scoreboard dt {
  color: var(--color-slate-muted);
  font-size: 0.75rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.scoreboard dd {
  color: var(--color-ink);
  font-size: 1.6rem;
  font-weight: 900;
  line-height: 1;
}

.game-actions {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  justify-content: center;
  padding: 1rem;
}

.player-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.75rem;
  margin-bottom: clamp(0.75rem, 2vw, 1.5rem);
}

.player-name-tag {
  position: relative;
  display: inline-flex;
  width: fit-content;
  max-width: 100%;
  align-items: center;
  overflow: hidden;
  border-radius: 999px;
  margin-inline: -0.35rem;
  padding: 0.08rem 0.35rem;
  isolation: isolate;
}

.player-name-tag::after {
  position: absolute;
  inset: -45% auto -45% -80%;
  width: 58%;
  content: "";
  opacity: 0;
  pointer-events: none;
  transform: skewX(-24deg);
}

.player-name-tag--correct-glint {
  color: var(--color-success-deep) !important;
  background: rgba(220, 252, 231, 0.78);
  box-shadow:
    0 0 0 1px rgba(34, 197, 94, 0.4),
    0 0 18px rgba(34, 197, 94, 0.34);
}

.player-name-tag--incorrect-glint {
  color: var(--color-danger-deep) !important;
  background: rgba(254, 226, 226, 0.84);
  box-shadow:
    0 0 0 1px rgba(239, 68, 68, 0.4),
    0 0 18px rgba(239, 68, 68, 0.34);
}

.player-name-tag--correct-glint::after {
  background: linear-gradient(90deg, transparent, rgba(34, 197, 94, 0.95), transparent);
  animation: player-name-glint 1.05s ease-out both;
}

.player-name-tag--incorrect-glint::after {
  background: linear-gradient(90deg, transparent, rgba(239, 68, 68, 0.95), transparent);
  animation: player-name-glint 1.05s ease-out both;
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

  .scoreboard {
    min-width: 0;
  }

  .game-actions {
    flex-direction: row;
  }
}
</style>
