// @vitest-environment node
import { createServer, request as httpRequest } from "node:http";
import type { ClientRequest, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createMultiplayerMiddleware } from "../multiplayer";
import { createRoomManager } from "../room-manager";
import type { RoomManager } from "../room-manager";
import type { MultiplayerApiResponse, PublicRoomState } from "../../shared/multiplayer-types";

const countries = [
  { id: "fr", name: "France" },
  { id: "jp", name: "Japan" },
];

type ApiPayload = MultiplayerApiResponse & { error?: string; ok?: boolean };

describe("multiplayer HTTP/SSE adapter", () => {
  let manager: RoomManager;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    manager = createRoomManager({
      loadCountries: () => Promise.resolve(countries),
      revealDelayMilliseconds: 20,
    });
    const middleware = createMultiplayerMiddleware(manager);
    server = createServer((request, response) => {
      middleware(request, response, () => {
        response.writeHead(404).end("not multiplayer");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    manager.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const jsonRequest = async (path: string, body?: unknown) => {
    const response = await fetch(
      `${baseUrl}/api/multiplayer/rooms${path}`,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const payload = (await response.json()) as ApiPayload;
    return { status: response.status, headers: response.headers, payload };
  };

  const createJoinedRoom = async (rounds = 2) => {
    const host = await jsonRequest("", { playerName: "Host", rounds });
    const code = host.payload.room.roomCode;
    const guest = await jsonRequest(`/${code}/join`, { playerName: "Guest" });
    return { code, host: host.payload, guest: guest.payload };
  };

  const openEvents = async (code: string, sessionToken: string) => {
    const response = await fetch(
      `${baseUrl}/api/multiplayer/rooms/${code}/events?sessionToken=${sessionToken}`,
    );
    const states: PublicRoomState[] = [];
    let raw = "";
    let ended = false;
    const reader = response.body!.getReader();
    const done = (async () => {
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        raw += chunk;
        pending += chunk;
        let end = pending.indexOf("\n\n");
        while (end >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (frame.startsWith("event: state\n")) {
            states.push(JSON.parse(frame.slice("event: state\ndata: ".length)) as PublicRoomState);
          }
          end = pending.indexOf("\n\n");
        }
      }
      ended = true;
    })();
    // Attach a rejection handler immediately; assertions can still await `done`.
    void done.catch(() => {});
    return {
      response,
      states,
      done,
      get raw() {
        return raw;
      },
      get ended() {
        return ended;
      },
    };
  };

  it("creates and joins with private credentials that never appear in snapshots", async () => {
    const create = await jsonRequest("", { playerName: "Host" });
    expect(create.status).toBe(201);
    expect(create.headers.get("cache-control")).toBe("no-store");
    expect(create.payload.sessionToken).toEqual(expect.any(String));
    expect(create.payload.sessionToken).not.toBe(create.payload.playerId);
    expect(create.payload.room).toMatchObject({ revision: 1, matchId: null, roundId: null });
    const code = create.payload.room.roomCode;
    const join = await jsonRequest(`/${code}/join`, { playerName: "Guest" });
    expect(join.status).toBe(200);
    expect(join.payload.sessionToken).toEqual(expect.any(String));
    expect(join.payload.sessionToken).not.toBe(create.payload.sessionToken);
    const snapshot = await jsonRequest(`/${code}?sessionToken=${create.payload.sessionToken}`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.payload.room.playerId).toBe(create.payload.playerId);
    expect(snapshot.payload.room.players.every((player) => player.active)).toBe(true);
    expect(snapshot.payload).not.toHaveProperty("sessionToken");
    expect(JSON.stringify(snapshot.payload)).not.toContain(create.payload.sessionToken);
    expect(JSON.stringify(snapshot.payload)).not.toContain(join.payload.sessionToken);
  });

  it("rejects public player IDs as credentials on every protected route", async () => {
    const { code, host } = await createJoinedRoom();
    for (const suffix of ["", "/events"]) {
      expect((await jsonRequest(`/${code}${suffix}?playerId=${host.playerId}`)).status).toBe(403);
      expect((await jsonRequest(`/${code}${suffix}?sessionToken=${host.playerId}`)).status).toBe(
        403,
      );
    }
    for (const action of ["start", "guess", "skip", "leave"]) {
      expect((await jsonRequest(`/${code}/${action}`, { playerId: host.playerId })).status).toBe(
        403,
      );
      expect(
        (await jsonRequest(`/${code}/${action}`, { sessionToken: host.playerId })).status,
      ).toBe(403);
    }
    const other = await jsonRequest("", {});
    expect((await jsonRequest(`/${code}?sessionToken=${other.payload.sessionToken}`)).status).toBe(
      403,
    );
  });

  it("derives host, answer and leave identity only from the token, ignoring forged body playerId", async () => {
    const { code, host, guest } = await createJoinedRoom();
    expect(
      (
        await jsonRequest(`/${code}/start`, {
          sessionToken: guest.sessionToken,
          playerId: host.playerId,
        })
      ).status,
    ).toBe(403);
    const start = await jsonRequest(`/${code}/start`, {
      sessionToken: host.sessionToken,
      playerId: guest.playerId,
    });
    expect(start.status).toBe(200);
    expect(start.payload.room.playerId).toBe(host.playerId);
    const { matchId, roundId } = start.payload.room;
    const answer = await jsonRequest(`/${code}/guess`, {
      sessionToken: guest.sessionToken,
      playerId: host.playerId,
      matchId,
      roundId,
      countryId: manager.getRoom(code)!.currentCountry!.id,
    });
    expect(answer.status).toBe(200);
    expect(answer.payload).not.toHaveProperty("sessionToken");
    expect(answer.payload.room.playerId).toBe(guest.playerId);
    expect(answer.payload.room.players.find((player) => player.id === guest.playerId)?.score).toBe(
      1,
    );
    expect(answer.payload.room.players.find((player) => player.id === host.playerId)?.score).toBe(
      0,
    );
    const snapshot = await jsonRequest(
      `/${code}?sessionToken=${guest.sessionToken}&playerId=${host.playerId}`,
    );
    expect(snapshot.payload.room.playerId).toBe(guest.playerId);
    expect(snapshot.payload.room.ownFeedback?.state).toBe("correct");
    const leave = await jsonRequest(`/${code}/leave`, {
      sessionToken: guest.sessionToken,
      playerId: host.playerId,
    });
    expect(leave.status).toBe(200);
    expect(manager.getPlayer(manager.getRoom(code)!, host.playerId!)?.active).toBe(true);
    expect(manager.getPlayer(manager.getRoom(code)!, guest.playerId!)?.active).toBe(false);
  });

  it("requires match and round IDs for guess and skip and rejects stale identities", async () => {
    const { code, host } = await createJoinedRoom();
    const start = await jsonRequest(`/${code}/start`, { sessionToken: host.sessionToken });
    const room = manager.getRoom(code)!;
    const { matchId, roundId } = start.payload.room;
    for (const action of ["guess", "skip"]) {
      for (const ids of [{}, { matchId }, { roundId }]) {
        expect(
          (
            await jsonRequest(`/${code}/${action}`, {
              sessionToken: host.sessionToken,
              countryId: "fr",
              ...ids,
            })
          ).status,
        ).toBe(400);
      }
    }
    expect(
      (await jsonRequest(`/${code}/guess`, { sessionToken: host.sessionToken, matchId, roundId }))
        .status,
    ).toBe(400);
    expect(
      (
        await jsonRequest(`/${code}/skip`, {
          sessionToken: host.sessionToken,
          matchId: "old-match",
          roundId,
        })
      ).status,
    ).toBe(409);
    manager.finishRound(room);
    await vi.waitFor(() => expect(room.currentRound).toBe(2));
    const revision = room.revision;
    expect(
      (
        await jsonRequest(`/${code}/guess`, {
          sessionToken: host.sessionToken,
          matchId,
          roundId,
          countryId: "fr",
        })
      ).status,
    ).toBe(409);
    expect(room.revision).toBe(revision);
    expect(manager.getPlayer(room, host.playerId!)?.answeredThisRound).toBe(false);
  });

  it("serializes concurrent answers and starts atomically over HTTP", async () => {
    const { code, host } = await createJoinedRoom();
    const starts = await Promise.all([
      jsonRequest(`/${code}/start`, { sessionToken: host.sessionToken }),
      jsonRequest(`/${code}/start`, { sessionToken: host.sessionToken }),
    ]);
    expect(starts.map((result) => result.status).sort((first, second) => first - second)).toEqual([
      200, 409,
    ]);
    const room = manager.getRoom(code)!;
    const answers = await Promise.all(
      Array.from({ length: 4 }, () =>
        jsonRequest(`/${code}/guess`, {
          sessionToken: host.sessionToken,
          matchId: room.matchId,
          roundId: room.roundId,
          countryId: room.currentCountry!.id,
        }),
      ),
    );
    expect(answers.filter((result) => result.status === 200)).toHaveLength(1);
    expect(manager.getPlayer(room, host.playerId!)).toMatchObject({ score: 1, attempts: 1 });
  });

  it("rejects a guess after the authoritative deadline before its timer callback", async () => {
    const { code, host } = await createJoinedRoom();
    await jsonRequest(`/${code}/start`, { sessionToken: host.sessionToken });
    const room = manager.getRoom(code)!;
    room.roundEndsAt = Date.now() - 1;
    const result = await jsonRequest(`/${code}/guess`, {
      sessionToken: host.sessionToken,
      matchId: room.matchId,
      roundId: room.roundId,
      countryId: room.currentCountry!.id,
    });
    expect(result.status).toBe(409);
    expect(manager.getPlayer(room, host.playerId!)?.roundPerformance).toEqual([
      { round: 1, outcome: "timeout" },
    ]);
    expect(manager.getPlayer(room, host.playerId!)?.score).toBe(0);
  });

  it("SSE and HTTP carry the same revisions, without duplicate initial frames or credential leakage", async () => {
    const { code, host, guest } = await createJoinedRoom();
    const stream = await openEvents(code, host.sessionToken!);
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get("content-type")).toBe("text/event-stream");
    await vi.waitFor(() => expect(stream.states).toHaveLength(1));
    const start = await jsonRequest(`/${code}/start`, { sessionToken: host.sessionToken });
    await vi.waitFor(() =>
      expect(stream.states[stream.states.length - 1]?.revision).toBe(start.payload.room.revision),
    );
    expect(stream.states[stream.states.length - 1]).toEqual(start.payload.room);
    const answer = await jsonRequest(`/${code}/skip`, {
      sessionToken: host.sessionToken,
      matchId: start.payload.room.matchId,
      roundId: start.payload.room.roundId,
    });
    await vi.waitFor(() =>
      expect(stream.states.some((state) => state.revision === answer.payload.room.revision)).toBe(
        true,
      ),
    );
    expect(stream.states.find((state) => state.revision === answer.payload.room.revision)).toEqual(
      answer.payload.room,
    );
    const revisions = stream.states.map((state) => state.revision);
    expect(
      revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!),
    ).toBe(true);
    expect(stream.raw).not.toContain(host.sessionToken);
    expect(stream.raw).not.toContain(guest.sessionToken);
    expect(stream.raw).not.toContain("sessionToken");
    manager.dispose();
    await stream.done;
    expect(stream.ended).toBe(true);
  });

  it("leaving revokes every open SSE stream and blocks reconnect, GET and POST with the old credential", async () => {
    const { code, host, guest } = await createJoinedRoom();
    const first = await openEvents(code, guest.sessionToken!);
    const second = await openEvents(code, guest.sessionToken!);
    await vi.waitFor(() => expect(second.states).toHaveLength(1));
    await jsonRequest(`/${code}/start`, { sessionToken: host.sessionToken });
    const leave = await jsonRequest(`/${code}/leave`, { sessionToken: guest.sessionToken });
    expect(leave.status).toBe(200);
    await Promise.all([first.done, second.done]);
    expect(first.ended).toBe(true);
    expect(second.ended).toBe(true);
    const count = first.states.length;
    const snapshot = await jsonRequest(`/${code}?sessionToken=${host.sessionToken}`);
    expect(
      snapshot.payload.room.players.find((player) => player.id === guest.playerId),
    ).toMatchObject({ active: false, connected: false });
    expect((await jsonRequest(`/${code}?sessionToken=${guest.sessionToken}`)).status).toBe(403);
    expect((await jsonRequest(`/${code}/events?sessionToken=${guest.sessionToken}`)).status).toBe(
      403,
    );
    for (const action of ["start", "skip", "leave"]) {
      expect(
        (await jsonRequest(`/${code}/${action}`, { sessionToken: guest.sessionToken })).status,
      ).toBe(403);
    }
    manager.finishRound(manager.getRoom(code)!);
    expect(first.states).toHaveLength(count);
  });

  it("deleting a room and disposing a manager close real SSE responses", async () => {
    const host = await jsonRequest("", {});
    const code = host.payload.room.roomCode;
    const stream = await openEvents(code, host.payload.sessionToken!);
    await vi.waitFor(() => expect(stream.states).toHaveLength(1));
    expect(
      (await jsonRequest(`/${code}/leave`, { sessionToken: host.payload.sessionToken })).status,
    ).toBe(200);
    await stream.done;
    expect(stream.ended).toBe(true);
    expect((await jsonRequest(`/${code}?sessionToken=${host.payload.sessionToken}`)).status).toBe(
      404,
    );
    const next = await jsonRequest("", {});
    const nextStream = await openEvents(next.payload.room.roomCode, next.payload.sessionToken!);
    manager.dispose();
    await nextStream.done;
    expect(nextStream.ended).toBe(true);
  });

  it("rechecks room membership after reading a delayed POST body", async () => {
    const { code, host, guest } = await createJoinedRoom();
    const body = JSON.stringify({ sessionToken: guest.sessionToken });
    let pending!: ClientRequest;
    const result = new Promise<number>((resolve, reject) => {
      pending = httpRequest(
        `${baseUrl}/api/multiplayer/rooms/${code}/leave`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        },
      );
      pending.on("error", reject);
    });
    pending.write(body.slice(0, 1));
    await jsonRequest(`/${code}/leave`, { sessionToken: guest.sessionToken });
    pending.end(body.slice(1));
    expect(await result).toBe(403);
    expect(manager.getRoom(code)?.hostId).toBe(host.playerId);
  });

  it("rejects invalid JSON shapes and passes unrelated paths to next", async () => {
    for (const body of [null, [], "string", 123]) {
      expect((await jsonRequest("", body)).status).toBe(400);
    }
    const unrelated = await fetch(`${baseUrl}/other`);
    expect(unrelated.status).toBe(404);
    expect(await unrelated.text()).toBe("not multiplayer");
  });
});
