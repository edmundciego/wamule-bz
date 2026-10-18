import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const result = spawnSync("npm", ["run", "build"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, VITE_BUILD_ENV: "staging-preview", VITE_PUBLIC_DEMO_MODE: "true" },
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const headersSource = join(root, "deploy-config", "staging", "_headers");
const publishDirectory = join(root, "dist");
if (!existsSync(headersSource) || !existsSync(publishDirectory)) {
  throw new Error("Staging response headers or build output are unavailable.");
}
mkdirSync(publishDirectory, { recursive: true });
copyFileSync(headersSource, join(publishDirectory, "_headers"));
console.log("[staging-build] Added staging-only noindex response headers and local-demo submission guard.");
