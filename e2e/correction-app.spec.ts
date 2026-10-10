import { expect, test } from "@playwright/test";

// Slice 1.5 workspace inside the admin app (/lots/correct). DEV-only
// ?demo=1 serves the committed correction fixture (mirrors EmbeddableMapPage's
// demo contract; eliminated from production bundles). Without demo the page
// enforces session + admin profile and lands on /login.

const URL = "/lots/correct?demo=1";
const queueRow = (lot: string) => `[aria-label="Uncertain-first lot queue"] button:has-text("${lot}")`;

test.beforeEach(async ({ page }) => {
  await page.goto(URL);
  await expect(page.locator('[aria-label="Uncertain-first lot queue"] button')).toHaveCount(12, { timeout: 30000 });
});

test("auth gate: no demo flag leaves the workspace for /login", async ({ page }) => {
  await page.goto("/lots/correct");
  await expect(page).toHaveURL(/\/login/, { timeout: 30000 });
  await expect(page.locator('[aria-label="Uncertain-first lot queue"]')).toHaveCount(0);
});

test("numbers flow confirms with two-signal marker and logs the edit", async ({ page }) => {
  await page.locator(queueRow("L-001")).click();
  await expect(page.locator("h2")).toContainText("L-001");
  await page.getByRole("button", { name: "Confirm (two-signal)" }).click();
  // Confirm steps to the next uncertain lot; reopen L-001 to check the marker.
  await page.locator(queueRow("L-001")).click();
  await expect(page.locator("text=Confirmed by operator")).toBeVisible();
  await expect(page.locator("text=signals detection+human")).toBeVisible();
  await page.getByRole("tab", { name: "Log" }).click();
  await expect(page.locator("text=operator · L-001 · status").first()).toBeVisible();
});

test("renumber keeps the stable id; duplicates refused", async ({ page }) => {
  await page.locator(queueRow("L-001")).click();
  await page.getByLabel("Renumber (display label; id unchanged)").fill("L-101");
  await page.getByRole("button", { name: "Renumber", exact: true }).click();
  await expect(page.locator("h2")).toContainText("L-101 (L-001)");
  page.once("dialog", (d) => void d.dismiss());
  await page.getByLabel("Renumber (display label; id unchanged)").fill("L-002");
  await page.getByRole("button", { name: "Renumber", exact: true }).click();
  await expect(page.locator("h2")).toContainText("L-101 (L-001)");
});

test("tier click-paint updates counts; undo reverts", async ({ page }) => {
  await page.getByRole("tab", { name: "Tiers" }).click();
  await expect(page.locator('[aria-label="Unassigned counter"]')).toContainText("Unassigned: 1 / 12");
  await page.locator('[aria-label="Tier paint map"] polygon[data-lot="L-012"]').click();
  await expect(page.locator('[aria-label="Unassigned counter"]')).toContainText("Unassigned: 0 / 12");
  await page.getByRole("tab", { name: "Log" }).click();
  await page.getByRole("button", { name: "Undo last batch" }).click();
  await page.getByRole("tab", { name: "Tiers" }).click();
  await expect(page.locator('[aria-label="Unassigned counter"]')).toContainText("Unassigned: 1 / 12");
});

test("gates block, waivers need reasons, bulk-accept enforces the sample", async ({ page }) => {
  await page.getByRole("tab", { name: "Gates" }).click();
  await expect(page.locator("text=BLOCKED")).toBeVisible();
  // Advancing past a blocked gate is refused (bypass guard).
  await page.getByRole("button", { name: "Advance stage" }).click();
  await expect(page.locator("text=gate bypass refused")).toBeVisible();
  // Waiver with an empty reason is refused via dialog; nothing is recorded.
  page.once("dialog", (d) => void d.dismiss());
  await page.getByLabel("Target").fill("L-012");
  await page.getByRole("button", { name: "Add waiver" }).click();
  await expect(page.locator("text=Waivers (")).toHaveCount(0);
  // Bulk flow: propose, confirm the whole sample, then the rest.
  await page.getByRole("button", { name: "Propose bulk accept" }).click();
  const sampleButtons = page.locator("button", { hasText: "Confirm sample" });
  expect(await sampleButtons.count()).toBeGreaterThanOrEqual(2);
  for (let i = 0, n = await sampleButtons.count(); i < n; i++) {
    await sampleButtons.first().click();
  }
  await page.getByRole("button", { name: /Confirm remaining/ }).click();
  // Success resets the flow to a fresh proposal button.
  await expect(page.getByRole("button", { name: "Propose bulk accept" })).toBeVisible();
});
