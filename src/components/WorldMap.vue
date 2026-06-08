<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

type Position = number[];
type LinearRing = Position[];
type PolygonCoordinates = LinearRing[];
type MultiPolygonCoordinates = PolygonCoordinates[];
type AnswerState = "idle" | "correct" | "incorrect";

interface MapPoint {
  x: number;
  y: number;
}

type CountryGeometry =
  | {
      type: "Polygon";
      coordinates: PolygonCoordinates;
    }
  | {
      type: "MultiPolygon";
      coordinates: MultiPolygonCoordinates;
    };

interface CountryFeature {
  type: "Feature";
  id?: string;
  properties?: {
    name?: string;
  };
  geometry: CountryGeometry | null;
}

interface CountryFeatureCollection {
  type: "FeatureCollection";
  features: CountryFeature[];
}

interface CountryPath {
  id: string;
  name: string;
  path: string;
}

const mapBounds = {
  x: -180,
  y: -90,
  width: 360,
  height: 180,
};
const minimumMapZoom = 1;
const maximumMapZoom = 8;
const zoomStep = 1.35;
const dragClickThreshold = 4;

const countries = ref<CountryPath[]>([]);
const currentCountry = ref<CountryPath | null>(null);
const score = ref(0);
const attempts = ref(0);
const streak = ref(0);
const feedbackMessage = ref("Click the prompted country on the map.");
const answerState = ref<AnswerState>("idle");
const lastSelectedCountryId = ref<string | null>(null);
const isRoundLocked = ref(false);
const isLoading = ref(true);
const errorMessage = ref("");
const nextRoundTimeout = ref<number | null>(null);
const mapSvg = ref<SVGSVGElement | null>(null);
const zoomLevel = ref(1);
const mapCenter = ref<MapPoint>({ x: 0, y: 0 });
const isPanning = ref(false);
const panStartClient = ref<MapPoint | null>(null);
const panStartCenter = ref<MapPoint>({ x: 0, y: 0 });
const panStartScale = ref<MapPoint>({ x: 1, y: 1 });
const hasDraggedMap = ref(false);
const suppressNextCountryClick = ref(false);

const accuracy = computed(() => {
  if (attempts.value === 0) {
    return "0%";
  }

  return `${Math.round((score.value / attempts.value) * 100)}%`;
});

const mapViewBox = computed(() => {
  const width = mapBounds.width / zoomLevel.value;
  const height = mapBounds.height / zoomLevel.value;
  const x = mapCenter.value.x - width / 2;
  const y = mapCenter.value.y - height / 2;

  return `${x} ${y} ${width} ${height}`;
});

const zoomPercent = computed(() => `${Math.round(zoomLevel.value * 100)}%`);
const canZoomIn = computed(() => zoomLevel.value < maximumMapZoom);
const canZoomOut = computed(() => zoomLevel.value > minimumMapZoom);

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

const getViewBoxSize = (zoom: number) => ({
  width: mapBounds.width / zoom,
  height: mapBounds.height / zoom,
});

const getClampedCenter = (center: MapPoint, zoom: number) => {
  const { width, height } = getViewBoxSize(zoom);
  const minimumX = mapBounds.x + width / 2;
  const maximumX = mapBounds.x + mapBounds.width - width / 2;
  const minimumY = mapBounds.y + height / 2;
  const maximumY = mapBounds.y + mapBounds.height - height / 2;

  return {
    x: clamp(center.x, minimumX, maximumX),
    y: clamp(center.y, minimumY, maximumY),
  };
};

const setMapCenter = (center: MapPoint) => {
  mapCenter.value = getClampedCenter(center, zoomLevel.value);
};

const coordinateToPoint = (coordinate: Position) => {
  const longitude = coordinate[0] ?? 0;
  const latitude = coordinate[1] ?? 0;

  return `${longitude},${-latitude}`;
};

const ringToPath = (ring: LinearRing) => {
  const firstCoordinate = ring[0];

  if (!firstCoordinate) {
    return "";
  }

  const commands = [`M${coordinateToPoint(firstCoordinate)}`];

  for (let index = 1; index < ring.length; index += 1) {
    const coordinate = ring[index];

    if (coordinate) {
      commands.push(`L${coordinateToPoint(coordinate)}`);
    }
  }

  commands.push("Z");

  return commands.join(" ");
};

const geometryToPath = (geometry: CountryGeometry | null) => {
  if (!geometry) {
    return "";
  }

  if (geometry.type === "Polygon") {
    return geometry.coordinates.map(ringToPath).join(" ");
  }

  return geometry.coordinates
    .flatMap((polygon) => polygon.map(ringToPath))
    .join(" ");
};

const clearPendingRound = () => {
  if (nextRoundTimeout.value !== null) {
    window.clearTimeout(nextRoundTimeout.value);
    nextRoundTimeout.value = null;
  }
};

const getRandomCountry = (excludedCountryId?: string) => {
  const choices = excludedCountryId
    ? countries.value.filter((country) => country.id !== excludedCountryId)
    : countries.value;
  const availableChoices = choices.length > 0 ? choices : countries.value;
  const randomIndex = Math.floor(Math.random() * availableChoices.length);
  const country = availableChoices[randomIndex];

  return country ?? null;
};

const startNextRound = () => {
  clearPendingRound();

  currentCountry.value = getRandomCountry(currentCountry.value?.id);
  answerState.value = "idle";
  lastSelectedCountryId.value = null;
  isRoundLocked.value = false;
  feedbackMessage.value = "Click the prompted country on the map.";
};

const loadCountries = async () => {
  try {
    const response = await fetch("/countries.geo.json");

    if (!response.ok) {
      throw new Error(`Could not load the map (${response.status})`);
    }

    const data = (await response.json()) as CountryFeatureCollection;

    countries.value = data.features
      .map((feature, index) => {
        const name = feature.properties?.name ?? `Country ${index + 1}`;
        const id = feature.id ?? name;
        const path = geometryToPath(feature.geometry);

        return { id, name, path };
      })
      .filter((country) => country.path.length > 0);

    startNextRound();
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : "Could not load the map.";
  } finally {
    isLoading.value = false;
  }
};

const getSvgPoint = (event: PointerEvent | WheelEvent) => {
  const svg = mapSvg.value;

  if (!svg) {
    return null;
  }

  const transformMatrix = svg.getScreenCTM();

  if (!transformMatrix) {
    return null;
  }

  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;

  const transformedPoint = point.matrixTransform(transformMatrix.inverse());

  return {
    x: transformedPoint.x,
    y: transformedPoint.y,
  };
};

const setZoom = (nextZoom: number, focalPoint?: MapPoint) => {
  const previousZoom = zoomLevel.value;
  const clampedZoom = clamp(nextZoom, minimumMapZoom, maximumMapZoom);

  if (clampedZoom === previousZoom) {
    return;
  }

  const previousSize = getViewBoxSize(previousZoom);
  const nextSize = getViewBoxSize(clampedZoom);
  let nextCenter = mapCenter.value;

  if (focalPoint) {
    const previousX = mapCenter.value.x - previousSize.width / 2;
    const previousY = mapCenter.value.y - previousSize.height / 2;
    const focalRatioX = (focalPoint.x - previousX) / previousSize.width;
    const focalRatioY = (focalPoint.y - previousY) / previousSize.height;

    nextCenter = {
      x: focalPoint.x + (0.5 - focalRatioX) * nextSize.width,
      y: focalPoint.y + (0.5 - focalRatioY) * nextSize.height,
    };
  }

  zoomLevel.value = clampedZoom;
  mapCenter.value = getClampedCenter(nextCenter, clampedZoom);
};

const zoomIn = () => {
  setZoom(zoomLevel.value * zoomStep);
};

const zoomOut = () => {
  setZoom(zoomLevel.value / zoomStep);
};

const resetZoom = () => {
  zoomLevel.value = minimumMapZoom;
  mapCenter.value = { x: 0, y: 0 };
};

const handleMapWheel = (event: WheelEvent) => {
  const focalPoint = getSvgPoint(event);
  const zoomFactor = event.deltaY < 0 ? zoomStep : 1 / zoomStep;

  setZoom(zoomLevel.value * zoomFactor, focalPoint ?? undefined);
};

const handleMapPointerDown = (event: PointerEvent) => {
  if (event.button !== 0) {
    return;
  }

  const svg = mapSvg.value;

  if (!svg) {
    return;
  }

  const bounds = svg.getBoundingClientRect();
  const { width, height } = getViewBoxSize(zoomLevel.value);

  isPanning.value = true;
  hasDraggedMap.value = false;
  panStartClient.value = { x: event.clientX, y: event.clientY };
  panStartCenter.value = { ...mapCenter.value };
  panStartScale.value = {
    x: width / bounds.width,
    y: height / bounds.height,
  };
};

const handleMapPointerMove = (event: PointerEvent) => {
  if (!isPanning.value || !panStartClient.value) {
    return;
  }

  const deltaX = event.clientX - panStartClient.value.x;
  const deltaY = event.clientY - panStartClient.value.y;

  if (Math.hypot(deltaX, deltaY) > dragClickThreshold) {
    hasDraggedMap.value = true;
  }

  setMapCenter({
    x: panStartCenter.value.x - deltaX * panStartScale.value.x,
    y: panStartCenter.value.y - deltaY * panStartScale.value.y,
  });
};

const stopPanning = () => {
  if (!isPanning.value) {
    return;
  }

  if (hasDraggedMap.value) {
    suppressNextCountryClick.value = true;
    window.setTimeout(() => {
      suppressNextCountryClick.value = false;
    }, 0);
  }

  isPanning.value = false;
  panStartClient.value = null;
};

const handleCountryGuess = (country: CountryPath) => {
  if (suppressNextCountryClick.value) {
    suppressNextCountryClick.value = false;
    return;
  }

  if (!currentCountry.value || isRoundLocked.value) {
    return;
  }

  attempts.value += 1;
  lastSelectedCountryId.value = country.id;

  if (country.id === currentCountry.value.id) {
    score.value += 1;
    streak.value += 1;
    answerState.value = "correct";
    isRoundLocked.value = true;
    feedbackMessage.value = `Correct! That was ${country.name}.`;

    nextRoundTimeout.value = window.setTimeout(() => {
      startNextRound();
    }, 900);

    return;
  }

  streak.value = 0;
  answerState.value = "incorrect";
  feedbackMessage.value = `${country.name} is not ${currentCountry.value.name}. Try again.`;
};

const skipCountry = () => {
  streak.value = 0;
  startNextRound();
};

const resetGame = () => {
  score.value = 0;
  attempts.value = 0;
  streak.value = 0;
  startNextRound();
};

onMounted(() => {
  void loadCountries();
});

onUnmounted(() => {
  clearPendingRound();
});
</script>

<template>
  <section class="map-panel" aria-label="Country guessing minigame">
    <div v-if="isLoading" class="map-message">Loading map…</div>
    <div v-else-if="errorMessage" class="map-message" role="alert">
      {{ errorMessage }}
    </div>

    <template v-else>
      <header class="game-header">
        <div class="prompt-card" aria-live="polite">
          <p class="eyebrow">World map challenge</p>
          <h2>
            Click
            <span class="target-country">
              {{ currentCountry?.name ?? "the highlighted country" }}
            </span>
          </h2>
          <p
            class="feedback"
            :class="{
              'feedback--correct': answerState === 'correct',
              'feedback--incorrect': answerState === 'incorrect',
            }"
          >
            {{ feedbackMessage }}
          </p>
        </div>

        <dl class="scoreboard" aria-label="Game score">
          <div>
            <dt>Score</dt>
            <dd>{{ score }}</dd>
          </div>
          <div>
            <dt>Attempts</dt>
            <dd>{{ attempts }}</dd>
          </div>
          <div>
            <dt>Accuracy</dt>
            <dd>{{ accuracy }}</dd>
          </div>
          <div>
            <dt>Streak</dt>
            <dd>{{ streak }}</dd>
          </div>
        </dl>

        <div class="game-actions">
          <button type="button" @click="skipCountry">Skip</button>
          <button type="button" @click="resetGame">Reset</button>
        </div>
      </header>

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
          <button class="zoom-reset" type="button" @click="resetZoom">
            Reset zoom
          </button>
        </div>

        <svg
          ref="mapSvg"
          class="world-map"
          :class="{ 'world-map--panning': isPanning }"
          :viewBox="mapViewBox"
          role="img"
          aria-label="World map. Click the country named in the prompt. Use the zoom controls, mouse wheel, or drag to move around the map."
          @wheel.prevent="handleMapWheel"
          @pointerdown="handleMapPointerDown"
          @pointermove.prevent="handleMapPointerMove"
          @pointerup="stopPanning"
          @pointercancel="stopPanning"
        >
          <rect class="ocean" x="-180" y="-90" width="360" height="180" />

          <path
            v-for="country in countries"
            :key="country.id"
            class="country"
            :class="{
              'country--correct':
                lastSelectedCountryId === country.id && answerState === 'correct',
              'country--incorrect':
                lastSelectedCountryId === country.id && answerState === 'incorrect',
            }"
            :d="country.path"
            fill-rule="evenodd"
            vector-effect="non-scaling-stroke"
            role="button"
            tabindex="0"
            :aria-label="`Guess ${country.name}`"
            :aria-disabled="isRoundLocked"
            @click="handleCountryGuess(country)"
            @keydown.enter.prevent="handleCountryGuess(country)"
            @keydown.space.prevent="handleCountryGuess(country)"
          />
        </svg>
      </div>
    </template>
  </section>
</template>

<style scoped>
.map-panel {
  width: min(100%, 1400px);
  padding: clamp(0.75rem, 2vw, 2rem);
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 24px;
  background:
    radial-gradient(circle at 15% 20%, rgba(125, 211, 252, 0.35), transparent 30%),
    linear-gradient(135deg, rgba(248, 250, 252, 0.92), rgba(226, 232, 240, 0.86));
  box-shadow: 0 24px 80px rgba(15, 23, 42, 0.18);
}

.game-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: clamp(0.75rem, 2vw, 1.25rem);
  align-items: stretch;
  margin-bottom: clamp(0.75rem, 2vw, 1.5rem);
}

.prompt-card,
.scoreboard,
.game-actions {
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
}

.prompt-card {
  padding: clamp(1rem, 2vw, 1.5rem);
}

.eyebrow {
  margin-bottom: 0.25rem;
  color: #2563eb;
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h2 {
  color: #0f172a;
  font-size: clamp(1.75rem, 4vw, 3.25rem);
  font-weight: 900;
  line-height: 1;
}

.target-country {
  color: #ea580c;
  font-weight: inherit;
}

.feedback {
  min-height: 1.6em;
  margin-top: 0.75rem;
  color: #475569;
  font-weight: 700;
}

.feedback--correct {
  color: #15803d;
}

.feedback--incorrect {
  color: #b91c1c;
}

.scoreboard {
  display: grid;
  grid-template-columns: repeat(2, minmax(5.5rem, 1fr));
  gap: 0.75rem;
  min-width: 18rem;
  padding: 1rem;
}

.scoreboard div {
  display: grid;
  gap: 0.15rem;
}

.scoreboard dt {
  color: #64748b;
  font-size: 0.75rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.scoreboard dd {
  color: #0f172a;
  font-size: 1.6rem;
  font-weight: 900;
  line-height: 1;
}

.game-actions {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  justify-content: center;
  padding: 1rem;
}

button {
  cursor: pointer;
  border: 0;
  border-radius: 999px;
  padding: 0.7rem 1.1rem;
  color: #ffffff;
  background: #2563eb;
  font-weight: 900;
  transition:
    background-color 160ms ease,
    opacity 160ms ease,
    transform 160ms ease;
}

button:hover,
button:focus-visible {
  background: #1d4ed8;
  transform: translateY(-1px);
}

button:disabled,
button:disabled:hover,
button:disabled:focus-visible {
  cursor: not-allowed;
  opacity: 0.45;
  transform: none;
}

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
  min-width: 3.5rem;
  color: #0f172a;
  font-size: 0.85rem;
  font-weight: 900;
  text-align: center;
}

.zoom-reset {
  padding: 0.58rem 0.85rem;
  color: #1e293b;
  background: #e2e8f0;
  box-shadow: none;
}

.zoom-reset:hover,
.zoom-reset:focus-visible {
  background: #cbd5e1;
}

.world-map {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 2 / 1;
  overflow: hidden;
  border-radius: 18px;
  background: #c7e8ff;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.world-map--panning {
  cursor: grabbing;
}

.ocean {
  fill: #c7e8ff;
}

.country {
  cursor: pointer;
  fill: #f8fafc;
  stroke: #475569;
  stroke-linejoin: round;
  stroke-width: 0.35;
  transition:
    fill 160ms ease,
    filter 160ms ease,
    stroke 160ms ease;
  outline: none;
}

.world-map--panning .country {
  cursor: grabbing;
}

.country:hover,
.country:focus-visible {
  fill: #fde68a;
  filter: drop-shadow(0 0 1.5px rgba(15, 23, 42, 0.45));
  stroke: #1e293b;
}

.country--correct,
.country--correct:hover,
.country--correct:focus-visible {
  fill: #22c55e;
  stroke: #14532d;
}

.country--incorrect,
.country--incorrect:hover,
.country--incorrect:focus-visible {
  fill: #ef4444;
  stroke: #7f1d1d;
}

.map-message {
  display: grid;
  min-height: min(70vh, 720px);
  place-items: center;
  color: #334155;
  font-size: clamp(1rem, 2vw, 1.25rem);
}

@media (max-width: 980px) {
  .game-header {
    grid-template-columns: 1fr;
  }

  .scoreboard {
    min-width: 0;
  }

  .game-actions {
    flex-direction: row;
  }
}

@media (max-width: 560px) {
  .zoom-controls {
    right: 0.55rem;
    left: 0.55rem;
    justify-content: center;
    border-radius: 18px;
  }

  .zoom-reset {
    padding-right: 0.7rem;
    padding-left: 0.7rem;
  }
}
</style>
