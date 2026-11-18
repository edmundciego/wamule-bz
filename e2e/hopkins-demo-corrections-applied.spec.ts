import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const dataDir = resolve(process.env.WAMULE_HOPKINS_MAP_DIR ?? "out/hopkins-ocr");
const lotsPath = resolve(dataDir, "lots.json");
const sourcePath = resolve(dataDir, "masterplan_background.webp");
const manifestPath = resolve(dataDir, "local-corrections.json");
const screenshotDir = resolve(process.env.HOPKINS_SCREENSHOT_DIR ?? "artifacts/hopkins-demo-applied-20261014");

test("normal Hopkins demo loads the applied correction manifest, selects all demo plots, and reloads by stable plot label", async ({ page }) => {
  test.skip(!existsSync(lotsPath) || !existsSync(sourcePath) || !existsSync(manifestPath), "Actual Hopkins source assets and the local correction manifest are not available.");
  const lots = JSON.parse(await readFile(lotsPath, "utf8")) as Array<{ lot_number: string; polygon_pct: unknown[] }>;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    approved_splits: Array<{ parent_detection_id: string; children: Array<{ id: string; printed_number: string; label_status: string }> }>;
    superseded_detections?: Array<{ detection_id: string; replaced_by_parent_detection_id: string; replacement_child_id: string }>;
    inaccessible_manual_session: { status: string; detection_id: string | null };
  };
  const childTotal = manifest.approved_splits.reduce((total, split) => total + split.children.length, 0);
  const supersededCount = manifest.superseded_detections?.length ?? 0;
  const expectedCount = lots.length - manifest.approved_splits.length + childTotal - supersededCount;
  expect(lots).toHaveLength(719);
  expect(manifest.approved_splits).toHaveLength(31);
  expect(childTotal).toBe(117);
  expect(supersededCount).toBe(2);
  expect(manifest.inaccessible_manual_session).toMatchObject({ status: "pending-not-imported", detection_id: null });
  expect(manifest.approved_splits.every((split) => split.children.every((child) => child.printed_number === "" && child.label_status === "pending"))).toBe(true);

  const localDraftSentinel = JSON.stringify({ keep: true, id: "isolated-browser-local-draft" });
  await page.addInitScript((sentinel) => {
    localStorage.setItem("cw:hopkins-grove:map-review", sentinel);
    localStorage.setItem("wamule-correction-split-drafts-v1:isolated-test", sentinel);
  }, localDraftSentinel);
  const origin = process.env.HOPKINS_NATIVE_PREVIEW_ORIGIN ?? "http://127.0.0.1:5322";
  const url = `${origin}/embed/demo?demo=hopkins&phase=default`;
  await page.goto(url);
  await expect(page.getByLabel("Hopkins Grove demo", { exact: true })).toHaveText("Demo");
  await expect(page.getByText(/Local Hopkins corrections were not applied/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zoom out" })).toBeVisible();
  const map = page.getByRole("listbox", { name: "Hopkins Grove demo plots" });
  const options = map.getByRole("option");
  await expect(options).toHaveCount(expectedCount);
  expect(await options.evaluateAll((elements) => elements.every((element) => getComputedStyle(element).cursor === "pointer"))).toBe(true);
  const mapOptionLabels = await options.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label") ?? ""));
  for (const split of manifest.approved_splits) {
    const number = split.parent_detection_id.match(/^L-(\d+)$/)?.[1];
    expect(number, `Expected numeric detection reference for ${split.parent_detection_id}`).toBeTruthy();
    expect(mapOptionLabels).not.toContain(`Select Demo Plot ${number}`);
  }
  for (const detectionId of ["L-137", "L-156"]) {
    const number = detectionId.slice(2);
    expect(mapOptionLabels).not.toContain(`Select Demo Plot ${number}`);
  }
  await expect(page.getByText("Review pending", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Candidate outline · review pending", { exact: true })).toHaveCount(0);
  await expect(page.getByText("source review pending", { exact: false })).toHaveCount(0);
  await expect(page.locator('[data-testid="candidate-map-viewport"] svg image')).toBeVisible();
  await page.locator('[data-testid="candidate-map-viewport"] svg image').evaluate((image: SVGImageElement) => {
    if (image.width.baseVal.value === 0 || image.height.baseVal.value === 0) throw new Error("Hopkins raster is not aligned in the map viewport.");
  });
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: resolve(screenshotDir, "overview-applied.png"), fullPage: true });

  const search = page.getByRole("textbox", { name: "Search demo plots" });
  await search.fill("L-050");
  await page.getByRole("button", { name: "Select Demo Plot 050", exact: true }).click();
  await expect(page.getByRole("region", { name: "Details for Demo Plot 050" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zoom to Demo Plot 050" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Details for Demo Plot 050" }).getByText(/price|availability|pending|not confirmed/i)).toHaveCount(0);

  await search.fill("L-049");
  const l049Children = page.getByRole("button", { name: /Select Demo Plot 049-\d\d/ });
  await expect(l049Children).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Select Demo Plot 049", exact: true })).toHaveCount(0);

  await search.fill("L-048");
  const l048Children = page.getByRole("button", { name: /Select Demo Plot 048-\d\d/ });
  await expect(l048Children).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Select Demo Plot 048", exact: true })).toHaveCount(0);
  await l048Children.first().click();
  await expect(page.getByTestId("local-preview-detail").getByRole("heading", { name: "Demo Plot 048-01" })).toBeVisible();
  await search.press("Escape");
  await page.screenshot({ path: resolve(screenshotDir, "selected-L048-refined-child.png"), fullPage: true });
  await search.fill("L-184");
  const l184Children = page.getByRole("button", { name: /Select Demo Plot 184-\d\d/ });
  await expect(l184Children).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Select Demo Plot 184", exact: true })).toHaveCount(0);
  await l184Children.first().click();
  await expect(page.getByTestId("local-preview-detail").getByRole("heading", { name: "Demo Plot 184-01" })).toBeVisible();
  await search.press("Escape");
  await page.screenshot({ path: resolve(screenshotDir, "selected-L184-child.png"), fullPage: true });
  await search.fill("L-235");
  const l235Children = page.getByRole("button", { name: /Select Demo Plot 235-\d\d/ });
  await expect(l235Children).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Select Demo Plot 235", exact: true })).toHaveCount(0);
  await l235Children.first().click();
  await expect(page.getByTestId("local-preview-detail").getByRole("heading", { name: "Demo Plot 235-01" })).toBeVisible();
  await search.press("Escape");
  await page.screenshot({ path: resolve(screenshotDir, "selected-L235-child.png"), fullPage: true });

  const addedSplitCounts: Array<[string, number]> = [
    ["365", 4], ["338", 4], ["337", 4], ["505", 6], ["504", 6],
    ["444", 3], ["506", 5], ["020", 3], ["011", 2],
  ];
  for (const [number, count] of addedSplitCounts) {
    await search.fill(`L-${number}`);
    const children = page.getByRole("button", { name: new RegExp(`Select Demo Plot ${number}-\\d{2}`) });
    await expect(children, `Expected ${count} selectable children for L-${number}`).toHaveCount(count);
    await expect(page.getByRole("button", { name: `Select Demo Plot ${number}`, exact: true })).toHaveCount(0);
    await children.first().click();
    const detail = page.getByTestId("local-preview-detail");
    await expect(detail.getByRole("heading", { name: `Demo Plot ${number}-01` })).toBeVisible();
    if (number === "505") {
      await detail.getByRole("button", { name: "Zoom to Demo Plot 505-01" }).click();
      await search.press("Escape");
      await page.screenshot({ path: resolve(screenshotDir, "selected-L505-standard-labels.png"), fullPage: true });
    }
  }

  for (const number of ["258", "363"]) {
    await search.fill(`L-${number}`);
    await expect(page.getByRole("button", { name: `Select Demo Plot ${number}`, exact: true })).toHaveCount(1);
  }

  await search.fill("L-155");
  const l155Children = page.getByRole("button", { name: /Select Demo Plot 155-\d\d/ });
  await expect(l155Children).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Select Demo Plot 155", exact: true })).toHaveCount(0);
  await l155Children.first().click();
  const details = page.getByTestId("local-preview-detail");
  await expect(details.getByRole("heading", { name: "Demo Plot 155-01" })).toBeVisible();
  const zoomToChild = details.getByRole("button", { name: "Zoom to Demo Plot 155-01" });
  await expect(zoomToChild).toBeVisible();
  await expect(details.getByText(/price|availability|pending|not confirmed|geometry exception/i)).toHaveCount(0);
  await zoomToChild.click();
  const mapLabelSizes = await page.locator('svg text[data-map-label="true"]').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("font-size")));
  expect(mapLabelSizes.length).toBeGreaterThan(0);
  expect(new Set(mapLabelSizes).size).toBe(1);
  await search.press("Escape");
  await expect(details).toBeVisible();
  await page.screenshot({ path: resolve(screenshotDir, "selected-applied-child.png"), fullPage: true });

  await search.fill("L-154");
  await expect(page.getByRole("button", { name: "Select Demo Plot 154", exact: true })).toHaveCount(1);
  const browserStorage = await page.evaluate(() => ({
    correction: localStorage.getItem("cw:hopkins-grove:map-review"),
    drafts: localStorage.getItem("wamule-correction-split-drafts-v1:isolated-test"),
  }));
  expect(browserStorage).toEqual({ correction: localDraftSentinel, drafts: localDraftSentinel });

  await page.reload();
  await expect(page.getByLabel("Hopkins Grove demo", { exact: true })).toHaveText("Demo");
  await expect(map.getByRole("option")).toHaveCount(expectedCount);
  await expect(page.getByRole("region", { name: "Details for Demo Plot 155-01" })).toBeVisible();
  await search.fill("L-505");
  await expect(page.getByRole("button", { name: /Select Demo Plot 505-\d\d/ })).toHaveCount(6);
  await search.fill("L-155");
  await expect(page.getByRole("button", { name: /Select Demo Plot 155-\d\d/ })).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Select Demo Plot 155", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => ({
    correction: localStorage.getItem("cw:hopkins-grove:map-review"),
    drafts: localStorage.getItem("wamule-correction-split-drafts-v1:isolated-test"),
  }))).toEqual({ correction: localDraftSentinel, drafts: localDraftSentinel });
  await search.press("Escape");
  await page.getByRole("region", { name: "Details for Demo Plot 155-01" }).getByRole("button", { name: "Zoom to Demo Plot 155-01" }).click();
  const reloadedLabelSizes = await page.locator('svg text[data-map-label="true"]').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("font-size")));
  expect(reloadedLabelSizes.length).toBeGreaterThan(0);
  expect(new Set(reloadedLabelSizes).size).toBe(1);
  await page.screenshot({ path: resolve(screenshotDir, "after-reload-applied.png"), fullPage: true });
});
