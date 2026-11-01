<script setup lang="ts">
import {
  defaultRoundCount,
  maximumPlayerCount,
  minimumMultiplayerPlayerCount,
  roundDurationSeconds,
} from "@shared/game-constants";
import type { GameMode, MultiplayerSetupAction } from "@/types/game";

defineProps<{
  maximumRoundCount: number;
  errorMessage: string;
  isBusy: boolean;
  canRetryRejoin?: boolean;
}>();

const emit = defineEmits<{
  startSolo: [];
  createRoom: [];
  joinRoom: [];
}>();

const selectedMode = defineModel<GameMode>("selectedMode", { required: true });
const roundCountSetting = defineModel<number>("roundCountSetting", { required: true });
const setupAction = defineModel<MultiplayerSetupAction>("setupAction", { required: true });
const playerName = defineModel<string>("playerName", { required: true });
const roomCodeInput = defineModel<string>("roomCodeInput", { required: true });
</script>

<template>
  <section class="setup-panel" aria-labelledby="setup-heading">
    <header class="setup-header">
      <h2 id="setup-heading">Choose how to play</h2>
      <p class="setup-copy">
        Each round names a country. Click it on the blank map within
        {{ roundDurationSeconds }} seconds.
      </p>
    </header>

    <div class="mode-grid" role="radiogroup" aria-label="Game mode">
      <label class="mode-card" :class="{ 'mode-card--active': selectedMode === 'solo' }">
        <input v-model="selectedMode" type="radio" value="solo" />
        <span class="mode-title">Solo</span>
        <span class="mode-description">Just you and the clock, in this browser.</span>
      </label>

      <label class="mode-card" :class="{ 'mode-card--active': selectedMode === 'multiplayer' }">
        <input v-model="selectedMode" type="radio" value="multiplayer" />
        <span class="mode-title">With friends</span>
        <span class="mode-description">
          {{ minimumMultiplayerPlayerCount }} to {{ maximumPlayerCount }} players race to find the
          same country.
        </span>
      </label>
    </div>

    <div class="setup-form">
      <label class="field field--rounds">
        <span class="field-label">Rounds</span>
        <input
          v-model.number="roundCountSetting"
          type="number"
          min="1"
          :max="maximumRoundCount"
          inputmode="numeric"
        />
        <small>{{ defaultRoundCount }} is a quick game. Up to {{ maximumRoundCount }}.</small>
      </label>

      <template v-if="selectedMode === 'solo'">
        <div class="setup-actions">
          <button class="btn btn--large start-button" type="button" @click="emit('startSolo')">
            Start solo game
          </button>
        </div>
      </template>

      <section v-else class="server-setup" aria-labelledby="server-multiplayer-heading">
        <div class="server-setup-header">
          <h3 id="server-multiplayer-heading">Room</h3>
          <div class="segmented-control" role="group" aria-label="Multiplayer action">
            <button
              type="button"
              :aria-pressed="setupAction === 'create'"
              :class="{ 'segmented-control__button--active': setupAction === 'create' }"
              @click="setupAction = 'create'"
            >
              Create
            </button>
            <button
              type="button"
              :aria-pressed="setupAction === 'join'"
              :class="{ 'segmented-control__button--active': setupAction === 'join' }"
              @click="setupAction = 'join'"
            >
              Join
            </button>
          </div>
        </div>

        <div class="server-form-grid">
          <label class="field">
            <span class="field-label">Your name</span>
            <input
              v-model="playerName"
              type="text"
              placeholder="Player name"
              maxlength="24"
              autocomplete="nickname"
            />
          </label>

          <label v-if="setupAction === 'join'" class="field">
            <span class="field-label">Room code</span>
            <input
              v-model="roomCodeInput"
              class="field-input--code"
              type="text"
              placeholder="ABC123"
              maxlength="8"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
            />
          </label>
        </div>

        <p v-if="errorMessage" class="setup-message" role="alert">
          {{ errorMessage }}
        </p>

        <div class="setup-actions">
          <button
            v-if="setupAction === 'create'"
            class="btn btn--large start-button"
            type="button"
            :disabled="isBusy"
            @click="emit('createRoom')"
          >
            {{ isBusy ? "Creating…" : "Create room" }}
          </button>
          <button
            v-else
            class="btn btn--large start-button"
            type="button"
            :disabled="isBusy"
            @click="emit('joinRoom')"
          >
            {{ isBusy ? "Joining…" : canRetryRejoin ? "Retry rejoin" : "Join room" }}
          </button>
          <small v-if="setupAction === 'create'" class="setup-hint">
            You'll get a code to share once the room is ready.
          </small>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.setup-panel {
  display: grid;
  gap: clamp(1.5rem, 3vw, 2.25rem);
  width: min(100%, 44rem);
}

.setup-header {
  display: grid;
  gap: 0.6rem;
}

.mode-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}

.mode-card {
  position: relative;
  display: grid;
  align-content: start;
  gap: 0.3rem;
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius-surface);
  padding: 1.1rem 1.2rem 1.2rem 3rem;
  cursor: pointer;
  transition:
    border-color 140ms ease,
    background-color 140ms ease;
}

/* The radio dot: a hollow ring that fills with paper when chosen. */
.mode-card::before {
  position: absolute;
  top: 1.35rem;
  left: 1.15rem;
  width: 1.1rem;
  height: 1.1rem;
  border: 1.5px solid var(--rule-strong);
  border-radius: 50%;
  content: "";
}

.mode-card:hover {
  border-color: var(--paper-dim);
}

.mode-card.mode-card--active {
  border-color: var(--paper);
  background: rgb(238 242 239 / 0.07);
}

.mode-card.mode-card--active::before {
  border-color: var(--paper);
  background: var(--paper);
  box-shadow: inset 0 0 0 3px var(--cyan-800);
}

.mode-card:has(input:focus-visible) {
  box-shadow: var(--focus-ring);
}

.mode-card input {
  position: absolute;
  inset: 1rem auto auto 1rem;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.mode-title {
  color: var(--paper);
  font-size: var(--step-1);
  font-weight: 650;
  line-height: 1.2;
}

.mode-description {
  color: var(--text-muted);
}

.setup-form {
  display: grid;
  gap: 1.5rem;
}

.field--rounds {
  max-width: 16rem;
}

.field--rounds input {
  font-size: var(--step-2);
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}

.server-setup {
  display: grid;
  gap: 1.25rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--rule);
}

.server-setup-header {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
}

.server-setup h3 {
  color: var(--paper);
  font-size: var(--step-2);
  font-weight: 650;
  line-height: 1.1;
}

.segmented-control {
  display: inline-flex;
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius-control);
  padding: 3px;
}

.segmented-control button {
  min-height: 2.25rem;
  border: 0;
  border-radius: 4px;
  padding: 0.35rem 1rem;
  color: var(--text-muted);
  background: transparent;
  font-weight: 600;
  cursor: pointer;
}

.segmented-control button:hover {
  color: var(--paper);
}

.segmented-control button.segmented-control__button--active {
  color: var(--ink-on-paper);
  background: var(--paper);
}

.server-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
}

.field-input--code {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

/* This slot carries both instructions ("Room ABC123 is ready…") and
 * failures, so it reads as a neutral notice rather than an alarm. */
.setup-message {
  border-left: 3px solid var(--signal);
  padding: 0.2rem 0 0.2rem 0.75rem;
  color: var(--paper);
  line-height: 1.4;
}

.setup-hint {
  color: var(--text-muted);
  font-size: var(--step--1);
}

@media (max-width: 640px) {
  .mode-grid,
  .server-form-grid {
    grid-template-columns: 1fr;
  }

  .field--rounds {
    max-width: none;
  }
}
</style>
