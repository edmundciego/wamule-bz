import { expect, test } from "@playwright/test";

// Slice-1 correction workspace (dev-only /correct/ mount, committed tiny
// fixture e2e/fixtures/correction). Hermetic: localStorage drafts only,
// no DB writes. Slice-3 preview-link test is skipped (not built).

const URL = "/correct/correct.html";

test.beforeEach(async ({ page }) => {
  await page.goto(URL);
  await expect(page.locator("#cw-queue .qrow")).toHaveCount(12, { timeout: 30000 });
});

test("numbers queue loads uncertain-first with plan crop beside proposal", async ({ page }) => {
  // L-012 has no detection unit -> rank 0, first in queue.
  const first = page.locator("#cw-queue .qrow").first();
  await expect(first).toContainText("L-012");
  await expect(first).toContainText("no-unit");
  await first.click();
  await expect(page.locator("#cw-lot-title")).toContainText("L-012");
  // Crop canvas rendered (plan image paints non-blank pixels).
  const nonBlank = await page.evaluate(() => {
    const c = document.getElementById("cw-crop") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4000) if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) n++;
    return n;
  });
  expect(nonBlank).toBeGreaterThan(0);
});

test("keyboard flow commits a number and logs the edit", async ({ page }) => {
  await page.locator("#cw-queue .qrow").first().click();
  await page.locator("#cw-number").fill("112");
  await page.locator("#cw-number").press("Enter");
  // Moved to next uncertain lot.
  await expect(page.locator("#cw-lot-title")).not.toContainText("L-012");
  await page.getByRole("tab", { name: "Log" }).click();
  await expect(page.locator("#cw-logtable")).toContainText("L-012");
  await expect(page.locator("#cw-logtable")).toContainText("number");
});

test("duplicate detection is live on edit", async ({ page }) => {
  await expect(page.locator("#cw-dups")).toContainText("105");
  // Typing the duplicated value onto L-012 extends the live warning.
  await page.locator("#cw-queue .qrow").first().click();
  await page.locator("#cw-number").fill("105");
  await page.locator("#cw-number").press("Enter");
  await expect(page.locator("#cw-dups")).toContainText("105 (L-005, L-007, L-012)");
});

test("tier click-paint updates counts and unassigned counter", async ({ page }) => {
  await page.getByRole("tab", { name: "Tiers" }).click();
  await expect(page.locator("#cw-unassigned")).toContainText("Unassigned: 1 / 12");
  // Default active tier is the first (standard); paint the unassigned lot.
  await page.locator('svg.tiermap polygon[data-lot="L-012"]').click();
  await expect(page.locator("#cw-unassigned")).toContainText("Unassigned: 0 / 12");
});

test("lasso paints a whole row and undo reverts it", async ({ page }) => {
  await page.getByRole("tab", { name: "Tiers" }).click();
  // Activate premium, then drag across the top row (all standard).
  await page.locator("#cw-tierlist .tierow:nth-child(2) button").click();
  await page.locator("svg.tiermap").scrollIntoViewIfNeeded();
  const box = await page.locator("svg.tiermap").boundingBox();
  if (!box) throw new Error("tier map not laid out");
  // Viewport-relative drag across the top row (works on touch viewports too).
  // Row 0 spans polygon-y 5-29 (centroid 17); screen fraction == polygon
  // percent (SVG height tracks the plan aspect, no letterboxing).
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.27, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#cw-tierlist .tierow:nth-child(1)")).toContainText("0 lots");
  await page.getByRole("tab", { name: "Log" }).click();
  await page.locator("#cw-undo").click();
  await expect(page.locator("#cw-tierlist .tierow:nth-child(1)")).toContainText("4 lots");
});

test("run fill previews confident lots; re-import preserves confirmed", async ({ page }) => {
  await page.locator("#cw-fill").click();
  await expect(page.locator("#cw-fill-preview")).toContainText("Would confirm 6 lots");
  await page.locator("#cw-fill-preview button.btn.primary").click();
  await expect(page.locator("#cw-stepper")).toContainText("Correct");
  await page.locator("#cw-reimport").click();
  await expect(page.locator("#cw-fill-preview")).toContainText("6 confirmed/locked preserved");
  await expect(page.locator("#cw-fill-preview")).toContainText("L-001 (confirmed)");
});

test.skip("draft preview links never expose drafts publicly (slice 3 — not built)", async () => {
  // Slice 3 will mint signed expiring preview URLs. This test will assert:
  // unsigned / expired / unknown-token preview URLs return 404 with no lot
  // data, while the stable embed URL serves only published snapshots.
});
