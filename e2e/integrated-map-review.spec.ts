import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const REVIEW_URL = "/lots/correct?demo=1&mode=labels";
const HOPKINS_REVIEW_ASSETS_AVAILABLE =
  existsSync("out/hopkins-ocr/lots.json") &&
  existsSync("out/hopkins-ocr/masterplan_background.webp") &&
  existsSync("out/hopkins-lot-number-benchmark-v1/benchmark-manifest.json");

async function findSelectablePoint(page: import("@playwright/test").Page, label: string): Promise<{ x: number; y: number }> {
  const point = await page.evaluate((targetLabel) => {
    const target = [...document.querySelectorAll<SVGPolygonElement>("g[role='listbox'] polygon[role='option']")]
      .find((polygon) => polygon.getAttribute("aria-label")?.startsWith(targetLabel));
    const svg = target?.ownerSVGElement;
    const matrix = svg?.getScreenCTM();
    if (!target || !svg || !matrix) return null;
    const vertices = (target.getAttribute("points") ?? "").trim().split(/\s+/).map((pair) => pair.split(",").map(Number));
    const xs = vertices.map(([x]) => x); const ys = vertices.map(([, y]) => y);
    const minX = Math.min(...xs); const maxX = Math.max(...xs);
    const minY = Math.min(...ys); const maxY = Math.max(...ys);
    const contains = (x: number, y: number) => {
      let inside = false;
      for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
        const [xi, yi] = vertices[i]; const [xj, yj] = vertices[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    for (let gy = 1; gy < 40; gy += 1) {
      for (let gx = 1; gx < 40; gx += 1) {
        const mapX = minX + (maxX - minX) * gx / 40;
        const mapY = minY + (maxY - minY) * gy / 40;
        if (!contains(mapX, mapY)) continue;
        const screen = new DOMPoint(mapX, mapY).matrixTransform(matrix);
        const ids = [...new Set(document.elementsFromPoint(screen.x, screen.y)
          .map((element) => element.closest("[data-lot-key]")?.getAttribute("data-lot-key"))
          .filter((id): id is string => Boolean(id)))];
        const winner = ids.map((id) => {
          const hit = svg.querySelector(`polygon[data-lot-key="${id}"]`);
          const box = hit?.getBBox();
          return { id, area: box ? box.width * box.height : Infinity };
        }).sort((a, b) => a.area - b.area)[0];
        if (winner?.id === target.getAttribute("data-lot-key")) return { x: screen.x, y: screen.y };
      }
    }
    return null;
  }, label);
  if (!point) throw new Error(`No interior point resolves to ${label} after map zoom`);
  return point;
}

async function clickSourceCoordinate(page: import("@playwright/test").Page, x: number, y: number): Promise<void> {
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

test.beforeEach(async ({ page }) => {
  test.skip(!HOPKINS_REVIEW_ASSETS_AVAILABLE, "Optional real-Hopkins verification requires the private local review artifacts.");
  await page.addInitScript(() => {
    if (sessionStorage.getItem("integrated-map-review-reset") !== "yes") {
      localStorage.clear();
      sessionStorage.setItem("integrated-map-review-reset", "yes");
    }
  });
  await page.goto(REVIEW_URL);
  await expect(page.getByRole("heading", { name: "Hopkins Grove map review" })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole("progressbar", { name: "Recorded benchmark decisions" })).toBeVisible({ timeout: 30000 });
});

test("full Hopkins map, benchmark target crop, decision resume, and geometry correction use shared map coordinates", async ({ page }) => {
  await expect(page.locator("svg[aria-label='Interactive correction map']")).toBeVisible();
  await expect(page.locator("[data-testid='source-polygon-crop']")).toHaveCount(0);
  await expect(page.locator("g[role='listbox'] polygon[role='option']")).toHaveCount(719);

  const source = await page.locator("svg[aria-label='Interactive correction map'] image").getAttribute("href");
  expect(source).toContain("/correction-review/hopkins/map/masterplan_background.webp");
  const dimensions = await page.evaluate(async (url) => {
    const image = new Image();
    image.src = url!;
    await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  }, source);
  expect(dimensions).toEqual([5700, 4800]);

  const map = page.locator("svg[aria-label='Interactive correction map']");
  const initialViewBox = await map.getAttribute("viewBox");
  await page.getByRole("button", { name: "Zoom in" }).click();
  const zoomedViewBox = await map.getAttribute("viewBox");
  expect(zoomedViewBox).not.toBe(initialViewBox);
  const mapBox = await map.boundingBox();
  expect(mapBox).not.toBeNull();
  await page.mouse.move(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(mapBox!.x + mapBox!.width / 2 + 60, mapBox!.y + mapBox!.height / 2 + 30, { steps: 4 });
  await page.mouse.up();
  expect(await map.getAttribute("viewBox")).not.toBe(zoomedViewBox);
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await expect(map).toHaveAttribute("viewBox", initialViewBox!);

  await page.getByRole("button", { name: "Open current target", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Case S001" })).toBeVisible();
  await page.getByRole("button", { name: "Clear map selection" }).click();
  const targetPoint = await findSelectablePoint(page, "Detected polygon L-064");
  await page.mouse.click(targetPoint.x, targetPoint.y);
  await expect(page.getByRole("heading", { name: "Case S001" })).toBeVisible();
  await expect(page.getByText("L-064", { exact: true })).toBeVisible();
  await expect(page.locator("[data-testid='source-polygon-crop'] polygon")).toHaveCount(2);
  await expect(page.getByText(/OCR\/AI guess is shown/i)).toBeVisible();

  await page.getByLabel("Reviewer").fill("Map review QA");
  await page.getByLabel("Printed lot number · digits only").fill("123");
  await page.getByRole("button", { name: "Confirm printed number" }).click();
  await expect(page.getByRole("heading", { name: "Case S002" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Recorded benchmark decisions" })).toHaveAttribute("aria-valuenow", "1");
  const numberInput = page.getByLabel("Printed lot number · digits only");
  await numberInput.fill("123");
  await expect(page.getByRole("alert")).toContainText("already recorded for L-064");
  await numberInput.fill("");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Case S002" })).toBeVisible();
  await expect(page.getByText("1 / 60 decisions recorded")).toBeVisible();
  await page.getByRole("button", { name: "Open current target", exact: true }).click();

  await page.getByRole("button", { name: "Flag geometry issue" }).click();
  await page.getByRole("button", { name: "Adjust boundary" }).click();
  const vertex = page.getByRole("slider", { name: "Move boundary point 1" });
  await expect(vertex).toBeVisible();
  await vertex.press("ArrowRight");
  await page.getByRole("button", { name: "Save boundary preview" }).click();
  await expect(page.getByText(/Boundary correction saved to the local correction draft/)).toBeVisible();
  const correctionDraft = await page.evaluate(() => JSON.parse(localStorage.getItem("cw:hopkins-grove:map-review") || "null"));
  expect(correctionDraft.log.some((entry: { field: string }) => entry.field === "polygon")).toBe(true);
  const editedPolygon = correctionDraft.lots["L-365"].polygon;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Case S002" })).toBeVisible();
  const restoredCorrectionDraft = await page.evaluate(() => JSON.parse(localStorage.getItem("cw:hopkins-grove:map-review") || "null"));
  expect(restoredCorrectionDraft.lots["L-365"].polygon).toEqual(editedPolygon);
  expect(restoredCorrectionDraft.log.some((entry: { field: string }) => entry.field === "polygon")).toBe(true);

  const [jsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export review JSON" }).click(),
  ]);
  expect(jsonDownload.suggestedFilename()).toBe("hopkins-grove-lot-number-ground-truth-v1.json");
  const exported = JSON.parse(await readFile((await jsonDownload.path())!, "utf8"));
  expect(exported.benchmark_manifest_sha256).toBeTruthy();
  expect(exported.cases).toHaveLength(60);
  expect(exported.cases[0].original_polygon_pct).toEqual(exported.cases[0].polygon_pct);
  expect(exported.cases[0].reviewer).toBe("Map review QA");
  expect(exported.cases[0].printed_number).toBe("123");
  expect(exported.geometry_issues[0].correction_history[0].field).toBe("polygon");

  const [csvDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export scorer CSV" }).click(),
  ]);
  expect(csvDownload.suggestedFilename()).toBe("hopkins-grove-labels.csv");
  expect(await readFile((await csvDownload.path())!, "utf8")).toContain("id,printed_number,printed_area_sqm,ambiguous,unreadable,skipped,reviewer,reviewed_at");

  await page.getByLabel("Search detected polygons by reference").fill("L-064");
  await page.getByRole("button", { name: "Select detected polygon L-064" }).click();
  await expect(page.getByRole("heading", { name: "Case S001" })).toBeVisible();
});

test("review controls remain usable at narrow mobile width without horizontal page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.locator("svg[aria-label='Interactive correction map']")).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    mapWidth: document.querySelector(".correction-review-map")?.getBoundingClientRect().width ?? 0,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  expect(dimensions.mapWidth).toBeGreaterThan(300);
  await page.getByRole("button", { name: /Open current target/ }).click();
  await expect(page.locator("[data-testid='source-polygon-crop']")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm printed number" })).toBeVisible();
});

test("actual Hopkins L-683 can be traced into four separate local child proposals without changing S019 benchmark geometry", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator("g[role='listbox'] polygon[role='option']")).toHaveCount(719);
  const target = await findSelectablePoint(page, "Detected polygon L-683");
  await page.mouse.click(target.x, target.y);
  await expect(page.getByRole("heading", { name: "Case S019" })).toBeVisible();
  await expect(page.locator("[data-testid='source-polygon-crop']")).toBeVisible();
  const splitButton = page.getByRole("button", { name: "Split Polygon", exact: true });
  await expect(splitButton).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("hopkins-l683-split-button-qa.png"), fullPage: false });
  await splitButton.click();
  await expect(page.getByRole("heading", { name: "Split Mode · L-683" })).toBeVisible();
  await expect(page.getByTestId("polygon-split-mode").getByRole("heading", { name: "Split Mode" })).toBeInViewport();
  await expect(page.getByText(/Tap or click each visible corner/)).toBeVisible();
  await expect(page.locator("[aria-label='Split Mode'] ol li")).toHaveCount(5);
  await expect(page.getByTestId("split-drawn-progress")).toContainText("0 polygons drawn");
  await expect(page.getByRole("button", { name: "Preview split" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Confirm Split" })).toBeDisabled();
  await page.getByLabel("Reviewer").fill("");
  await expect(page.getByRole("alert", { name: "Split validation guidance" })).toContainText("Trace at least two child outlines");
  await expect(page.getByTestId("split-confirm-blockers")).toContainText("Enter your name in the Reviewer field");
  await expect(page.getByTestId("split-confirm-blockers")).toContainText("Add a short note explaining why this detection needs to be split");
  await page.screenshot({ path: testInfo.outputPath("hopkins-l683-split-mode-instructions-qa.png"), fullPage: false });
  await page.getByLabel("Reviewer").fill("Local geometry QA · not ground truth");
  await page.getByLabel("Why should this detection be split?").fill("One auto-detected boundary spans four separately outlined printed parcels; trace requires human review.");

  // Exercise an invalid trace through the displayed map and controls. The
  // finish action must explain the crossing and remain unavailable.
  for (const [x, y] of [[90.7, 78.6], [94.2, 88.1], [94, 80], [90.7, 88]]) {
    await clickSourceCoordinate(page, x, y);
  }
  await expect(page.getByTestId("split-active-child-state")).toHaveAttribute("data-state", "needs-correction");
  await expect(page.getByRole("button", { name: "Finish Polygon" })).toBeDisabled();
  await expect(page.getByRole("alert", { name: "Split validation guidance" })).toContainText("crosses itself");
  await expect(page.getByTestId("split-confirm-blockers")).toContainText("The outline crosses itself");
  await page.screenshot({ path: testInfo.outputPath("hopkins-l683-invalid-outline-guidance-qa.png"), fullPage: false });
  await page.getByRole("button", { name: "Cancel Split" }).click();
  await page.getByRole("button", { name: "Split Polygon", exact: true }).click();

  const sourcePoints = [
    [[39, 70], [209, 181], [198, 252], [45, 230]],
    [[45, 230], [198, 252], [207, 331], [36, 307]],
    [[36, 307], [207, 331], [218, 419], [26, 395]],
    [[26, 395], [218, 419], [235, 524], [11, 494]],
  ];
  for (const [index, child] of sourcePoints.entries()) {
    if (index > 0) await page.getByRole("button", { name: "Start Next Polygon" }).click();
    for (const [x, y] of child) {
      await clickSourceCoordinate(page, (5150 + x) / 57, (3720 + y) / 48);
    }
    await page.getByRole("button", { name: "Finish Polygon" }).click();
    const childState = page.getByTestId("split-child-states").locator("li").nth(index);
    await expect(childState).toContainText(`Child ${index + 1} ·`);
    await expect(childState).not.toContainText("Editing");
    expect(["completed", "needs-correction"]).toContain(await childState.getAttribute("data-child-state"));
    await expect(page.getByTestId("split-action-feedback")).toContainText(`Choose Start Next Polygon`);
    if (index === 0) await page.screenshot({ path: testInfo.outputPath("hopkins-l683-child-1-finished-qa.png"), fullPage: false });
  }
  await expect(page.getByTestId("split-drawn-progress")).toContainText("4 polygons drawn");
  await expect(page.getByRole("button", { name: "Edit Child 1" })).toBeVisible();
  await page.getByRole("button", { name: "Edit Child 1" }).click();
  const editedChild = page.getByTestId("split-child-states").locator("li").first();
  await expect(editedChild).toContainText("Child 1 · Editing");
  await page.getByRole("button", { name: "Cancel adjustment" }).click();
  await expect(editedChild).not.toContainText("Editing");
  await expect(page.getByRole("button", { name: "Preview split" })).toBeEnabled();
  const gapAcknowledgement = page.getByLabel("I checked the uncovered area and all child-boundary warnings against the source.");
  if (await gapAcknowledgement.count()) {
    await expect(page.getByRole("button", { name: "Confirm Split" })).toBeDisabled();
    await expect(page.getByTestId("split-confirm-blockers")).toContainText("Inspect the uncovered parent area and each child-boundary warning");
    await expect(page.getByTestId("split-confirm-blockers")).toContainText("check the acknowledgment box");
  }
  if (await gapAcknowledgement.count()) await gapAcknowledgement.check();
  await page.getByRole("button", { name: "Preview split" }).click();
  await expect(page.getByTestId("split-drawn-progress")).toContainText("Preview is ready");
  await expect(page.getByRole("button", { name: "Confirm Split" })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("hopkins-l683-after-split-preview-qa.png"), fullPage: false });
  await page.getByRole("button", { name: "Confirm Split" }).click();

  await expect(page.getByRole("option", { name: /Draft child 1 · not canonical/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Draft child 4 · not canonical/ })).toBeVisible();
  await expect(page.locator("g[role='listbox'] polygon[role='option']")).toHaveCount(722);
  await expect(page.locator("[data-testid='source-polygon-crop']")).toBeVisible();
  await expect(page.getByTestId("split-child-next-steps")).toContainText(/To review the next plot, tap its outlined child on the map/);
  await expect(page.getByTestId("split-child-next-steps")).toBeInViewport();

  const [jsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export review JSON" }).click(),
  ]);
  const exported = JSON.parse(await readFile((await jsonDownload.path())!, "utf8"));
  const originalCase = exported.cases.find((item: { id: string }) => item.id === "S019");
  expect(originalCase.original_polygon_pct).toEqual(originalCase.polygon_pct);
  expect(originalCase.status).toBe("pending");
  expect(exported.geometry_issues).toContainEqual(expect.objectContaining({ correction_key: "L-683" }));
  expect(exported.proposed_polygon_splits[0].children).toHaveLength(4);
  expect(exported.proposed_polygon_splits[0].parent_polygon_pct).toEqual(originalCase.polygon_pct);
  expect(exported.proposed_polygon_splits[0].source_image_sha256).toBe(exported.source_image.sha256);

  await page.getByRole("button", { name: "Undo split · restore parent" }).click();
  await expect(page.getByRole("option", { name: /Detected polygon L-683, Geometry issue/ })).toBeVisible();
  await expect(page.locator("g[role='listbox'] polygon[role='option']")).toHaveCount(719);
});

test("capture desktop and mobile editor review checkpoints (QA-only test data)", async ({ page }, testInfo) => {
  const screenshot = (name: string) => testInfo.outputPath(`hopkins-${name}.png`);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: screenshot("desktop-overview"), fullPage: true });

  await page.getByRole("button", { name: "Open current target", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Case S001" })).toBeVisible();
  await page.screenshot({ path: screenshot("desktop-selected"), fullPage: true });

  await page.evaluate(() => {
    const badge = document.createElement("div");
    badge.textContent = "VISUAL QA ONLY · test state, not human ground truth";
    Object.assign(badge.style, { position: "fixed", zIndex: "99999", left: "50%", top: "8px", transform: "translateX(-50%)", background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: "6px", font: "600 12px system-ui", boxShadow: "0 2px 10px #0005" });
    document.body.append(badge);
  });
  await page.getByLabel("Reviewer").fill("QA automation · not ground truth");
  await page.getByRole("button", { name: "Ambiguous" }).click();
  await expect(page.getByText("1 / 60 decisions recorded")).toBeVisible();
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await page.screenshot({ path: screenshot("desktop-progress-qa-only"), fullPage: true });

  await page.getByRole("button", { name: "Flag geometry issue" }).click();
  await page.getByRole("button", { name: "Adjust boundary" }).click();
  await expect(page.getByRole("slider", { name: "Move boundary point 1" })).toBeVisible();
  await page.getByText(/Geometry issue flagged/).scrollIntoViewIfNeeded();
  await expect(page.getByText(/Geometry issue flagged/)).toBeVisible();
  await page.screenshot({ path: screenshot("desktop-geometry-qa-only") });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Discard preview" }).click();
  await page.screenshot({ path: screenshot("mobile-390-overview"), fullPage: true });
  await page.getByRole("button", { name: /Next unresolved/ }).click();
  await page.screenshot({ path: screenshot("mobile-390-selected"), fullPage: true });

  await page.setViewportSize({ width: 320, height: 800 });
  await page.screenshot({ path: screenshot("mobile-320-selected"), fullPage: true });
});
