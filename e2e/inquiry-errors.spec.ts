import { expect, test, type Page } from "@playwright/test";

const DEMO_URL = "/embed/demo?demo=1";
const FN = "**/functions/v1/submit-public-inquiry";
const LIBRARY_TEXT = "Edge Function returned a non-2xx status code";

async function openInquiryModal(page: Page): Promise<void> {
  const pt = await page.evaluate(() => {
    const svg = document.querySelector("main svg") as SVGSVGElement | null;
    if (!svg) throw new Error("map svg not found");
    const poly = [...svg.querySelectorAll('polygon[fill="transparent"]')][5] as SVGPolygonElement | undefined;
    if (!poly) throw new Error("hit polygon missing");
    const box = poly.getBBox();
    const p = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(poly.getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(pt.x, pt.y);
  await page.getByRole("button", { name: /^Inquire About Lot/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Full Name").fill("Amara Test");
  await page.getByLabel("Email Address").fill("amara@example.com");
}

async function submitOnce(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Send Inquiry", exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto(DEMO_URL);
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('main svg polygon[fill="transparent"]').length), {
      timeout: 30000,
    })
    .toBeGreaterThan(50);
  // Wait for the aspect probe: the viewBox snaps from square to the real
  // image ratio on load, shifting every polygon. Clicking before it settles
  // misses (same guard as lot-map.spec.ts).
  await expect
    .poll(() => page.locator("main svg").first().getAttribute("viewBox"), { timeout: 15000 })
    .not.toBe("0 0 100 100");
});

test("400 shows the friendly lot message, never library text", async ({ page }) => {
  await page.route(FN, (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "Select an available public lot for this inquiry." }),
    }),
  );
  await openInquiryModal(page);
  await submitOnce(page);
  await expect(page.getByText("That lot isn't currently listed for inquiry")).toBeVisible();
  await expect(page.getByText(LIBRARY_TEXT)).toHaveCount(0);
  // Still on the form (no false success).
  await expect(page.getByRole("button", { name: "Send Inquiry", exact: true })).toBeVisible();
});

test("404 falls back to a generic friendly message", async ({ page }) => {
  await page.route(FN, (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found" }) }),
  );
  await openInquiryModal(page);
  await submitOnce(page);
  await expect(page.getByText("Not found")).toBeVisible();
  await expect(page.getByText(LIBRARY_TEXT)).toHaveCount(0);
});

test("500 shows the server message, logs status/body, keeps the form", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.route(FN, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "We could not save your inquiry. Please try again." }),
    }),
  );
  await openInquiryModal(page);
  await submitOnce(page);
  await expect(page.getByText("We could not save your inquiry. Please try again.")).toBeVisible();
  await expect(page.getByText(LIBRARY_TEXT)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send Inquiry", exact: true })).toBeVisible();
  expect(errors.some((text) => text.includes("[edge-function]") && text.includes("500"))).toBe(true);
});

test("409 conflict shows the server message, never library text", async ({ page }) => {  await page.route(FN, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "This request conflicts with an earlier submission. Please start a new inquiry." }),
    }),
  );
  await openInquiryModal(page);
  await submitOnce(page);
  await expect(page.getByText("This request conflicts with an earlier submission.")).toBeVisible();
  await expect(page.getByText(LIBRARY_TEXT)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send Inquiry", exact: true })).toBeVisible();
});

test("waitlist flow: Reserved lot offers Join Waitlist, no availability promise", async ({ page }) => {
  await page.route(FN, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, waitlist: true }) }),
  );
  const pt = await page.evaluate(() => {
    const svg = document.querySelector("main svg") as SVGSVGElement | null;
    if (!svg) throw new Error("map svg not found");
    const poly = [...svg.querySelectorAll('polygon[fill="transparent"]')].find((p) =>
      (p.querySelector("title")?.textContent ?? "").includes("Lot S-059 "),
    ) as SVGPolygonElement | undefined;
    if (!poly?.getScreenCTM()) throw new Error("S-059 not found");
    const box = poly.getBBox();
    const c = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(poly.getScreenCTM()!);
    return { x: c.x, y: c.y };
  });
  await page.mouse.click(pt.x, pt.y);
  await page.getByRole("button", { name: "Join Waitlist for Lot S-059" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Join the Waitlist for Lot S-059", { exact: true })).toBeVisible();
  await page.getByLabel("Full Name").fill("Amara Test");
  await page.getByLabel("Email Address").fill("amara@example.com");
  await page.getByRole("button", { name: "Join Waitlist", exact: true }).click();
  await expect(page.getByText("You're on the Waitlist!")).toBeVisible();
  await expect(page.getByText(LIBRARY_TEXT)).toHaveCount(0);
});

test("retry reuses the idempotency key and fires once per submit", async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  await page.route(FN, (route) => {
    calls += 1;
    const req = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(req);
    if (calls === 1) {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "We could not save your inquiry. Please try again." }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await openInquiryModal(page);
  await submitOnce(page);
  await expect(page.getByText("We could not save your inquiry. Please try again.")).toBeVisible();
  await submitOnce(page);
  await expect(page.getByText("Inquiry Sent!")).toBeVisible();
  expect(calls).toBe(2);
  expect(bodies).toHaveLength(2);
  // Same key on both attempts: the server can dedupe, so no duplicate lead.
  expect(bodies[0].client_reference_id).toBeTruthy();
  expect(bodies[1].client_reference_id).toBe(bodies[0].client_reference_id);
  // Same buyer payload reshaped identically (builder-driven, no drift).
  expect(bodies[1].specific_lot_id).toBe(bodies[0].specific_lot_id);
});
