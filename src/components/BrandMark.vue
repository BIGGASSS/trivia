<script setup lang="ts">
// A circle with two meridians and the equator: the smallest possible globe,
// drawn in the same line weight as the map's graticule.
</script>

<template>
  <svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="10.25" />
    <ellipse cx="12" cy="12" rx="4.6" ry="10.25" />
    <path d="M1.75 12h20.5" />
    <circle class="brand-mark__pin" cx="15.6" cy="8.2" r="2.1" />
  </svg>
</template>

<style scoped>
.brand-mark {
  width: 1.5rem;
  height: 1.5rem;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
}

.brand-mark__pin {
  fill: var(--signal);
  stroke: none;
}
</style>
