<script setup lang="ts">
import { computed, ref } from "vue";
import type { PublicRoomState } from "@shared/multiplayer-types";
import { multiplayerGamePath } from "@shared/game-constants";

const props = defineProps<{
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

const openSeats = computed(() => Math.max(0, props.room.maxPlayers - props.room.players.length));
const copyState = ref<"idle" | "copied" | "failed">("idle");

// Room links contain only the public room code, never a session token.
const inviteLink = computed(() =>
  typeof window === "undefined"
    ? `${multiplayerGamePath}/${props.room.roomCode}`
    : `${window.location.origin}${multiplayerGamePath}/${props.room.roomCode}`,
);

const copyInviteLink = async () => {
  try {
    await navigator.clipboard.writeText(inviteLink.value);
    copyState.value = "copied";
  } catch {
    copyState.value = "failed";
  }
};
</script>

<template>
  <section class="lobby-panel" aria-labelledby="lobby-heading">
    <header class="lobby-header">
      <h2 id="lobby-heading">Waiting room</h2>
      <p class="setup-copy">
        {{ statusMessage }} {{ room.roundCount }} rounds, {{ room.roundDurationSeconds }} seconds
        each.
      </p>
    </header>

    <div class="room-code-card">
      <p class="room-code-label" id="room-code-label">Share this code with friends</p>
      <strong class="room-code" aria-labelledby="room-code-label">{{ room.roomCode }}</strong>
      <div class="room-code-actions">
        <button class="btn btn--quiet" type="button" @click="copyInviteLink">
          {{ copyState === "copied" ? "Link copied" : "Copy invite link" }}
        </button>
        <span v-if="copyState === 'failed'" class="room-code-hint" role="status">
          Copy blocked by the browser. Share the code instead.
        </span>
      </div>
    </div>

    <section class="lobby-roster" aria-labelledby="roster-heading">
      <h3 id="roster-heading">
        Players
        <span class="lobby-roster__count">{{ room.players.length }} of {{ room.maxPlayers }}</span>
      </h3>
      <ul class="lobby-grid">
        <li
          v-for="player in room.players"
          :key="player.id"
          class="player-score-card"
          :class="{
            'player-score-card--active': player.id === room.playerId,
            'player-score-card--offline': !player.connected,
          }"
        >
          <strong>{{ player.name }}</strong>
          <span class="player-turn-label">
            {{ player.isHost ? "Host" : "Player" }}{{ player.id === room.playerId ? " (you)" : "" }}
          </span>
          <span class="player-connection">
            {{ player.connected ? "Connected" : "Disconnected" }}
          </span>
        </li>
        <li v-for="seat in openSeats" :key="`open-${seat}`" class="lobby-open-seat">Open seat</li>
      </ul>
    </section>

    <p v-if="errorMessage" class="server-error" role="alert">
      {{ errorMessage }}
    </p>
    <p v-if="connectionMessage" class="server-warning" role="status">
      {{ connectionMessage }}
    </p>

    <div class="setup-actions">
      <button
        v-if="isHost"
        class="btn btn--large start-button"
        type="button"
        :disabled="!room.canStart || isBusy"
        @click="emit('start')"
      >
        {{ room.canStart ? "Start match" : "Waiting for players" }}
      </button>
      <span v-else class="waiting-pill">Waiting for the host to start</span>
      <button class="btn btn--quiet btn--large" type="button" @click="emit('leave')">
        Leave room
      </button>
    </div>
  </section>
</template>

<style scoped>
.lobby-panel {
  display: grid;
  gap: clamp(1.5rem, 3vw, 2rem);
  width: min(100%, 44rem);
}

.lobby-header {
  display: grid;
  gap: 0.6rem;
}

.room-code-card {
  display: grid;
  justify-items: start;
  gap: 0.75rem;
  padding-block: 1.25rem 1.5rem;
  border-block: 1px solid var(--rule);
}

.room-code-label {
  color: var(--text-muted);
}

/* The code is the one thing people read aloud, so it gets the space. */
.room-code {
  color: var(--paper);
  font-size: clamp(3rem, 12vw, 5.5rem);
  font-stretch: 80%;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  letter-spacing: 0.08em;
  line-height: 1;
}

.room-code-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  align-items: center;
}

.room-code-hint {
  color: var(--text-muted);
  font-size: var(--step--1);
}

.lobby-roster {
  display: grid;
  gap: 0.75rem;
}

.lobby-roster h3 {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  color: var(--paper);
  font-size: var(--step-1);
  font-weight: 650;
}

.lobby-roster__count {
  color: var(--text-muted);
  font-size: var(--step-0);
  font-variant-numeric: tabular-nums;
  font-weight: 400;
}

.lobby-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
  gap: 0.5rem;
  padding: 0;
  list-style: none;
}

.lobby-open-seat {
  display: grid;
  min-height: 5.25rem;
  place-items: center;
  border: 1px dashed var(--rule);
  border-radius: var(--radius-surface);
  color: var(--cyan-500);
}

.player-connection {
  color: var(--text-muted);
  font-size: var(--step--1);
}

.player-score-card--offline .player-connection {
  color: var(--wrong);
}
</style>
