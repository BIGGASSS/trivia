/**
 * Production HTTP server: serves the built client from `dist/` and handles the
 * multiplayer API with the same middleware that Vite dev/preview use.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { join } from "node:path";
import sirv from "sirv";
import { createCountriesLoader, createMultiplayerMiddleware, startRoomSweep } from "./multiplayer";
import { createRoomManager } from "./room-manager";
import type { RoomManager } from "./room-manager";

export interface ProductionServerOptions {
  /** Directory containing the `vp build` output (index.html, assets/, ...). */
  staticDirectory: string;
  /** Override the room manager (tests). Defaults to one backed by the built map data. */
  manager?: RoomManager;
}

export interface ProductionServer {
  server: Server;
  manager: RoomManager;
  /** Stop accepting requests, end open SSE streams, and dispose the room manager. */
  close: () => Promise<void>;
}

export const createProductionServer = ({
  staticDirectory,
  manager = createRoomManager({
    loadCountries: createCountriesLoader(join(staticDirectory, "countries.paths.json")),
  }),
}: ProductionServerOptions): ProductionServer => {
  const stopSweep = startRoomSweep(manager);
  const multiplayer = createMultiplayerMiddleware(manager);
  const assets = sirv(staticDirectory, {
    // Fall back to index.html so client-side (history mode) routes resolve.
    single: true,
    etag: true,
    gzip: false,
    brotli: false,
    setHeaders: (response, pathname) => {
      // Vite fingerprints everything under assets/, so it can be cached forever.
      response.setHeader(
        "Cache-Control",
        pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      );
    },
  });

  const server = createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    multiplayer(request, response, () => {
      assets(request, response, () => {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      });
    });
  });

  const close = async () => {
    stopSweep();
    manager.dispose();
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    // SSE streams never end on their own; drop them so close() can finish.
    server.closeAllConnections();
    await closed;
  };

  return { server, manager, close };
};
