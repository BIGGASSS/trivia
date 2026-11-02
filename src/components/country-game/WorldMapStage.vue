<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, toRef, watch } from "vue";
import type { AnswerState } from "@shared/multiplayer-types";
import type { CountryPath } from "@/types/game";
import { useMapViewport } from "@/composables/useMapViewport";
import { useRevealZoom } from "@/composables/useRevealZoom";
import { getLargestSubpathBounds } from "@/utils/svg-path-bounds";
import { buildGraticulePath, primeLinesPath } from "@/utils/graticule";

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

const graticulePath = buildGraticulePath();

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
  if (props.guessingDisabled || consumeSuppressedClick()) {
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

// Only keyboard focus should scroll the map to the focused country.
let lastInputWasPointer = false;

const markPointerInput = () => {
  lastInputWasPointer = true;
};

const markKeyboardInput = () => {
  lastInputWasPointer = false;
};

onMounted(() => {
  document.addEventListener("pointerdown", markPointerInput, true);
  document.addEventListener("keydown", markKeyboardInput, true);
});

const handleCountryFocus = (index: number) => {
  focusedCountryIndex.value = index;

  // Pointer focus must not move the country out from under a click or drag.
  // Touch taps focus the path after pointerup (via compatibility mouse
  // events), when the pan has already ended, so also check input modality.
  if (props.guessingDisabled || lastInputWasPointer || isPanning.value || isPinchingMap.value) {
    return;
  }

  const country = props.countries[index];
  const bounds = country && getLargestSubpathBounds(country.path);
  if (!bounds) {
    return;
  }

  cancelRevealZoomAnimation();
  const state = viewport.getCurrentMapViewState();
  const { width, height } = viewport.getViewBoxSize(state.zoom);
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const visibleRatio = 0.8;

  if (
    Math.abs(center.x - state.center.x) + bounds.width / 2 <= (width * visibleRatio) / 2 &&
    Math.abs(center.y - state.center.y) + bounds.height / 2 <= (height * visibleRatio) / 2
  ) {
    return;
  }

  // Reveal the mainland instantly, zooming out only if needed. This also
  // works with reduced motion and does not depend on SVG getBBox support.
  viewport.setMapViewState({
    zoom:
      state.zoom *
      Math.min(
        1,
        (width * visibleRatio) / Math.max(bounds.width, 0.75),
        (height * visibleRatio) / Math.max(bounds.height, 0.75),
      ),
    center,
  });
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

    paths?.[nextIndex]?.focus({ preventScroll: true });
  });
};

const handleCountryKeydown = (event: KeyboardEvent, country: CountryPath, index: number) => {
  if (props.guessingDisabled) {
    return;
  }

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
  document.removeEventListener("pointerdown", markPointerInput, true);
  document.removeEventListener("keydown", markKeyboardInput, true);
  cancelRevealZoomAnimation();
  teardown();
});

defineExpose({ resetZoom });
</script>

<template>
  <div class="map-stage">
    <div class="zoom-controls" role="group" aria-label="Map zoom controls">
      <button
        class="zoom-button"
        type="button"
        aria-label="Zoom out"
        :disabled="!canZoomOut"
        @click="zoomOut"
      >
        <span class="zoom-glyph" aria-hidden="true">−</span>
      </button>
      <span class="zoom-level" aria-live="polite">{{ zoomPercent }}</span>
      <button
        class="zoom-button"
        type="button"
        aria-label="Zoom in"
        :disabled="!canZoomIn"
        @click="zoomIn"
      >
        <span class="zoom-glyph" aria-hidden="true">+</span>
      </button>
      <button class="zoom-reset" type="button" @click="resetZoom">Reset zoom</button>
    </div>

    <p class="map-touch-hint" aria-hidden="true">Pinch to zoom, drag to move</p>

    <svg
      ref="mapSvg"
      class="world-map"
      :class="{ 'world-map--panning': isPanning || isPinchingMap }"
      :viewBox="mapViewBox"
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label="World map. Click the country named in the prompt. Use the zoom controls, mouse wheel, two-finger pinch, or drag to move around the map. With the keyboard, use the arrow keys to move between countries and Enter to guess."
      @wheel.prevent="handleMapWheel"
      @pointerdown="handleMapPointerDown"
      @pointermove.prevent="handleMapPointerMove"
      @pointerup="handleMapPointerEnd"
      @pointercancel="handleMapPointerEnd"
      @lostpointercapture="handleMapPointerEnd"
    >
      <rect class="ocean" x="-180" y="-90" width="360" height="180" />
      <path class="graticule" :d="graticulePath" vector-effect="non-scaling-stroke" />
      <path
        class="graticule graticule--prime"
        :d="primeLinesPath"
        vector-effect="non-scaling-stroke"
      />

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
        @focus="handleCountryFocus(index)"
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
  top: 0.75rem;
  left: 0.75rem;
  display: flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius-control);
  padding: 3px;
  background: rgb(14 37 87 / 0.88);
  backdrop-filter: blur(8px);
}

.zoom-controls button {
  display: inline-grid;
  min-width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  border: 0;
  border-radius: 4px;
  padding: 0 0.6rem;
  color: var(--paper);
  background: transparent;
  font-size: var(--step--1);
  font-weight: 600;
  cursor: pointer;
}

.zoom-controls button:hover {
  background: rgb(238 242 239 / 0.12);
}

.zoom-controls button:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.zoom-controls button:disabled:hover {
  background: transparent;
}

.zoom-button {
  padding: 0;
}

.zoom-glyph {
  font-size: 1.25rem;
  font-weight: 500;
  line-height: 1;
}

.zoom-level {
  min-width: 3.25rem;
  color: var(--text-muted);
  font-size: var(--step--1);
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.zoom-controls .zoom-reset {
  margin-left: 2px;
  border-left: 1px solid var(--rule);
  border-radius: 0 4px 4px 0;
}

.map-touch-hint {
  position: absolute;
  right: 0.75rem;
  bottom: 0.75rem;
  z-index: 2;
  display: none;
  max-width: calc(100% - 1.5rem);
  margin: 0;
  border-radius: var(--radius-control);
  padding: 0.35rem 0.6rem;
  color: var(--paper);
  background: rgb(14 37 87 / 0.85);
  font-size: var(--step--1);
  line-height: 1.2;
  pointer-events: none;
}

.world-map {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 2 / 1;
  overflow: hidden;
  border: 1px solid var(--rule);
  border-radius: var(--radius-surface);
  background: var(--cyan-900);
  cursor: grab;
  shape-rendering: geometricPrecision;
  touch-action: none;
  user-select: none;
}

.world-map--panning {
  cursor: grabbing;
}

.ocean {
  fill: var(--cyan-900);
}

.graticule {
  fill: none;
  stroke: var(--cyan-500);
  stroke-width: 0.6;
  opacity: 0.4;
  pointer-events: none;
}

.graticule--prime {
  stroke-dasharray: 4 4;
  opacity: 0.65;
}

.country {
  cursor: pointer;
  fill: var(--paper-dim);
  stroke: var(--cyan-700);
  stroke-linejoin: round;
  stroke-width: 0.6;
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
  fill: #fff;
  stroke: var(--cyan-900);
}

.country--correct,
.country--correct:hover,
.country--correct:focus-visible {
  fill: var(--correct);
  stroke: var(--cyan-950);
}

.country--incorrect,
.country--incorrect:hover,
.country--incorrect:focus-visible {
  fill: var(--wrong);
  stroke: var(--cyan-950);
}

/* The answer, after a miss, is shown in the same ink as the prompt text. */
.country--missed-target,
.country--missed-target:hover,
.country--missed-target:focus-visible {
  fill: var(--signal);
  stroke: var(--cyan-950);
  animation: target-pulse 1.4s ease-out 2;
}

@keyframes target-pulse {
  0%,
  100% {
    stroke-width: 0.6;
  }

  35% {
    stroke-width: 5;
    stroke: var(--signal);
  }
}

.country:focus-visible {
  stroke: var(--cyan-950);
  stroke-width: 2;
}

@media (prefers-reduced-motion: reduce) {
  .country {
    transition: none;
  }

  .country--missed-target {
    animation: none;
  }
}

@media (hover: none), (pointer: coarse) {
  .map-touch-hint {
    display: inline-flex;
  }
}
</style>
