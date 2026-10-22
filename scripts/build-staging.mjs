import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createStagingBuildEnv } from "./staging-build-config.mjs";

const root = process.cwd();
const env = createStagingBuildEnv(process.env);
const result = spawnSync("npm", ["run", "build"], {
  cwd: root,
  stdio: "inherit",
  env,
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

const guard = spawnSync("npm", ["run", "verify:public-build:staging"], {
  cwd: root,
  stdio: "inherit",
  env,
});
if (guard.error) throw guard.error;
if (guard.status !== 0) process.exit(guard.status ?? 1);

console.log(
  `[staging-build] Project ${env.VITE_SUPABASE_URL}; demo mode on; connected submissions limited to ${env.VITE_PUBLIC_STAGING_SUBMISSION_SCOPES}.`,
);
