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
  return page.locator("strong", { hasText: /^Lot S-/ }).first();
}

/** Screen-space centre of the hit polygon for a lot number (e.g. "S-057"). */
async function lotCenter(page: Page, lotNumber: string): Promise<{ x: number; y: number }> {
  return page.evaluate((lot) => {
    const svg = document.querySelector("main svg") as SVGSVGElement | null;
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
    .poll(() => page.locator("main svg").first().first().getAttribute("viewBox"), { timeout: 15000 })
    .not.toBe("0 0 100 100");
});

test("demo map loads lots over the background", async ({ page }) => {
  await expect(page.locator("main svg image")).toBeAttached();
  expect(await lotCount(page)).toBeGreaterThan(50);
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

test("tiny-lot tap selects the smallest lot under the cursor", async ({ page }) => {
  // S-055…S-058 are 1.4-unit lots 0.6 apart: their 14px hit paddings
  // overlap at 1x. Paint order is smallest-on-top, so the tap must lock
  // exactly S-057 — not the topmost-in-data-order neighbor S-058.
  const pt = await lotCenter(page, "S-057");
  await page.mouse.click(pt.x, pt.y);
  await expect(page.locator("strong", { hasText: /^Lot S-057$/ }).first()).toBeVisible();
});

test("selected lot draws a thick outline with no fill", async ({ page }) => {
  const pt = await hitCenter(page, 5);
  await page.mouse.click(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
  const lot = /Lot (\S+)/.exec((await selectedLotCard(page).textContent()) ?? "")?.[1] ?? "";
  const stroke = await page.evaluate((lotNumber) => {
    const svg = document.querySelector("main svg") as SVGSVGElement | null;
    const id = [...(svg?.querySelectorAll('polygon[fill="transparent"]') ?? [])].find((p) =>
      (p.querySelector("title")?.textContent ?? "").includes(`Lot ${lotNumber} `),
    )?.getAttribute("data-lot-id");
    const visible = svg?.querySelector(`polygon[fill="none"][data-lot-id="${id}"]`);
    return {
      width: visible?.getAttribute("stroke-width"),
      fill: visible?.getAttribute("fill"),
    };
  }, lot);
  expect(stroke.width).toBe("3");
  expect(stroke.fill).toBe("none");
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
  // At 1x with no selection the pan range is zero, but selecting grants
  // card padding (bottom sheet ~= card height), so there is room to reveal
  // by panning without touching zoom. Tap the bottom-most visible lot with
  // a real click: on phone viewports the opening bottom sheet covers it and
  // selection must pan until uncovered; elsewhere it is already visible and
  // this asserts the invariant (visible, zoom unchanged).
  const lotId = await page.evaluate(() => {
    const svg = document.querySelector("main svg") as SVGSVGElement | null;
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
      if (!best || pt.y > best.y) best = { id: Number(el.getAttribute("data-lot-id")), y: pt.y };
    }
    if (!best) throw new Error("no visible lot found");
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
});

test("fullscreen lot click selects", async ({ page }) => {
  await page.getByRole("button", { name: "Enter fullscreen" }).click();
  const pt = await hitCenter(page, 5);
  await page.mouse.click(pt.x, pt.y);
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
      const el = document.querySelector(`main svg polygon[data-lot-id="${lotId}"]`) as SVGPolygonElement | null;
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
        const svg = document.querySelector("main svg") as SVGSVGElement | null;
        if (!svg) throw new Error("no svg");
        const poly = svg.querySelector(`polygon[data-lot-id="${lotId}"]`) as SVGPolygonElement | null;
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
  await expect(page.locator("main svg text")).toHaveCount(0);
  expect(await page.locator("main svg circle").count()).toBeGreaterThan(50);
  await page.screenshot({ path: "test-results/labels-1x.png" });

  // Sample by geometry at 1x (full view): smallest (tiny), largest (huge).
  const sample = await page.evaluate(() => {
    const svg = document.querySelector("main svg") as SVGSVGElement | null;
    if (!svg) throw new Error("no svg");
    const rows = [...svg.querySelectorAll('polygon[fill="transparent"]')].map((p) => {
      const el = p as SVGPolygonElement;
      const b = el.getBBox();
      const title = el.querySelector("title")?.textContent ?? "";
      return {
        id: Number(el.getAttribute("data-lot-id")),
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
    const svg = document.querySelector("main svg") as SVGSVGElement | null;
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
          id: Number(el.getAttribute("data-lot-id")),
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
    await expect(page.locator("main svg text", { hasText: s.lot })).toBeVisible();
    const fit = await labelFits(s.id, s.lot);
    expect(fit.ok, `2x hover label fit for ${s.lot}: ${fit.detail}`).toBe(true);
  }
  {
    const pt = await screenCenterOf(visible2x.median.id);
    await page.mouse.move(pt.x, pt.y);
    await page.screenshot({ path: "test-results/labels-2x.png" });
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
      const svg = document.querySelector("main svg") as SVGSVGElement | null;
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
      const els = [...document.querySelectorAll('main svg polygon[fill="transparent"]')];
      const hit = els.find((p) => (p.querySelector("title")?.textContent ?? "").includes(`Lot ${lotNumber} `));
      return hit ? Number((hit as SVGPolygonElement).getAttribute("data-lot-id")) : -1;
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
    expect(await page.locator("main svg text").count()).toBe(0);
  }
  const tiny = await selectedLot();

  /** Ctrl+wheel zoom around the stationary cursor until viewBox width <= max. */
  async function wheelZoomTo(maxWidth: number) {
    await page.keyboard.down("Control");
    try {
      await expect
        .poll(async () => {
          const vb = await page.locator("main svg").first().getAttribute("viewBox");
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
    await expect(page.locator("main svg text", { hasText: tiny.lot })).toHaveCount(0);
  }

  // ~4x via Zoom to Lot (exact fit+center on every engine): hover the tiny
  // lot for its label (selection alone no longer labels), which appears
  // and fits.
  await page.getByRole("button", { name: /^Zoom to Lot/ }).click();
  await page.waitForTimeout(400);
  {
    const pt = await screenCenterOf(tiny.id);
    await page.mouse.move(pt.x, pt.y);
  }
  await expect(page.locator("main svg text", { hasText: tiny.lot })).toBeVisible();
  {
    const fit = await labelFits(tiny.id, tiny.lot);
    expect(fit.ok, `4x label fit for ${tiny.lot}: ${fit.detail}`).toBe(true);
  }
  await page.screenshot({ path: "test-results/labels-4x.png" });

  // Selection shows no overlay text (the number lives in the card, never
  // on top of baked plat text): move away, zero labels remain.
  await page.mouse.move(5, 5);
  await expect(page.locator("main svg text")).toHaveCount(0);
});

test("tap selects a lot (touch)", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, "touch input needs a hasTouch project");
  const pt = await hitCenter(page, 5);
  await page.touchscreen.tap(pt.x, pt.y);
  await expect(selectedLotCard(page)).toBeVisible();
});
