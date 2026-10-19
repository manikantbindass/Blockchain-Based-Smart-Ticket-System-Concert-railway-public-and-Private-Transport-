import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        defaultBrowserType: "chromium",
        channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
      },
    },
  ],
  webServer: {
    command: "node apps/api/dist/server.js",
    url: "http://127.0.0.1:4173/api/ready",
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: "4173",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      SQLITE_PATH: ":memory:",
      SEED_DEMO: "true",
      DEMO_MODE: "true",
      BLOCKCHAIN_ENABLED: "false",
      WEB_ORIGIN: "http://127.0.0.1:4173",
    },
  },
});
