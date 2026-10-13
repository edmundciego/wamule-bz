import { expect, test, type Locator, type Page } from "@playwright/test";

const DEMO_URL = "/embed/demo?demo=1";

/** Screen-space centre of the nth hit-layer polygon (fill=transparent). */
async function hitCenter(page: Page, index: number): Promise<{ x: number; y: number }> {
  return page.evaluate((i) => {
    const svg = document.querySelector("main svg[role=group]") as SVGSVGElement | null;
    if (!svg) throw new Error("map svg not found");
    const polys = [...svg.querySelectorAll('polygon[fill="transparent"]')];
    const poly = polys[i] as SVGPolygonElement | undefined;
    if (!poly) throw new Error(`hit polygon ${i} not found`);
    const box = poly.getBBox();
    const ctm = poly.getScreenCTM();
    if (!ctm) throw new Error("no screen CTM");
    const pt = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(ctm);
    return { x: pt.x, y: pt.y };
  }, index);
}

/** Screen-space centre of the first hit polygon currently inside the viewport. */
async function hitCenterVisible(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const svg = document.querySelector("main svg[role=group]") as SVGSVGElement | null;
    if (!svg) throw new Error("map svg not found");
    const rect = svg.getBoundingClientRect();
    const polys = [...svg.querySelectorAll('polygon[fill="transparent"]')];
    for (const poly of polys) {
      const box = (poly as SVGPolygonElement).getBBox();
      const ctm = (poly as SVGPolygonElement).getScreenCTM();
      if (!ctm) continue;
      const pt = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(ctm);
      if (pt.x >= rect.left + 4 && pt.x <= rect.right - 4 && pt.y >= rect.top + 4 && pt.y <= rect.bottom - 4) {
        return { x: pt.x, y: pt.y };
      }
    }
    throw new Error("no visible lot found");
  });
}
async function hitEdge(page: Page, index: number): Promise<{ x: number; y: number }> {
  return page.evaluate((i) => {
    const svg = document.querySelector("main svg[role=group]") as SVGSVGElement | null;
    if (!svg) throw new Error("map svg not found");
    const poly = [...svg.querySelectorAll('polygon[fill="transparent"]')][i] as SVGPolygonElement;
    const box = poly.getBBox();
    const ctm = poly.getScreenCTM();
    if (!ctm) throw new Error("no screen CTM");
    const pt = new DOMPoint(box.x + 1, box.y + box.height / 2).matrixTransform(ctm);
    return { x: pt.x, y: pt.y };
  }, index);
}

async function lotCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('main svg[role=group] polygon[fill="transparent"]').length);
}

function selectedLotCard(page: Page): Locator {
  return page.locator("strong", { hasText: /^Lot S-/ }).first();
}

/** Screen-space centre of the hit polygon for a lot number (e.g. "S-057"). */
async function lotCenter(page: Page, lotNumber: string): Promise<{ x: number; y: number }> {
  return page.evaluate((lot) => {
    const svg = document.querySelector("main svg[role=group]") as SVGSVGElement | null;
    if (!svg) throw new Error("map svg not found");
    const poly = [...svg.querySelectorAll('polygon[fill="transparent"]')].find((p) =>
      (p.querySelector("title")?.textContent ?? "").includes(`Lot ${lot} `),
    ) as SVGPolygonElement | undefined;
    if (!poly?.getScreenCTM()) throw new Error(`lot ${lot} not found`);
    const box = poly.getBBox();
    const pt = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(poly.getScreenCTM()!);
    return { x: pt.x, y: pt.y };
  }, lotNumber);
}

test.beforeEach(async ({ page }) => {
  await page.goto(DEMO_URL);
  await expect.poll(() => lotCount(page), { timeout: 30000 }).toBeGreaterThan(50);
  // Wait for the aspect probe: the viewBox snaps from square to the real
  // image ratio on load, shifting every polygon on screen. Clicking before
  // that settles misses (this bit us — real users never click that fast,
  // but tests do).
  await expect
    .poll(() => page.locator("main svg[role=group]").first().first().getAttribute("viewBox"), { timeout: 15000 })
    .not.toBe("0 0 100 100");
});

test("records synthetic map-load evidence under a provisional good-4G profile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("webkit"), "The network/CPU throttle in this probe requires Chromium CDP.");
  await page.goto("about:blank");
  const cdp = await page.context().newCDPSession(page);
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

  try {
    await page.goto(DEMO_URL, { waitUntil: "load" });
    await expect.poll(() => lotCount(page), { timeout: 30000 }).toBeGreaterThan(50);
    await page.waitForFunction(() => {
      const image = document.querySelector("main svg[role=group] image");
      if (!image) return false;
      const imageUrl = new URL(image.getAttribute("href") ?? "", location.href).href;
      return performance.getEntriesByType("resource").some((entry) => entry.name === imageUrl && entry.responseEnd > 0);
    });

    const report = await page.evaluate((project) => {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const sameOriginResources = resources.filter((entry) => new URL(entry.name).origin === location.origin);
      const image = sameOriginResources.find((entry) => entry.name.includes("masterplan_background.webp"));
      const resourceBytes = sameOriginResources.reduce((sum, entry) => sum + entry.transferSize, 0);
      const largestResources = sameOriginResources
        .map((entry) => ({ path: new URL(entry.name).pathname, transferBytes: entry.transferSize }))
        .sort((left, right) => right.transferBytes - left.transferBytes)
        .slice(0, 12);
      return {
        fixture: "e2e/fixtures/synthetic",
        serveMode: "Vite development server (unbundled module graph)",
        project,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        profile: {
          downloadBytesPerSecond: 1_500_000,
          uploadBytesPerSecond: 750_000,
          roundTripLatencyMs: 50,
          cpuSlowdown: 4,
          cacheDisabled: true,
        },
        usefulMapReadyMs: Number(performance.now().toFixed(1)),
        firstContentfulPaintMs: Number(
          (performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0).toFixed(1),
        ),
        domContentLoadedMs: Number(navigation.domContentLoadedEventEnd.toFixed(1)),
        loadEventEndMs: Number(navigation.loadEventEnd.toFixed(1)),
        navigationTransferBytes: navigation.transferSize,
        sameOriginResourceTransferBytes: resourceBytes,
        totalTransferBytes: navigation.transferSize + resourceBytes,
        largestResources,
        background: image
          ? {
              transferBytes: image.transferSize,
              encodedBodyBytes: image.encodedBodySize,
              responseEndMs: Number(image.responseEnd.toFixed(1)),
            }
          : null,
        renderedHitPolygons: document.querySelectorAll('main svg[role=group] polygon[fill="transparent"]').length,
        interpretation: "Map-ready is measured after the background response completes and more than 50 lot hit polygons render.",
        scope: "Local Vite dev server and synthetic fixture only; the unbundled module graph distorts transfer/timing. Not a phone, hosted payload, or release measurement.",
      };
    }, testInfo.project.name);

    await testInfo.attach("synthetic-map-load-baseline.json", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    console.info(`[MAP_LOAD_BASELINE] ${JSON.stringify(report)}`);
    expect(report.renderedHitPolygons).toBeGreaterThan(50);
    expect(report.background).not.toBeNull();
  } finally {
    await cdp.detach();
  }
});

test("demo map loads lots over the background", async ({ page }) => {
  await expect(page.locator("main svg[role=group] image")).toBeAttached();
  expect(await lotCount(page)).toBeGreaterThan(50);
});

test("synthetic test preview fits a narrow phone without claiming sales-plat provenance", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  const previewTitle = page.getByText("Hopkins Grove (preview)", { exact: true });
  const search = page.getByLabel("Search lots");
  await expect(previewTitle).toBeVisible();
  await expect(search).toBeVisible();
  // ?demo=1 is a synthetic automated-test fixture, not the reviewed Hopkins
  // source drawing. Never let the fixture imply that it was traced from a plat.
  await expect(page.getByText("traced from sales plat", { exact: true })).toHaveCount(0);

  const [titleBounds, searchBounds] = await Promise.all(
    [previewTitle, search].map((element) => element.evaluate((target) => {
      const rect = target.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
      };
    })),
  );
  for (const bounds of [titleBounds, searchBounds]) {
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
    expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewportWidth);
  }
});

test("synthetic preview makes no business API calls or inquiry offers", async ({ page }) => {
  await page.goto("about:blank");
  const businessApiRequests: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/(?:functions|rest)\/v1\//.test(path)) businessApiRequests.push(`${request.method()} ${path}`);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(DEMO_URL);
  await expect.poll(() => lotCount(page), { timeout: 30000 }).toBeGreaterThan(50);
  const point = await hitCenter(page, 5);
  await page.mouse.click(point.x, point.y);
  await expect(selectedLotCard(page)).toBeVisible();
  await expect(page.getByRole("button", { name: /Inquire About Lot|Join Waitlist for Lot/ })).toHaveCount(0);
  expect(businessApiRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("project route aliases the default project", async ({ page }) => {
  // /embed/:tenant is the default-project alias of /embed/:tenant/:project.
  // On the hermetic demo fixture (no DB projects) both serve the same lots.
  await page.goto("/embed/demo/phase-1?demo=1");
  await expect.poll(() => lotCount(page), { timeout: 30000 }).toBeGreaterThan(50);
  const aliased = await lotCount(page);
  await page.goto(DEMO_URL);
  await expect.poll(() => lotCount(page), { timeout: 30000 }).toBeGreaterThan(50);
  expect(await lotCount(page)).toBe(aliased);
});

test("empty project data shows the published-lots empty state", async ({ page }) => {
  await page.route("**/demo-map/lots.json", (route) => route.fulfill({ json: [] }));
  await page.goto(DEMO_URL);

  await expect(page.getByText("No lots are published for this project yet.", { exact: true })).toBeVisible();
  await expect.poll(() => lotCount(page)).toBe(0);
});

test("map failure offers a retry that recovers from the local fixture", async ({ page }) => {
  let lotRequests = 0;
  let retryAllowed = false;
  await page.route("**/demo-map/lots.json", (route) => {
    lotRequests += 1;
    return retryAllowed ? route.continue() : route.fulfill({ status: 503, body: "temporary fixture failure" });
  });
  await page.goto(DEMO_URL);

  await expect(page.getByText("Map unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("Demo map files not found.", { exact: true })).toBeVisible();
  retryAllowed = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect.poll(() => lotCount(page)).toBeGreaterThan(50);
  expect(lotRequests).toBeGreaterThan(2);
});

test("search, tier and availability filters clear cleanly; lot deep links select", async ({ page }) => {
  const allLots = await lotCount(page);
  const search = page.getByLabel("Search lots");

  await search.fill("S-010");
  await expect.poll(() => lotCount(page)).toBe(1);
  await search.fill("");
  await expect.poll(() => lotCount(page)).toBe(allLots);

  await page.getByRole("button", { name: "Tier colours" }).click();
  const tierToggle = page.getByRole("button", { name: /Tiers/ });
  if ((await tierToggle.getAttribute("aria-expanded")) !== "true") await tierToggle.click();
  const premiumTier = page.getByRole("button", { name: "Premium", exact: true });
  await expect(premiumTier).toBeVisible();
  await premiumTier.click();
  await expect.poll(() => lotCount(page)).toBeLessThan(allLots);
  await premiumTier.click();
  await expect.poll(() => lotCount(page)).toBe(allLots);

  await page.getByRole("button", { name: "Available Only" }).click();
  await expect.poll(() => lotCount(page)).toBeLessThan(allLots);
  await search.fill("S-059"); // Reserved in the fixture: excluded by Available Only.
  await expect(page.getByText("No lots match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters and search" }).click();
  await expect.poll(() => lotCount(page)).toBe(allLots);

  await page.goto("/embed/demo?demo=1&lot=S-010");
  await expect(selectedLotCard(page)).toBeVisible();
  await expect(selectedLotCard(page)).toContainText("Lot S-010");
});

test("synthetic buyer-map overlay keeps tier and status palettes exclusive and avoids urgency", async ({ page }) => {
  const statusPalette = new Set(["#22c55e", "#f59e0b", "#ef4444"]);
  const statusStrokePalette = new Set(["#15803d", "#b45309", "#b91c1c"]);
  const mapMarkers = page.locator('main svg[role=group] > g[aria-hidden="true"] > g[data-lot-status]');
  const lotOutlines = page.locator('svg polygon[data-lot-key][fill="none"]');

  await page.goto(`${DEMO_URL}&lot=S-010`);
  const details = page.getByRole("region", { name: "Details for Lot S-010" });
  await expect(details).toBeVisible();
  await expect(page.locator('[aria-label="Map legend"]')).toBeVisible();

  const statusMarkers = await mapMarkers.evaluateAll((elements) => elements.map((element) => ({
    key: element.getAttribute("data-lot-key"),
    fill: element.firstElementChild?.getAttribute("fill")?.toLowerCase() ?? "",
  })));
  const selectedKey = await page.locator('main svg[role="group"] polygon[fill="transparent"][aria-selected="true"]').getAttribute("data-lot-key");
  expect(selectedKey).toBeTruthy();
  const statusColors = new Set(statusMarkers.filter((marker) => marker.key !== selectedKey).map((marker) => marker.fill));
  expect(statusColors).toEqual(statusPalette);
  expect(statusMarkers.find((marker) => marker.key === selectedKey)?.fill).toBe("var(--lotmap-accent)");
  const statusShapes = await mapMarkers.evaluateAll((elements) =>
    [...new Set(elements.map((element) => `${element.getAttribute("data-lot-status")}:${element.getAttribute("data-marker-shape")}`))].sort(),
  );
  expect(statusShapes).toEqual(["Available:circle", "Reserved:diamond", "Sold:square"]);
  const legendMarkerShapes = await page.locator('[aria-label="Map legend"] svg > *').evaluateAll((elements) =>
    elements.map((element) => element.tagName.toLowerCase()),
  );
  expect(legendMarkerShapes.sort()).toEqual(["circle", "path", "polygon", "polygon"]);
  const statusStrokeColors = await lotOutlines.evaluateAll((elements) =>
    [...new Set(elements.map((element) => (element as SVGPolygonElement).getAttribute("stroke")?.toLowerCase() ?? ""))],
  );
  expect(statusStrokeColors.every((color) => statusStrokePalette.has(color))).toBe(true);

  await page.getByRole("button", { name: "Tier colours", exact: true }).click();
  await expect(page.locator('[aria-label="Map legend"]')).toContainText("Selected lot");
  await expect(details.getByText("Available", { exact: true })).toHaveClass(/bg-muted/);

  const tiersResponse = await page.request.get("/demo-map/tiers.json");
  expect(tiersResponse.ok()).toBe(true);
  const tiersPayload = (await tiersResponse.json()) as { tiers: Record<string, { legend: string }> };
  const tierPalette = new Set(Object.values(tiersPayload.tiers).map(({ legend }) => legend.toLowerCase()));
  const tierColors = await mapMarkers.evaluateAll((elements, activeKey) => [...new Set(elements
    .filter((element) => element.getAttribute("data-lot-key") !== activeKey)
    .map((element) => element.firstElementChild?.getAttribute("fill")?.toLowerCase() ?? ""))], selectedKey);
  expect(tierColors.length).toBeGreaterThan(0);
  expect(tierColors.every((color) => tierPalette.has(color))).toBe(true);
  const selectedTierFills = await mapMarkers.evaluateAll((elements, activeKey) => elements
    .filter((element) => element.getAttribute("data-lot-key") === activeKey)
    .map((element) => element.firstElementChild?.getAttribute("fill")?.toLowerCase() ?? ""), selectedKey);
  expect(selectedTierFills).toEqual(["var(--lotmap-accent)"]);
  expect(tierColors.some((color) => statusPalette.has(color))).toBe(false);
  const tierShapes = await mapMarkers.evaluateAll((elements) =>
    [...new Set(elements.map((element) => element.getAttribute("data-marker-shape")))],
  );
  expect(tierShapes).toEqual(["circle"]);
  const tierStrokeColors = await lotOutlines.evaluateAll((elements) =>
    [...new Set(elements.map((element) => (element as SVGPolygonElement).getAttribute("stroke")?.toLowerCase() ?? ""))],
  );
  expect(tierStrokeColors.every((color) => tierPalette.has(color))).toBe(true);

  await expect(page.getByText(/only\s+\d+\s+left|ends\s+in\s+\d+|limited[- ]time|in demand/i)).toHaveCount(0);
});

test("keyboard lot search opens details and exposes a keyboard lot action", async ({ page }) => {
  const search = page.getByLabel("Search lots");
  await search.fill("S-010");

  const result = page.getByRole("button", { name: /^Show details for Lot S-010/ });
  await expect(result).toBeVisible();
  await search.focus();
  await page.keyboard.press("ArrowDown");
  await expect(result).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(search).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(result).toBeFocused();
  await page.keyboard.press("Enter");

  const details = page.getByRole("region", { name: "Details for Lot S-010" });
  await expect(details).toBeFocused();
  const zoomToLot = details.getByRole("button", { name: /Zoom/ });
  await expect(zoomToLot).toBeVisible();
});

test("buyer-map search and filter controls keep names and visible keyboard focus", async ({ page }) => {
  const search = page.getByRole("textbox", { name: "Search lots" });
  const statusView = page.getByRole("button", { name: "Status colours", exact: true });
  const hasVisibleFocus = (locator: Locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      const outlineVisible = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
      return element.matches(":focus-visible") && (outlineVisible || style.boxShadow !== "none");
    });

  await page.keyboard.press("Tab");
  await expect(search).toBeFocused();
  expect(await hasVisibleFocus(search)).toBe(true);

  // Keep the keyboard modality established by the first Tab, but focus the
  // next control directly: macOS WebKit can skip buttons during Tab traversal
  // unless the host OS enables full keyboard access.
  await statusView.focus();
  await expect(statusView).toBeFocused();
  expect(await hasVisibleFocus(statusView)).toBe(true);
  await expect(page.getByText("Hopkins Grove (preview)", { exact: true })).toBeVisible();
  await expect(page.getByText("Wamule", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tier colours", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "All Lots", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Available Only", exact: true })).toBeVisible();
});

test("keyboard map navigation moves between nearby lots and opens focused details", async ({ page }) => {
  const mapLots = page.getByRole("listbox", { name: "Lots on the map" });
  await expect(mapLots).toBeVisible();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await mapLots.focus();
  const keyboardFocusRing = page.locator('svg > g[aria-hidden="true"] polygon[stroke="#111827"]');
  await expect(keyboardFocusRing).toHaveCount(1);
  const [ringBounds, mapBounds] = await Promise.all([
    keyboardFocusRing.boundingBox(),
    page.getByRole("group", { name: "Interactive lot map" }).boundingBox(),
  ]);
  expect(ringBounds).not.toBeNull();
  expect(mapBounds).not.toBeNull();
  expect(ringBounds!.x + ringBounds!.width / 2).toBeGreaterThanOrEqual(mapBounds!.x);
  expect(ringBounds!.x + ringBounds!.width / 2).toBeLessThanOrEqual(mapBounds!.x + mapBounds!.width);
  expect(ringBounds!.y + ringBounds!.height / 2).toBeGreaterThanOrEqual(mapBounds!.y);
  expect(ringBounds!.y + ringBounds!.height / 2).toBeLessThanOrEqual(mapBounds!.y + mapBounds!.height);

  const initialOptionId = await mapLots.getAttribute("aria-activedescendant");
  expect(initialOptionId).toBeTruthy();
  await mapLots.press("ArrowRight");
  const activeOptionId = await mapLots.getAttribute("aria-activedescendant");
  expect(activeOptionId).toBeTruthy();
  expect(activeOptionId).not.toBe(initialOptionId);
  const activeOption = page.locator(`[id="${activeOptionId}"]`);
  const activeLabel = await activeOption.getAttribute("aria-label");
  const lotNumber = activeLabel?.match(/^Lot ([^,]+)/)?.[1];
  expect(lotNumber).toBeTruthy();

  await mapLots.press("Escape");
  await expect(page.getByLabel("Search lots")).toBeFocused();
  await mapLots.focus();
  await mapLots.press("Space");
  const details = page.getByRole("region", { name: `Details for Lot ${lotNumber}` });
  await expect(details).toBeFocused();
  await expect(details).toContainText(`Lot ${lotNumber}`);
  await details.getByRole("button", { name: `Close details for Lot ${lotNumber}` }).click();
  await mapLots.focus();
  await mapLots.press("Enter");
  await expect(details).toBeFocused();
});

test("mobile lot search results stay fully on screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const search = page.getByLabel("Search lots");
  const colourView = page.getByRole("group", { name: "Colour view" });
  const lotFilter = page.getByRole("group", { name: "Lot filter" });
  const [colourBounds, filterBounds] = await Promise.all([colourView.boundingBox(), lotFilter.boundingBox()]);
  expect(colourBounds).not.toBeNull();
  expect(filterBounds).not.toBeNull();
  expect(Math.abs(colourBounds!.y - filterBounds!.y)).toBeLessThan(2);
  await expect(page.getByRole("button", { name: "Tier colours", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Available Only", exact: true })).toBeVisible();
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(documentWidth).toBeLessThanOrEqual(320);

  await search.fill("S-010");
  const results = page.getByRole("region", { name: "Lot search results" });
  await expect(results).toBeVisible();
  const bounds = await results.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width, viewport: window.innerWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
  expect(bounds.width).toBeGreaterThan(0);
  const searchHeight = await search.evaluate((element) => element.getBoundingClientRect().height);
  const zoomHeight = await page.getByRole("button", { name: "Zoom in" }).evaluate((element) => element.getBoundingClientRect().height);
  expect(searchHeight).toBeGreaterThanOrEqual(44);
  expect(zoomHeight).toBeGreaterThanOrEqual(44);
});

test("tier-color view keeps the selected lot status badge neutral and readable", async ({ page }) => {
  await page.getByRole("button", { name: "Tier colours" }).click();
  const point = await hitCenter(page, 5);
  await page.mouse.click(point.x, point.y);
  const details = page.getByRole("region", { name: /^Details for Lot/ });
  await expect(details).toBeVisible();
  await expect(page.locator('[aria-label="Map legend"]')).toContainText("Selected lot");
  const badge = details.locator("span.rounded-full");
  await expect(badge).toBeVisible();
  const result = await badge.evaluate((element) => {
    const parse = (value: string) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const luminance = (value: string) => {
      const [r, g, b] = parse(value).map((channel) => {
        const c = channel / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const color = getComputedStyle(element).color;
    const background = getComputedStyle(element).backgroundColor;
    const [a, b] = [luminance(color), luminance(background)].sort((left, right) => right - left);
    return { background, ratio: (a + 0.05) / (b + 0.05) };
  });
  expect(["rgb(34, 197, 94)", "rgb(245, 158, 11)", "rgb(239, 68, 68)"]).not.toContain(result.background);
  expect(result.ratio).toBeGreaterThanOrEqual(4.5);
});

test("mouse click selects a lot and locks the card", async ({ page }) => {
  const pt = await hitCenter(page, 5);
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
});

test("click selects after a pan (drag then click)", async ({ page }) => {
  const box = await page.locator("main svg[role=group]").first().boundingBox();
  if (!box) throw new Error("no svg box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 80, { steps: 12 });
  await page.mouse.up();
  const pt = await hitCenter(page, 5);
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
});

test("dragging the map pans without selecting the lot under the pointer", async ({ page }) => {
  await page.getByRole("button", { name: "Zoom in" }).click();
  const before = await page.locator("main svg[role=group]").first().getAttribute("viewBox");
  const { x, y } = await hitCenterVisible(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 80, { steps: 12 });
  await page.mouse.up();

  await expect(selectedLotCard(page)).toHaveCount(0);
  await expect.poll(() => page.locator("main svg[role=group]").first().getAttribute("viewBox")).not.toBe(before);
});

test("reset zoom restores the original map window after zooming and panning", async ({ page }) => {
  const map = page.locator("main svg[role=group]").first();
  const initialView = await map.getAttribute("viewBox");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  const { x, y } = await hitCenterVisible(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y + 50, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => map.getAttribute("viewBox")).not.toBe(initialView);
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await expect.poll(() => map.getAttribute("viewBox")).toBe(initialView);
});

test("hit-layer edge click still selects", async ({ page }) => {
  const pt = await hitEdge(page, 5);
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
});

test("tiny-lot tap selects the smallest lot under the cursor", async ({ page }) => {
  // S-055…S-058 are 1.4-unit lots 0.6 apart: their 14px hit paddings
  // overlap at 1x. Paint order is smallest-on-top, so the tap must lock
  // exactly S-057 — not the topmost-in-data-order neighbor S-058.
  const pt = await lotCenter(page, "S-057");
  await page.mouse.click(pt.x, pt.y);
  await expect(page.locator("strong", { hasText: /^Lot S-057$/ }).first()).toBeVisible();
});

test("selected lot uses the tenant accent fill and a thick outline", async ({ page }) => {
  const pt = await hitCenter(page, 5);
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
  const lot = /Lot (\S+)/.exec((await selectedLotCard(page).textContent()) ?? "")?.[1] ?? "";
  const stroke = await page.evaluate((lotNumber) => {
    const svg = document.querySelector("main svg[role=group]") as SVGSVGElement | null;
    const id = [...(svg?.querySelectorAll('polygon[fill="transparent"]') ?? [])].find((p) =>
      (p.querySelector("title")?.textContent ?? "").includes(`Lot ${lotNumber} `),
    )?.getAttribute("data-lot-key");
    const visible = svg?.querySelector(`polygon[data-lot-key="${id}"][fill="var(--lotmap-accent)"]`);
    return {
      width: visible?.getAttribute("stroke-width"),
      fill: visible?.getAttribute("fill"),
      opacity: visible?.getAttribute("fill-opacity"),
    };
  }, lot);
  expect(Number(stroke.width)).toBeGreaterThanOrEqual(3);
  expect(stroke.fill).toBe("var(--lotmap-accent)");
  expect(Number(stroke.opacity)).toBeGreaterThan(0);
});

test("card shows printed area dual-unit and tier for lots that have them", async ({ page }) => {
  const pt = await lotCenter(page, "S-010");
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
  await expect(page.getByText("650 m² · 6,997 sq ft")).toBeVisible();
  await expect(page.getByText("Premium", { exact: true }).first()).toBeVisible();
});

test("Reset control stays clickable with the detail card open", async ({ page }) => {
  // Phone viewports: the bottom sheet used to cover the Reset button
  // (controls sat at bottom-48, inside the card's footprint). The column is
  // now lifted above the measured card height: the centre of Reset must
  // hit-test to the button itself (poll: the lift applies on the effect
  // after selection commits).
  const pt = await hitCenter(page, 5);
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const btn = document.querySelector('main button[aria-label="Reset zoom"]') as HTMLElement | null;
          if (!btn) return "no-button";
          const r = btn.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return (hit as Element | null)?.closest?.('button[aria-label="Reset zoom"]') ? "hit" : `covered-by-${hit?.tagName ?? "null"}`;
        }),
      { timeout: 5000 },
    )
    .toBe("hit");
});

test("Sold lots offer no inquiry action", async ({ page }) => {
  const pt = await lotCenter(page, "S-054");
  await page.mouse.click(pt.x, pt.y);
  await expect(page.locator("strong", { hasText: /^Lot S-054$/ }).first()).toBeVisible();
  await expect(page.getByText("Sold", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Inquire About Lot|Join Waitlist)/ })).toHaveCount(0);
});

test("Zoom to lot button zooms to the lot (mouse)", async ({ page }) => {
  const pt = await hitCenter(page, 5);
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
  // Selection opens the card only — no inquiry modal on tap.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const before = await page.locator("main svg[role=group]").first().getAttribute("viewBox");
  await page.getByRole("button", { name: /^Zoom to Lot/ }).click();
  await expect
    .poll(async () => page.locator("main svg[role=group]").first().getAttribute("viewBox"), { timeout: 5000 })
    .not.toBe(before);
  await expect(selectedLotCard(page)).toBeVisible();
});

test("Zoom to lot button works with touch", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, "touch input needs a hasTouch project");
  const pt = await hitCenter(page, 5);
  await page.touchscreen.tap(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
  const before = await page.locator("main svg[role=group]").first().getAttribute("viewBox");
  await page.getByRole("button", { name: /^Zoom to Lot/ }).tap();
  await expect
    .poll(async () => page.locator("main svg[role=group]").first().getAttribute("viewBox"), { timeout: 5000 })
    .not.toBe(before);
});

test("Zoom to lot works in fullscreen", async ({ page }) => {
  await page.getByRole("button", { name: "Enter fullscreen" }).click();
  const pt = await hitCenter(page, 5);
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
  const before = await page.locator("main svg[role=group]").first().getAttribute("viewBox");
  await page.getByRole("button", { name: /^Zoom to Lot/ }).click();
  await expect
    .poll(async () => page.locator("main svg[role=group]").first().getAttribute("viewBox"), { timeout: 5000 })
    .not.toBe(before);
  await expect(selectedLotCard(page)).toBeVisible();
});

test("selecting a lot behind the detail card pans it into view", async ({ page }) => {
  // At 1x with no selection the pan range is zero, but selecting grants
  // card padding (bottom sheet ~= card height), so there is room to reveal
  // by panning without touching zoom. Tap the bottom-most visible lot with
  // a real click: on phone viewports the opening bottom sheet covers it and
  // selection must pan until uncovered; elsewhere it is already visible and
  // this asserts the invariant (visible, zoom unchanged).
  const lotId = await page.evaluate(() => {
    const svg = document.querySelector("main svg[role=group]") as SVGSVGElement | null;
    if (!svg) throw new Error("map svg not found");
    const rect = svg.getBoundingClientRect();
    let best: { id: number; y: number } | null = null;
    for (const poly of svg.querySelectorAll('polygon[fill="transparent"]')) {
      const el = poly as SVGPolygonElement;
      const box = el.getBBox();
      const ctm = el.getScreenCTM();
      if (!ctm) continue;
      const pt = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(ctm);
      if (pt.x < rect.left + 4 || pt.x > rect.right - 4 || pt.y < rect.top + 4 || pt.y > rect.bottom - 4) continue;
      // Keep clear of the floating zoom-control column (bottom-right).
      if (pt.x > rect.right - 70 && pt.y > rect.bottom - 180) continue;
      if (!best || pt.y > best.y) best = { id: Number(el.getAttribute("data-lot-key")), y: pt.y };
    }
    if (!best) throw new Error("no visible lot found");
    return best.id;
  });
  const center = await page.evaluate((id) => {
    const el = document.querySelector(`main svg[role=group] polygon[data-lot-key="${id}"]`) as SVGPolygonElement | null;
    if (!el?.getScreenCTM()) throw new Error("lot not found");
    const box = el.getBBox();
    const pt = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(el.getScreenCTM()!);
    return { x: pt.x, y: pt.y };
  }, lotId);
  const before = await page.locator("main svg[role=group]").first().getAttribute("viewBox");
  await page.mouse.click(center.x, center.y);
  await expect(selectedLotCard(page)).toBeVisible();
  // Zoom must not have changed (reveal pans only): viewBox width encodes zoom.
  const viewBoxWidth = async () => (await page.locator("main svg[role=group]").first().getAttribute("viewBox"))?.split(" ")[2];
  expect(await viewBoxWidth()).toBe(before.split(" ")[2]);
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const el = document.querySelector(`main svg[role=group] polygon[data-lot-key="${id}"]`) as SVGPolygonElement | null;
          if (!el?.getScreenCTM()) return "no-lot";
          const box = el.getBBox();
          const pt = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(
            el.getScreenCTM()!,
          );
          const hit = document.elementFromPoint(pt.x, pt.y);
          const card = [...document.querySelectorAll("main div")].find(
            (d) => typeof d.className === "string" && d.className.includes("bottom-3") && d.textContent?.includes("Zoom to Lot"),
          );
          if (!card) return "no-card";
          return card.contains(hit) ? "covered" : "visible";
        }, lotId),
      { timeout: 5000 },
    ).toBe("visible");
});

test("zoom buttons keep working after pan", async ({ page }) => {
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  const pt = await hitCenterVisible(page);
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
});

test("fullscreen lot click selects", async ({ page }) => {
  await page.getByRole("button", { name: "Enter fullscreen" }).click();
  const pt = await hitCenter(page, 5);
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
  await page.getByRole("button", { name: "✕ Close" }).click();
  await expect(page.getByRole("button", { name: "Enter fullscreen" })).toBeVisible();
  await expect(selectedLotCard(page)).toBeVisible();
});

test("mobile fullscreen exit control stays clear of the selected lot card", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, "mobile layout needs a touch viewport");
  await page.getByRole("button", { name: "Enter fullscreen" }).tap();
  const point = await hitCenter(page, 5);
  await page.touchscreen.tap(point.x, point.y);
  await expect(selectedLotCard(page)).toBeVisible();

  const exitFullscreen = page.getByRole("button", { name: "Exit fullscreen" });
  await expect(exitFullscreen).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const control = document.querySelector('button[aria-label="Exit fullscreen"]');
          const card = document.querySelector('[role="region"][aria-label^="Details for Lot"]');
          if (!control || !card) return false;
          const a = control.getBoundingClientRect();
          const b = card.getBoundingClientRect();
          return a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;
        }),
      { timeout: 5000 },
    )
    .toBe(true);

  await exitFullscreen.tap();
  await expect(page.getByRole("button", { name: "Enter fullscreen" })).toBeVisible();
  await expect(selectedLotCard(page)).toBeVisible();
});

test("lot numbers show on hover/selection and fit inside their lots", async ({ page }, testInfo) => {
  // mouse.wheel is unsupported in mobile WebKit, so the hold-2x gate check
  // below is skipped there; the 4x check uses Zoom to Lot (exact on all).
  const canWheel = testInfo.project.name !== "webkit-mobile";
  // Overlay numbers render only for the hovered/selected lot (the plat
  // raster already prints every number); the hit layer stays active for all.
  async function screenCenterOf(id: number): Promise<{ x: number; y: number }> {
    return page.evaluate((lotId) => {
      const el = document.querySelector(`main svg[role=group] polygon[data-lot-key="${lotId}"]`) as SVGPolygonElement | null;
      if (!el?.getScreenCTM()) throw new Error("lot not found");
      const box = el.getBBox();
      const pt = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(el.getScreenCTM()!);
      return { x: pt.x, y: pt.y };
    }, id);
  }

  /** Advance-box containment of a lot's label inside its polygon (5% tol). */
  async function labelFits(id: number, lot: string): Promise<{ ok: boolean; detail: string }> {
    return page.evaluate(
      ({ lotId, lotNumber }) => {
        const svg = document.querySelector("main svg[role=group]") as SVGSVGElement | null;
        if (!svg) throw new Error("no svg");
        const poly = svg.querySelector(`polygon[data-lot-key="${lotId}"]`) as SVGPolygonElement | null;
        const label = [...svg.querySelectorAll("text")].find((t) => t.textContent === lotNumber) as
          | SVGTextElement
          | undefined;
        if (!poly || !label) return { ok: false, detail: `missing poly=${!!poly} label=${!!label}` };
        const b = poly.getBBox();
        const tb = label.getBBox();
        // Advance-based ink box (engine-robust across getBBox rulers).
        const advance = label.getComputedTextLength();
        const x = tb.x + (tb.width - advance) / 2;
        const tol = 0.05;
        const ok =
          x >= b.x - b.width * tol &&
          tb.y >= b.y - b.height * tol &&
          x + advance <= b.x + b.width * (1 + tol) &&
          tb.y + tb.height <= b.y + b.height * (1 + tol);
        return {
          ok,
          detail: `label@${x.toFixed(2)},${tb.y.toFixed(2)} ${advance.toFixed(2)}x${tb.height.toFixed(2)} vs lot@${b.x.toFixed(2)},${b.y.toFixed(2)} ${b.width.toFixed(2)}x${b.height.toFixed(2)}`,
        };
      },
      { lotId: id, lotNumber: lot },
    );
  }

  // No hover/selection yet: zero overlay labels (status dots still show).
  await expect(page.locator("main svg[role=group] text")).toHaveCount(0);
  expect(await page.locator("main svg[role=group] circle").count()).toBeGreaterThan(50);
  await page.screenshot({ path: testInfo.outputPath("labels-1x.png") });

  // Sample by geometry at 1x (full view): smallest (tiny), largest (huge).
  const sample = await page.evaluate(() => {
    const svg = document.querySelector("main svg[role=group]") as SVGSVGElement | null;
    if (!svg) throw new Error("no svg");
    const rows = [...svg.querySelectorAll('polygon[fill="transparent"]')].map((p) => {
      const el = p as SVGPolygonElement;
      const b = el.getBBox();
      const title = el.querySelector("title")?.textContent ?? "";
      return {
        id: Number(el.getAttribute("data-lot-key")),
        lot: /Lot (\S+)/.exec(title)?.[1] ?? "",
        area: b.width * b.height,
      };
    });
    const sorted = [...rows].sort((a, b) => a.area - b.area);
    return { smallest: sorted[0], largest: sorted[sorted.length - 1] };
  });

  // 2x: hover targets must be inside the current window (zoom recenters, so
  // re-sample visibility in this view, not the 1x one).
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.waitForTimeout(300);
  const visible2x = await page.evaluate(() => {
    const svg = document.querySelector("main svg[role=group]") as SVGSVGElement | null;
    if (!svg) throw new Error("no svg");
    const rect = svg.getBoundingClientRect();
    const rows = [...svg.querySelectorAll('polygon[fill="transparent"]')]
      .map((p) => {
        const el = p as SVGPolygonElement;
        const b = el.getBBox();
        const ctm = el.getScreenCTM();
        if (!ctm) return null;
        const pt = new DOMPoint(b.x + b.width / 2, b.y + b.height / 2).matrixTransform(ctm);
        const title = el.querySelector("title")?.textContent ?? "";
        return {
          id: Number(el.getAttribute("data-lot-key")),
          lot: /Lot (\S+)/.exec(title)?.[1] ?? "",
          area: b.width * b.height,
          onScreen: pt.x >= rect.left && pt.x <= rect.right && pt.y >= rect.top && pt.y <= rect.bottom,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null && r.onScreen)
      .sort((a, b) => a.area - b.area);
    if (!rows.length) throw new Error("no on-screen lot at 2x");
    return { median: rows[Math.floor(rows.length / 2)], largest: rows[rows.length - 1] };
  });
  for (const s of [visible2x.median, visible2x.largest]) {
    const pt = await screenCenterOf(s.id);
    await page.mouse.move(pt.x, pt.y);
    await expect(page.locator("main svg[role=group] text", { hasText: s.lot })).toBeVisible();
    const fit = await labelFits(s.id, s.lot);
    expect(fit.ok, `2x hover label fit for ${s.lot}: ${fit.detail}`).toBe(true);
  }
  {
    const pt = await screenCenterOf(visible2x.median.id);
    await page.mouse.move(pt.x, pt.y);
    await page.screenshot({ path: testInfo.outputPath("labels-2x.png") });
  }

  // Screen-size cap: the huge lot via Zoom to Lot must not render at its
  // fitted size (fs ~= 10 units — billboard). The cap forces fs far below
  // the fit on every viewport; screen height stays sane.
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await page.waitForTimeout(300);
  {
    const pt = await screenCenterOf(sample.largest.id);
    await page.mouse.click(pt.x, pt.y);
    await expect(selectedLotCard(page)).toBeVisible();
    await page.getByRole("button", { name: /^Zoom to Lot/ }).click();
    await page.waitForTimeout(400);
    // Selection alone no longer labels: hover the fitted lot for its label.
    {
      const pt = await screenCenterOf(sample.largest.id);
      await page.mouse.move(pt.x, pt.y);
      await page.waitForTimeout(300);
    }
    const m = await page.evaluate((lotNumber) => {
      const svg = document.querySelector("main svg[role=group]") as SVGSVGElement | null;
      const label = [...(svg?.querySelectorAll("text") ?? [])].find((t) => t.textContent === lotNumber) as
        | SVGTextElement
        | undefined;
      if (!svg || !label) return null;
      const vb = svg.getAttribute("viewBox")!.split(" ").map(Number);
      const rect = svg.getBoundingClientRect();
      const tb = label.getBBox();
      return {
        fs: Number(label.getAttribute("font-size")),
        screenH: tb.height * (rect.height / vb[3]),
      };
    }, sample.largest.lot);
    expect(m).not.toBeNull();
    expect(m!.fs).toBeLessThan(5);
    expect(m!.screenH).toBeLessThanOrEqual(60);
    const fit = await labelFits(sample.largest.id, sample.largest.lot);
    expect(fit.ok, `capped label fit for ${sample.largest.lot}: ${fit.detail}`).toBe(true);
  }

  /** Lot actually locked in the detail card (hit padding overlaps on tiny
   *  lots, so read reality — not the aim point — for the assertions below). */
  async function selectedLot(): Promise<{ id: number; lot: string }> {
    const cardText = (await selectedLotCard(page).textContent()) ?? "";
    const lot = /Lot (\S+)/.exec(cardText)?.[1] ?? "";
    const id = await page.evaluate((lotNumber) => {
      const els = [...document.querySelectorAll('main svg[role=group] polygon[fill="transparent"]')];
      const hit = els.find((p) => (p.querySelector("title")?.textContent ?? "").includes(`Lot ${lotNumber} `));
      return hit ? Number((hit as SVGPolygonElement).getAttribute("data-lot-key")) : -1;
    }, lot);
    return { id, lot };
  }

  // Tiny lot: close any open card (on phones the open sheet covers the
  // Reset control), reset, select the tiny row at 1x (zoom gate hides even
  // selected labels), then Ctrl+wheel zoom around the cursor so it stays put.
  {
    const close = page.getByRole("button", { name: /^Close details/ });
    if (await close.count()) await close.click();
  }
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await page.waitForTimeout(300);
  // Tap the tiny row; the ACTUAL selection may be the topmost neighbor
  // (hit padding overlaps at 1x), so read it back from the card.
  {
    const pt = await screenCenterOf(sample.smallest.id);
    await page.mouse.click(pt.x, pt.y);
    await expect(selectedLotCard(page)).toBeVisible();
    expect(await page.locator("main svg[role=group] text").count()).toBe(0);
  }
  const tiny = await selectedLot();

  /** Ctrl+wheel zoom around the stationary cursor until viewBox width <= max. */
  async function wheelZoomTo(maxWidth: number) {
    await page.keyboard.down("Control");
    try {
      await expect
        .poll(async () => {
          const vb = await page.locator("main svg[role=group]").first().getAttribute("viewBox");
          const w = Number(vb?.split(" ")[2]);
          if (w <= maxWidth) return w;
          await page.mouse.wheel(0, -240);
          await page.waitForTimeout(150);
          return w;
        }, { timeout: 15000 })
        .toBeLessThanOrEqual(maxWidth);
    } finally {
      await page.keyboard.up("Control");
    }
  }

  // ~2x: the tiny lot's label is still gated off (selected, but too small).
  // Wheel-zoom holds the cursor (and the lot) put; buttons would recenter.
  if (canWheel) {
    await wheelZoomTo(51);
    await expect(page.locator("main svg[role=group] text", { hasText: tiny.lot })).toHaveCount(0);
  }

  // ~4x via Zoom to Lot (exact fit+center on every engine): the tiny lot's
  // label becomes large enough to render and fit.
  await page.getByRole("button", { name: /^Zoom to Lot/ }).click();
  await page.waitForTimeout(400);
  {
    const pt = await screenCenterOf(tiny.id);
    await page.mouse.move(pt.x, pt.y);
  }
  await expect(page.locator("main svg[role=group] text", { hasText: tiny.lot })).toBeVisible();
  {
    const fit = await labelFits(tiny.id, tiny.lot);
    expect(fit.ok, `4x label fit for ${tiny.lot}: ${fit.detail}`).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("labels-4x.png") });

  // The selected lot keeps its label visible after hover leaves; clearing
  // selection removes the overlay label.
  await page.mouse.move(5, 5);
  const labels = page.locator("main svg[role=group] text");
  await expect(labels).toHaveCount(1);
  await expect(labels).toHaveText(tiny.lot);
  await page.getByRole("button", { name: `Close details for Lot ${tiny.lot}` }).click();
  await expect(labels).toHaveCount(0);
});

test("tap selects a lot (touch)", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, "touch input needs a hasTouch project");
  const pt = await hitCenter(page, 5);
  await page.touchscreen.tap(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
});
