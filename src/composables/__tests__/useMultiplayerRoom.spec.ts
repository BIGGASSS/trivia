import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { defineComponent, h, ref } from "vue";
import type { Ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import type { PublicRoomState } from "@shared/multiplayer-types";
import type { GameMode, GamePhase } from "@/types/game";
import {
  getPendingMultiplayerJoin,
  getStoredMultiplayerSession,
  savePendingMultiplayerJoin,
  saveMultiplayerSession,
} from "@/utils/multiplayer-session";
import { useMultiplayerRoom } from "../useMultiplayerRoom";

const roomSnapshot = (overrides: Partial<PublicRoomState> = {}): PublicRoomState => ({
  roomCode: "ABC123",
  revision: 1,
  serverNow: Date.now(),
  matchId: "match-1",
  roundId: "round-1",
  status: "playing",
  hostId: "host-id",
  playerId: "host-id",
  maxPlayers: 5,
  minPlayers: 2,
  roundCount: 2,
  currentRound: 1,
  roundDurationSeconds: 10,
  roundEndsAt: Date.now() + 10_000,
  currentCountryName: "France",
  revealCountryId: null,
  roundLocked: false,
  canStart: false,
  players: [
    {
      id: "host-id",
      name: "Ada",
      score: 0,
      attempts: 0,
      streak: 0,
      isHost: true,
      active: true,
      connected: true,
      hasAnswered: false,
      roundPerformance: [],
    },
  ],
  roundCountries: [],
  ownFeedback: null,
  ...overrides,
});
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const deferred = () => {
  let resolve!: (value: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const storeSession = (sessionToken = "private-token") =>
  saveMultiplayerSession({
    roomCode: "ABC123",
    playerId: "host-id",
    sessionToken,
    playerName: "Ada",
    updatedAt: Date.now(),
  });

class MockEventSource extends EventTarget {
  static CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn<() => void>(() => {
    this.readyState = MockEventSource.CLOSED;
  });
  constructor(readonly url: string) {
    super();
    MockEventSource.instances.push(this);
  }
  state(room: PublicRoomState) {
    this.dispatchEvent(new MessageEvent("state", { data: JSON.stringify(room) }));
  }
}

describe("multiplayer client lifecycle", () => {
  let wrapper: VueWrapper | undefined;
  let client: ReturnType<typeof useMultiplayerRoom>;
  let gamePhase: Ref<GamePhase>;
  let setGamePath: ReturnType<typeof vi.fn<(path: string, replace?: boolean) => void>>;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  const source = () => MockEventSource.instances[MockEventSource.instances.length - 1]!;

  const mountClient = () => {
    wrapper = mount(
      defineComponent({
        setup() {
          client = useMultiplayerRoom({
            gamePhase,
            selectedMode: ref<GameMode>("multiplayer"),
            totalRounds: ref(2),
            getConfiguredRoundCount: () => 2,
            setGamePath,
          });
          return () => h("div");
        },
      }),
    );
  };

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      json({
        sessionToken: "private-token",
        room: roomSnapshot(),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    gamePhase = ref<GamePhase>("setup");
    setGamePath = vi.fn<(path: string, replace?: boolean) => void>();
    mountClient();
  });
  afterEach(() => {
    wrapper?.unmount();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["retry", "reload"])(
    "reuses a persisted join identity after a lost response (%s)",
    async (retry) => {
      client.multiplayerRoomCodeInput.value = "ABC123";
      fetchMock.mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        expect(getPendingMultiplayerJoin("ABC123")?.joinRequestId).toBe(body.joinRequestId);
        expect(body.joinRequestId).toMatch(/^[0-9a-f-]{36}$/);
        throw new TypeError("Lost response after admission");
      });
      await client.joinServerRoom();
      const identity = getPendingMultiplayerJoin("ABC123")?.joinRequestId;
      expect(identity).toBeTruthy();
      client.multiplayerPlayerName.value = "Changed name after a lost response";
      if (retry === "reload") {
        wrapper?.unmount();
        mountClient();
        await client.restoreServerRoomFromRoute("ABC123");
      } else {
        await client.joinServerRoom();
      }
      expect(JSON.parse(fetchMock.mock.lastCall?.[1]?.body as string)).toEqual({
        joinRequestId: identity,
        playerName: "Player 1",
      });
      expect(getPendingMultiplayerJoin("ABC123")).toBeNull();
      expect(getStoredMultiplayerSession("ABC123")?.sessionToken).toBe("private-token");
    },
  );

  it("keeps the join identity across reload when the admitted session cannot be saved", async () => {
    client.multiplayerRoomCodeInput.value = "ABC123";
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    const storage = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (key, value) {
        if (key === "world-trivia.multiplayer-sessions") throw new Error("Quota exceeded");
        setItem(key, value);
      });
    await client.joinServerRoom();
    const pending = getPendingMultiplayerJoin("ABC123");
    expect(pending).not.toBeNull();
    expect(getStoredMultiplayerSession("ABC123")).toBeNull();
    wrapper?.unmount();
    storage.mockRestore();
    mountClient();
    await client.restoreServerRoomFromRoute("ABC123");
    expect(JSON.parse(fetchMock.mock.lastCall?.[1]?.body as string)).toEqual(pending);
    expect(client.roomState.value?.playerId).toBe("host-id");
    expect(getPendingMultiplayerJoin("ABC123")).toBeNull();
  });

  it("does not attempt a join unless its retry identity can be persisted", async () => {
    client.multiplayerRoomCodeInput.value = "ABC123";
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    await client.joinServerRoom();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.multiplayerErrorMessage.value).toContain("Storage unavailable");
  });

  it.each([404, 410, 400])(
    "discards a definitively rejected join identity (%s)",
    async (status) => {
      client.multiplayerRoomCodeInput.value = "ABC123";
      fetchMock.mockResolvedValueOnce(json({ error: "Rejected" }, status));
      await client.joinServerRoom();
      expect(getPendingMultiplayerJoin("ABC123")).toBeNull();
    },
  );

  it.each(["network", "502", "malformed"])(
    "preserves membership and exposes a retry after failed leave (%s)",
    async (failure) => {
      await client.createServerRoom();
      setGamePath.mockClear();
      if (failure === "network") fetchMock.mockRejectedValueOnce(new TypeError("Offline"));
      if (failure === "502")
        fetchMock.mockResolvedValueOnce(new Response("Gateway error", { status: 502 }));
      if (failure === "malformed") fetchMock.mockResolvedValueOnce(new Response("not json"));
      expect(await client.leaveServerRoom()).toBe(false);
      expect(getStoredMultiplayerSession("ABC123")?.sessionToken).toBe("private-token");
      expect(client.roomState.value).not.toBeNull();
      expect(client.canRetryLeave.value).toBe(true);
      expect(client.multiplayerErrorMessage.value).toContain("Retry leaving");
      expect(setGamePath).not.toHaveBeenCalled();
      source().state(roomSnapshot({ revision: 2 }));
      expect(client.multiplayerErrorMessage.value).toContain("Retry leaving");
      expect(await client.leaveServerRoom()).toBe(true);
      expect(getStoredMultiplayerSession("ABC123")).toBeNull();
      expect(client.canRetryLeave.value).toBe(false);
    },
  );

  it("does not let an in-flight invalidation cancel a successful leave", async () => {
    await client.createServerRoom();
    const events = source();
    const sync = deferred();
    const leave = deferred();
    fetchMock.mockReturnValueOnce(sync.promise).mockReturnValueOnce(leave.promise);
    const syncRequest = client.syncCurrentRoomState();
    const syncSignal = fetchMock.mock.lastCall?.[1]?.signal;
    const leaveRequest = client.leaveServerRoom();
    const leaveSignal = fetchMock.mock.lastCall?.[1]?.signal;
    expect(syncSignal?.aborted).toBe(true);
    events.onerror?.();
    window.dispatchEvent(new Event("online"));
    await client.submitServerAnswer("france");
    await client.syncCurrentRoomState();
    await vi.advanceTimersByTimeAsync(7000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    sync.resolve(json({ error: "Revoked by leave" }, 403));
    await syncRequest;
    expect(leaveSignal?.aborted).toBe(false);
    leave.resolve(json({ ok: true }));
    expect(await leaveRequest).toBe(true);
    expect(client.roomState.value).toBeNull();
    expect(getStoredMultiplayerSession("ABC123")).toBeNull();
    expect(setGamePath).toHaveBeenLastCalledWith("/country-game/multiplayer");
  });

  it("ignores a late leave response after navigating to another room", async () => {
    await client.createServerRoom();
    const leave = deferred();
    fetchMock.mockReturnValueOnce(leave.promise);
    const request = client.leaveServerRoom();
    const signal = fetchMock.mock.lastCall?.[1]?.signal;
    await client.restoreServerRoomFromRoute("NEW123");
    setGamePath.mockClear();
    leave.resolve(json({ ok: true }));
    expect(await request).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(client.multiplayerRoomCodeInput.value).toBe("NEW123");
    expect(setGamePath).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("does not erase a replacement pending join created while leaving", async () => {
    await client.createServerRoom();
    savePendingMultiplayerJoin("ABC123", { joinRequestId: "old-id", playerName: "Ada" });
    const leave = deferred();
    fetchMock.mockReturnValueOnce(leave.promise);
    const request = client.leaveServerRoom();
    const replacement = { joinRequestId: "replacement-id", playerName: "Grace" };
    savePendingMultiplayerJoin("ABC123", replacement);
    storeSession("replacement-token");
    leave.resolve(json({ ok: true }));
    expect(await request).toBe(true);
    expect(getPendingMultiplayerJoin("ABC123")).toEqual(replacement);
    expect(getStoredMultiplayerSession("ABC123")?.sessionToken).toBe("replacement-token");
  });

  it.each([403, 404, 410])(
    "accepts confirmed revocation as a completed departure (%s)",
    async (status) => {
      await client.createServerRoom();
      fetchMock.mockResolvedValueOnce(json({ error: "Already gone" }, status));
      expect(await client.leaveServerRoom()).toBe(true);
      expect(getStoredMultiplayerSession("ABC123")).toBeNull();
      expect(client.roomState.value).toBeNull();
    },
  );

  it.each([-300_000, 300_000])(
    "uses server time for countdown and deadline sync with client skew %s",
    async (skew) => {
      const serverNow = Date.now() - skew;
      const room = roomSnapshot({ serverNow, roundEndsAt: serverNow + 10_000 });
      fetchMock.mockResolvedValueOnce(json({ sessionToken: "private-token", room }));
      await client.createServerRoom();
      await flushPromises();
      expect(client.now.value).toBe(serverNow);
      await vi.advanceTimersByTimeAsync(5000);
      expect(client.now.value).toBe(serverNow + 5000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      source().dispatchEvent(
        new MessageEvent("heartbeat", { data: JSON.stringify(serverNow + 5000) }),
      );
      await vi.advanceTimersByTimeAsync(5250);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("updates the server clock from heartbeats and ignores local wall-clock changes", async () => {
    await client.createServerRoom();
    const serverNow = Date.now() + 1000;
    source().dispatchEvent(new MessageEvent("heartbeat", { data: JSON.stringify(serverNow) }));
    expect(client.now.value).toBe(serverNow);
    vi.setSystemTime(Date.now() - 120_000);
    await vi.advanceTimersByTimeAsync(250);
    expect(client.now.value).toBe(serverNow + 250);
  });

  it.each([1, 2])(
    "ignores a delayed HTTP clock sample while applying room revision %s",
    async (revision) => {
      const room = roomSnapshot({ serverNow: 1000, roundEndsAt: 11_000 });
      fetchMock.mockResolvedValueOnce(json({ sessionToken: "private-token", room }));
      await client.createServerRoom();
      await flushPromises();
      const pending = deferred();
      fetchMock.mockReturnValueOnce(pending.promise);
      const sync = client.syncCurrentRoomState();
      source().dispatchEvent(new MessageEvent("heartbeat", { data: "6000" }));
      expect(client.now.value).toBe(6000);

      pending.resolve(json({ room: { ...room, revision } }));
      await sync;
      expect(client.roomState.value?.revision).toBe(revision);
      expect(client.now.value).toBe(6000);
      expect(Math.ceil((room.roundEndsAt! - client.now.value) / 1000)).toBe(5);

      // A stale response must not postpone the deadline-triggered resync.
      await vi.advanceTimersByTimeAsync(5250);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it.each([5000, 6000])("ignores stale or repeated heartbeat timestamp %s", async (timestamp) => {
    await client.createServerRoom();
    client.detachRoom();
    // Detaching resets clock freshness, even if the next server clock is earlier.
    fetchMock.mockResolvedValueOnce(
      json({ sessionToken: "private-token", room: roomSnapshot({ serverNow: 1000 }) }),
    );
    await client.createServerRoom();
    expect(client.now.value).toBe(1000);
    source().dispatchEvent(new MessageEvent("heartbeat", { data: "6000" }));
    await vi.advanceTimersByTimeAsync(250);
    source().dispatchEvent(new MessageEvent("heartbeat", { data: String(timestamp) }));
    expect(client.now.value).toBe(6250);
    await vi.advanceTimersByTimeAsync(250);
    expect(client.now.value).toBe(6500);
  });

  it("retains a join identity after a detached admission attempt", async () => {
    client.multiplayerRoomCodeInput.value = "ABC123";
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    const request = client.joinServerRoom();
    const identity = getPendingMultiplayerJoin("ABC123")?.joinRequestId;
    client.detachRoom();
    pending.resolve(json({ sessionToken: "private-token", room: roomSnapshot() }));
    await request;
    expect(getPendingMultiplayerJoin("ABC123")?.joinRequestId).toBe(identity);
    expect(getStoredMultiplayerSession("ABC123")).toBeNull();
    await client.joinServerRoom();
    expect(JSON.parse(fetchMock.mock.lastCall?.[1]?.body as string).joinRequestId).toBe(identity);
  });

  it("preserves a failed departure's credential across reload for confirmed revocation", async () => {
    await client.createServerRoom();
    fetchMock.mockRejectedValueOnce(new TypeError("Lost leave response"));
    await client.leaveServerRoom();
    wrapper?.unmount();
    mountClient();
    fetchMock.mockResolvedValueOnce(json({ error: "Revoked" }, 403));
    await client.restoreServerRoomFromRoute("ABC123");
    expect(fetchMock.mock.lastCall?.[0]).toContain("sessionToken=private-token");
    expect(getStoredMultiplayerSession("ABC123")).toBeNull();
  });

  it.each(["decode", "shape", "identity", "application"])(
    "resyncs a broken %s event and does not let heartbeats hide it",
    async (failure) => {
      await client.createServerRoom();
      const events = source();
      const pending = deferred();
      fetchMock.mockReturnValueOnce(pending.promise);
      if (failure === "application")
        setGamePath.mockImplementationOnce(() => {
          throw new Error("Route failed");
        });
      if (failure === "decode")
        events.dispatchEvent(new MessageEvent("state", { data: "invalid json" }));
      else
        events.state(
          roomSnapshot({
            revision: 2,
            ...(failure === "shape"
              ? { players: null as unknown as PublicRoomState["players"] }
              : failure === "identity"
                ? { playerId: "wrong" }
                : {}),
          }),
        );
      expect(client.roomConnectionState.value).toBe("reconnecting");
      expect(events.close).toHaveBeenCalledOnce();
      events.onopen?.();
      events.dispatchEvent(new MessageEvent("heartbeat", { data: JSON.stringify(Date.now()) }));
      expect(client.roomConnectionState.value).toBe("reconnecting");
      pending.resolve(json({ room: roomSnapshot({ revision: 2 }) }));
      await flushPromises();
      expect(client.roomConnectionState.value).toBe("connected");
      expect(source()).not.toBe(events);
    },
  );

  it.each(["create", "join"])(
    "recovers a malformed initial %s snapshot using the admitted session",
    async (action) => {
      client.multiplayerRoomCodeInput.value = "ABC123";
      fetchMock.mockResolvedValueOnce(
        json({ sessionToken: "private-token", room: { roomCode: "ABC123", playerId: "host-id" } }),
      );
      if (action === "create") await client.createServerRoom();
      else await client.joinServerRoom();
      await flushPromises();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.lastCall?.[0]).toContain("?sessionToken=private-token");
      expect(fetchMock.mock.lastCall?.[1]?.method).toBe("GET");
      expect(client.roomState.value?.roomCode).toBe("ABC123");
      expect(client.roomConnectionState.value).toBe("connected");
      expect(getPendingMultiplayerJoin("ABC123")).toBeNull();
    },
  );

  it("offers a credential-based retry when initial decode recovery also fails", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ sessionToken: "private-token", room: { roomCode: "ABC123", playerId: "host-id" } }),
      )
      .mockRejectedValueOnce(new TypeError("Offline during recovery"));
    await client.createServerRoom();
    await flushPromises();
    expect(client.roomState.value).toBeNull();
    expect(client.canRetryRejoin.value).toBe(true);
    expect(client.multiplayerSetupAction.value).toBe("join");
    window.dispatchEvent(new Event("online"));
    await flushPromises();
    expect(fetchMock.mock.lastCall?.[1]?.method).toBe("GET");
    expect(client.roomState.value?.roomCode).toBe("ABC123");
  });

  it("retries malformed HTTP sync even while a stream was sending heartbeats", async () => {
    await client.createServerRoom();
    const events = source();
    fetchMock.mockResolvedValueOnce(json({ room: { revision: 2 } }));
    await client.syncCurrentRoomState();
    events.dispatchEvent(new MessageEvent("heartbeat", { data: JSON.stringify(Date.now()) }));
    expect(client.roomConnectionState.value).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(2250);
    expect(client.roomConnectionState.value).toBe("connected");
    expect(source()).not.toBe(events);
  });

  it("uses private credentials for SSE, sync, start, guesses, skips and leave", async () => {
    await client.createServerRoom();
    expect(source().url).toContain("sessionToken=private-token");
    expect(source().url).not.toContain("host-id");
    expect(getStoredMultiplayerSession("ABC123")?.sessionToken).toBe("private-token");
    await client.syncCurrentRoomState();
    expect(fetchMock.mock.lastCall?.[0]).toBe(
      "/api/multiplayer/rooms/ABC123?sessionToken=private-token",
    );
    await client.startServerRoom();
    expect(JSON.parse(fetchMock.mock.lastCall?.[1]?.body as string)).toEqual({
      sessionToken: "private-token",
    });
    for (const countryId of ["france", null]) {
      await client.submitServerAnswer(countryId);
      expect(JSON.parse(fetchMock.mock.lastCall?.[1]?.body as string)).toEqual({
        sessionToken: "private-token",
        matchId: "match-1",
        roundId: "round-1",
        countryId,
      });
    }
    const events = source();
    await client.leaveServerRoom();
    expect(JSON.parse(fetchMock.mock.lastCall?.[1]?.body as string)).toEqual({
      sessionToken: "private-token",
    });
    expect(events.close).toHaveBeenCalledOnce();
    expect(getStoredMultiplayerSession("ABC123")).toBeNull();
    expect(client.roomState.value).toBeNull();
  });

  it.each(["sync", "answer", "start"])(
    "ignores an older %s HTTP snapshot after newer SSE results",
    async (action) => {
      await client.createServerRoom();
      const pending = deferred();
      fetchMock.mockReturnValueOnce(pending.promise);
      const request =
        action === "sync"
          ? client.syncCurrentRoomState()
          : action === "answer"
            ? client.submitServerAnswer("france")
            : client.startServerRoom();
      source().state(roomSnapshot({ revision: 5, status: "results", roundId: null }));
      pending.resolve(json({ room: roomSnapshot({ revision: 2 }) }));
      const result = await request;
      expect(result).toBe(action === "start" ? false : undefined);
      expect(client.roomState.value?.revision).toBe(5);
      expect(gamePhase.value).toBe("results");
      source().state(roomSnapshot({ revision: 4 }));
      source().state(roomSnapshot({ revision: 5 }));
      expect(gamePhase.value).toBe("results");
    },
  );

  it("unblocks the next round without letting an old answer clear its pending flag", async () => {
    await client.createServerRoom();
    const oldAnswer = deferred();
    const newAnswer = deferred();
    fetchMock.mockReturnValueOnce(oldAnswer.promise).mockReturnValueOnce(newAnswer.promise);
    const oldRequest = client.submitServerAnswer("france");
    expect(client.isSubmittingAnswer.value).toBe(true);
    source().state(roomSnapshot({ revision: 3, currentRound: 2, roundId: "round-2" }));
    expect(client.isSubmittingAnswer.value).toBe(false);
    const newRequest = client.submitServerAnswer("japan");
    oldAnswer.resolve(json({ room: roomSnapshot({ revision: 2 }) }));
    await oldRequest;
    expect(client.isSubmittingAnswer.value).toBe(true);
    expect(client.roomState.value?.roundId).toBe("round-2");
    newAnswer.resolve(
      json({ room: roomSnapshot({ revision: 4, currentRound: 2, roundId: "round-2" }) }),
    );
    await newRequest;
    expect(client.isSubmittingAnswer.value).toBe(false);
  });

  it("does not show errors from an obsolete round", async () => {
    await client.createServerRoom();
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    const request = client.submitServerAnswer(null);
    source().state(roomSnapshot({ revision: 3, roundId: "round-2" }));
    pending.resolve(json({ error: "Old round" }, 409));
    await request;
    expect(client.multiplayerErrorMessage.value).toBe("");
  });

  it.each(["create", "join", "restore", "answer", "sync", "start"])(
    "cancels %s on detach and ignores a late response even if abort is ignored",
    async (action) => {
      if (["answer", "sync", "start"].includes(action)) await client.createServerRoom();
      if (action === "restore") storeSession();
      const pending = deferred();
      fetchMock.mockReturnValueOnce(pending.promise);
      client.multiplayerRoomCodeInput.value = "ABC123";
      const request =
        action === "create"
          ? client.createServerRoom()
          : action === "join"
            ? client.joinServerRoom()
            : action === "restore"
              ? client.restoreServerRoomFromRoute("ABC123")
              : action === "answer"
                ? client.submitServerAnswer(null)
                : action === "sync"
                  ? client.syncCurrentRoomState()
                  : client.startServerRoom();
      const signal = fetchMock.mock.lastCall?.[1]?.signal;
      client.detachRoom();
      setGamePath.mockClear();
      pending.resolve(json({ sessionToken: "late-token", room: roomSnapshot({ revision: 9 }) }));
      await request;
      expect(signal?.aborted).toBe(true);
      expect(client.roomState.value).toBeNull();
      expect(client.isMultiplayerBusy.value).toBe(false);
      expect(client.isSubmittingAnswer.value).toBe(false);
      expect(client.isRoomSyncInFlight.value).toBe(false);
      expect(setGamePath).not.toHaveBeenCalled();
      expect(getStoredMultiplayerSession("ABC123")?.sessionToken).not.toBe("late-token");
      // Flush the Response body's queued stream cleanup, not application timers.
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("ignores stale errors/finalizers while a newer creation is pending", async () => {
    const first = deferred();
    const second = deferred();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const firstRequest = client.createServerRoom();
    client.detachRoom();
    const secondRequest = client.createServerRoom();
    first.reject(new Error("Obsolete error"));
    await firstRequest;
    expect(client.isMultiplayerBusy.value).toBe(true);
    expect(client.multiplayerErrorMessage.value).toBe("");
    second.resolve(json({ sessionToken: "current-token", room: roomSnapshot() }));
    await secondRequest;
    expect(getStoredMultiplayerSession("ABC123")?.sessionToken).toBe("current-token");
  });

  it("ignores all queued events from a closed or replaced EventSource", async () => {
    await client.createServerRoom();
    const oldSource = source();
    oldSource.readyState = MockEventSource.CLOSED;
    await client.syncCurrentRoomState();
    expect(source()).not.toBe(oldSource);
    oldSource.state(roomSnapshot({ revision: 10, status: "results" }));
    oldSource.onerror?.();
    expect(client.roomState.value?.revision).toBe(1);
    expect(client.roomConnectionState.value).toBe("connected");
    client.detachRoom();
    oldSource.onopen?.();
    oldSource.dispatchEvent(new Event("heartbeat"));
    source().state(roomSnapshot({ revision: 20 }));
    expect(client.roomState.value).toBeNull();
  });

  it.each(["offline", "502", "malformed"])(
    "preserves credentials on %s rejoin failures and offers retry, not duplicate join",
    async (failure) => {
      storeSession();
      if (failure === "offline") fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      if (failure === "502")
        fetchMock.mockResolvedValueOnce(new Response("Bad gateway", { status: 502 }));
      if (failure === "malformed")
        fetchMock.mockResolvedValueOnce(new Response("<html>oops</html>"));
      await client.restoreServerRoomFromRoute("ABC123");
      expect(getStoredMultiplayerSession("ABC123")?.sessionToken).toBe("private-token");
      expect(client.canRetryRejoin.value).toBe(true);
      expect(client.multiplayerErrorMessage.value).toContain("Your session is saved");
      await client.joinServerRoom();
      expect(fetchMock.mock.lastCall?.[0]).toContain("?sessionToken=private-token");
      expect(fetchMock.mock.lastCall?.[1]?.method).toBe("GET");
      expect(client.roomState.value?.playerId).toBe("host-id");
      expect(client.canRetryRejoin.value).toBe(false);
    },
  );

  it.each([403, 404, 410])(
    "clears credentials only on definitive rejoin invalidation (%s)",
    async (status) => {
      storeSession();
      fetchMock.mockResolvedValueOnce(json({ error: "Session invalid" }, status));
      await client.restoreServerRoomFromRoute("ABC123");
      expect(getStoredMultiplayerSession("ABC123")).toBeNull();
      expect(client.canRetryRejoin.value).toBe(false);
      expect(client.isMultiplayerBusy.value).toBe(false);
    },
  );

  it("an invalidated old session cannot delete a new credential stored by another tab", async () => {
    storeSession();
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    const request = client.restoreServerRoomFromRoute("ABC123");
    storeSession("replacement-token");
    pending.resolve(json({ error: "Expired" }, 403));
    await request;
    expect(getStoredMultiplayerSession("ABC123")?.sessionToken).toBe("replacement-token");
  });

  it("recovers on online events but never after teardown", async () => {
    storeSession();
    fetchMock.mockRejectedValueOnce(new TypeError("Offline"));
    await client.restoreServerRoomFromRoute("ABC123");
    window.dispatchEvent(new Event("online"));
    await flushPromises();
    expect(client.roomState.value?.roomCode).toBe("ABC123");
    wrapper?.unmount();
    wrapper = undefined;
    fetchMock.mockClear();
    window.dispatchEvent(new Event("online"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(source().close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["code", "action"])(
    "does not retry an old room after changing setup %s",
    async (intent) => {
      storeSession();
      fetchMock.mockRejectedValueOnce(new TypeError("Offline"));
      await client.restoreServerRoomFromRoute("ABC123");
      if (intent === "code") client.multiplayerRoomCodeInput.value = "NEW123";
      else client.multiplayerSetupAction.value = "create";
      fetchMock.mockClear();
      window.dispatchEvent(new Event("online"));
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("checks SSE failures over HTTP and revokes invalid local sessions", async () => {
    await client.createServerRoom();
    const events = source();
    fetchMock.mockResolvedValueOnce(json({ error: "Revoked" }, 403));
    events.onerror?.();
    await flushPromises();
    expect(client.roomState.value).toBeNull();
    expect(events.close).toHaveBeenCalledOnce();
    expect(getStoredMultiplayerSession("ABC123")).toBeNull();
  });

  it("aborts stalled rejoin requests after a bounded timeout, retaining retry credentials", async () => {
    storeSession();
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Timed out", "AbortError")),
          );
        }),
    );
    const request = client.restoreServerRoomFromRoute("ABC123");
    await vi.advanceTimersByTimeAsync(15_000);
    await request;
    expect(client.isMultiplayerBusy.value).toBe(false);
    expect(client.canRetryRejoin.value).toBe(true);
    expect(getStoredMultiplayerSession("ABC123")?.sessionToken).toBe("private-token");
    expect(vi.getTimerCount()).toBe(0);
  });
});
