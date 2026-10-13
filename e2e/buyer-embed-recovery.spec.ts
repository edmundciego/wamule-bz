import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const PREVIEW_URL = "http://127.0.0.1:5176/embed/wamule";
const SCREENSHOTS = resolve(process.cwd(), "artifacts/buyer-experience-recovery");

test("real Wamule React embed stays usable and honest at desktop and phone sizes", async ({ page }) => {
  test.setTimeout(60000);
  mkdirSync(SCREENSHOTS, { recursive: true });
  const pageErrors: string[] = [];
  let apiSummary: null | {
    total: number;
    uniqueLots: number;
    available: number;
    mapped: number;
    withoutGeometry: number;
  } = null;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", async (response) => {
    if (!response.url().includes("get-public-lots")) return;
    try {
      const payload = await response.json();
      const parcels = payload.parcels ?? [];
      const lotNumbers = new Set(parcels.map((parcel: { lot_number?: string }) => parcel.lot_number));
      const mapped = parcels.filter((parcel: { map_polygon?: unknown }) =>
        Array.isArray(parcel.map_polygon) && parcel.map_polygon.length >= 3,
      ).length;
      apiSummary = {
        total: parcels.length,
        uniqueLots: lotNumbers.size,
        available: parcels.filter((parcel: { status?: string }) => parcel.status === "Available").length,
        mapped,
        withoutGeometry: parcels.length - mapped,
      };
    } catch {
      // The UI's accessible failure state is asserted below if the payload is unavailable.
    }
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(PREVIEW_URL);
  const map = page.locator('svg[aria-label="Interactive lot map"]');
  const mapFrame = page.getByTestId("candidate-map-viewport");
  await expect(map).toBeVisible();
  await expect(page.getByText("Proof of concept · sample data", { exact: true })).toBeVisible();
  await expect(page.getByText("Explore the development", { exact: true })).toBeVisible();
  await expect.poll(() => apiSummary).toEqual({
    total: 743,
    uniqueLots: 743,
    available: 743,
    mapped: 719,
    withoutGeometry: 24,
  });
  const desktopBounds = await mapFrame.boundingBox();
  expect(desktopBounds).not.toBeNull();
  expect(desktopBounds!.width).toBeGreaterThan(850);
  expect(desktopBounds!.height).toBeGreaterThan(700);
  const image = map.locator("image");
  await expect(image).toHaveAttribute("href", /masterplan-.*hopkins-grove-clean\.webp/);
  await expect.poll(() => map.getAttribute("viewBox")).toMatch(/^0 0 100 84\./);
  const imageBounds = await image.boundingBox();
  expect(imageBounds).not.toBeNull();
  expect(imageBounds!.width / desktopBounds!.width).toBeGreaterThan(0.88);
  expect(imageBounds!.height / desktopBounds!.height).toBeGreaterThan(0.88);
  const lotOptions = map.locator('[role="option"]');
  await expect(lotOptions).toHaveCount(719);
  const firstLot = lotOptions.first();
  const optionLabel = await firstLot.getAttribute("aria-label");
  const lotNumber = optionLabel?.match(/^Lot ([^,]+)/)?.[1];
  expect(lotNumber).toBeTruthy();

  const initialView = await map.getAttribute("viewBox");
  await firstLot.click({ force: true });
  const details = page.getByRole("region", { name: `Details for Lot ${lotNumber}` });
  await expect(details).toBeVisible();
  await expect(details).toContainText("sample");
  await expect(details).toContainText("not configured for this lot yet");
  await expect(map.locator("text")).toHaveText(lotNumber!);
  const selected = map.locator('[role="option"][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  const selectedOverlay = map.locator(`[data-lot-key="${await selected.getAttribute("data-lot-key")}"]`).first();
  await expect(selectedOverlay).toHaveAttribute("fill", "var(--lotmap-accent)");
  await page.screenshot({ path: resolve(SCREENSHOTS, "desktop-1440-selected.png"), animations: "disabled" });

  const selectedView = await map.getAttribute("viewBox");
  expect(selectedView).not.toBe(initialView);
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await expect(map).toHaveAttribute("viewBox", initialView!);
  await details.getByRole("button", { name: `Zoom to Lot ${lotNumber}` }).click();
  await expect.poll(() => map.getAttribute("viewBox")).not.toBe(initialView);
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await expect(map).toHaveAttribute("viewBox", initialView!);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(() => map.getAttribute("viewBox")).not.toBe(initialView);
  const zoomedView = await map.getAttribute("viewBox");
  const mapBounds = await map.boundingBox();
  expect(mapBounds).not.toBeNull();
  await page.mouse.move(mapBounds!.x + mapBounds!.width * 0.68, mapBounds!.y + mapBounds!.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(mapBounds!.x + mapBounds!.width * 0.54, mapBounds!.y + mapBounds!.height * 0.62, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => map.getAttribute("viewBox")).not.toBe(zoomedView);
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await expect(map).toHaveAttribute("viewBox", initialView!);

  const search = page.getByRole("textbox", { name: "Search lots" });
  await search.fill(lotNumber!);
  await page.getByRole("button", { name: new RegExp(`Show details for Lot ${lotNumber}`) }).click();
  await expect(details).toBeVisible();
  await details.getByRole("button", { name: `Close details for Lot ${lotNumber}` }).click();
  await expect(page.getByRole("region", { name: "No lot selected" })).toBeVisible();
  await page.getByRole("button", { name: "Reported available only, sample data" }).click();
  await expect(lotOptions).toHaveCount(1);
  await search.fill("");
  await expect(lotOptions).toHaveCount(719);
  await page.getByRole("button", { name: "All Lots" }).click();
  await page.getByRole("button", { name: "Tier colours" }).click();
  await expect(page.getByRole("group", { name: "Colour view" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  apiSummary = null;
  await page.goto(`${PREVIEW_URL}?view=status`);
  await expect.poll(() => apiSummary, { timeout: 30000 }).toEqual({
    total: 743,
    uniqueLots: 743,
    available: 743,
    mapped: 719,
    withoutGeometry: 24,
  });
  await expect(page.getByText("Proof of concept · sample data", { exact: true })).toBeVisible();
  await expect(mapFrame).toBeVisible();
  await expect.poll(() => map.getAttribute("viewBox")).toMatch(/^0 0 100 84\./);
  const phoneBounds = await mapFrame.boundingBox();
  expect(phoneBounds).not.toBeNull();
  expect(phoneBounds!.width).toBeGreaterThan(380);
  expect(phoneBounds!.height).toBeGreaterThan(280);
  const phoneImageBounds = await map.locator("image").boundingBox();
  expect(phoneImageBounds).not.toBeNull();
  expect(phoneImageBounds!.width / phoneBounds!.width).toBeGreaterThan(0.88);
  expect(phoneImageBounds!.height / phoneBounds!.height).toBeGreaterThan(0.88);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await map.locator('[role="option"]').first().click({ force: true });
  await expect(page.getByRole("region", { name: /Details for Lot/ })).toBeVisible();
  await page.screenshot({ path: resolve(SCREENSHOTS, "mobile-390-selected.png"), animations: "disabled" });

  await page.setViewportSize({ width: 320, height: 780 });
  await expect(mapFrame).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  await expect(zoomIn).toBeVisible();
  const zoomBounds = await zoomIn.boundingBox();
  expect(zoomBounds?.width).toBeGreaterThanOrEqual(44);
  expect(zoomBounds?.height).toBeGreaterThanOrEqual(44);
  const narrowBounds = await mapFrame.boundingBox();
  expect(narrowBounds).not.toBeNull();
  expect(narrowBounds!.width).toBeGreaterThanOrEqual(320);
  await page.screenshot({ path: resolve(SCREENSHOTS, "narrow-320-selected.png"), animations: "disabled" });
  expect(pageErrors).toEqual([]);
});
