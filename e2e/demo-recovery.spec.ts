import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const DEMO_URL = "/embed/demo?demo=hopkins";
const SCREENSHOTS = resolve(process.cwd(), "artifacts/demo-recovery");

test("Hopkins buyer preview frames the source plat and supports the lot journey at phone sizes", async ({ page }, testInfo) => {
  mkdirSync(SCREENSHOTS, { recursive: true });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(DEMO_URL);
  const map = page.getByRole("group", { name: "Interactive lot map" });
  const options = map.getByRole("option");
  await expect.poll(() => options.count(), { timeout: 30000 }).toBe(719);
  await expect(page.getByText("Hopkins Grove", { exact: true })).toBeVisible();
  await expect(page.getByText("Proof of concept, sample data", { exact: true })).toBeVisible();
  await expect(page.getByText("traced from sales plat", { exact: true })).toBeVisible();
  await expect(page.getByText("Candidate outline · review pending", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "No lot selected" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Colour view" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Lot filter" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Inquire About Lot|Join Waitlist/ })).toHaveCount(0);

  const mapFrame = page.getByTestId("candidate-map-viewport");
  const desktopBounds = await mapFrame.boundingBox();
  expect(desktopBounds).not.toBeNull();
  expect(desktopBounds!.width).toBeGreaterThan(700);
  expect(desktopBounds!.height).toBeGreaterThan(520);
  const image = page.locator('svg[role="group"] image');
  await expect(image).toHaveAttribute("href", /demo-hopkins-map\/masterplan_background\.webp/);
  const desktopImageBounds = await image.boundingBox();
  expect(desktopImageBounds).not.toBeNull();
  expect(desktopImageBounds!.width / desktopBounds!.width).toBeGreaterThan(0.88);
  expect(desktopImageBounds!.height / desktopBounds!.height).toBeGreaterThan(0.88);
  if (testInfo.project.name === "chromium") {
    await page.screenshot({ path: resolve(SCREENSHOTS, "desktop-1440.png"), animations: "disabled" });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const initialPhoneView = await map.getAttribute("viewBox");
  if (testInfo.project.name === "mobile") await options.first().tap({ force: true });
  else await options.first().click({ force: true });
  const chosenOption = map.locator('[role="option"][aria-selected="true"]');
  await expect(chosenOption).toHaveCount(1);
  const selectedLabel = await chosenOption.getAttribute("aria-label");
  const lotNumber = selectedLabel?.match(/^Lot ([^,]+)/)?.[1];
  expect(lotNumber).toBeTruthy();
  const details = page.getByRole("region", { name: `Details for Lot ${lotNumber}` });
  await expect(details).toBeVisible();
  await expect.poll(() => map.getAttribute("viewBox")).not.toBe(initialPhoneView);
  await expect(details.getByText("Review pending", { exact: true })).toBeVisible();
  await expect(details).toContainText("Plan price");
  await expect(details).toContainText("sample");
  await expect(details).toContainText("Not published");
  const phoneBounds = await mapFrame.boundingBox();
  expect(phoneBounds).not.toBeNull();
  expect(phoneBounds!.width).toBeGreaterThan(360);
  expect(phoneBounds!.height).toBeGreaterThan(250);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  if (testInfo.project.name === "chromium") {
    await page.screenshot({ path: resolve(SCREENSHOTS, "mobile-390-selected.png"), animations: "disabled" });
  }

  const selectedView = await map.getAttribute("viewBox");
  const selectedMapBounds = await map.boundingBox();
  expect(selectedMapBounds).not.toBeNull();
  await page.mouse.move(selectedMapBounds!.x + selectedMapBounds!.width * 0.65, selectedMapBounds!.y + selectedMapBounds!.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(selectedMapBounds!.x + selectedMapBounds!.width * 0.52, selectedMapBounds!.y + selectedMapBounds!.height * 0.62, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => map.getAttribute("viewBox")).not.toBe(selectedView);
  const pannedView = await map.getAttribute("viewBox");
  await details.getByRole("button", { name: `Zoom to Lot ${lotNumber}` }).click();
  await expect.poll(() => map.getAttribute("viewBox")).not.toBe(pannedView);
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await expect.poll(() => map.getAttribute("viewBox")).toBe(initialPhoneView);
  await details.getByRole("button", { name: `Close details for Lot ${lotNumber}` }).click();
  await expect(page.getByRole("region", { name: "No lot selected" })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("lot")).toBe(false);

  const mapBounds = await map.boundingBox();
  expect(mapBounds).not.toBeNull();
  await page.getByRole("button", { name: "Zoom in" }).click();
  const zoomedView = await map.getAttribute("viewBox");
  await page.mouse.move(mapBounds!.x + mapBounds!.width * 0.65, mapBounds!.y + mapBounds!.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(mapBounds!.x + mapBounds!.width * 0.52, mapBounds!.y + mapBounds!.height * 0.62, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => map.getAttribute("viewBox")).not.toBe(zoomedView);

  await page.getByRole("button", { name: "Reset zoom" }).click();
  await page.setViewportSize({ width: 320, height: 780 });
  await expect(page.getByTestId("candidate-map-viewport")).toBeVisible();
  await expect(page.getByRole("region", { name: "No lot selected" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const narrowBounds = await mapFrame.boundingBox();
  expect(narrowBounds).not.toBeNull();
  expect(narrowBounds!.width).toBeGreaterThanOrEqual(320);
  if (testInfo.project.name === "chromium") {
    await page.screenshot({ path: resolve(SCREENSHOTS, "narrow-320.png"), animations: "disabled" });
  }

  expect(pageErrors).toEqual([]);
});
