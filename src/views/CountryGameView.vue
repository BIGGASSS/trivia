<script setup lang="ts">
import { useRouter } from "vue-router";
import BrandMark from "@/components/BrandMark.vue";
import WorldMap from "@/components/WorldMap.vue";

const router = useRouter();

const returnHome = () => {
  void router.push("/");
};
</script>

<template>
  <section class="game-page" aria-label="Country guessing game">
    <button class="back-button" type="button" @click="returnHome">
      <BrandMark />
      World Trivia
      <span class="sr-only">homepage</span>
    </button>
    <WorldMap />
  </section>
</template>

<style scoped>
.game-page {
  display: grid;
  width: min(100%, 1680px);
  min-height: calc(100dvh - clamp(1rem, 3vw, 2.5rem));
  margin: 0 auto;
  grid-template-rows: auto minmax(0, 1fr);
  gap: clamp(0.5rem, 1.2vh, 0.85rem);
}

.back-button {
  display: inline-flex;
  justify-self: start;
  align-items: center;
  gap: 0.55rem;
  min-height: 2.5rem;
  border: 0;
  border-radius: var(--radius-control);
  padding: 0.25rem 0.5rem 0.25rem 0.25rem;
  color: var(--paper);
  background: transparent;
  font-size: 1.0625rem;
  font-weight: 650;
  cursor: pointer;
}

.back-button:hover {
  background: rgb(238 242 239 / 0.08);
}
</style>
