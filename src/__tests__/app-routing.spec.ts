import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import App from "../App.vue";
import router from "../router";

const countriesPayload = {
  countries: [
    { id: "0-France", name: "France", path: "M0,0 10,0 10,10 0,10Z" },
    { id: "1-Japan", name: "Japan", path: "M20,0 30,0 30,10 20,10Z" },
    { id: "2-Brazil", name: "Brazil", path: "M40,0 50,0 50,10 40,10Z" },
  ],
};

const mountApp = async (path: string) => {
  await router.replace(path);
  await router.isReady();

  const wrapper = mount(App, {
    global: { plugins: [router] },
    attachTo: document.body,
  });

  await flushPromises();

  return wrapper;
};

describe("app routing", () => {
  let wrapper: VueWrapper | undefined;

  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : "url" in input ? input.url : input.href;

        if (url.includes("/countries.paths.json")) {
          return new Response(JSON.stringify(countriesPayload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ error: "Not found." }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.unstubAllGlobals();
  });

  it("renders the homepage at /", async () => {
    wrapper = await mountApp("/");

    expect(wrapper.find(".home-page").exists()).toBe(true);
    expect(wrapper.text()).toContain("Test how well you know the world.");
    expect(wrapper.find(".map-panel").exists()).toBe(false);
  });

  it("navigates from the homepage to the game setup", async () => {
    wrapper = await mountApp("/");

    await wrapper.find(".nav-action").trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/country-game");
    expect(wrapper.find(".setup-panel").exists()).toBe(true);
    expect(wrapper.text()).toContain("Choose how to play");
  });

  it("renders the game setup with multiplayer preselected at /country-game", async () => {
    wrapper = await mountApp("/country-game");

    expect(wrapper.find(".setup-panel").exists()).toBe(true);
    expect(wrapper.find(".server-setup").exists()).toBe(true);
    expect(wrapper.find(".back-button").exists()).toBe(true);
  });

  it("selects solo mode when deep-linking to /country-game/solo", async () => {
    wrapper = await mountApp("/country-game/solo");

    const soloRadio = wrapper.find<HTMLInputElement>('input[value="solo"]');

    expect(soloRadio.element.checked).toBe(true);
    expect(wrapper.text()).toContain("Start solo game");
  });

  it("shows the join form when deep-linking into an unknown room", async () => {
    wrapper = await mountApp("/country-game/multiplayer/ABC123");

    expect(wrapper.find(".setup-panel").exists()).toBe(true);
    expect(wrapper.text()).toContain("Room ABC123 is ready. Enter your name to join.");
    expect(wrapper.find<HTMLInputElement>('input[placeholder="ABC123"]').element.value).toBe(
      "ABC123",
    );
  });

  it("starts a solo game, plays a round on the map, and returns to setup", async () => {
    wrapper = await mountApp("/country-game/solo");

    await wrapper.find(".start-button").trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/country-game/solo");
    expect(wrapper.find(".map-stage").exists()).toBe(true);
    expect(wrapper.findAll("path.country")).toHaveLength(countriesPayload.countries.length);
    expect(wrapper.text()).toContain("Round 1 of");

    // Roving tabindex: exactly one country is in the tab order while
    // guessing is enabled; the rest are skipped.
    const tabIndexes = wrapper.findAll("path.country").map((path) => path.attributes("tabindex"));

    expect(tabIndexes.filter((tabIndex) => tabIndex === "0")).toHaveLength(1);
    expect(tabIndexes.filter((tabIndex) => tabIndex === "-1")).toHaveLength(
      countriesPayload.countries.length - 1,
    );

    // Guess the prompted country by name from the aria labels.
    const prompted = wrapper.find(".target-country").text().trim();
    const target = wrapper.find(`path[aria-label="Guess ${prompted}"]`);

    await target.trigger("click");
    expect(wrapper.text()).toContain(`Correct! That was ${prompted}.`);

    // While the round is locked, every country leaves the tab order.
    await flushPromises();
    expect(
      wrapper.findAll("path.country").every((path) => path.attributes("tabindex") === "-1"),
    ).toBe(true);

    // Leave the game via the Setup action.
    const setupButton = wrapper.findAll("button").find((button) => button.text() === "Setup");

    await setupButton?.trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/country-game");
    expect(wrapper.find(".setup-panel").exists()).toBe(true);
  });

  it("updates the URL when switching game modes on the setup screen", async () => {
    wrapper = await mountApp("/country-game");

    await wrapper.find('input[value="solo"]').setValue();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/country-game/solo");

    await wrapper.find('input[value="multiplayer"]').setValue();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/country-game/multiplayer");
  });

  it("redirects unknown routes to the homepage", async () => {
    wrapper = await mountApp("/nope/nothing-here");

    expect(router.currentRoute.value.path).toBe("/");
    expect(wrapper.find(".home-page").exists()).toBe(true);
  });
});
