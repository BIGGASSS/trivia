<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import WorldMap from "./components/WorldMap.vue";

type AppView = "home" | "country-game";

const getViewFromPath = (): AppView =>
  window.location.pathname.startsWith("/country-game")
    ? "country-game"
    : "home";

const currentView = ref<AppView>(getViewFromPath());

const setAppPath = (path: string) => {
  if (window.location.pathname === path && !window.location.search) {
    return;
  }

  window.history.pushState({}, "", path);
};

const syncViewFromPath = () => {
  currentView.value = getViewFromPath();
};

const startCountryGame = () => {
  currentView.value = "country-game";
  setAppPath("/country-game");
};

const returnHome = () => {
  currentView.value = "home";
  setAppPath("/");
};

onMounted(() => {
  window.addEventListener("popstate", syncViewFromPath);
});

onUnmounted(() => {
  window.removeEventListener("popstate", syncViewFromPath);
});
</script>

<template>
  <main
    class="app-shell"
    :class="{ 'app-shell--game': currentView === 'country-game' }"
  >
    <section v-if="currentView === 'home'" class="home-page">
      <nav class="site-nav" aria-label="Main navigation">
        <a class="brand" href="#top" aria-label="World Trivia home">
          <span class="brand-mark">🌍</span>
          <span>World Trivia</span>
        </a>
        <button class="nav-action" type="button" @click="startCountryGame">
          Play now
        </button>
      </nav>

      <div class="hero" id="top">
        <div class="hero-copy">
          <p class="eyebrow">Geography minigames</p>
          <h1>Test how well you know the world.</h1>
          <p class="hero-description">
            Jump into quick map challenges, learn country locations, and build a
            streak as you explore the globe.
          </p>

          <div class="hero-actions">
            <button
              class="primary-action"
              type="button"
              @click="startCountryGame"
            >
              Start country guessing
            </button>
            <a class="secondary-action" href="#games">View games</a>
          </div>
        </div>

        <div class="hero-visual" aria-hidden="true">
          <div class="globe-card">
            <div class="globe">
              <span class="continent continent--one"></span>
              <span class="continent continent--two"></span>
              <span class="continent continent--three"></span>
              <span class="map-pin"></span>
            </div>
          </div>
        </div>
      </div>

      <section class="games-section" id="games" aria-labelledby="games-heading">
        <div class="section-heading">
          <p class="eyebrow">Choose a challenge</p>
          <h2 id="games-heading">Games</h2>
        </div>

        <article class="game-card game-card--featured">
          <div>
            <p class="card-kicker">Available now</p>
            <h3>Country Guessing Game</h3>
            <p>
              The site prompts a random country. Click the correct country on
              the border-only world map to score points and keep your streak
              alive.
            </p>
          </div>

          <ul class="feature-list" aria-label="Country guessing features">
            <li>No map labels</li>
            <li>Multiplayer rooms</li>
            <li>Timed rounds and leaderboards</li>
          </ul>

          <button
            class="primary-action card-action"
            type="button"
            @click="startCountryGame"
          >
            Enter game
          </button>
        </article>
      </section>
    </section>

    <section v-else class="game-page" aria-label="Country guessing game">
      <button class="back-button" type="button" @click="returnHome">
        ← Back to homepage
      </button>
      <WorldMap />
    </section>
  </main>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  padding: clamp(1rem, 2.5vw, 2rem);
  background:
    radial-gradient(
      circle at top left,
      rgba(59, 130, 246, 0.24),
      transparent 34rem
    ),
    radial-gradient(
      circle at bottom right,
      rgba(249, 115, 22, 0.2),
      transparent 30rem
    ),
    linear-gradient(135deg, #eff6ff 0%, #f8fafc 46%, #fff7ed 100%);
}

.home-page,
.game-page {
  width: min(100%, 1400px);
  margin: 0 auto;
}

.home-page {
  display: grid;
  gap: clamp(2rem, 5vw, 5rem);
}

.site-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.7rem;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.75);
  box-shadow: 0 16px 50px rgba(15, 23, 42, 0.08);
  backdrop-filter: blur(18px);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.65rem;
  padding-left: 0.55rem;
  color: #0f172a;
  font-size: 1rem;
  font-weight: 900;
  text-decoration: none;
}

.brand-mark {
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  border-radius: 50%;
  background: #dbeafe;
  font-size: 1.35rem;
}

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(18rem, 0.78fr);
  gap: clamp(2rem, 6vw, 5rem);
  align-items: center;
  min-height: min(72vh, 720px);
}

.hero-copy {
  max-width: 46rem;
}

.eyebrow,
.card-kicker {
  color: #2563eb;
  font-size: 0.78rem;
  font-weight: 900;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

h1,
h2,
h3 {
  color: #0f172a;
  font-weight: 950;
  line-height: 0.96;
}

h1 {
  max-width: 12ch;
  margin-top: 0.65rem;
  font-size: clamp(3.25rem, 10vw, 7.6rem);
  letter-spacing: -0.08em;
}

.hero-description {
  max-width: 40rem;
  margin-top: 1.4rem;
  color: #475569;
  font-size: clamp(1.05rem, 2vw, 1.35rem);
  font-weight: 600;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.85rem;
  margin-top: 2rem;
}

button,
.secondary-action {
  cursor: pointer;
  border-radius: 999px;
  font-weight: 900;
  transition:
    background-color 160ms ease,
    border-color 160ms ease,
    color 160ms ease,
    transform 160ms ease;
}

button:hover,
button:focus-visible,
.secondary-action:hover,
.secondary-action:focus-visible {
  transform: translateY(-1px);
}

.primary-action,
.nav-action {
  border: 0;
  color: #ffffff;
  background: #2563eb;
  box-shadow: 0 12px 30px rgba(37, 99, 235, 0.24);
}

.primary-action {
  padding: 0.95rem 1.35rem;
  font-size: 1rem;
}

.nav-action {
  padding: 0.7rem 1rem;
}

.primary-action:hover,
.primary-action:focus-visible,
.nav-action:hover,
.nav-action:focus-visible {
  background: #1d4ed8;
}

.secondary-action {
  display: inline-flex;
  align-items: center;
  border: 1px solid rgba(71, 85, 105, 0.25);
  padding: 0.9rem 1.25rem;
  color: #0f172a;
  background: rgba(255, 255, 255, 0.75);
  text-decoration: none;
}

.secondary-action:hover,
.secondary-action:focus-visible {
  border-color: rgba(37, 99, 235, 0.5);
  color: #1d4ed8;
}

.hero-visual {
  display: grid;
  place-items: center;
}

.globe-card {
  display: grid;
  width: min(100%, 34rem);
  aspect-ratio: 1;
  place-items: center;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 36px;
  background:
    linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.82),
      rgba(219, 234, 254, 0.72)
    ),
    radial-gradient(
      circle at 20% 20%,
      rgba(125, 211, 252, 0.45),
      transparent 30%
    );
  box-shadow: 0 30px 80px rgba(15, 23, 42, 0.16);
}

.globe {
  position: relative;
  width: 70%;
  aspect-ratio: 1;
  overflow: hidden;
  border: 10px solid rgba(255, 255, 255, 0.9);
  border-radius: 50%;
  background:
    linear-gradient(
      90deg,
      transparent 48%,
      rgba(15, 23, 42, 0.14) 49%,
      transparent 51%
    ),
    linear-gradient(
      0deg,
      transparent 48%,
      rgba(15, 23, 42, 0.14) 49%,
      transparent 51%
    ),
    radial-gradient(circle at 35% 32%, #7dd3fc 0 15%, transparent 16%), #38bdf8;
  box-shadow:
    inset -28px -32px 70px rgba(30, 41, 59, 0.24),
    0 24px 50px rgba(14, 116, 144, 0.28);
}

.globe::before,
.globe::after {
  position: absolute;
  inset: 11% 25%;
  content: "";
  border: 2px solid rgba(15, 23, 42, 0.16);
  border-top: 0;
  border-bottom: 0;
  border-radius: 50%;
}

.globe::after {
  inset: 25% 9%;
  border: 0;
  border-top: 2px solid rgba(15, 23, 42, 0.16);
  border-bottom: 2px solid rgba(15, 23, 42, 0.16);
}

.continent {
  position: absolute;
  display: block;
  background: #22c55e;
  box-shadow: inset -8px -10px 20px rgba(21, 128, 61, 0.3);
}

.continent--one {
  top: 24%;
  left: 18%;
  width: 30%;
  height: 25%;
  border-radius: 64% 36% 44% 56% / 48% 54% 46% 52%;
  transform: rotate(-18deg);
}

.continent--two {
  right: 16%;
  bottom: 28%;
  width: 34%;
  height: 22%;
  border-radius: 45% 55% 61% 39% / 55% 43% 57% 45%;
  transform: rotate(18deg);
}

.continent--three {
  bottom: 17%;
  left: 36%;
  width: 17%;
  height: 23%;
  border-radius: 48% 52% 66% 34% / 58% 38% 62% 42%;
  transform: rotate(12deg);
}

.map-pin {
  position: absolute;
  top: 20%;
  right: 26%;
  width: 1.1rem;
  height: 1.1rem;
  border: 3px solid #ffffff;
  border-radius: 50% 50% 50% 0;
  background: #f97316;
  box-shadow: 0 8px 20px rgba(124, 45, 18, 0.35);
  transform: rotate(-45deg);
}

.games-section {
  display: grid;
  gap: 1rem;
  padding-bottom: 3rem;
}

.section-heading h2 {
  margin-top: 0.3rem;
  font-size: clamp(2rem, 5vw, 4.5rem);
  letter-spacing: -0.06em;
}

.game-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: clamp(1rem, 3vw, 2rem);
  align-items: center;
  padding: clamp(1.25rem, 3vw, 2rem);
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.78);
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.12);
}

.game-card h3 {
  margin-top: 0.35rem;
  font-size: clamp(1.75rem, 3vw, 3rem);
  letter-spacing: -0.05em;
}

.game-card p:not(.card-kicker) {
  max-width: 44rem;
  margin-top: 0.65rem;
  color: #475569;
  font-size: 1.05rem;
  font-weight: 600;
}

.feature-list {
  display: grid;
  gap: 0.45rem;
  min-width: 15rem;
  padding: 0;
  color: #334155;
  list-style: none;
}

.feature-list li {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  font-weight: 800;
}

.feature-list li::before {
  display: inline-grid;
  width: 1.35rem;
  height: 1.35rem;
  place-items: center;
  border-radius: 50%;
  color: #ffffff;
  background: #22c55e;
  content: "✓";
  font-size: 0.8rem;
  font-weight: 900;
}

.card-action {
  white-space: nowrap;
}

.game-page {
  display: grid;
  gap: 1rem;
}

.app-shell--game {
  min-height: 100dvh;
  padding-block: clamp(0.5rem, 1.4vh, 1rem);
}

.app-shell--game .game-page {
  width: min(100%, 1680px);
  min-height: calc(100dvh - clamp(1rem, 2.8vh, 2rem));
  grid-template-rows: auto minmax(0, 1fr);
  gap: clamp(0.5rem, 1vh, 0.75rem);
}

.back-button {
  justify-self: start;
  border: 1px solid rgba(71, 85, 105, 0.24);
  padding: 0.8rem 1rem;
  color: #0f172a;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
}

.app-shell--game .back-button {
  padding: 0.62rem 0.95rem;
  line-height: 1;
}

.back-button:hover,
.back-button:focus-visible {
  border-color: rgba(37, 99, 235, 0.45);
  color: #1d4ed8;
}

@media (max-width: 920px) {
  .hero,
  .game-card {
    grid-template-columns: 1fr;
  }

  .hero {
    min-height: auto;
    padding-top: 2rem;
  }

  h1 {
    max-width: 10ch;
  }

  .hero-visual {
    order: -1;
  }

  .globe-card {
    max-width: 24rem;
  }

  .feature-list {
    min-width: 0;
  }

  .card-action {
    justify-self: start;
  }
}

@media (max-width: 560px) {
  .app-shell {
    padding: 0.75rem;
  }

  .site-nav {
    border-radius: 24px;
  }

  .hero-actions {
    flex-direction: column;
  }

  .primary-action,
  .secondary-action,
  .nav-action {
    justify-content: center;
    text-align: center;
  }
}
</style>
