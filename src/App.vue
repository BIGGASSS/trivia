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
  padding: clamp(1rem, 2.5vw, 2rem);
  background:
    radial-gradient(circle at top left, rgba(59, 130, 246, 0.24), transparent 34rem),
    radial-gradient(circle at bottom right, rgba(249, 115, 22, 0.2), transparent 30rem),
    linear-gradient(135deg, #eff6ff 0%, #f8fafc 46%, #fff7ed 100%);
}

.app-shell--game {
  min-height: 100dvh;
  padding-block: clamp(0.5rem, 1.4vh, 1rem);
}

@media (max-width: 560px) {
  .app-shell {
    padding: 0.75rem;
  }
}
</style>
