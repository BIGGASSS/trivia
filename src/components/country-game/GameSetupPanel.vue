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
      <p class="eyebrow">Country guessing game</p>
      <h2 id="setup-heading">Choose how to play</h2>
      <p class="setup-copy">
        Play solo in this browser, or create a multiplayer room for up to
        {{ maximumPlayerCount }} players. Multiplayer rounds use a shared
        {{ roundDurationSeconds }} second timer.
      </p>
    </header>

    <div class="mode-grid" role="radiogroup" aria-label="Game mode">
      <label class="mode-card" :class="{ 'mode-card--active': selectedMode === 'solo' }">
        <input v-model="selectedMode" type="radio" value="solo" />
        <span class="mode-title">Solo</span>
        <span class="mode-description">
          A focused {{ defaultRoundCount }} round challenge against the timer.
        </span>
      </label>

      <label class="mode-card" :class="{ 'mode-card--active': selectedMode === 'multiplayer' }">
        <input v-model="selectedMode" type="radio" value="multiplayer" />
        <span class="mode-title">Multiplayer</span>
        <span class="mode-description">
          Create or join a live room. Everyone guesses the same country at the same time.
        </span>
      </label>
    </div>

    <div class="settings-grid">
      <label class="setting-field">
        <span>Rounds</span>
        <input
          v-model.number="roundCountSetting"
          type="number"
          min="1"
          :max="maximumRoundCount"
          inputmode="numeric"
        />
        <small>
          Default is {{ defaultRoundCount }} rounds; choose up to {{ maximumRoundCount }} to include
          every loaded country.
        </small>
      </label>

      <div class="setting-field setting-field--static">
        <span>Time per round</span>
        <strong>{{ roundDurationSeconds }}s</strong>
        <small>The countdown is fixed for every round.</small>
      </div>

      <div v-if="selectedMode === 'multiplayer'" class="setting-field setting-field--static">
        <span>Players</span>
        <strong>{{ minimumMultiplayerPlayerCount }}–{{ maximumPlayerCount }}</strong>
        <small>Rooms start after at least {{ minimumMultiplayerPlayerCount }} players join.</small>
      </div>
    </div>

    <div v-if="selectedMode === 'solo'" class="setup-actions">
      <button class="start-button" type="button" @click="emit('startSolo')">Start solo game</button>
    </div>

    <section v-else class="server-setup" aria-labelledby="server-multiplayer-heading">
      <div class="server-setup-header">
        <div>
          <p class="eyebrow">Multiplayer</p>
          <h3 id="server-multiplayer-heading">Play together online</h3>
        </div>
        <div class="segmented-control" aria-label="Multiplayer action">
          <button
            type="button"
            :class="{ 'segmented-control__button--active': setupAction === 'create' }"
            @click="setupAction = 'create'"
          >
            Create
          </button>
          <button
            type="button"
            :class="{ 'segmented-control__button--active': setupAction === 'join' }"
            @click="setupAction = 'join'"
          >
            Join
          </button>
        </div>
      </div>

      <div class="server-form-grid">
        <label class="player-name-field">
          <span>Your name</span>
          <input v-model="playerName" type="text" placeholder="Player name" maxlength="24" />
        </label>

        <label v-if="setupAction === 'join'" class="player-name-field">
          <span>Room code</span>
          <input
            v-model="roomCodeInput"
            type="text"
            placeholder="ABC123"
            maxlength="8"
            autocomplete="off"
          />
        </label>
      </div>

      <p v-if="errorMessage" class="server-error" role="alert">
        {{ errorMessage }}
      </p>

      <div class="setup-actions">
        <button
          v-if="setupAction === 'create'"
          class="start-button"
          type="button"
          :disabled="isBusy"
          @click="emit('createRoom')"
        >
          {{ isBusy ? "Creating…" : "Create room" }}
        </button>
        <button
          v-else
          class="start-button"
          type="button"
          :disabled="isBusy"
          @click="emit('joinRoom')"
        >
          {{ isBusy ? "Joining…" : "Join room" }}
        </button>
      </div>
    </section>
  </section>
</template>

<style scoped>
.mode-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.mode-card {
  position: relative;
  display: grid;
  gap: 0.45rem;
  padding: 1rem;
  cursor: pointer;
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease,
    transform 160ms ease;
}

.mode-card:hover,
.mode-card:focus-within {
  transform: translateY(-1px);
}

.mode-card--active {
  border-color: rgba(37, 99, 235, 0.85);
  box-shadow: 0 18px 42px rgba(37, 99, 235, 0.16);
}

.mode-card input {
  position: absolute;
  inset: 1rem auto auto 1rem;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.mode-title {
  color: var(--color-ink);
  font-size: 1.2rem;
  font-weight: 950;
}

.mode-description {
  color: var(--color-slate);
  font-weight: 700;
}

.settings-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.server-setup-header {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
}

.server-setup h3 {
  color: var(--color-ink);
  font-size: clamp(1.35rem, 2.5vw, 2.2rem);
  font-weight: 950;
  line-height: 1;
}

.segmented-control {
  display: inline-flex;
  gap: 0.35rem;
  padding: 0.35rem;
  border-radius: 999px;
  background: var(--color-surface-muted);
}

.segmented-control button {
  color: var(--color-slate-strong);
  background: transparent;
  box-shadow: none;
}

.segmented-control__button--active,
.segmented-control__button--active:hover,
.segmented-control__button--active:focus-visible {
  color: var(--color-surface) !important;
  background: var(--color-primary) !important;
}

.server-form-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.setting-field,
.player-name-field {
  display: grid;
  gap: 0.45rem;
  padding: 1rem;
}

.setting-field span,
.player-name-field span {
  color: var(--color-slate-muted);
  font-size: 0.75rem;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.setting-field input,
.setting-field select,
.player-name-field input {
  width: 100%;
  border: 1px solid rgba(71, 85, 105, 0.24);
  border-radius: 12px;
  padding: 0.7rem 0.8rem;
  color: var(--color-ink);
  background: var(--color-surface);
  font: inherit;
  font-weight: 800;
}

.setting-field strong {
  color: var(--color-ink);
  font-size: 2rem;
  font-weight: 950;
  line-height: 1;
}

.setting-field small {
  color: var(--color-slate-muted);
  font-weight: 700;
}

@media (max-width: 980px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 700px) {
  .mode-grid,
  .server-form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
