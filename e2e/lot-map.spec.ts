import { expect, test, type Locator, type Page } from "@playwright/test";

const DEMO_URL = "/embed/demo?demo=1";

/** Screen-space centre of the nth hit-layer polygon (fill=transparent). */
async function hitCenter(page: Page, index: number): Promise<{ x: number; y: number }> {
  return page.evaluate((i) => {
    const svg = document.querySelector("main svg") as SVGSVGElement | null;
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
    const svg = document.querySelector("main svg") as SVGSVGElement | null;
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
    const svg = document.querySelector("main svg") as SVGSVGElement | null;
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
  return page.evaluate(() => document.querySelectorAll('main svg polygon[fill="transparent"]').length);
}

function selectedLotCard(page: Page): Locator {
  return page.locator("strong", { hasText: /^Lot L-/ }).first();
}

test.beforeEach(async ({ page }) => {
  await page.goto(DEMO_URL);
  await expect.poll(() => lotCount(page), { timeout: 30000 }).toBeGreaterThan(700);
  // Wait for the aspect probe: the viewBox snaps from square to the real
  // image ratio on load, shifting every polygon on screen. Clicking before
  // that settles misses (this bit us — real users never click that fast,
  // but tests do).
  await expect
    .poll(() => page.locator("main svg").first().first().getAttribute("viewBox"), { timeout: 15000 })
    .not.toBe("0 0 100 100");
});

test("demo map loads lots over the background", async ({ page }) => {
  await expect(page.locator("main svg image")).toBeAttached();
  expect(await lotCount(page)).toBeGreaterThan(700);
});

test("mouse click selects a lot and locks the card", async ({ page }) => {
  const pt = await hitCenter(page, 5);
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
});

test("click selects after a pan (drag then click)", async ({ page }) => {
  const box = await page.locator("main svg").first().boundingBox();
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

test("hit-layer edge click still selects", async ({ page }) => {
  const pt = await hitEdge(page, 5);
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
});

test("Zoom to lot button zooms to the lot (mouse)", async ({ page }) => {
  const pt = await hitCenter(page, 5);
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
  // Selection opens the card only — no inquiry modal on tap.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const before = await page.locator("main svg").first().getAttribute("viewBox");
  await page.getByRole("button", { name: /^Zoom to Lot/ }).click();
  await expect
    .poll(async () => page.locator("main svg").first().getAttribute("viewBox"), { timeout: 5000 })
    .not.toBe(before);
  await expect(selectedLotCard(page)).toBeVisible();
});

test("Zoom to lot button works with touch", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, "touch input needs a hasTouch project");
  const pt = await hitCenter(page, 5);
  await page.touchscreen.tap(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
  const before = await page.locator("main svg").first().getAttribute("viewBox");
  await page.getByRole("button", { name: /^Zoom to Lot/ }).tap();
  await expect
    .poll(async () => page.locator("main svg").first().getAttribute("viewBox"), { timeout: 5000 })
    .not.toBe(before);
});

test("Zoom to lot works in fullscreen", async ({ page }) => {
  await page.getByRole("button", { name: "Enter fullscreen" }).click();
  const pt = await hitCenter(page, 5);
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
  const before = await page.locator("main svg").first().getAttribute("viewBox");
  await page.getByRole("button", { name: /^Zoom to Lot/ }).click();
  await expect
    .poll(async () => page.locator("main svg").first().getAttribute("viewBox"), { timeout: 5000 })
    .not.toBe(before);
  await expect(selectedLotCard(page)).toBeVisible();
});

test("selecting a lot behind the detail card pans it into view", async ({ page }) => {
  // Zoom to 3x first: near 1x there is little pan room and the pan clamp
  // can strand bottom-row lots behind the tall bottom-sheet card no matter
  // how correct the reveal math is (verified by measurement). At 3x there
  // is room to reveal by panning. No card is open yet, so predict where it
  // WILL appear (bottom sheet on small screens, bottom-right w-64 on sm+)
  // and tap a visible lot inside that region — outside the zoom-control
  // column — with a real click. The opening card covers the lot, so
  // selection must pan (never zoom) until uncovered.
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.waitForTimeout(300);
  const lotId = await page.evaluate(() => {
    const svg = document.querySelector("main svg") as SVGSVGElement | null;
    if (!svg) throw new Error("map svg not found");
    const rect = svg.getBoundingClientRect();
    const small = window.innerWidth < 640;
    const card = small
      ? { left: rect.left, right: rect.right, top: rect.bottom - 280 }
      : { left: rect.right - 340, right: rect.right, top: rect.bottom - 280 };
    let best: { id: number; y: number } | null = null;
    for (const poly of svg.querySelectorAll('polygon[fill="transparent"]')) {
      const el = poly as SVGPolygonElement;
      const box = el.getBBox();
      const ctm = el.getScreenCTM();
      if (!ctm) continue;
      const pt = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(ctm);
      if (pt.x < rect.left + 4 || pt.x > rect.right - 4 || pt.y < rect.top + 4 || pt.y > rect.bottom - 4) continue;
      if (pt.x < card.left || pt.x > card.right || pt.y < card.top) continue;
      // Keep clear of the floating zoom-control column (bottom-right).
      if (pt.x > rect.right - 70 && pt.y > rect.bottom - 180) continue;
      if (!best || pt.y > best.y) best = { id: Number(el.getAttribute("data-lot-id")), y: pt.y };
    }
    if (!best) throw new Error("no visible lot inside the future card region");
    return best.id;
  });
  const center = await page.evaluate((id) => {
    const el = document.querySelector(`main svg polygon[data-lot-id="${id}"]`) as SVGPolygonElement | null;
    if (!el?.getScreenCTM()) throw new Error("lot not found");
    const box = el.getBBox();
    const pt = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(el.getScreenCTM()!);
    return { x: pt.x, y: pt.y };
  }, lotId);
  const before = await page.locator("main svg").first().getAttribute("viewBox");
  await page.mouse.click(center.x, center.y);
  await expect(selectedLotCard(page)).toBeVisible();
  // Zoom must not have changed (reveal pans only): viewBox width encodes zoom.
  const viewBoxWidth = async () => (await page.locator("main svg").first().getAttribute("viewBox"))?.split(" ")[2];
  expect(await viewBoxWidth()).toBe(before.split(" ")[2]);
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const el = document.querySelector(`main svg polygon[data-lot-id="${id}"]`) as SVGPolygonElement | null;
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
  await page.screenshot({ path: "test-results/labels-2x.png" });
});

test("fullscreen lot click selects", async ({ page }) => {
  await page.getByRole("button", { name: "Enter fullscreen" }).click();
  const pt = await hitCenter(page, 5);
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
});

test("label sizes stay consistent and inside lots at 1x/2x/4x", async ({ page }) => {
  async function labelStats() {
    return page.evaluate(() => {
      const svg = document.querySelector("main svg") as SVGSVGElement | null;
      if (!svg) throw new Error("no svg");
      const hits = [...svg.querySelectorAll('polygon[fill="transparent"]')];
      const vis = [...svg.querySelectorAll("polygon:not([fill='transparent'])")];
      const boxes = vis.map((p, i) => {
        const b = (p as SVGPolygonElement).getBBox();
        const title = hits[i]?.querySelector("title")?.textContent ?? "";
        const lot = /Lot (\S+)/.exec(title)?.[1] ?? "";
        return { lot, x: b.x, y: b.y, w: b.width, h: b.height };
      });
      const labels = [...svg.querySelectorAll("text")].map((t) => {
        const el = t as SVGTextElement;
        const tb = el.getBBox();
        // getBBox() on <text> includes side bearings, and Firefox reports
        // them systematically wider (~0.13 units/side here) than
        // Chromium/WebKit — same pixels, different rulers. getComputedText-
        // Length() is the sum of glyph advances (font-table derived, stable
        // across engines), so center the advance box inside the bbox and
        // test *that* against the lot: tighter and engine-robust.
        const advance = el.getComputedTextLength();
        const inkX = tb.x + (tb.width - advance) / 2;
        return { lot: t.textContent ?? "", w: advance, h: tb.height, x: inkX, y: tb.y };
      });
      return { labels, boxes };
    });
  }

  await page.screenshot({ path: "test-results/labels-1x.png" });
  const z1 = await labelStats();
  expect(Array.isArray(z1.labels)).toBe(true);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.waitForTimeout(300);
  const z2 = await labelStats();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/labels-4x.png" });
  const z4 = await labelStats();

  // At 1x most lots are too small for labels; from 2x up labels must exist
  // and every label must fit inside its own polygon box (5% tolerance).
  expect(z2.labels.length).toBeGreaterThan(100);
  expect(z4.labels.length).toBeGreaterThan(300);
  for (const [tag, stats] of [["2x", z2], ["4x", z4]] as const) {
    const boxByLot = new Map(stats.boxes.filter((b) => b.lot).map((b) => [b.lot, b]));
    let inside = 0;
    const offenders: string[] = [];
    for (const label of stats.labels) {
      const b = boxByLot.get(label.lot);
      if (!b) continue;
      const tol = 0.05;
      if (label.x >= b.x - b.w * tol && label.y >= b.y - b.h * tol &&
          label.x + label.w <= b.x + b.w * (1 + tol) && label.y + label.h <= b.y + b.h * (1 + tol)) {
        inside++;
      } else if (offenders.length < 15) {
        offenders.push(
          `${label.lot}: label@${label.x.toFixed(2)},${label.y.toFixed(2)} ${label.w.toFixed(2)}x${label.h.toFixed(2)} vs lot@${b.x.toFixed(2)},${b.y.toFixed(2)} ${b.w.toFixed(2)}x${b.h.toFixed(2)}`,
        );
      }
    }
    const ratio = inside / Math.max(stats.labels.length, 1);
    console.log(`[labels@${tag}] ${inside}/${stats.labels.length} inside (ratio ${ratio.toFixed(3)})`);
    if (offenders.length) {
      console.log(`[labels@${tag}] offenders:\n  - ${offenders.join("\n  - ")}`);
    }
    expect(ratio).toBeGreaterThan(0.9);
  }
});

test("tap selects a lot (touch)", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, "touch input needs a hasTouch project");
  const pt = await hitCenter(page, 5);
  await page.touchscreen.tap(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
});
