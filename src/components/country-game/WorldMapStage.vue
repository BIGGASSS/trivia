<script setup lang="ts">
import { nextTick, onUnmounted, ref, toRef, watch } from "vue";
import type { AnswerState } from "@shared/multiplayer-types";
import type { CountryPath } from "@/types/game";
import { useMapViewport } from "@/composables/useMapViewport";
import { useRevealZoom } from "@/composables/useRevealZoom";

export interface RevealTarget {
  key: string;
  countryId: string;
}

const props = defineProps<{
  countries: CountryPath[];
  selectedCountryId: string | null;
  answerState: AnswerState;
  missedTargetCountryId: string | null;
  guessingDisabled: boolean;
  revealTarget: RevealTarget | null;
}>();

const emit = defineEmits<{
  countryGuess: [country: CountryPath];
}>();

const viewport = useMapViewport({
  onBeforeInteraction: () => {
    cancelRevealZoomAnimation();
  },
});
const {
  mapSvg,
  mapViewBox,
  zoomPercent,
  canZoomIn,
  canZoomOut,
  isPanning,
  isPinchingMap,
  zoomIn,
  zoomOut,
  resetZoom,
  handleMapWheel,
  handleMapPointerDown,
  handleMapPointerMove,
  handleMapPointerEnd,
  consumeSuppressedClick,
  teardown,
} = viewport;
const countriesRef = toRef(props, "countries");
const { cancelRevealZoomAnimation, playMissedCountryRevealZoom } = useRevealZoom(
  viewport,
  countriesRef,
);

let lastRevealZoomKey: string | null = null;

watch(
  () => ({ target: props.revealTarget, countryCount: props.countries.length }),
  ({ target }) => {
    if (!target) {
      lastRevealZoomKey = null;
      cancelRevealZoomAnimation(true);
      return;
    }

    if (target.key === lastRevealZoomKey) {
      return;
    }

    if (playMissedCountryRevealZoom(target.countryId)) {
      lastRevealZoomKey = target.key;
    }
  },
  // The stage mounts only while a game is playing, so a reveal may already
  // be pending when the watcher is registered (e.g. rejoining a locked
  // multiplayer round). Run immediately to catch that case.
  { immediate: true },
);

const handleCountryGuess = (country: CountryPath) => {
  if (consumeSuppressedClick()) {
    return;
  }

  emit("countryGuess", country);
};

// Roving tabindex: only one country path is in the tab order at a time so
// keyboard users are not forced through ~200 tab stops. Arrow keys move
// between countries; Enter/Space guesses the focused one.
const focusedCountryIndex = ref(0);

const getCountryTabIndex = (index: number) => {
  if (props.guessingDisabled) {
    return -1;
  }

  return index === focusedCountryIndex.value ? 0 : -1;
};

const focusCountryAt = (index: number) => {
  const countryCount = props.countries.length;

  if (countryCount === 0) {
    return;
  }

  const nextIndex = (index + countryCount) % countryCount;

  focusedCountryIndex.value = nextIndex;

  void nextTick(() => {
    const paths = mapSvg.value?.querySelectorAll<SVGPathElement>(".country");

    paths?.[nextIndex]?.focus();
  });
};

const handleCountryKeydown = (event: KeyboardEvent, country: CountryPath, index: number) => {
  switch (event.key) {
    case "Enter":
    case " ": {
      event.preventDefault();
      handleCountryGuess(country);
      return;
    }
    case "ArrowRight":
    case "ArrowDown": {
      event.preventDefault();
      focusCountryAt(index + 1);
      return;
    }
    case "ArrowLeft":
    case "ArrowUp": {
      event.preventDefault();
      focusCountryAt(index - 1);
      return;
    }
    case "Home": {
      event.preventDefault();
      focusCountryAt(0);
      return;
    }
    case "End": {
      event.preventDefault();
      focusCountryAt(props.countries.length - 1);
      return;
    }
    default:
  }
};

onUnmounted(() => {
  cancelRevealZoomAnimation();
  teardown();
});

defineExpose({ resetZoom });
</script>

<template>
  <div class="map-stage">
    <div class="zoom-controls" aria-label="Map zoom controls">
      <button
        class="zoom-button"
        type="button"
        aria-label="Zoom out"
        :disabled="!canZoomOut"
        @click="zoomOut"
      >
        −
      </button>
      <span class="zoom-level" aria-live="polite">{{ zoomPercent }}</span>
      <button
        class="zoom-button"
        type="button"
        aria-label="Zoom in"
        :disabled="!canZoomIn"
        @click="zoomIn"
      >
        +
      </button>
      <button class="zoom-reset" type="button" @click="resetZoom">Reset zoom</button>
    </div>

    <p class="map-touch-hint" aria-hidden="true">Pinch to zoom · Drag to move</p>

    <svg
      ref="mapSvg"
      class="world-map"
      :class="{ 'world-map--panning': isPanning || isPinchingMap }"
      :viewBox="mapViewBox"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="World map. Click the country named in the prompt. Use the zoom controls, mouse wheel, two-finger pinch, or drag to move around the map. With the keyboard, use the arrow keys to move between countries and Enter to guess."
      @wheel.prevent="handleMapWheel"
      @pointerdown="handleMapPointerDown"
      @pointermove.prevent="handleMapPointerMove"
      @pointerup="handleMapPointerEnd"
      @pointercancel="handleMapPointerEnd"
    >
      <rect class="ocean" x="-180" y="-90" width="360" height="180" />

      <path
        v-for="(country, index) in countries"
        :key="country.id"
        class="country"
        :class="{
          'country--correct': selectedCountryId === country.id && answerState === 'correct',
          'country--incorrect': selectedCountryId === country.id && answerState === 'incorrect',
          'country--missed-target': missedTargetCountryId === country.id,
        }"
        :d="country.path"
        fill-rule="evenodd"
        vector-effect="non-scaling-stroke"
        role="button"
        :tabindex="getCountryTabIndex(index)"
        :aria-label="`Guess ${country.name}`"
        :aria-disabled="guessingDisabled"
        @click="handleCountryGuess(country)"
        @focus="focusedCountryIndex = index"
        @keydown="handleCountryKeydown($event, country, index)"
      />
    </svg>
  </div>
</template>

<style scoped>
.map-stage {
  position: relative;
}

.zoom-controls {
  position: absolute;
  z-index: 2;
  top: clamp(0.6rem, 1.6vw, 1rem);
  left: clamp(0.6rem, 1.6vw, 1rem);
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.45rem;
  border: 1px solid rgba(71, 85, 105, 0.22);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.88);
  box-shadow: 0 14px 35px rgba(15, 23, 42, 0.16);
  backdrop-filter: blur(16px);
}

.zoom-button {
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  padding: 0;
  font-size: 1.25rem;
  line-height: 1;
}

.zoom-level {
  min-width: 4rem;
  color: var(--color-ink);
  font-size: 0.85rem;
  font-weight: 900;
  text-align: center;
}

.zoom-reset {
  padding: 0.58rem 0.85rem;
  color: var(--color-ink-soft);
  background: var(--color-surface-muted);
  box-shadow: none;
}

.zoom-reset:hover,
.zoom-reset:focus-visible {
  background: var(--color-surface-hover);
}

.map-touch-hint {
  position: absolute;
  right: clamp(0.6rem, 1.6vw, 1rem);
  bottom: clamp(0.6rem, 1.6vw, 1rem);
  z-index: 2;
  display: none;
  max-width: calc(100% - 1.2rem);
  margin: 0;
  border: 1px solid rgba(71, 85, 105, 0.18);
  border-radius: 999px;
  padding: 0.45rem 0.7rem;
  color: var(--color-ink-soft);
  background: rgba(255, 255, 255, 0.84);
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.14);
  font-size: 0.78rem;
  font-weight: 900;
  line-height: 1;
  pointer-events: none;
  backdrop-filter: blur(14px);
}

.world-map {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 2 / 1;
  overflow: hidden;
  border-radius: 18px;
  background: var(--color-ocean);
  cursor: grab;
  shape-rendering: optimizeSpeed;
  touch-action: none;
  user-select: none;
}

.world-map--panning {
  cursor: grabbing;
}

.ocean {
  fill: var(--color-ocean);
}

.country {
  cursor: pointer;
  fill: var(--color-surface-soft);
  stroke: var(--color-slate);
  stroke-linejoin: round;
  stroke-width: 0.35;
  transition:
    fill 120ms ease,
    stroke 120ms ease;
  outline: none;
}

.world-map--panning .country {
  cursor: grabbing;
  pointer-events: none;
}

.country:hover,
.country:focus-visible {
  fill: #fde68a;
  stroke: var(--color-ink-soft);
}

.country:focus-visible {
  stroke-width: 1;
}

.country--correct,
.country--correct:hover,
.country--correct:focus-visible {
  fill: var(--color-success);
  stroke: var(--color-success-deep);
}

.country--incorrect,
.country--incorrect:hover,
.country--incorrect:focus-visible {
  fill: var(--color-danger);
  stroke: var(--color-danger-deep);
}

.country--missed-target,
.country--missed-target:hover,
.country--missed-target:focus-visible {
  fill: var(--color-success);
  stroke: var(--color-success-deep);
}

@media (hover: none), (pointer: coarse) {
  .map-touch-hint {
    display: inline-flex;
  }
}
</style>
