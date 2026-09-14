import { fileURLToPath } from "node:url";
import { mergeConfig, defineConfig } from "vite-plus";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      // Use jsdom's storage instead of Node's native Web Storage globals.
      execArgv: ["--no-experimental-webstorage"],
      root: fileURLToPath(new URL("./", import.meta.url)),
    },
  }),
);
