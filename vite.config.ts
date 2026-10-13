import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const FIXTURE_MIME: Record<string, string> = {
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".html": "text/html",
  ".js": "text/javascript",
};

/**
 * Serves the synthetic test fixture and the private Hopkins review fixture
 * at separate paths in dev only (`apply: "serve"` — `vite build` never runs
 * this, so no fixture file can reach dist/). The synthetic source may be
 * overridden for isolated local checks with E2E_FIXTURE_DIR; `/demo-hopkins-map`
 * always serves the explicit local candidate-review fixture.
 */
function e2eFixturePlugin(): Plugin {
  return {
    name: "e2e-fixture",
    apply: "serve",
    configureServer(server) {
      const root = server.config.root;
      const fixtures = [
        {
          route: "/demo-map",
          dir: resolve(root, process.env.E2E_FIXTURE_DIR ?? "e2e/fixtures/synthetic"),
        },
        { route: "/demo-hopkins-map", dir: resolve(root, "e2e/fixtures/hopkins") },
      ];
      for (const fixture of fixtures) {
        const prefix = fixture.dir.replace(/\\/g, "/");
        server.middlewares.use(fixture.route, (req, res, next) => {
          if (!req.url || req.method !== "GET") return next();
          const file = normalize(join(fixture.dir, decodeURIComponent(req.url.split("?")[0]))).replace(/\\/g, "/");
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
      }
    },
  };
}

/**
 * Serves the slice-1 correction workspace (correction-workspace/correct.html)
 * at /correct/ and its data directory at /correct/data/ in dev only
 * (`apply: "serve"` — never built, never in dist/). Default data is the
 * committed tiny fixture e2e/fixtures/correction; local-only runs against
 * real pipeline output: CORRECTION_DATA_DIR=out/hopkins-ocr.
 */
function correctionWorkspacePlugin(): Plugin {
  return {
    name: "correction-workspace",
    apply: "serve",
    configureServer(server) {
      const root = server.config.root;
      const appDir = resolve(root, "correction-workspace");
      const dataDir = resolve(root, process.env.CORRECTION_DATA_DIR ?? "e2e/fixtures/correction");
      const serve = (route: string, dir: string) => {
        const prefix = dir.replace(/\\/g, "/");
        server.middlewares.use(route, (req, res, next) => {
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
      };
      const serveRestricted = (route: string, dir: string, allowed: (relative: string) => boolean) => {
        const prefix = dir.replace(/\\/g, "/");
        server.middlewares.use(route, (req, res, next) => {
          if (!req.url || req.method !== "GET") return next();
          let relative: string;
          try {
            relative = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
          } catch {
            res.statusCode = 400;
            res.end();
            return;
          }
          if (!allowed(relative) || relative.split(/[\\/]/).some((part) => part === ".." || part === ".")) {
            res.statusCode = 404;
            res.end();
            return;
          }
          const file = normalize(join(dir, relative)).replace(/\\/g, "/");
          if (!file.startsWith(`${prefix}/`) || !existsSync(file) || !statSync(file).isFile()) {
            res.statusCode = 404;
            res.end();
            return;
          }
          const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
          res.setHeader("Content-Type", FIXTURE_MIME[ext] ?? "application/octet-stream");
          res.setHeader("Cache-Control", "no-store");
          createReadStream(file).pipe(res);
        });
      };
      serve("/correct/data", dataDir);
      serve("/correct", appDir);
      serveRestricted(
        "/correction-review/hopkins/map",
        resolve(root, "out/hopkins-ocr"),
        (relative) => relative === "lots.json" || relative === "masterplan_background.webp",
      );
      serveRestricted(
        "/correction-review/hopkins/benchmark",
        resolve(root, "out/hopkins-lot-number-benchmark-v1"),
        (relative) => relative === "benchmark-manifest.json" || /^sheet-crops\/S\d{3}\.png$/.test(relative),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), e2eFixturePlugin(), correctionWorkspacePlugin()],
});
