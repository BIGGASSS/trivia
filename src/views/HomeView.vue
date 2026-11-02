<script setup lang="ts">
import { useRouter } from "vue-router";
import {
  countryGamePath,
  defaultRoundCount,
  maximumPlayerCount,
  multiplayerGamePath,
  roundDurationSeconds,
  soloGamePath,
} from "@shared/game-constants";
import BrandMark from "@/components/BrandMark.vue";
import HeroMapDemo from "@/components/HeroMapDemo.vue";

const router = useRouter();

const go = (path: string) => {
  void router.push(path);
};
</script>

<template>
  <section class="home-page">
    <nav class="site-nav" aria-label="Main navigation">
      <span class="brand">
        <BrandMark />
        World Trivia
      </span>
      <button class="btn btn--quiet nav-action" type="button" @click="go(countryGamePath)">
        Play
      </button>
    </nav>

    <HeroMapDemo />

    <section class="home-intro" aria-labelledby="intro-heading">
      <div class="home-intro__copy">
        <h2 id="intro-heading">A map with no labels, one country at a time.</h2>
        <p>
          Every round names a country. Find it on a blank world map before the clock runs out. Play
          alone, or share a room code and race your friends on the same map.
        </p>
        <div class="home-actions">
          <button class="btn btn--large" type="button" @click="go(soloGamePath)">Play solo</button>
          <button class="btn btn--quiet btn--large" type="button" @click="go(multiplayerGamePath)">
            Play with friends
          </button>
        </div>
      </div>

      <dl class="home-facts">
        <div>
          <dt>Seconds per round</dt>
          <dd>{{ roundDurationSeconds }}</dd>
        </div>
        <div>
          <dt>Rounds by default</dt>
          <dd>{{ defaultRoundCount }}</dd>
        </div>
        <div>
          <dt>Players per room</dt>
          <dd>{{ maximumPlayerCount }}</dd>
        </div>
      </dl>
    </section>
  </section>
</template>

<style scoped>
.home-page {
  display: grid;
  width: min(100%, 76rem);
  margin: 0 auto;
  gap: clamp(1.5rem, 4vw, 3rem);
}

.site-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  color: var(--paper);
  font-size: var(--step-1);
  font-weight: 650;
  letter-spacing: -0.01em;
}

.nav-action {
  min-height: 2.5rem;
}

.home-intro {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: clamp(1.5rem, 5vw, 4rem);
  align-items: start;
  padding-block: clamp(1rem, 3vw, 2rem) clamp(2rem, 5vw, 4rem);
  border-top: 1px solid var(--rule);
}

.home-intro__copy {
  display: grid;
  gap: 1rem;
  max-width: 38rem;
}

.home-intro h2 {
  color: var(--paper);
  font-size: var(--step-3);
  font-variation-settings: "opsz" 60;
  font-weight: 650;
  letter-spacing: -0.015em;
  line-height: 1.05;
  text-wrap: balance;
}

.home-intro p {
  max-width: 60ch;
  color: var(--text-muted);
  font-size: 1.125rem;
  line-height: 1.55;
}

.home-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.home-facts {
  display: grid;
  gap: 0;
}

.home-facts div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  padding-block: 0.85rem;
  border-bottom: 1px solid var(--rule);
}

.home-facts dt {
  color: var(--text-muted);
}

.home-facts dd {
  color: var(--paper);
  font-size: var(--step-3);
  font-stretch: 80%;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  line-height: 1;
}

@media (max-width: 820px) {
  .home-intro {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 480px) {
  .home-actions .btn {
    flex: 1 1 100%;
  }
}
</style>
