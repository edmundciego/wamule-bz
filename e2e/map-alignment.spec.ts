import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const demoUrl = "/embed/demo?demo=1";
const privateBuild = resolve(process.cwd(), "out/hopkins-ocr");
const privateLotsPath = resolve(privateBuild, "lots.json");
const privateBackgroundPath = resolve(privateBuild, "masterplan_background.webp");
const hasPrivateAlignmentSource = existsSync(privateLotsPath) && existsSync(privateBackgroundPath);
const sourceLots = hasPrivateAlignmentSource
  ? (JSON.parse(readFileSync(privateLotsPath, "utf8")) as Array<{
      polygon_pct?: Array<{ x: number; y: number }>;
    }>)
  : [];
const alignmentLots = sourceLots
  .filter((lot) => Array.isArray(lot.polygon_pct) && lot.polygon_pct.length >= 3)
  .map((lot, index) => ({
    lot_number: `ALIGN-${String(index + 1).padStart(4, "0")}`,
    tier_key: "alignment",
    price: 0,
    status: "Sold",
    polygon_pct: lot.polygon_pct,
  }));

test("Hopkins background and polygon coordinates stay aligned across ratios and zoom", async ({ page }, testInfo) => {
  test.skip(!["chromium", "webkit-mobile"].includes(testInfo.project.name), "Run the viewport matrix in Chromium and WebKit/iPhone.");
  test.skip(!hasPrivateAlignmentSource, "Local Hopkins build artifacts are not present; no private map files are bundled with this test.");

  // Inject only the two needed private build artifacts. Do not point Vite's
  // fixture server at out/hopkins-ocr: that directory also contains OCR and
  // reviewer evidence. The browser receives anonymized labels and polygons.
  await page.route("**/demo-map/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/demo-map/lots.json") {
      await route.fulfill({ json: alignmentLots });
    } else if (pathname === "/demo-map/tiers.json") {
      await route.fulfill({ json: { tiers: { alignment: { label: "Geometry check", price: 0, legend: "#4ade80" } } } });
    } else if (pathname === "/demo-map/masterplan_background.webp") {
      await route.fulfill({ path: privateBackgroundPath });
    } else {
      await route.fulfill({ status: 404, body: "Private alignment fixture exposes no other files." });
    }
  });

  const businessApiRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/(?:functions|rest)\/v1\//.test(path)) businessApiRequests.push(path);
  });

  const viewports = [
    { name: "desktop landscape", width: 1280, height: 800 },
    { name: "phone portrait", width: 390, height: 844 },
    { name: "phone landscape", width: 844, height: 390 },
  ];
  const mapSvg = page.getByRole("group", { name: "Interactive lot map" });

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForFunction(({ width, height }) => window.innerWidth === width && window.innerHeight === height, viewport);
    await page.goto(demoUrl);
    await expect.poll(() => page.locator('main svg polygon[fill="transparent"]').count(), { timeout: 30000 }).toBeGreaterThan(50);
    const mapMarkers = page.locator('main svg > g[aria-hidden="true"] > g[data-lot-status]');
    await expect.poll(() => mapMarkers.count(), { timeout: 15000 }).toBe(alignmentLots.length);

    // These are anonymized alignment polygons with one deliberately forced
    // status. This is a deterministic visual-state check, never inventory.
    const statusMarkers = await mapMarkers.evaluateAll((elements) =>
      [...new Set(elements.map((element) => `${element.getAttribute("data-lot-status")}:${element.getAttribute("data-marker-shape")}:${element.firstElementChild?.getAttribute("fill")?.toLowerCase()}`))],
    );
    expect(statusMarkers).toEqual(["Sold:square:#ef4444"]);

    await page.getByRole("button", { name: "Tier colours", exact: true }).click();
    await expect(page.locator('[aria-label="Map legend"]')).toContainText("Selected lot");
    const tierMarkers = await mapMarkers.evaluateAll((elements) =>
      [...new Set(elements.map((element) => `${element.getAttribute("data-marker-shape")}:${element.firstElementChild?.getAttribute("fill")?.toLowerCase()}`))],
    );
    expect(tierMarkers).toEqual(["circle:#4ade80"]);
    await page.getByRole("button", { name: "Status colours", exact: true }).click();

    // Use the real local Hopkins raster here; the buyer's display must mute
    // its printed tier colors and de-emphasize baked plat detail without
    // changing the source file or geometry.
    await expect(mapSvg.locator("image")).toHaveCSS("filter", "grayscale(1)");
    await expect(mapSvg.locator("image")).toHaveCSS("opacity", "0.68");
    await expect
      .poll(() => mapSvg.getAttribute("viewBox"), { timeout: 15000 })
      .not.toBe("0 0 100 100");

    const reset = page.getByRole("button", { name: "Reset zoom" });
    if (await reset.isEnabled()) await reset.click();
    await expect.poll(async () => Number((await mapSvg.getAttribute("viewBox"))?.split(" ")[2])).toBe(100);

    for (let zoomStep = 0; zoomStep < 3; zoomStep += 1) {
      if (zoomStep > 0) {
        const previousWidth = Number((await mapSvg.getAttribute("viewBox"))?.split(" ")[2]);
        await page.getByRole("button", { name: "Zoom in" }).click();
        await expect.poll(async () => Number((await mapSvg.getAttribute("viewBox"))?.split(" ")[2])).toBeLessThan(previousWidth);
      }

      const alignment = await page.evaluate(async () => {
        const svg = document.querySelector('svg[aria-label="Interactive lot map"]') as SVGSVGElement | null;
        const image = svg?.querySelector("image") as SVGImageElement | null;
        if (!svg || !image) throw new Error("map SVG or background image is missing");

        const probe = new Image();
        probe.src = image.href.baseVal;
        await probe.decode();

        const box = image.getBBox();
        const viewBox = svg.viewBox.baseVal;
        const svgRect = svg.getBoundingClientRect();
        const imageMatrix = image.getScreenCTM();
        if (!imageMatrix) throw new Error("background image has no screen transform");
        const response = await fetch("/demo-map/lots.json");
        if (!response.ok) throw new Error("anonymized alignment polygons are unavailable");
        const lots = (await response.json()) as Array<{ polygon_pct: Array<{ x: number; y: number }> }>;

        const scale = Math.min(svgRect.width / viewBox.width, svgRect.height / viewBox.height);
        const letterboxX = svgRect.left + (svgRect.width - viewBox.width * scale) / 2;
        const letterboxY = svgRect.top + (svgRect.height - viewBox.height * scale) / 2;
        const expectedOrigin = {
          x: letterboxX + (box.x - viewBox.x) * scale,
          y: letterboxY + (box.y - viewBox.y) * scale,
        };
        const actualOrigin = {
          x: imageMatrix.a * box.x + imageMatrix.c * box.y + imageMatrix.e,
          y: imageMatrix.b * box.x + imageMatrix.d * box.y + imageMatrix.f,
        };
        let screenTransformError = Math.max(
          Math.abs(expectedOrigin.x - actualOrigin.x),
          Math.abs(expectedOrigin.y - actualOrigin.y),
        );
        let maxCoordinateError = 0;
        let maxTransformDelta = 0;
        let checkedPolygons = 0;

        const hitPolygons = [...svg.querySelectorAll('polygon[fill="transparent"]')] as SVGPolygonElement[];
        for (let index = 0; index < hitPolygons.length; index += 1) {
          const polygon = hitPolygons[index];
          const key = Number(polygon.getAttribute("data-lot-key")) - 1;
          const source = lots[key]?.polygon_pct;
          if (!source || source.length !== polygon.points.length) throw new Error(`polygon ${key + 1} does not match its source geometry`);

          for (let pointIndex = 0; pointIndex < source.length; pointIndex += 1) {
            const actual = polygon.points.getItem(pointIndex);
            const expected = source[pointIndex];
            maxCoordinateError = Math.max(
              maxCoordinateError,
              Math.abs(actual.x - expected.x),
              Math.abs(actual.y - expected.y * (box.height / 100)),
            );
          }

          const polygonMatrix = polygon.getScreenCTM();
          if (!polygonMatrix) throw new Error(`polygon ${key + 1} has no screen transform`);
          maxTransformDelta = Math.max(
            maxTransformDelta,
            ...(["a", "b", "c", "d", "e", "f"] as const).map((field) => Math.abs(polygonMatrix[field] - imageMatrix[field])),
          );
          checkedPolygons += 1;
        }

        const imageAspect = box.width / box.height;
        const viewBoxAspect = viewBox.width / viewBox.height;
        const sourceAspect = probe.naturalWidth / probe.naturalHeight;
        screenTransformError = Math.max(
          screenTransformError,
          Math.abs(viewBoxAspect - imageAspect) * Math.max(svgRect.width, svgRect.height),
        );
        return {
          imageAspect,
          sourceAspect,
          viewBoxAspect,
          checkedPolygons,
          maxCoordinateError,
          maxTransformDelta,
          screenTransformError,
        };
      });

      expect(alignment.checkedPolygons, `${viewport.name}, zoom step ${zoomStep}`).toBe(alignmentLots.length);
      expect(alignment.sourceAspect).toBeCloseTo(alignment.imageAspect, 3);
      expect(alignment.viewBoxAspect).toBeCloseTo(alignment.imageAspect, 3);
      expect(alignment.maxCoordinateError).toBeLessThan(0.01);
      expect(alignment.maxTransformDelta).toBeLessThan(0.001);
      expect(alignment.screenTransformError).toBeLessThan(1);
    }
  }

  expect(businessApiRequests).toEqual([]);
});
