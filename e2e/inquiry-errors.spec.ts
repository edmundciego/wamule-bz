import { expect, test, type Page } from "@playwright/test";

const DEMO_URL = "/embed/demo";
const GET_LOTS = "**/functions/v1/get-public-lots**";
const FN = "**/functions/v1/submit-public-inquiry";
const LIBRARY_TEXT = "Edge Function returned a non-2xx status code";

const MAP_PAYLOAD = {
  tenant: { name: "Hopkins Grove (synthetic)", slug: "demo" },
  project: { slug: "synthetic-e2e", name: "Synthetic E2E project" },
  masterplan_image_url: "/demo-map/masterplan_background.webp",
  masterplan_preview_url: null,
  branding: { company_name: "Hopkins Grove (synthetic)", logo_url: "", short_description: "" },
  theme: null,
  parcels: [
    {
      public_ref: "plr1:synthetic-e2e:S-030",
      lot_number: "S-030",
      status: "Available",
      price: 20000,
      dimensions: null,
      area_sqm: null,
      map_polygon: [
        { x: 10, y: 10 },
        { x: 25, y: 10 },
        { x: 25, y: 25 },
        { x: 10, y: 25 },
      ],
      tier_key: "standard",
      tier_label: "Standard",
      tier_color_hex: "#3b82f6",
      is_corner: false,
      effective_price_cents: 2000000,
    },
    {
      public_ref: "plr1:synthetic-e2e:S-059",
      lot_number: "S-059",
      status: "Reserved",
      price: 45000,
      dimensions: null,
      area_sqm: 1450,
      map_polygon: [
        { x: 30, y: 10 },
        { x: 45, y: 10 },
        { x: 45, y: 25 },
        { x: 30, y: 25 },
      ],
      tier_key: "estate",
      tier_label: "Estate",
      tier_color_hex: "#8b5cf6",
      is_corner: false,
      effective_price_cents: 4500000,
    },
  ],
};

async function lotCenter(page: Page, lotNumber: string): Promise<{ x: number; y: number }> {
  return page.evaluate((lot) => {
    const svg = document.querySelector("main svg[role=group]") as SVGSVGElement | null;
    if (!svg) throw new Error("map svg not found");
    const poly = [...svg.querySelectorAll('polygon[fill="transparent"]')].find((candidate) =>
      (candidate.querySelector("title")?.textContent ?? "").includes(`Lot ${lot} —`),
    ) as SVGPolygonElement | undefined;
    if (!poly?.getScreenCTM()) throw new Error(`Lot ${lot} not found`);
    const box = poly.getBBox();
    const point = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(poly.getScreenCTM()!);
    return { x: point.x, y: point.y };
  }, lotNumber);
}

async function openInquiryModal(page: Page, lotNumber = "S-030"): Promise<void> {
  const pt = await lotCenter(page, lotNumber);
  await page.mouse.click(pt.x, pt.y);
  await page.getByRole("button", { name: `Inquire About Lot ${lotNumber}`, exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Full Name").fill("Amara Test");
  await page.getByLabel("Email Address").fill("amara@example.com");
}

async function submitOnce(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Send Inquiry", exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.route(GET_LOTS, (route) => route.fulfill({ json: MAP_PAYLOAD }));
  await page.goto(DEMO_URL);
  await expect.poll(() => page.locator('main svg[role=group] polygon[fill="transparent"]').count()).toBe(2);
  // Wait for the aspect probe: the viewBox snaps from square to the real
  // image ratio on load, shifting every polygon. Clicking before it settles
  // misses (same guard as lot-map.spec.ts).
  await expect
    .poll(() => page.locator("main svg[role=group]").first().getAttribute("viewBox"), { timeout: 15000 })
    .not.toBe("0 0 100 100");
});

test("inquiry dialog manages focus, traps Tab, and restores focus on Escape", async ({ page }) => {
  const point = await lotCenter(page, "S-030");
  await page.mouse.click(point.x, point.y);
  const trigger = page.getByRole("button", { name: "Inquire About Lot S-030", exact: true });
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Inquire About Lot S-030" });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("Full Name")).toBeFocused();

  const close = page.getByRole("button", { name: "Close inquiry form" });
  const submit = page.getByRole("button", { name: "Send Inquiry", exact: true });
  await submit.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(submit).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("public embed applies scoped tenant color and type tokens", async ({ page }) => {
  await page.route(GET_LOTS, (route) =>
    route.fulfill({
      json: {
        ...MAP_PAYLOAD,
        theme: {
          tokens: {
            primary: "#123456",
            background: "#fafafa",
            card: "#ffffff",
            accent: "#345678",
            text: "#111111",
            muted: "#444444",
            fontFamily: "Georgia, serif",
          },
          card: {},
          cssUrl: null,
        },
      },
    }),
  );
  await page.reload();
  await expect.poll(() => page.locator('main svg[role=group] polygon[fill="transparent"]').count()).toBe(2);

  const root = page.locator(".lotmap-t-demo").first();
  const applied = await root.evaluate((element) => {
    const style = getComputedStyle(element);
    const active = element.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    return {
      primaryToken: style.getPropertyValue("--lotmap-primary").trim(),
      primaryUtility: style.getPropertyValue("--primary").trim(),
      backgroundUtility: style.getPropertyValue("--background").trim(),
      fontFamily: style.fontFamily,
      activeButtonBackground: active ? getComputedStyle(active).backgroundColor : "",
    };
  });
  expect(applied.primaryToken).toBe("#123456");
  expect(applied.primaryUtility).toBe("210 65% 20%");
  expect(applied.backgroundUtility).toBe("0 0% 98%");
  expect(applied.fontFamily).toBe("Georgia, serif");
  expect(applied.activeButtonBackground).not.toBe("rgb(31, 107, 69)");
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

test("409 conflict shows the server message, never library text", async ({ page }) => {
  await page.route(FN, (route) =>
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
  const pt = await lotCenter(page, "S-059");
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
  expect(bodies[1].specific_lot_ref).toBe(bodies[0].specific_lot_ref);
});

test("successful inquiry returns to the selected map lot", async ({ page }) => {
  await page.route(FN, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
  );
  await openInquiryModal(page);
  const trigger = page.getByRole("button", { name: "Inquire About Lot S-030", exact: true });
  const selectedLot = page.locator("strong", { hasText: /^Lot S-/ }).first();
  const lotBefore = await selectedLot.textContent();
  await submitOnce(page);
  await expect(page.getByText("Inquiry Sent!")).toBeVisible();
  const done = page.getByRole("button", { name: "Done", exact: true });
  await expect(done).toBeFocused();
  await done.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(selectedLot).toBeVisible();
  await expect(selectedLot).toHaveText(lotBefore ?? "");
});
