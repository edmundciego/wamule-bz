import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const FIXTURE_MIME: Record<string, string> = {
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
};

/**
 * Serves the e2e map fixture directory at /demo-map in dev only
 * (`apply: "serve"` — `vite build` never runs this, so no fixture file can
 * reach dist/). Default: the committed synthetic fixture. Local-only runs
 * against real pipeline output: E2E_FIXTURE_DIR=e2e/fixtures/hopkins.
 */
function e2eFixturePlugin(): Plugin {
  return {
    name: "e2e-fixture",
    apply: "serve",
    configureServer(server) {
      const root = server.config.root;
      const dir = resolve(root, process.env.E2E_FIXTURE_DIR ?? "e2e/fixtures/synthetic");
      const prefix = dir.replace(/\\/g, "/");
      server.middlewares.use("/demo-map", (req, res, next) => {
        if (!req.url || req.method !== "GET") return next();
        const file = normalize(join(dir, decodeURIComponent(req.url.split("?")[0]))).replace(/\\/g, "/");
        if (file !== prefix && !file.startsWith(`${prefix}/`)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
        res.setHeader("Content-Type", FIXTURE_MIME[ext] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), e2eFixturePlugin()],
});
