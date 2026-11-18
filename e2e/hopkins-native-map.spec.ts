import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const localDataDir = resolve(process.env.CORRECTION_DATA_DIR ?? "out/hopkins-ocr");
const lotsPath = resolve(localDataDir, "lots.json");
const sourcePath = resolve(localDataDir, "masterplan_background.webp");
const previewKey = "wamule-local-map-preview-v1:hopkins-grove:map-review:default";

test("actual Hopkins native map loads source geometry, selects L-049, and retains pending state on reload", async ({ page }, testInfo) => {
  test.skip(!existsSync(lotsPath) || !existsSync(sourcePath), "Private local Hopkins source imagery and polygon data are not available.");
  const lots = JSON.parse(await readFile(lotsPath, "utf8")) as Array<{ lot_number: string; polygon_pct: unknown[] }>;
  expect(lots).toHaveLength(719);
  const parent = lots.find((lot) => lot.lot_number === "L-049");
  expect(parent?.polygon_pct.length).toBeGreaterThanOrEqual(3);

  const origin = process.env.HOPKINS_NATIVE_PREVIEW_ORIGIN ?? "http://127.0.0.1:5321";
  const url = `${origin}/embed/hopkins-grove/map-review?demo=hopkins&preview=local&phase=default`;
  const sourceResponse = page.waitForResponse((response) => response.url().includes("/demo-hopkins-map/masterplan_background.webp"));
  await page.goto(url);
  const imageResponse = await sourceResponse;
  expect(imageResponse.ok()).toBeTruthy();
  await expect(page.getByLabel("Local preview only; not published")).toBeVisible();
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zoom out" })).toBeVisible();

  const imageInfo = await page.locator('[data-testid="candidate-map-viewport"] svg image').evaluate((image: SVGImageElement) => {
    const probe = new Image();
    probe.src = image.href.baseVal;
    return new Promise<{ href: string; width: number; height: number }>((resolve, reject) => {
      probe.onload = () => resolve({ href: image.href.baseVal, width: probe.naturalWidth, height: probe.naturalHeight });
      probe.onerror = () => reject(new Error("Hopkins source image failed to decode."));
    });
  });
  expect(imageInfo.href).toContain("/demo-hopkins-map/masterplan_background.webp");
  expect(imageInfo.width).toBe(5700);
  expect(imageInfo.height).toBe(4800);
  await expect(page.getByRole("listbox", { name: "Detected polygons on the map" }).getByRole("option")).toHaveCount(719);

  await page.screenshot({ path: testInfo.outputPath("hopkins-native-map-before-reviewed-correction.png"), fullPage: true });
  const search = page.getByRole("textbox", { name: "Search detected polygons by reference" });
  await search.fill("L-049");
  await page.getByRole("button", { name: /Show details for detection L-049/ }).click();
  await expect(page.getByRole("region", { name: "Details for detection L-049" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Details for detection L-049" }).getByText("Review pending", { exact: true })).toBeVisible();
  await expect(page.getByText("Detection reference · not an official lot number")).toBeVisible();
  await expect(page.locator('svg text').filter({ hasText: "L-049" })).toHaveCount(0);
  await search.press("Escape");
  await expect(page.getByRole("region", { name: "Details for detection L-049" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("hopkins-native-map-selected-l049.png"), fullPage: true });

  const initialStore = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), previewKey);
  expect(initialStore?.approved_splits ?? []).toHaveLength(0);
  await page.reload();
  await expect(page.getByLabel("Local preview only; not published")).toBeVisible();
  await search.fill("L-049");
  await page.getByRole("button", { name: /Show details for detection L-049/ }).click();
  await expect(page.getByRole("region", { name: "Details for detection L-049" })).toBeVisible();
  const persistedStore = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), previewKey);
  expect(persistedStore?.approved_splits ?? []).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("hopkins-native-map-after-reload-pending.png"), fullPage: true });
});
