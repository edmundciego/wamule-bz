import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "shared-public-homepage.spec.ts",
  fullyParallel: false,
  reporter: "list",
  outputDir: "../test-results/shared-public-homepage",
  use: {
    baseURL: "http://127.0.0.1:5382",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "cd .. && ./node_modules/.bin/vite --host 127.0.0.1 --port 5382 --strictPort",
    url: "http://127.0.0.1:5382",
    reuseExistingServer: false,
    env: {
      VITE_SUPABASE_URL: "https://tenant-homepage.invalid",
      VITE_SUPABASE_ANON_KEY: "synthetic-browser-test",
      VITE_PUBLIC_DEMO_MODE: "true",
    },
  },
});
