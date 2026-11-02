// @vitest-environment node
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createMultiplayerMiddleware } from "../multiplayer";
import { createRoomManager } from "../room-manager";
import type { RoomManager } from "../room-manager";

// Deterministic backpressure at the Node write boundary, rather than relying on
// OS socket buffer sizes or flooding a real network connection in tests.
const createResponse = () => {
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    writeHead: vi.fn<() => void>(),
    setHeader: vi.fn<() => void>(),
    write: vi.fn<(_frame: string) => boolean>(() => true),
    end: vi.fn<() => void>(),
    destroy: vi.fn<() => void>(),
  });
  response.destroy.mockImplementation(() => {
    response.destroyed = true;
  });
  response.end.mockImplementation(() => {
    response.writableEnded = true;
  });
  return response;
};

describe("SSE bounded transport", () => {
  let manager: RoomManager;
  beforeEach(() => {
    vi.useFakeTimers();
    manager = createRoomManager({
      loadCountries: () => Promise.resolve([{ id: "fr", name: "France" }]),
    });
  });
  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  it.each(["retry", "initial state", "later state", "heartbeat"])(
    "destroys and unregisters on %s backpressure, without further writes or timers",
    async (phase) => {
      const { room, playerId, sessionToken } = await manager.createRoom({});
      const response = createResponse();
      const middleware = createMultiplayerMiddleware(manager);
      if (phase === "retry") response.write.mockReturnValueOnce(false);
      if (phase === "initial state") {
        response.write.mockReturnValueOnce(true).mockReturnValueOnce(false);
      }
      middleware(
        {
          method: "GET",
          url: `/api/multiplayer/rooms/${room.code}/events?sessionToken=${sessionToken}`,
        } as IncomingMessage,
        response as unknown as ServerResponse,
        vi.fn(),
      );
      expect(manager.getPlayer(room, playerId)?.connected).toBe(
        phase === "later state" || phase === "heartbeat",
      );
      if (phase === "later state" || phase === "heartbeat") {
        response.write.mockReturnValueOnce(false);
        if (phase === "later state") manager.joinRoom(room, {});
        else vi.advanceTimersByTime(3000);
      }
      expect(response.destroy).toHaveBeenCalledTimes(1);
      expect(manager.getPlayer(room, playerId)).toMatchObject({ active: true, connected: false });
      expect(manager.authenticatePlayer(room, sessionToken).id).toBe(playerId);
      expect(vi.getTimerCount()).toBe(0);
      const writes = response.write.mock.calls.length;
      const revision = room.revision;
      // A later close/error notification must not repeat cleanup or broadcasts.
      response.emit("close");
      response.emit("error", new Error("socket closed"));
      expect(room.revision).toBe(revision);
      manager.joinRoom(room, {});
      vi.advanceTimersByTime(30_000);
      expect(response.write).toHaveBeenCalledTimes(writes);
      expect(response.end).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "keeps healthy subscribers running after backpressure (synchronous close: %s)",
    async (synchronousClose) => {
      const { room, playerId, sessionToken } = await manager.createRoom({});
      const middleware = createMultiplayerMiddleware(manager);
      const slow = createResponse();
      const healthy = createResponse();
      for (const response of [slow, healthy]) {
        middleware(
          {
            method: "GET",
            url: `/api/multiplayer/rooms/${room.code}/events?sessionToken=${sessionToken}`,
          } as IncomingMessage,
          response as unknown as ServerResponse,
          vi.fn(),
        );
      }
      if (synchronousClose) {
        slow.destroy.mockImplementation(() => {
          slow.destroyed = true;
          slow.emit("close");
        });
      }
      slow.write.mockReturnValueOnce(false);
      manager.joinRoom(room, {});
      expect(slow.destroy).toHaveBeenCalledTimes(1);
      expect(healthy.destroy).not.toHaveBeenCalled();
      expect(manager.getPlayer(room, playerId)?.connected).toBe(true);
      const writes = healthy.write.mock.calls.length;
      vi.advanceTimersByTime(3000);
      expect(healthy.write).toHaveBeenCalledTimes(writes + 1);
      const revisions = healthy.write.mock.calls
        .map(([frame]) => frame)
        .filter((frame) => frame.startsWith("event: state\n"))
        .map(
          (frame) =>
            (JSON.parse(frame.slice("event: state\ndata: ".length)) as { revision: number })
              .revision,
        );
      expect(
        revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!),
      ).toBe(true);
      manager.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not register or start a heartbeat after the retry write closes synchronously", async () => {
    const { room, playerId, sessionToken } = await manager.createRoom({});
    const response = createResponse();
    response.write.mockImplementationOnce(() => {
      response.emit("close");
      return true;
    });
    createMultiplayerMiddleware(manager)(
      {
        method: "GET",
        url: `/api/multiplayer/rooms/${room.code}/events?sessionToken=${sessionToken}`,
      } as IncomingMessage,
      response as unknown as ServerResponse,
      vi.fn(),
    );
    expect(manager.getPlayer(room, playerId)?.connected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(response.write).toHaveBeenCalledTimes(1);
  });
});
