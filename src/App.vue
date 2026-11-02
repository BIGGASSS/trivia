<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { countryGamePath } from "@shared/game-constants";

const route = useRoute();
const isGameRoute = computed(() => route.path.startsWith(countryGamePath));
</script>

<template>
  <main class="app-shell" :class="{ 'app-shell--game': isGameRoute }">
    <RouterView />
  </main>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  padding: clamp(1rem, 3vw, 2.5rem);
}

.app-shell--game {
  min-height: 100dvh;
  padding: clamp(0.5rem, 1.5vw, 1.25rem);
}
</style>
