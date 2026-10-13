#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { preview } from "vite";
import { verifyPublicBuild } from "./verify-public-build.mjs";
import { verifyTenantBuild } from "./tenant-build-evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TENANT_SLUG = "hopkins-grove";

export function buildSyntheticPayload(sourceLots, apiOrigin) {
  if (!Array.isArray(sourceLots)) throw new Error("tenant lots output must be an array");
  const parcels = [];
  let renderedVertices = 0;
  for (const lot of sourceLots) {
    if (!Array.isArray(lot?.polygon_pct) || lot.polygon_pct.length < 3) continue;
    const polygon = lot.polygon_pct.map((point) => ({ x: Number(point?.x), y: Number(point?.y) }));
    if (polygon.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      throw new Error("tenant lots output contains a non-finite polygon coordinate");
    }
    if (polygon.some((point) => point.x < 0 || point.x > 100 || point.y < 0 || point.y > 100)) {
      throw new Error("tenant lots output contains a polygon coordinate outside 0–100% space");
    }
    const index = parcels.length + 1;
    renderedVertices += polygon.length;
    parcels.push({
      public_ref: null,
      lot_number: `P-${String(index).padStart(4, "0")}`,
      status: "Sold",
      price: 0,
      dimensions: null,
      area_sqm: null,
      map_polygon: polygon,
      tier_key: "synthetic-probe",
      tier_label: "Synthetic probe",
      tier_color_hex: "#4ade80",
      is_corner: false,
      effective_price_cents: 0,
    });
  }
  if (parcels.length === 0) throw new Error("tenant lots output contains no usable polygons");

  return {
    renderedVertices,
    payload: {
      tenant: { name: "Local synthetic performance fixture", slug: "performance-probe" },
      project: { slug: "performance-probe", name: "Local synthetic performance fixture" },
      masterplan_image_url: `${apiOrigin}/masterplan-background.webp`,
      masterplan_preview_url: `${apiOrigin}/masterplan-preview.webp`,
      branding: { company_name: "Local synthetic fixture", logo_url: "", short_description: "" },
      theme: null,
      parcels,
    },
  };
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "apikey, content-type");
  response.setHeader("Access-Control-Max-Age", "600");
  response.setHeader("Timing-Allow-Origin", "*");
  response.setHeader("Cache-Control", "no-store");
}

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("local fixture server has no TCP port"));
      resolveListen(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    if (!server?.listening) return resolveClose();
    server.close(() => resolveClose());
  });
}

function usage() {
  return [
    "Usage: npm run probe:production-map",
    "Requires a verified tenants/hopkins-grove/build package and installed Chromium.",
    "Builds the production bundle into a disposable temp directory and serves a local-only synthetic payload.",
  ].join("\n");
}

async function runProbe() {
  const packageDir = join(ROOT, "tenants", TENANT_SLUG, "build");
  const lotsPath = join(packageDir, "lots.json");
  const backgroundPath = join(packageDir, "masterplan_background.webp");
  const previewPath = join(packageDir, "masterplan_preview.webp");
  const manifest = verifyTenantBuild({ repositoryRoot: ROOT, slug: TENANT_SLUG });
  if (!manifest.ok) throw new Error("Hopkins private build does not pass its manifest verifier; refusing to use it as probe input");
  for (const path of [lotsPath, backgroundPath, previewPath]) {
    if (!existsSync(path)) throw new Error(`verified tenant build is missing a required probe input: ${path.split("/").at(-1)}`);
  }

  const rawLots = JSON.parse(readFileSync(lotsPath, "utf8"));
  const inputGeometryCount = Array.isArray(rawLots)
    ? rawLots.filter((lot) => Array.isArray(lot?.polygon_pct) && lot.polygon_pct.length >= 3).length
    : 0;
  const counters = { lotApiGets: 0, previewGets: 0, fullBackgroundGets: 0 };
  let syntheticPayload = null;
  const background = readFileSync(backgroundPath);
  const mobilePreview = readFileSync(previewPath);
  const fixtureServer = createServer((request, response) => {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && pathname === "/functions/v1/get-public-lots" && syntheticPayload) {
      counters.lotApiGets += 1;
      const body = gzipSync(Buffer.from(JSON.stringify(syntheticPayload.payload)));
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": "gzip",
        "Content-Length": body.length,
      });
      response.end(body);
      return;
    }
    if (request.method === "GET" && pathname === "/masterplan-preview.webp") {
      counters.previewGets += 1;
      response.writeHead(200, { "Content-Type": "image/webp", "Content-Length": mobilePreview.length });
      response.end(mobilePreview);
      return;
    }
    if (request.method === "GET" && pathname === "/masterplan-background.webp") {
      counters.fullBackgroundGets += 1;
      response.writeHead(200, { "Content-Type": "image/webp", "Content-Length": background.length });
      response.end(background);
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  let browser;
  let cdp;
  let previewServer;
  let temporaryRoot;
  try {
    const fixturePort = await listen(fixtureServer);
    const apiOrigin = `http://127.0.0.1:${fixturePort}`;
    syntheticPayload = buildSyntheticPayload(rawLots, apiOrigin);
    temporaryRoot = mkdtempSync(join(tmpdir(), "wamule-production-map-probe-"));
    const isolatedDist = join(temporaryRoot, "dist");

    const buildEnvironment = {
      ...process.env,
      VITE_SUPABASE_URL: apiOrigin,
      VITE_SUPABASE_ANON_KEY: "local-performance-fixture-key",
    };
    execFileSync("npm", ["run", "build", "--", "--outDir", isolatedDist, "--emptyOutDir"], {
      cwd: ROOT,
      env: buildEnvironment,
      stdio: "inherit",
    });

    const artifactCheck = verifyPublicBuild(isolatedDist);
    if (artifactCheck.errors.length > 0) {
      throw new Error(`isolated production artifact guard failed: ${artifactCheck.errors.length} issue(s)`);
    }

    previewServer = await preview({
      root: ROOT,
      configFile: join(ROOT, "vite.config.ts"),
      build: { outDir: isolatedDist },
      preview: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    const previewAddress = previewServer.httpServer.address();
    if (!previewAddress || typeof previewAddress === "string") throw new Error("production preview has no TCP port");
    const previewOrigin = `http://127.0.0.1:${previewAddress.port}`;

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 412, height: 839 },
      deviceScaleFactor: 2.625,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const allowedOrigins = new Set([apiOrigin, previewOrigin]);
    const blockedExternalOrigins = new Set();
    const pageErrors = [];
    const consoleErrors = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if ((url.protocol === "http:" || url.protocol === "https:") && !allowedOrigins.has(url.origin)) {
        blockedExternalOrigins.add(url.origin);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    page.on("pageerror", (error) => pageErrors.push(error.name));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push("console error");
    });

    cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 50,
      downloadThroughput: 1_500_000,
      uploadThroughput: 750_000,
      connectionType: "cellular4g",
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

    await page.goto(`${previewOrigin}/embed/performance-probe`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(
      (expected) => document.querySelectorAll('main svg polygon[fill="transparent"]').length === expected,
      syntheticPayload.payload.parcels.length,
      { timeout: 60000 },
    );
    await page.waitForFunction(
      () => performance.getEntriesByType("resource").some((entry) => {
        const resource = entry;
        return new URL(resource.name).pathname === "/masterplan-preview.webp" && resource.responseEnd > 0;
      }),
      undefined,
      { timeout: 60000 },
    );

    const report = await page.evaluate(({ expectedPolygons, vertices }) => {
      const navigation = performance.getEntriesByType("navigation")[0];
      const resources = performance.getEntriesByType("resource");
      const largestResources = resources
        .map((entry) => ({ path: new URL(entry.name).pathname, transferBytes: entry.transferSize, encodedBodyBytes: entry.encodedBodySize }))
        .sort((left, right) => right.transferBytes - left.transferBytes)
        .slice(0, 12);
      const preview = resources.find((entry) => new URL(entry.name).pathname === "/masterplan-preview.webp");
      return {
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        profile: {
          downloadBytesPerSecond: 1_500_000,
          uploadBytesPerSecond: 750_000,
          roundTripLatencyMs: 50,
          cpuSlowdown: 4,
          cacheDisabled: true,
        },
        usefulMapReadyMs: Number(performance.now().toFixed(1)),
        firstContentfulPaintMs: Number((performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0).toFixed(1)),
        domContentLoadedMs: Number((navigation?.domContentLoadedEventEnd ?? 0).toFixed(1)),
        loadEventEndMs: Number((navigation?.loadEventEnd ?? 0).toFixed(1)),
        navigationTransferBytes: navigation?.transferSize ?? 0,
        resourceTransferBytes: resources.reduce((total, entry) => total + entry.transferSize, 0),
        resourceEncodedBodyBytes: resources.reduce((total, entry) => total + entry.encodedBodySize, 0),
        largestResources,
        mobilePreview: preview
          ? {
              transferBytes: preview.transferSize,
              encodedBodyBytes: preview.encodedBodySize,
              responseEndMs: Number(preview.responseEnd.toFixed(1)),
            }
          : null,
        renderedHitPolygons: document.querySelectorAll('main svg polygon[fill="transparent"]').length,
        expectedPolygons,
        sourceVertices: vertices,
      };
    }, { expectedPolygons: syntheticPayload.payload.parcels.length, vertices: syntheticPayload.renderedVertices });

    const totalTransferBytes = report.navigationTransferBytes + report.resourceTransferBytes;
    const completed = {
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      method: "isolated Vite production build; Chromium mobile viewport; local gzip API fixture and local WebP assets over CDP-throttled loopback HTTP",
      source: {
        package: "verified tenants/hopkins-grove/build output",
        geometryOnly: true,
        anonymizedLotLabels: true,
        syntheticStatusPriceAndTier: true,
        renderedPolygons: syntheticPayload.payload.parcels.length,
        renderedVertices: syntheticPayload.renderedVertices,
        apiJsonGzipBytes: gzipSync(Buffer.from(JSON.stringify(syntheticPayload.payload))).length,
        previewAssetBytes: mobilePreview.length,
      },
      browser: report,
      totalTransferBytes,
      withinProvisional3SecondAim: report.usefulMapReadyMs <= 3000,
      fixtureRequests: counters,
      blockedExternalOriginCount: blockedExternalOrigins.size,
      pageErrorCount: pageErrors.length,
      consoleErrorCount: consoleErrors.length,
      limitations: [
        "Local synthetic payload only; lot labels, tier, status, price, area, branding, and public references are synthetic or absent.",
        "The private Hopkins geometry and preview image are read from the verified local build and served only on loopback; no hosted request is allowed.",
        "This is Chromium emulation, not a physical phone; it does not measure sustained frame rate, Edge execution, approved register values, or a hosted route.",
        "The 3-second figure is a provisional engineering aim, not an owner-approved release threshold.",
      ],
    };
    console.log(`[production-map-probe] ${JSON.stringify(completed)}`);

    if (report.renderedHitPolygons !== report.expectedPolygons) throw new Error("production map did not render the complete synthetic polygon set");
    if (!report.mobilePreview) throw new Error("mobile preview was not requested/measured at the phone viewport");
    if (counters.lotApiGets < 1 || counters.previewGets < 1 || counters.fullBackgroundGets !== 0) {
      throw new Error("production fixture did not exercise the expected compressed API + mobile preview path");
    }
    if (blockedExternalOrigins.size > 0) throw new Error("browser attempted to contact an external origin; the request was blocked");
    if (pageErrors.length > 0 || consoleErrors.length > 0) throw new Error("production map emitted a browser or console error");
  } finally {
    try { await cdp?.detach(); } catch { /* browser teardown closes remaining sessions */ }
    await browser?.close();
    if (previewServer?.httpServer?.listening) {
      await new Promise((resolveClose) => previewServer.httpServer.close(() => resolveClose()));
    }
    await closeServer(fixtureServer);
    if (temporaryRoot?.startsWith(join(tmpdir(), "wamule-production-map-probe-"))) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

async function main(argv) {
  if (argv.length > 0) {
    console.log(usage());
    process.exitCode = argv.length === 1 && ["--help", "-h"].includes(argv[0]) ? 0 : 2;
    return;
  }
  try {
    await runProbe();
  } catch (error) {
    console.error(`[production-map-probe] ${error instanceof Error ? error.message : "probe failed"}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2));
}
