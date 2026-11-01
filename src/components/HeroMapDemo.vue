<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { CountryPath } from "@/types/game";
import { useCountriesData } from "@/composables/useCountriesData";
import { buildGraticulePath, primeLinesPath } from "@/utils/graticule";

// Large, recognisable-by-shape countries that are still easy to confuse
// with a neighbour. Falls back to the first loaded country.
const demoCandidates = ["Mongolia", "Madagascar", "Peru", "Chad", "Kazakhstan", "Iran", "Bolivia"];

const { countries, isLoading, loadCountries } = useCountriesData();

const pickTarget = (loaded: CountryPath[]) => {
  const pool = loaded.filter((country) => demoCandidates.includes(country.name));
  const choices = pool.length > 0 ? pool : loaded.slice(0, 1);

  return choices[Math.floor(Math.random() * choices.length)] ?? null;
};

const target = ref<CountryPath | null>(null);
const guessedId = ref<string | null>(null);
const revealed = ref(false);

const graticule = buildGraticulePath();
const targetName = computed(() => target.value?.name ?? "Mongolia");

const outcome = computed(() => {
  if (!revealed.value) {
    return null;
  }

  if (!guessedId.value) {
    return `${targetName.value} is marked in yellow.`;
  }

  if (guessedId.value === target.value?.id) {
    return `Correct. That's ${targetName.value}.`;
  }

  const guessedName = countries.value.find((country) => country.id === guessedId.value)?.name;

  return `That's ${guessedName ?? "another country"}. ${targetName.value} is marked in yellow.`;
});

const guess = (country: CountryPath) => {
  if (revealed.value) {
    return;
  }

  guessedId.value = country.id;
  revealed.value = true;
};

const showAnswer = () => {
  revealed.value = true;
};

const tryAnother = () => {
  const loaded = countries.value;
  const previous = target.value;
  let next = pickTarget(loaded);

  for (let attempt = 0; attempt < 4 && next && previous && next.id === previous.id; attempt += 1) {
    next = pickTarget(loaded);
  }

  target.value = next;
  guessedId.value = null;
  revealed.value = false;
};

const countryClass = (country: CountryPath) => {
  if (!revealed.value) {
    return null;
  }

  if (country.id === target.value?.id) {
    return guessedId.value === country.id ? "demo-country--correct" : "demo-country--answer";
  }

  return country.id === guessedId.value ? "demo-country--wrong" : null;
};

onMounted(async () => {
  await loadCountries();
  target.value = pickTarget(countries.value);
});
</script>

<template>
  <div class="hero-demo">
    <h1 class="hero-question">
      Where is <span class="hero-question__country">{{ targetName }}</span
      >?
    </h1>

    <div class="hero-map-frame" :class="{ 'hero-map-frame--loading': isLoading }">
      <svg
        class="hero-map"
        viewBox="-180 -90 360 180"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        focusable="false"
      >
        <rect class="hero-ocean" x="-180" y="-90" width="360" height="180" />
        <path class="hero-graticule" :d="graticule" vector-effect="non-scaling-stroke" />
        <path class="hero-prime" :d="primeLinesPath" vector-effect="non-scaling-stroke" />
        <path
          v-for="country in countries"
          :key="country.id"
          class="demo-country"
          :class="countryClass(country)"
          :d="country.path"
          fill-rule="evenodd"
          vector-effect="non-scaling-stroke"
          @click="guess(country)"
        />
      </svg>
    </div>

    <div class="hero-demo-bar">
      <p class="hero-demo-status" aria-live="polite">
        <template v-if="outcome">{{ outcome }}</template>
        <template v-else>Try it: click {{ targetName }} on the map.</template>
      </p>
      <button v-if="!revealed" class="btn btn--quiet" type="button" @click="showAnswer">
        Show answer
      </button>
      <button v-else class="btn btn--quiet" type="button" @click="tryAnother">Try another</button>
    </div>
  </div>
</template>

<style scoped>
.hero-demo {
  display: grid;
  gap: clamp(1rem, 2.5vw, 1.75rem);
}

.hero-question {
  max-width: 14ch;
  color: var(--paper);
  font-size: clamp(2.75rem, 8.5vw, 7.5rem);
  font-stretch: 78%;
  font-variation-settings: "opsz" 96;
  font-weight: 760;
  letter-spacing: -0.025em;
  line-height: 0.92;
  text-wrap: balance;
}

/* The prompt is the whole point: it is set in the target ink, the same
 * yellow the country turns on the map once revealed. */
.hero-question__country {
  color: var(--signal);
}

.hero-map-frame {
  overflow: hidden;
  border: 1px solid var(--rule);
  border-radius: var(--radius-surface);
  background: var(--cyan-900);
}

.hero-map {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 2 / 1;
}

.hero-map-frame--loading .hero-map {
  opacity: 0.6;
}

.hero-ocean {
  fill: var(--cyan-900);
}

.hero-graticule,
.hero-prime {
  fill: none;
  stroke: var(--cyan-500);
  stroke-width: 0.5;
  opacity: 0.45;
  pointer-events: none;
}

.hero-prime {
  stroke-dasharray: 3 3;
  opacity: 0.7;
}

.demo-country {
  cursor: pointer;
  fill: var(--paper-dim);
  stroke: var(--cyan-700);
  stroke-linejoin: round;
  stroke-width: 0.6;
  transition: fill 160ms ease;
}

.demo-country:hover {
  fill: #fff;
}

.demo-country--answer,
.demo-country--answer:hover {
  fill: var(--signal);
}

.demo-country--correct,
.demo-country--correct:hover {
  fill: var(--correct);
}

.demo-country--wrong,
.demo-country--wrong:hover {
  fill: var(--wrong);
}

.hero-demo-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.5rem;
  align-items: center;
  justify-content: space-between;
}

.hero-demo-status {
  min-height: 1.5em;
  color: var(--text-muted);
  font-size: var(--step-1);
  line-height: 1.3;
}
</style>
