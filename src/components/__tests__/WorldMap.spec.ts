import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { flushPromises, shallowMount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import WorldMap from "../WorldMap.vue";
import GameHud from "../country-game/GameHud.vue";
import GameSetupPanel from "../country-game/GameSetupPanel.vue";
import ResultsLeaderboard from "../country-game/ResultsLeaderboard.vue";
import WorldMapStage from "../country-game/WorldMapStage.vue";

const countries = [
  { id: "france", name: "France", path: "M0,0 1,0 1,1Z" },
  { id: "japan", name: "Japan", path: "M2,0 3,0 3,1Z" },
];

describe("WorldMap route synchronization", () => {
  let wrapper: VueWrapper;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ countries }),
      }),
    );
  });

  afterEach(() => {
    wrapper?.unmount();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const startSolo = async (rounds = 2) => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/:pathMatch(.*)*", component: WorldMap }],
    });
    await router.push("/country-game/solo");
    await router.isReady();
    wrapper = shallowMount(WorldMap, { global: { plugins: [router] } });
    await flushPromises();
    const setup = wrapper.getComponent(GameSetupPanel);
    setup.vm.$emit("update:roundCountSetting", rounds);
    setup.vm.$emit("start-solo");
    await nextTick();
    return router;
  };

  const answerCorrectly = () => {
    const target = wrapper.getComponent(GameHud).props("targetCountryName");
    wrapper.getComponent(WorldMapStage).vm.$emit(
      "country-guess",
      countries.find((country) => country.name === target),
    );
  };

  it.each(["?view=map", "#map", "/?view=map#map"])(
    "preserves progress and the original deadline on equivalent solo navigation %s",
    async (suffix) => {
      const router = await startSolo();
      answerCorrectly();
      vi.advanceTimersByTime(2900);
      await nextTick();
      const before = wrapper.getComponent(GameHud).props();
      expect(before.roundSummary).toBe("Round 2 of 2");
      expect(before.scoreboardPlayer).toMatchObject({ score: 1 });
      expect(before.timeLeft).toBe(8);

      await router.push(`/country-game/solo${suffix}`);
      await nextTick();
      const after = wrapper.getComponent(GameHud).props();
      expect(after.roundSummary).toBe(before.roundSummary);
      expect(after.targetCountryName).toBe(before.targetCountryName);
      expect(after.scoreboardPlayer).toMatchObject({ score: 1 });
      expect(after.timeLeft).toBe(8);
      vi.advanceTimersByTime(1000);
      await nextTick();
      expect(wrapper.getComponent(GameHud).props("timeLeft")).toBe(7);
    },
  );

  it("preserves the final reveal delay and results on query/hash navigation", async () => {
    const router = await startSolo(1);
    answerCorrectly();
    await nextTick();
    await router.push("/country-game/solo?view=map");
    expect(wrapper.getComponent(GameHud).props("answerState")).toBe("correct");

    vi.advanceTimersByTime(900);
    await nextTick();
    expect(wrapper.getComponent(ResultsLeaderboard).props("players")).toMatchObject([{ score: 1 }]);
    await router.push("/country-game/solo?view=map#results");
    expect(wrapper.getComponent(ResultsLeaderboard).props("players")).toMatchObject([{ score: 1 }]);
  });

  it.each(["/country-game", "/country-game/multiplayer"])(
    "abandons a pending solo reveal when navigating to %s",
    async (path) => {
      const router = await startSolo(1);
      answerCorrectly();
      await nextTick();
      await router.push(path);
      expect(wrapper.findComponent(GameSetupPanel).exists()).toBe(true);
      vi.advanceTimersByTime(20_000);
      await nextTick();
      expect(wrapper.findComponent(GameSetupPanel).exists()).toBe(true);
      expect(wrapper.findComponent(ResultsLeaderboard).exists()).toBe(false);
      await router.push("/country-game/solo");
      expect(wrapper.findComponent(GameSetupPanel).exists()).toBe(true);
    },
  );
});
