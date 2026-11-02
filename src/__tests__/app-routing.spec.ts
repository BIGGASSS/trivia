import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import type { PublicPlayer, PublicRoomState } from "@shared/multiplayer-types";
import App from "../App.vue";
import router from "../router";
import { getStoredMultiplayerSession, saveMultiplayerSession } from "../utils/multiplayer-session";

const countriesPayload = {
  countries: [
    { id: "0-France", name: "France", path: "M0,0 10,0 10,10 0,10Z" },
    { id: "1-Japan", name: "Japan", path: "M20,0 30,0 30,10 20,10Z" },
    { id: "2-Brazil", name: "Brazil", path: "M40,0 50,0 50,10 40,10Z" },
  ],
};

const roomCode = "ABC123";
const roomPath = `/country-game/multiplayer/${roomCode}`;
const roomApiPath = `/api/multiplayer/rooms/${roomCode}`;
const sessionToken = "private-session-token";
const sessionStorageKey = "world-trivia.multiplayer-sessions";

const makePlayer = (overrides: Partial<PublicPlayer> = {}): PublicPlayer => ({
  id: "player-1",
  name: "Ada",
  score: 0,
  attempts: 0,
  streak: 0,
  isHost: true,
  active: true,
  connected: true,
  hasAnswered: false,
  roundPerformance: [],
  ...overrides,
});

const makeRoom = (overrides: Partial<PublicRoomState> = {}): PublicRoomState => ({
  roomCode,
  revision: 1,
  serverNow: Date.now(),
  matchId: null,
  roundId: null,
  status: "lobby",
  hostId: "player-1",
  playerId: "player-1",
  maxPlayers: 8,
  minPlayers: 2,
  roundCount: 3,
  currentRound: 0,
  roundDurationSeconds: 15,
  roundEndsAt: null,
  currentCountryName: null,
  revealCountryId: null,
  roundLocked: false,
  canStart: true,
  players: [makePlayer(), makePlayer({ id: "player-2", name: "Grace", isHost: false })],
  roundCountries: [],
  ownFeedback: null,
  ...overrides,
});

const makePlayingRoom = (overrides: Partial<PublicRoomState> = {}) =>
  makeRoom({
    status: "playing",
    matchId: "match-1",
    roundId: "round-1",
    currentRound: 1,
    currentCountryName: "France",
    roundEndsAt: Date.now() + 15_000,
    canStart: false,
    ...overrides,
  });

const seedSession = () => {
  saveMultiplayerSession({
    roomCode,
    playerId: "player-1",
    sessionToken,
    playerName: "Ada",
    updatedAt: Date.now() - 1000,
  });
};

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

class MockEventSource extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = MockEventSource.OPEN;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn<() => void>(() => {
    this.readyState = MockEventSource.CLOSED;
  });

  constructor(readonly url: string) {
    super();
    MockEventSource.instances.push(this);
  }

  emitState(room: PublicRoomState) {
    // Deliberately allow delivery after close to simulate an already-queued event.
    this.dispatchEvent(new MessageEvent("state", { data: JSON.stringify(room) }));
  }
}

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
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders the homepage at /", async () => {
    wrapper = await mountApp("/");

    expect(wrapper.find(".home-page").exists()).toBe(true);
    expect(wrapper.text()).toContain("Where is");
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
    const setupButton = wrapper
      .findAll("button")
      .find((button) => button.text() === "Back to setup");

    await setupButton?.trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/country-game");
    expect(wrapper.find(".setup-panel").exists()).toBe(true);
  });

  it.each(["/country-game", "/country-game/multiplayer", "/country-game/multiplayer/ABC123"])(
    "abandons the solo final delay on external navigation to %s",
    async (path) => {
      vi.useFakeTimers();
      wrapper = await mountApp("/country-game/solo");

      await wrapper.find('input[type="number"]').setValue(1);
      await wrapper.find(".start-button").trigger("click");
      const prompted = wrapper.find(".target-country").text().trim();
      await wrapper.find(`path[aria-label="Guess ${prompted}"]`).trigger("click");

      // Unlike the Setup button, back/forward or router navigation reuses the
      // mounted game view and must explicitly cancel the pending final result.
      await router.push(path);
      await flushPromises();
      expect(wrapper.find(".setup-panel").exists()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(15_000);
      await flushPromises();
      expect(router.currentRoute.value.fullPath).toBe(path);
      expect(wrapper.find(".setup-panel").exists()).toBe(true);
      expect(wrapper.find(".results-panel").exists()).toBe(false);
      expect(wrapper.find(".map-stage").exists()).toBe(false);
    },
  );

  it("cancels the solo reveal and timers when navigating away from the game", async () => {
    vi.useFakeTimers();
    wrapper = await mountApp("/country-game/solo");
    await wrapper.find('input[type="number"]').setValue(1);
    await wrapper.find(".start-button").trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Skip")
      ?.trigger("click");

    await router.push("/");
    await flushPromises();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(wrapper.find(".home-page").exists()).toBe(true);
    await router.push("/country-game/solo");
    await flushPromises();
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

  describe("multiplayer navigation", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    const entryActions = ["create", "join", "restore"] as const;
    const awayNavigations = [
      { name: "external solo navigation", path: "/country-game/solo", selector: ".setup-panel" },
      { name: "external homepage navigation", path: "/", selector: ".home-page" },
      {
        name: "external other-room navigation",
        path: "/country-game/multiplayer/XYZ789",
        selector: ".setup-panel",
      },
      { name: "the solo mode radio", path: "/country-game/solo", selector: ".setup-panel" },
    ];

    it.each(entryActions.flatMap((action) => awayNavigations.map((away) => ({ action, ...away }))))(
      "ignores a deferred $action response after $name",
      async ({ action, name, path, selector }) => {
        const response = deferred<Response>();
        const fetchMock = vi.mocked(fetch);
        const fallback = fetchMock.getMockImplementation()!;
        const requestUrl =
          action === "create"
            ? "/api/multiplayer/rooms"
            : action === "join"
              ? `${roomApiPath}/join`
              : `${roomApiPath}?sessionToken=${sessionToken}`;
        fetchMock.mockImplementation((input, init) =>
          input === requestUrl ? response.promise : fallback(input, init),
        );
        if (action === "restore") seedSession();
        const storedBefore = window.localStorage.getItem(sessionStorageKey);

        wrapper = await mountApp(action === "create" ? "/country-game/multiplayer" : roomPath);
        if (action !== "restore") await wrapper.get(".start-button").trigger("click");
        await flushPromises();

        const request = fetchMock.mock.calls.find(([url]) => url === requestUrl);
        expect(request).toBeDefined();
        expect(request?.[1]?.signal?.aborted).toBe(false);
        expect(wrapper.get<HTMLButtonElement>(".start-button").element.disabled).toBe(true);

        if (name === "the solo mode radio") {
          await wrapper.get('input[value="solo"]').setValue();
        } else {
          await router.push(path);
        }
        await flushPromises();
        expect(router.currentRoute.value.fullPath).toBe(path);
        expect(wrapper.find(selector).exists()).toBe(true);
        expect(request?.[1]?.signal?.aborted).toBe(true);
        const storageWrite = vi.spyOn(Storage.prototype, "setItem");

        // The transport ignores AbortSignal: cancellation must also guard the response.
        response.resolve(
          jsonResponse({
            room: makeRoom(),
            ...(action === "restore" ? {} : { playerId: "player-1", sessionToken }),
          }),
        );
        await flushPromises();
        await vi.advanceTimersByTimeAsync(15_000);
        await flushPromises();

        expect(router.currentRoute.value.fullPath).toBe(path);
        expect(wrapper.find(selector).exists()).toBe(true);
        expect(wrapper.find(".lobby-panel").exists()).toBe(false);
        expect(wrapper.find(".map-stage").exists()).toBe(false);
        expect(wrapper.find(".results-panel").exists()).toBe(false);
        expect(window.localStorage.getItem(sessionStorageKey)).toBe(storedBefore);
        expect(storageWrite).not.toHaveBeenCalled();
        expect(MockEventSource.instances).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(fetchMock.mock.calls.filter(([url]) => url === requestUrl)).toHaveLength(1);
      },
    );

    it.each(["create", "join"] as const)(
      "persists the private session returned by %s and opens its authenticated stream",
      async (action) => {
        wrapper = await mountApp(action === "create" ? "/country-game/multiplayer" : roomPath);
        vi.mocked(fetch).mockResolvedValueOnce(
          jsonResponse({ playerId: "player-1", sessionToken, room: makeRoom() }),
        );
        await wrapper.get(".start-button").trigger("click");
        await flushPromises();

        expect(router.currentRoute.value.fullPath).toBe(roomPath);
        expect(wrapper.find(".lobby-panel").exists()).toBe(true);
        expect(getStoredMultiplayerSession(roomCode)).toEqual({
          roomCode,
          playerId: "player-1",
          sessionToken,
          playerName: "Ada",
          updatedAt: Date.now(),
        });
        expect(MockEventSource.instances).toHaveLength(1);
        expect(MockEventSource.instances[0]?.url).toBe(
          `${roomApiPath}/events?sessionToken=${sessionToken}`,
        );
        expect(router.currentRoute.value.fullPath).not.toContain(sessionToken);
      },
    );

    it("does not use a public player ID in a room deep link as authentication", async () => {
      wrapper = await mountApp(`${roomPath}?playerId=player-1`);

      expect(wrapper.text()).toContain("Room ABC123 is ready. Enter your name to join.");
      expect(wrapper.get(".start-button").text()).toBe("Join room");
      expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
        expect.stringContaining("/countries.paths.json"),
      ]);
      expect(MockEventSource.instances).toHaveLength(0);
      expect(getStoredMultiplayerSession(roomCode)).toBeNull();
    });

    const restoreRoom = async (room: PublicRoomState) => {
      seedSession();
      const fetchMock = vi.mocked(fetch);
      const fallback = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input, init) =>
        input === `${roomApiPath}?sessionToken=${sessionToken}`
          ? Promise.resolve(jsonResponse({ room }))
          : fallback(input, init),
      );
      wrapper = await mountApp(roomPath);
      return wrapper;
    };

    it.each(["guess", "skip"] as const)(
      "ignores a deferred %s response and queued room events after navigating to solo",
      async (action) => {
        wrapper = await restoreRoom(makePlayingRoom());
        const source = MockEventSource.instances[0]!;
        const response = deferred<Response>();
        vi.mocked(fetch).mockImplementationOnce(() => response.promise);

        if (action === "guess") {
          await wrapper.get('path[aria-label="Guess Japan"]').trigger("click");
        } else {
          await wrapper
            .findAll("button")
            .find((button) => button.text() === "Skip round")!
            .trigger("click");
        }
        await flushPromises();
        const request = vi.mocked(fetch).mock.lastCall;
        expect(request?.[0]).toBe(`${roomApiPath}/${action}`);
        expect(JSON.parse(request?.[1]?.body as string)).toEqual({
          sessionToken,
          matchId: "match-1",
          roundId: "round-1",
          countryId: action === "guess" ? "1-Japan" : null,
        });
        expect(request?.[1]?.signal?.aborted).toBe(false);

        await router.push("/country-game/solo");
        await flushPromises();
        const storedBefore = window.localStorage.getItem(sessionStorageKey);
        const storageWrite = vi.spyOn(Storage.prototype, "setItem");
        expect(request?.[1]?.signal?.aborted).toBe(true);
        expect(source.close).toHaveBeenCalledTimes(1);

        // Start a new game before the old answer arrives. It must not replace
        // the new prompt, feedback, mode, or URL with the abandoned match.
        await wrapper.get(".start-button").trigger("click");
        await flushPromises();
        const soloPrompt = wrapper.get(".target-country").text();
        const soloFeedback = wrapper.get(".feedback").text();
        const lateRoom = makePlayingRoom({
          revision: 2,
          roundLocked: true,
          revealCountryId: "0-France",
          ownFeedback: {
            state: "incorrect",
            message: "Stale multiplayer answer feedback.",
            selectedCountryId: action === "guess" ? "1-Japan" : null,
          },
        });
        response.resolve(jsonResponse({ room: lateRoom }));
        source.emitState({ ...lateRoom, revision: 3, status: "results" });
        await flushPromises();

        expect(router.currentRoute.value.fullPath).toBe("/country-game/solo");
        expect(wrapper.get(".target-country").text()).toBe(soloPrompt);
        expect(wrapper.get(".feedback").text()).toBe(soloFeedback);
        expect(wrapper.text()).not.toContain("Stale multiplayer answer feedback.");
        expect(wrapper.find(".answered-meta").exists()).toBe(false);
        expect(wrapper.find(".player-strip").exists()).toBe(false);
        expect(wrapper.find(".results-panel").exists()).toBe(false);
        expect(window.localStorage.getItem(sessionStorageKey)).toBe(storedBefore);
        expect(storageWrite).not.toHaveBeenCalled();
        expect(MockEventSource.instances).toHaveLength(1);
      },
    );

    it("ignores an answer body that finishes after the game route unmounts", async () => {
      wrapper = await restoreRoom(makePlayingRoom());
      const source = MockEventSource.instances[0]!;
      const body = deferred<{ room: PublicRoomState }>();
      const response = jsonResponse({});
      const readBody = vi.spyOn(response, "json").mockReturnValue(body.promise);
      vi.mocked(fetch).mockResolvedValueOnce(response);
      await wrapper.get('path[aria-label="Guess Japan"]').trigger("click");
      await flushPromises();
      expect(readBody).toHaveBeenCalledTimes(1);
      const request = vi.mocked(fetch).mock.lastCall;

      await router.push("/");
      await flushPromises();
      const storedBefore = window.localStorage.getItem(sessionStorageKey);
      const storageWrite = vi.spyOn(Storage.prototype, "setItem");
      expect(request?.[1]?.signal?.aborted).toBe(true);
      expect(source.close).toHaveBeenCalledTimes(1);
      body.resolve({ room: makePlayingRoom({ revision: 2 }) });
      source.emitState(makeRoom({ revision: 3, status: "results" }));
      await flushPromises();
      await vi.advanceTimersByTimeAsync(15_000);

      expect(router.currentRoute.value.fullPath).toBe("/");
      expect(wrapper.find(".home-page").exists()).toBe(true);
      expect(window.localStorage.getItem(sessionStorageKey)).toBe(storedBefore);
      expect(storageWrite).not.toHaveBeenCalled();
      expect(MockEventSource.instances).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["?from=history", "#scores"])(
      "preserves an in-progress multiplayer reveal on same-room navigation to %s",
      async (suffix) => {
        // Reduced motion makes the focused reveal viewport deterministic in jsdom.
        vi.stubGlobal(
          "matchMedia",
          vi.fn(() => ({ matches: true })),
        );
        wrapper = await restoreRoom(makePlayingRoom());
        const initialViewBox = wrapper.get(".world-map").attributes("viewBox");
        const source = MockEventSource.instances[0]!;
        source.emitState(
          makePlayingRoom({
            revision: 2,
            roundLocked: true,
            revealCountryId: "0-France",
            ownFeedback: {
              state: "incorrect",
              message: "Incorrect. That was France.",
              selectedCountryId: "1-Japan",
            },
            players: [
              makePlayer({ hasAnswered: true }),
              makePlayer({ id: "player-2", name: "Grace", isHost: false, hasAnswered: true }),
            ],
          }),
        );
        await flushPromises();
        const revealViewBox = wrapper.get(".world-map").attributes("viewBox");
        const mapElement = wrapper.get(".map-stage").element;
        const requestCount = vi.mocked(fetch).mock.calls.length;
        const timerCount = vi.getTimerCount();
        expect(revealViewBox).not.toBe(initialViewBox);
        expect(wrapper.get(".feedback").text()).toBe("Incorrect. That was France.");

        await router.push(`${roomPath}${suffix}`);
        await flushPromises();

        expect(router.currentRoute.value.fullPath).toBe(`${roomPath}${suffix}`);
        expect(wrapper.get(".map-stage").element).toBe(mapElement);
        expect(wrapper.get(".world-map").attributes("viewBox")).toBe(revealViewBox);
        expect(wrapper.get(".feedback").text()).toBe("Incorrect. That was France.");
        expect(wrapper.get('path[aria-label="Guess France"]').classes()).toContain(
          "country--missed-target",
        );
        expect(
          wrapper.findAll("path.country").every((path) => path.attributes("tabindex") === "-1"),
        ).toBe(true);
        expect(wrapper.find(".setup-panel").exists()).toBe(false);
        expect(wrapper.find(".results-panel").exists()).toBe(false);
        expect(vi.mocked(fetch).mock.calls).toHaveLength(requestCount);
        expect(MockEventSource.instances).toHaveLength(1);
        expect(source.close).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(timerCount);
      },
    );

    it.each([
      { status: "lobby", selector: ".lobby-panel" },
      { status: "playing", selector: ".map-stage" },
      { status: "results", selector: ".results-panel" },
    ] as const)(
      "keeps the $status phase across same-room query and hash changes",
      async ({ status, selector }) => {
        wrapper = await restoreRoom(
          status === "lobby"
            ? makeRoom()
            : makePlayingRoom({
                status,
                ...(status === "results"
                  ? {
                      currentRound: 3,
                      roundId: null,
                      roundEndsAt: null,
                      currentCountryName: null,
                      roundLocked: true,
                    }
                  : {}),
              }),
        );
        const phaseElement = wrapper.get(selector).element;
        const requestCount = vi.mocked(fetch).mock.calls.length;
        const source = MockEventSource.instances[0]!;

        for (const suffix of ["?from=history", "?from=history#scores"]) {
          await router.push(`${roomPath}${suffix}`);
          await flushPromises();

          expect(router.currentRoute.value.fullPath).toBe(`${roomPath}${suffix}`);
          expect(wrapper.get(selector).element).toBe(phaseElement);
          expect(wrapper.find(".setup-panel").exists()).toBe(false);
          expect(vi.mocked(fetch).mock.calls).toHaveLength(requestCount);
          expect(MockEventSource.instances).toHaveLength(1);
          expect(source.close).not.toHaveBeenCalled();
        }
      },
    );

    it("labels departed roster entries Left whether or not they answered", async () => {
      wrapper = await restoreRoom(
        makePlayingRoom({
          players: [
            makePlayer(),
            // A temporarily disconnected member still belongs in the denominator.
            makePlayer({
              id: "player-2",
              name: "Grace",
              isHost: false,
              connected: false,
              hasAnswered: true,
            }),
            makePlayer({
              id: "player-3",
              name: "Linus",
              isHost: false,
              active: false,
              connected: false,
              hasAnswered: true,
            }),
            makePlayer({
              id: "player-4",
              name: "Margaret",
              isHost: false,
              active: false,
              connected: false,
            }),
          ],
        }),
      );

      expect(wrapper.findAll(".player-score-card")).toHaveLength(4);
      const labels = wrapper.findAll(".player-score-card").map((card) => ({
        name: card.get(".player-name-tag").text(),
        label: card.get(".player-turn-label").text(),
      }));
      expect(labels).toEqual([
        { name: "Ada", label: "You" },
        { name: "Grace", label: "Answered" },
        { name: "Linus", label: "Left" },
        { name: "Margaret", label: "Left" },
      ]);
    });

    it("updates answered totals using active membership, not connection or historical answers", async () => {
      wrapper = await restoreRoom(makePlayingRoom());
      expect(wrapper.get(".round-meta").text()).toBe("Round 1 of 3");
      expect(wrapper.get(".answered-meta").text()).toBe("0 of 2 players answered");

      MockEventSource.instances[0]!.emitState(
        makePlayingRoom({
          revision: 2,
          players: [
            makePlayer(),
            makePlayer({ id: "player-2", isHost: false, connected: false, hasAnswered: true }),
            makePlayer({
              id: "player-3",
              isHost: false,
              active: false,
              connected: false,
              hasAnswered: true,
            }),
          ],
        }),
      );
      await flushPromises();

      expect(wrapper.get(".answered-meta").text()).toBe("1 of 2 players answered");
      expect(wrapper.findAll(".player-score-card")).toHaveLength(3);
    });
  });

  it("redirects unknown routes to the homepage", async () => {
    wrapper = await mountApp("/nope/nothing-here");

    expect(router.currentRoute.value.path).toBe("/");
    expect(wrapper.find(".home-page").exists()).toBe(true);
  });
});
