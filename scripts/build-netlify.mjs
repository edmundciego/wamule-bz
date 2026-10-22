import { spawnSync } from "node:child_process";
import { getNetlifyBuildScript } from "./netlify-build-target.mjs";

const script = getNetlifyBuildScript(process.env);
const branch = process.env.BRANCH?.trim() || "local";
console.log(`[netlify-build] ${script} selected for branch ${branch}.`);

const result = spawnSync("npm", ["run", script], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env,
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
