import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function expectNativePixel(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThan(1.5);
}

test("road review verifies its source and maps responsive canvas clicks to native pixels", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The coordinate/export contract is exercised once in Chromium.");
  const tempRoot = mkdtempSync(join(tmpdir(), "road-tool-e2e-"));
  const imagePath = join(tempRoot, "source.webp");
  const pagePath = join(tempRoot, "measure-roads.html");
  const exportedPath = join(tempRoot, "road-measurements.json");

  try {
    execFileSync("python3", ["-c", "from PIL import Image; import sys; Image.new('RGB', (600, 400), '#557766').save(sys.argv[1], 'WEBP')", imagePath]);
    execFileSync("python3", [
      "scripts/build-road-measurement-tool.py",
      "--image", imagePath,
      "--out", pagePath,
    ], { cwd: process.cwd(), encoding: "utf8" });
    const html = readFileSync(pagePath, "utf8");
    await page.route("**/review/measure-roads.html", (route) => route.fulfill({ body: html, contentType: "text/html" }));
    await page.route("**/review/source.webp", (route) => route.fulfill({ path: imagePath, contentType: "image/webp" }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/review/measure-roads.html");
    await expect(page.locator("#source-status")).toContainText("Source verified");

    const canvas = page.locator("#canvas");
    const clickSegment = async (x1: number, y1: number, x2: number, y2: number) => {
      await canvas.evaluate((element, fractions) => {
        const target = element as HTMLCanvasElement;
        const clickAt = (x: number, y: number) => {
          const rect = target.getBoundingClientRect();
          target.dispatchEvent(new MouseEvent("click", {
            bubbles: true,
            clientX: rect.left + target.clientLeft + target.clientWidth * x,
            clientY: rect.top + target.clientTop + target.clientHeight * y,
          }));
        };
        clickAt(fractions.x1, fractions.y1);
        clickAt(fractions.x2, fractions.y2);
      }, { x1, y1, x2, y2 });
    };

    await clickSegment(0.1, 0.2, 0.9, 0.2);
    expect(await page.locator("#results tr").count()).toBe(1);
    await clickSegment(0.1, 0.2, 0.9, 0.2);
    await expect(page.locator("#results tr")).toHaveCount(1);
    await expect(page.locator("#source-status")).toContainText("duplicates an existing click pair");
    expect(await page.locator("#results tr").count()).toBe(1);

    await page.getByRole("button", { name: "40 ft · held-out check" }).click();
    await clickSegment(0.5, 0.1, 0.5, 0.9);
    expect(await page.locator("#results tr").count()).toBe(2);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export raw clicks" }).click();
    const download = await downloadPromise;
    await download.saveAs(exportedPath);
    const data = JSON.parse(readFileSync(exportedPath, "utf8")) as {
      roads: Array<{ stated: number; p1: { x: number; y: number }; p2: { x: number; y: number }; width: number }>;
      imageSize: number[];
      imageSha256: string;
    };
    expect(data.imageSize).toEqual([600, 400]);
    expect(data.imageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(data.roads).toHaveLength(2);
    expect(data.roads[0].stated).toBe(60);
    expectNativePixel(data.roads[0].p1.x, 60);
    expectNativePixel(data.roads[0].p1.y, 80);
    expectNativePixel(data.roads[0].p2.x, 540);
    expectNativePixel(data.roads[0].p2.y, 80);
    expect(data.roads[1].stated).toBe(40);
    expectNativePixel(data.roads[1].p1.x, 300);
    expectNativePixel(data.roads[1].p1.y, 40);
    expectNativePixel(data.roads[1].p2.x, 300);
    expectNativePixel(data.roads[1].p2.y, 360);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("road review disables clicks when an image changes without changing dimensions", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The source-fingerprint contract is exercised once in Chromium.");
  const tempRoot = mkdtempSync(join(tmpdir(), "road-tool-hash-e2e-"));
  const imagePath = join(tempRoot, "source.webp");
  const mismatchPath = join(tempRoot, "mismatch.webp");
  const pagePath = join(tempRoot, "measure-roads.html");
  execFileSync("python3", ["-c", "from PIL import Image; import sys; Image.new('RGB', (600, 400), '#557766').save(sys.argv[1], 'WEBP')", imagePath]);
  execFileSync("python3", ["-c", "from PIL import Image; import sys; Image.new('RGB', (600, 400), '#eee').save(sys.argv[1], 'WEBP')", mismatchPath]);

  try {
    execFileSync("python3", [
      "scripts/build-road-measurement-tool.py",
      "--image", imagePath,
      "--out", pagePath,
    ], { cwd: process.cwd(), encoding: "utf8" });
    const html = readFileSync(pagePath, "utf8");
    await page.route("**/review/measure-roads.html", (route) => route.fulfill({ body: html, contentType: "text/html" }));
    await page.route("**/review/source.webp", (route) => route.fulfill({ path: mismatchPath, contentType: "image/webp" }));
    await page.goto("/review/measure-roads.html");
    await expect(page.locator("#source-status")).toContainText("fingerprint changed");
    await expect(page.getByRole("button", { name: "Export raw clicks" })).toBeDisabled();
    await expect(page.locator("#canvas")).toHaveAttribute("aria-disabled", "true");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
