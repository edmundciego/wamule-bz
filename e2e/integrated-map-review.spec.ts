import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const REVIEW_URL = "/lots/correct?demo=1&mode=labels";

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

test.beforeEach(async ({ page }) => {
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

test("capture desktop and mobile editor review checkpoints (QA-only test data)", async ({ page }) => {
  const base = "artifacts/persistent-lot-labels-review/integrated-map";
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: `${base}-desktop-overview.png`, fullPage: true });

  await page.getByRole("button", { name: "Open current target", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Case S001" })).toBeVisible();
  await page.screenshot({ path: `${base}-desktop-selected.png`, fullPage: true });

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
  await page.screenshot({ path: `${base}-desktop-progress-qa-only.png`, fullPage: true });

  await page.getByRole("button", { name: "Flag geometry issue" }).click();
  await page.getByRole("button", { name: "Adjust boundary" }).click();
  await expect(page.getByRole("slider", { name: "Move boundary point 1" })).toBeVisible();
  await page.getByText(/Geometry issue flagged/).scrollIntoViewIfNeeded();
  await expect(page.getByText(/Geometry issue flagged/)).toBeVisible();
  await page.screenshot({ path: `${base}-desktop-geometry-qa-only.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Discard preview" }).click();
  await page.screenshot({ path: `${base}-mobile-390-overview.png`, fullPage: true });
  await page.getByRole("button", { name: /Next unresolved/ }).click();
  await page.screenshot({ path: `${base}-mobile-390-selected.png`, fullPage: true });

  await page.setViewportSize({ width: 320, height: 800 });
  await page.screenshot({ path: `${base}-mobile-320-selected.png`, fullPage: true });
});
