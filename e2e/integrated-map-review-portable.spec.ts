import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createSyntheticReviewManifest } from "./fixtures/map-review-synthetic/create-manifest.mjs";

const REVIEW_URL = "/lots/correct?demo=1&mode=labels&fixture=synthetic";
const FIXTURE_ROOT = new URL("./fixtures/map-review-synthetic/", import.meta.url);
const [sourceBytes, lotsBytes] = await Promise.all([
  readFile(new URL("masterplan_background.svg", FIXTURE_ROOT)),
  readFile(new URL("lots.json", FIXTURE_ROOT)),
]);
const benchmark = createSyntheticReviewManifest(sourceBytes, lotsBytes);
const sourceSha = benchmark.source_image.sha256;

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("synthetic-map-review-reset") !== "yes") {
      localStorage.clear();
      sessionStorage.setItem("synthetic-map-review-reset", "yes");
    }
  });
  await page.goto(REVIEW_URL);
  await expect(page.getByRole("heading", { name: "Synthetic map review · test fixture" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Recorded benchmark decisions" })).toHaveAttribute("aria-valuemax", "6");
});

test("portable fixture shares map coordinates and supports direct polygon selection, crop evidence, pan and zoom", async ({ page }, testInfo) => {
  const map = page.locator("svg[aria-label='Interactive correction map']");
  await expect(map).toBeVisible();
  await expect(map.locator("image")).toHaveAttribute("href", /masterplan_background\.svg$/);
  expect(sourceBytes.toString("utf8")).toContain("SYNTHETIC TEST FIXTURE");
  await expect(page.getByRole("heading", { name: "Synthetic map review · test fixture" })).toBeVisible();
  await expect(page.getByRole("option", { name: /Detected polygon TEST-003/ })).toBeVisible();

  const originalViewBox = await map.getAttribute("viewBox");
  await page.getByRole("button", { name: "Zoom in" }).click();
  const zoomViewBox = await map.getAttribute("viewBox");
  expect(zoomViewBox).not.toBe(originalViewBox);
  const mapBox = await map.boundingBox();
  expect(mapBox).not.toBeNull();
  await page.mouse.move(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(mapBox!.x + mapBox!.width / 2 + 35, mapBox!.y + mapBox!.height / 2 + 22, { steps: 3 });
  await page.mouse.up();
  expect(await map.getAttribute("viewBox")).not.toBe(zoomViewBox);
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await expect(map).toHaveAttribute("viewBox", originalViewBox!);

  // This concave target's box center is inside its broad top span; the click
  // therefore exercises map hit-testing, not the review queue shortcut.
  await page.getByRole("option", { name: /Detected polygon TEST-003/ }).click();
  await expect(page.getByRole("heading", { name: "Case SYN-003" })).toBeVisible();
  const crop = page.locator("[data-testid='source-polygon-crop']");
  await expect(crop).toBeVisible();
  await expect(crop.locator("image")).toHaveAttribute("href", /masterplan_background\.svg$/);
  await expect(crop.locator("polygon")).toHaveCount(2);
  expect(await page.locator("[data-testid='source-polygon-crop'] svg").getAttribute("viewBox")).not.toBe("0 0 5700 4800");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath("portable-editor-desktop-selected.png"), fullPage: true });
});

test("portable reviewer saves, resumes, warns on duplicate numbers, records geometry history, and exports", async ({ page }) => {
  await page.getByLabel("Reviewer").fill("Portable fixture QA");
  await page.getByRole("button", { name: "Open current target", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Case SYN-001" })).toBeVisible();
  await page.getByLabel("Printed lot number · digits only").fill("123");
  await page.getByRole("button", { name: "Confirm printed number" }).click();
  await expect(page.getByRole("heading", { name: "Case SYN-002" })).toBeVisible();
  await page.getByLabel("Printed lot number · digits only").fill("123");
  await expect(page.getByRole("alert")).toContainText("already recorded for FIX-001");
  await page.getByLabel("Printed lot number · digits only").fill("");

  await page.getByRole("button", { name: "Flag geometry issue" }).click();
  await page.getByRole("button", { name: "Adjust boundary" }).click();
  const vertex = page.getByRole("slider", { name: "Move boundary point 1" });
  await expect(vertex).toBeVisible();
  await vertex.press("ArrowRight");
  await page.getByRole("button", { name: "Save boundary preview" }).click();
  await expect(page.getByText(/Boundary correction saved to the local correction draft/)).toBeVisible();

  const persisted = await page.evaluate(() => ({
    review: Object.entries(localStorage).find(([key]) => key.startsWith("wamule-lot-number-benchmark-v1:"))?.[1],
    draft: localStorage.getItem("cw:synthetic-map:portable-review-fixture"),
  }));
  expect(persisted.review).toBeTruthy();
  const review = JSON.parse(persisted.review!) as { reviews: Record<string, { status: string; printed_number: string }> };
  expect(review.reviews["SYN-001"]).toMatchObject({ status: "confirmed", printed_number: "123" });
  const draft = JSON.parse(persisted.draft!) as { lots: Record<string, { polygon: unknown[] }>; log: Array<{ field: string }> };
  expect(draft.log.some((entry) => entry.field === "polygon")).toBe(true);
  expect(draft.lots["FIX-002"].polygon).toHaveLength(4);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Case SYN-002" })).toBeVisible();
  await expect(page.getByText("1 / 6 decisions recorded")).toBeVisible();

  const [jsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export review JSON" }).click(),
  ]);
  expect(jsonDownload.suggestedFilename()).toBe("wamule-synthetic-map-review-v1.json");
  const exported = JSON.parse(await readFile((await jsonDownload.path())!, "utf8")) as {
    source_image: { sha256: string };
    cases: Array<{ id: string; reviewer: string; printed_number: string }>;
    geometry_issues: Array<{ correction_history: Array<{ field: string }> }>;
  };
  expect(exported.source_image.sha256).toBe(sourceSha);
  expect(exported.cases).toHaveLength(6);
  expect(exported.cases[0]).toMatchObject({ id: "SYN-001", reviewer: "Portable fixture QA", printed_number: "123" });
  expect(exported.geometry_issues[0].correction_history[0].field).toBe("polygon");

  const [csvDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export scorer CSV" }).click(),
  ]);
  expect(csvDownload.suggestedFilename()).toBe("wamule-synthetic-map-review-labels.csv");
  expect(await readFile((await csvDownload.path())!, "utf8")).toContain("SYN-001,123");
});

test("keyboard map navigation selects a reviewed detection without using the mouse", async ({ page }) => {
  const listbox = page.getByRole("listbox", { name: "Detected polygons on the map" });
  await listbox.focus();
  await listbox.press("Home");
  await listbox.press("Enter");
  await expect(page.getByRole("heading", { name: "Case SYN-001" })).toBeVisible();
  await expect(page.getByText("TEST-001", { exact: true })).toBeVisible();
  await expect(page.locator("[data-testid='source-polygon-crop']")).toBeVisible();
});

test("mobile review canvas and actions remain usable at 390px and 320px", async ({ page }, testInfo) => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 820 });
    await expect(page.locator("svg[aria-label='Interactive correction map']")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "Open current target", exact: true }).click();
    await expect(page.locator("[data-testid='source-polygon-crop']")).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm printed number" })).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`portable-editor-${width}px.png`), fullPage: true });
    await page.reload();
  }
});

test("buyer map keeps its own product wrapper over the shared rendering primitives", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/embed/demo?demo=1");
  const map = page.locator("main svg[role='group']");
  await expect(map).toBeVisible();
  await expect.poll(() => map.locator("polygon[fill='transparent']").count(), { timeout: 30000 }).toBeGreaterThan(0);
  const screenshotName = process.env.E2E_FIXTURE_DIR?.includes("hopkins")
    ? "local-hopkins-buyer-map-desktop.png"
    : "synthetic-buyer-map-desktop.png";
  await page.screenshot({ path: testInfo.outputPath(screenshotName), fullPage: true });
});
