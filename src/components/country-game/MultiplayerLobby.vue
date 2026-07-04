<script setup lang="ts">
import type { PublicRoomState } from "@shared/multiplayer-types";

defineProps<{
  room: PublicRoomState;
  statusMessage: string;
  errorMessage: string;
  connectionMessage: string;
  isHost: boolean;
  isBusy: boolean;
}>();

const emit = defineEmits<{
  start: [];
  leave: [];
}>();
</script>

<template>
  <section class="lobby-panel" aria-labelledby="lobby-heading">
    <header class="lobby-header">
      <div>
        <p class="eyebrow">Multiplayer lobby</p>
        <h2 id="lobby-heading">Room {{ room.roomCode }}</h2>
        <p class="setup-copy">
          {{ statusMessage }} The match will run {{ room.roundCount }} rounds with
          {{ room.roundDurationSeconds }} seconds each.
        </p>
      </div>
      <div class="room-code-card" aria-label="Room code">
        <span>Room code</span>
        <strong>{{ room.roomCode }}</strong>
        <small>Share this with friends</small>
      </div>
    </header>

    <div class="lobby-grid">
      <article
        v-for="player in room.players"
        :key="player.id"
        class="player-score-card"
        :class="{ 'player-score-card--active': player.id === room.playerId }"
      >
        <span class="player-turn-label">
          {{ player.isHost ? "Host" : "Player" }}
        </span>
        <strong>{{ player.name }}</strong>
        <span>{{ player.connected ? "Connected" : "Disconnected" }}</span>
      </article>
    </div>

    <p v-if="errorMessage" class="server-error" role="alert">
      {{ errorMessage }}
    </p>
    <p v-if="connectionMessage" class="server-warning" role="status">
      {{ connectionMessage }}
    </p>

    <div class="setup-actions">
      <button
        v-if="isHost"
        class="start-button"
        type="button"
        :disabled="!room.canStart || isBusy"
        @click="emit('start')"
      >
        {{ room.canStart ? "Start match" : "Waiting for players" }}
      </button>
      <span v-else class="waiting-pill">Waiting for host</span>
      <button class="secondary-button" type="button" @click="emit('leave')">Leave room</button>
    </div>
  </section>
</template>

<style scoped>
.lobby-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1rem;
  align-items: center;
}

.room-code-card {
  display: grid;
  gap: 0.4rem;
  min-width: 13rem;
  padding: 1rem;
  text-align: center;
}

.room-code-card span {
  color: var(--color-slate-muted);
  font-size: 0.75rem;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.room-code-card strong {
  color: var(--color-accent);
  font-size: 2.4rem;
  font-weight: 950;
  letter-spacing: 0.08em;
  line-height: 1;
}

.room-code-card small {
  color: var(--color-slate-muted);
  font-weight: 700;
}

.lobby-grid {
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
}

@media (max-width: 980px) {
  .lobby-header {
    grid-template-columns: 1fr;
  }

  .room-code-card {
    justify-items: start;
    text-align: left;
  }
}
</style>
