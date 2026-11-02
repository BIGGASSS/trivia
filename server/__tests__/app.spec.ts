// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createProductionServer } from "../app";
import type { ProductionServer } from "../app";

describe("production server", () => {
  let staticDirectory: string;
  let app: ProductionServer;
  let baseUrl: string;

  beforeEach(async () => {
    staticDirectory = await mkdtemp(join(tmpdir(), "trivia-dist-"));
    await mkdir(join(staticDirectory, "assets"));
    await writeFile(join(staticDirectory, "index.html"), "<!doctype html><title>app</title>");
    await writeFile(join(staticDirectory, "assets", "app-abc123.js"), "console.log(1);");
    await writeFile(
      join(staticDirectory, "countries.paths.json"),
      JSON.stringify({ countries: [{ id: "fr", name: "France" }] }),
    );
    app = createProductionServer({ staticDirectory });
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app.close();
    await rm(staticDirectory, { recursive: true, force: true });
  });

  it("serves index.html for client-side routes", async () => {
    const response = await fetch(`${baseUrl}/multiplayer/ABCD`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toContain("<title>app</title>");
  });

  it("caches fingerprinted assets immutably", async () => {
    const response = await fetch(`${baseUrl}/assets/app-abc123.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  it("handles the multiplayer API using the built map data", async () => {
    const response = await fetch(`${baseUrl}/api/multiplayer/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerName: "Ada" }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = (await response.json()) as { room: { roomCode: string } };
    expect(payload.room.roomCode).toBeTruthy();
  });

  /** Send a raw HTTP/1.1 request so the request target is not normalized by a client. */
  const rawRequest = (target: string) =>
    new Promise<string>((resolve, reject) => {
      const { port } = app.server.address() as AddressInfo;
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      });
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => (data += chunk));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });

  it.each(["//[", "/api/multiplayer/rooms//[", "/%E0%A4%A"])(
    "rejects malformed request target %s without crashing",
    async (target) => {
      const raw = await rawRequest(target);
      expect(raw).toMatch(/^HTTP\/1\.1 (200|400|404) /);
      // The server is still up and serving normal requests.
      const response = await fetch(`${baseUrl}/`);
      expect(response.status).toBe(200);
    },
  );

  it("closes while an SSE stream is open", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/multiplayer/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName: "Ada" }),
      })
    ).json()) as { sessionToken: string; room: { roomCode: string } };
    const events = await fetch(
      `${baseUrl}/api/multiplayer/rooms/${created.room.roomCode}/events?sessionToken=${created.sessionToken}`,
    );
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    await expect(app.close()).resolves.toBeUndefined();
    await events.body?.cancel().catch(() => {});
    // afterEach closes again; make that a no-op-safe call.
    app = { ...app, close: () => Promise.resolve() };
  });
});
