import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { resolveConfig } from "vite";

const root = resolve(import.meta.dirname, "..");

test("Map Studio isolates React's Vite optimizer cache from the main app", async () => {
  const studio = await resolveConfig(
    { configFile: resolve(root, "apps/map-studio/vite.config.ts") },
    "serve",
  );
  const application = await resolveConfig(
    { configFile: resolve(root, "vite.config.ts") },
    "serve",
  );

  assert.equal(studio.cacheDir, resolve(root, "node_modules/.vite-map-studio"));
  assert.notEqual(studio.cacheDir, application.cacheDir);
  assert.ok(["react", "react-dom"].every((name) => studio.resolve.dedupe.includes(name)));
});
