/**
 * Production entry point. Build with `vp run build:server`, then run
 * `node dist-server/main.mjs` from the project root (after `vp run build`).
 *
 * Environment:
 * - PORT (default 3000), HOST (default 0.0.0.0)
 * - STATIC_DIR: client build directory (default `dist` next to `dist-server`)
 */
import { fileURLToPath } from "node:url";
import { createProductionServer } from "./app";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const staticDirectory =
  process.env.STATIC_DIR ?? fileURLToPath(new URL("../dist/", import.meta.url));

const { server, close } = createProductionServer({ staticDirectory });

server.listen(port, host, () => {
  console.log(`World Trivia listening on http://${host}:${port} (serving ${staticDirectory})`);
});

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down.`);
  close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
