import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  outputDir: "./test-results",
  use: {
    baseURL: "http://127.0.0.1:5174",
    trace: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], hasTouch: true },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit-mobile", use: { ...devices["iPhone 13"] } },
  ],
  // Local-source map runs can point at an already-running isolated Vite
  // server (for example one serving private Hopkins assets); don't start or
  // disturb the shared default test server in that mode.
  webServer: process.env.PLAYWRIGHT_EXTERNAL_SERVER === "1" ? undefined : {
    command: "npx vite --host 127.0.0.1 --port 5174 --strictPort",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: true,
    timeout: 120000,
    // Fixture served at /demo-map by the serve-only vite plugin. Default is
    // the committed synthetic fixture; local-only runs against real
    // pipeline output: E2E_FIXTURE_DIR=e2e/fixtures/hopkins.
    env: { E2E_FIXTURE_DIR: process.env.E2E_FIXTURE_DIR ?? "e2e/fixtures/synthetic" },
  },
});
