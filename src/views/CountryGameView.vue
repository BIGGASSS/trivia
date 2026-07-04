<script setup lang="ts">
import { useRouter } from "vue-router";
import WorldMap from "@/components/WorldMap.vue";

const router = useRouter();

const returnHome = () => {
  void router.push("/");
};
</script>

<template>
  <section class="game-page" aria-label="Country guessing game">
    <button class="back-button" type="button" @click="returnHome">← Back to homepage</button>
    <WorldMap />
  </section>
</template>

<style scoped>
.game-page {
  display: grid;
  width: min(100%, 1680px);
  min-height: calc(100dvh - clamp(1rem, 2.8vh, 2rem));
  margin: 0 auto;
  grid-template-rows: auto minmax(0, 1fr);
  gap: clamp(0.5rem, 1vh, 0.75rem);
}

.back-button {
  justify-self: start;
  cursor: pointer;
  border: 1px solid rgba(71, 85, 105, 0.24);
  border-radius: 999px;
  padding: 0.62rem 0.95rem;
  color: var(--color-ink);
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
  font-weight: 900;
  line-height: 1;
  transition:
    background-color 160ms ease,
    border-color 160ms ease,
    color 160ms ease,
    transform 160ms ease;
}

.back-button:hover,
.back-button:focus-visible {
  border-color: rgba(37, 99, 235, 0.45);
  color: var(--color-primary-strong);
  transform: translateY(-1px);
}
</style>
