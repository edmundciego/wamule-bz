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

async function clickSourceCoordinate(page: Page, x: number, y: number): Promise<void> {
  const point = await page.locator("svg[aria-label='Interactive correction map']").evaluate((svg, sourcePoint) => {
    const element = svg as SVGSVGElement;
    const mapPoint = element.createSVGPoint();
    mapPoint.x = sourcePoint.x;
    mapPoint.y = sourcePoint.y * (4800 / 5700);
    const client = mapPoint.matrixTransform(element.getScreenCTM()!);
    return { x: client.x, y: client.y };
  }, { x, y });
  await page.mouse.click(point.x, point.y);
}

async function traceSyntheticChild(page: Page, bounds: [number, number, number, number]): Promise<void> {
  const [left, top, right, bottom] = bounds;
  const startNext = page.getByRole("button", { name: "Start Next Polygon" });
  if (await startNext.count()) await startNext.click();
  await clickSourceCoordinate(page, left, top);
  await clickSourceCoordinate(page, right, top);
  await clickSourceCoordinate(page, right, bottom);
  await clickSourceCoordinate(page, left, bottom);
  await page.getByRole("button", { name: "Finish Polygon" }).click();
}

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

test("one synthetic detection spanning three plots can be split, labeled independently, resumed, exported, and undone", async ({ page }) => {
  await page.getByLabel("Reviewer").fill("Split workflow QA");
  const parentOption = page.getByRole("option", { name: /Detected polygon TEST-006/ });
  await parentOption.click();
  await expect(page.getByRole("heading", { name: "Case SYN-006" })).toBeVisible();
  await page.getByLabel("What looks wrong? (optional)").fill("One detected outline covers three printed source lots.");
  await page.getByRole("button", { name: "Flag geometry issue" }).click();
  await expect(page.getByRole("button", { name: "Confirm printed number" })).toBeDisabled();

  await page.getByRole("button", { name: "Split Polygon" }).click();
  await expect(page.getByTestId("polygon-split-mode")).toBeVisible();
  await clickSourceCoordinate(page, 35.7, 32);
  await clickSourceCoordinate(page, 39.2, 32);
  await clickSourceCoordinate(page, 39.2, 39);
  await page.getByRole("button", { name: "Cancel Split" }).click();
  await expect(page.getByRole("option", { name: /Detected polygon TEST-006/ })).toBeVisible();
  expect(await page.evaluate(() => {
    const review = Object.entries(localStorage).find(([key]) => key.startsWith("wamule-lot-number-benchmark-v1:"))?.[1];
    return review ? JSON.parse(review).split_operations.length : 0;
  })).toBe(0);

  await page.getByRole("button", { name: "Split Polygon" }).click();
  const x1 = 1995 / 57;
  const x2 = 2261 / 57;
  const x3 = 2527 / 57;
  const x4 = 2793 / 57;
  await traceSyntheticChild(page, [35, 31, x2, 43]);
  await traceSyntheticChild(page, [x2, 31, x3, 43]);
  await traceSyntheticChild(page, [x3, 31, 49, 43]);
  await expect(page.getByTestId("split-drawn-progress")).toContainText("3 polygons drawn");
  await page.getByRole("button", { name: "Edit Child 2" }).click();
  await page.getByRole("slider", { name: "Move boundary point 1" }).press("ArrowRight");
  await page.getByRole("button", { name: "Save adjustment" }).click();
  await page.getByRole("button", { name: "Preview split" }).click();
  await page.getByRole("button", { name: "Confirm Split" }).click();

  await expect(page.getByRole("option", { name: /Draft child 1 · not canonical/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Draft child 2 · not canonical/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Draft child 3 · not canonical/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Detected polygon TEST-006/ })).toHaveCount(0);
  const firstChildHeading = page.getByRole("heading", { name: /Draft child · DRAFT-FIX-006-S1-C1/ });
  await expect(firstChildHeading).toBeVisible();
  await expect(page.locator("[data-testid='source-polygon-crop']")).toBeVisible();
  await expect(page.getByText(/not part of the benchmark target geometry/)).toBeVisible();

  await page.getByLabel("Printed lot number · digits only").last().fill("601");
  await page.getByRole("button", { name: "Save number review" }).click();
  await clickSourceCoordinate(page, (x2 + x3) / 2, 37);
  await expect(page.getByRole("heading", { name: /Draft child · DRAFT-FIX-006-S1-C2/ })).toBeVisible();
  await page.getByLabel("Printed lot number · digits only").last().fill("601");
  await expect(page.getByRole("alert")).toContainText("Possible duplicate 601");
  await page.getByLabel("Printed lot number · digits only").last().fill("602");
  await page.getByRole("button", { name: "Save number review" }).click();
  await clickSourceCoordinate(page, (x3 + x4) / 2, 37);
  await expect(page.getByRole("heading", { name: /Draft child · DRAFT-FIX-006-S1-C3/ })).toBeVisible();
  await page.getByLabel("Printed lot number · digits only").last().fill("603");
  await page.getByRole("button", { name: "Save number review" }).click();
  await expect(page.getByTestId("split-review-progress")).toContainText("3 / 3 reviewed");

  // A map drag remains a pan while child hit targets continue to select the right outline.
  const map = page.locator("svg[aria-label='Interactive correction map']");
  const mapBounds = await map.boundingBox();
  expect(mapBounds).not.toBeNull();
  await page.mouse.move(mapBounds!.x + mapBounds!.width / 2, mapBounds!.y + mapBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(mapBounds!.x + mapBounds!.width / 2 + 22, mapBounds!.y + mapBounds!.height / 2 + 14, { steps: 2 });
  await page.mouse.up();
  await clickSourceCoordinate(page, (x1 + x2) / 2, 37);
  await expect(page.getByRole("heading", { name: /Draft child · DRAFT-FIX-006-S1-C1/ })).toBeVisible();

  const [jsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export review JSON" }).click(),
  ]);
  const exported = JSON.parse(await readFile((await jsonDownload.path())!, "utf8")) as {
    source_image: { sha256: string };
    benchmark_case_geometry_unchanged: boolean;
    cases: Array<{ id: string; original_polygon_pct: unknown; status: string }>;
    geometry_issues: Array<{ correction_key: string }>;
    proposed_polygon_splits: Array<{ parent_detection_id: string; parent_polygon_pct: unknown; children: Array<{ id: string; polygon_pct: unknown; review: { printed_number: string } }> }>;
  };
  expect(exported.source_image.sha256).toBe(sourceSha);
  expect(exported.benchmark_case_geometry_unchanged).toBe(true);
  expect(exported.cases.find((item) => item.id === "SYN-006")?.original_polygon_pct).toEqual(benchmark.cases.find((item) => item.id === "SYN-006")?.polygon_pct);
  expect(exported.cases.find((item) => item.id === "SYN-006")?.status).toBe("pending");
  expect(exported.geometry_issues).toContainEqual(expect.objectContaining({ correction_key: "FIX-006" }));
  expect(exported.proposed_polygon_splits[0]).toMatchObject({
    parent_detection_id: "FIX-006",
    source_image_sha256: sourceSha,
  });
  expect(exported.proposed_polygon_splits[0].children.map((child) => child.review.printed_number)).toEqual(["601", "602", "603"]);

  await page.reload();
  const resumedChild = page.getByRole("option", { name: /Draft child 1 · not canonical/ });
  await expect(resumedChild).toBeVisible();
  await resumedChild.click();
  await expect(page.getByRole("heading", { name: /Draft child · DRAFT-FIX-006-S1-C1/ })).toBeVisible();
  await expect(page.getByLabel("Printed lot number · digits only").last()).toHaveValue("601");
  await page.getByRole("button", { name: "Undo split · restore parent" }).click();
  await expect(page.getByRole("option", { name: /Detected polygon TEST-006/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Draft child 1 · not canonical/ })).toHaveCount(0);
  await page.reload();
  const splitHistory = await page.evaluate(() => {
    const review = Object.entries(localStorage).find(([key]) => key.startsWith("wamule-lot-number-benchmark-v1:"))?.[1];
    return review ? JSON.parse(review).split_operations : [];
  });
  expect(splitHistory).toHaveLength(1);
  expect(splitHistory[0].status).toBe("undone");
  expect(splitHistory[0].children.map((child: { review: { printed_number: string } }) => child.review.printed_number)).toEqual(["601", "602", "603"]);
});

test("mobile review canvas and actions remain usable at 390px and 320px", async ({ page }, testInfo) => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 820 });
    await expect(page.locator("svg[aria-label='Interactive correction map']")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await page.getByRole("option", { name: /Detected polygon TEST-001/ }).click();
    await expect(page.getByRole("heading", { name: "Case SYN-001" })).toBeVisible();
    await expect(page.locator("[data-testid='source-polygon-crop']")).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm printed number" })).toBeVisible();
    const splitButton = page.getByRole("button", { name: "Split Polygon", exact: true });
    await expect(splitButton).toBeVisible();
    await splitButton.click();
    await expect(page.getByRole("heading", { name: "Split Mode · TEST-001" })).toBeVisible();
    await expect(page.getByText(/Tap or click each visible corner/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Preview split" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Confirm Split" })).toBeDisabled();
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`portable-editor-split-mode-${width}px.png`), fullPage: true });
    await page.getByRole("button", { name: "Cancel Split" }).click();
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
