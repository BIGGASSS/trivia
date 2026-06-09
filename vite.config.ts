import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { multiplayerPlugin } from "./server/multiplayer";

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), multiplayerPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
