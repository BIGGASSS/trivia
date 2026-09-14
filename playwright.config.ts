import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  reporter: "list",
  outputDir: "./node_modules/.cache/playwright-results",
  use: {
    browserName: "chromium",
    baseURL: "http://trivia.test",
    viewport: { width: 1100, height: 1000 },
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  // Intentionally no webServer: the browser fixture fulfills requests from dist/.
});
