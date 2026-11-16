import { expect, test } from "@playwright/test";

const outlineId = "50000000-0000-4000-8000-000000000031";
const requests: URL[] = [];
let hostnameResolutionCalls = 0;
let applicationsOpen = true;
const inquiryPayloads: Array<Record<string, unknown>> = [];

test.beforeEach(async ({ page }) => {
  requests.length = 0;
  hostnameResolutionCalls = 0;
  applicationsOpen = true;
  inquiryPayloads.length = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/functions/v1/")) requests.push(url);
  });
  await page.route("**/rest/v1/rpc/resolve_public_hostname", async (route) => {
    hostnameResolutionCalls += 1;
    await route.fulfill({ json: [{ resolution: "unresolved", reason: "no-host-binding" }] });
  });
  await page.route("**/functions/v1/get-public-site-experience**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("tenant")).toBe("wamule");
    expect(url.searchParams.get("project")).toBe("synthetic-review");
    expect(url.searchParams.has("host")).toBe(false);
    await route.fulfill({ json: {
      scope: { tenantSlug: "wamule", projectSlug: "synthetic-review", phaseSlug: "initial" },
      phases: [{ slug: "initial", name: "Initial" }, { slug: "later", name: "Later" }],
      siteExperience: { templateId: "wamule-classic", applicationType: "project_application", enabledModules: { map: true, inquiry: false, application: true, pricing: false } },
      company: { company_name: "Wamule", logo_url: "", short_description: "Synthetic review workspace.", contact_email: "review@example.test", phone_number: "+501 600 0000", location_address: "Test site", website: "https://example.test" },
      publicApplication: { applications_open: applicationsOpen, notices_complete: true, public_notice_text: "Synthetic notice.", application_acknowledgment_text: "Synthetic acknowledgment.", default_confirmation_message: "Received for review.", show_lot_prices_publicly: false, show_available_lot_count_publicly: false },
      installmentPlans: [], paymentMethods: [],
    } });
  });
  await page.route("**/functions/v1/get-public-project-page**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.has("host")).toBe(false);
    await route.fulfill({ json: {
      tenant: { name: "Wamule", slug: "wamule" },
      project: { name: "Synthetic Review Project", slug: "synthetic-review", mapExperienceMode: "demo" },
      phase: { name: "Initial", slug: "initial" },
      company: { name: "Wamule", email: "review@example.test", phone: "+501 600 0000", website: "https://example.test", location: "Test site", description: "Synthetic review workspace.", publicNotice: "Company notice." },
      applicationSettings: { applicationsOpen: true, noticeVersion: "review-v1", publicNotice: "Synthetic notice.", acknowledgmentText: "Synthetic acknowledgment.", intendedUses: ["Residential", "Other"], maxMapPreferences: 2, confirmationMessage: "Received for review." },
    } });
  });
  await page.route("**/functions/v1/get-public-lots**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("tenant")).toBe("wamule");
    expect(url.searchParams.get("project")).toBe("synthetic-review");
    expect(url.searchParams.get("phase")).toBe("initial");
    expect(url.searchParams.has("host")).toBe(false);
    await route.fulfill({ json: {
      tenant: { name: "Wamule", slug: "wamule" },
      project: { slug: "synthetic-review", name: "Synthetic Review Project" },
      phase: { slug: "initial", name: "Initial" },
      map_experience_mode: "demo",
      branding: { company_name: "Wamule", logo_url: "", short_description: "Synthetic review workspace." },
      masterplan_image_url: null, masterplan_preview_url: null, theme: null, parcels: [],
      features: [{ map_feature_ref: outlineId, demo_label: "SYN-001", map_polygon: [{ x: 15, y: 15 }, { x: 35, y: 15 }, { x: 35, y: 35 }, { x: 15, y: 35 }] }],
    } });
  });
  await page.route("**/functions/v1/submit-public-inquiry", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    inquiryPayloads.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: { ok: true, leadCreated: true, followUpCreated: true, emailSent: false, emailSuppressed: true } });
  });
});

test("fresh signed-out shared links refresh, show map inquiry, apply with selected plot, and set preview metadata", async ({ page }) => {
  await page.goto("/p/wamule/synthetic-review?phase=initial");
  await expect(page.getByText("Synthetic Review Project", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Project application" })).toBeVisible();
  await expect(page.getByText("Synthetic notice.", { exact: true })).toBeVisible();
  await expect(page).toHaveTitle(/Synthetic Review Project \| Wamule/);
  await expect.poll(() => page.locator('meta[property="og:title"]').getAttribute("content"))
    .toBe("Synthetic Review Project | Wamule");
  await expect.poll(() => page.locator('meta[property="og:description"]').getAttribute("content"))
    .toContain("project team");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Project application" })).toBeVisible();
  await expect(page).toHaveTitle(/Synthetic Review Project \| Wamule/);

  await page.goto(`/p/wamule/synthetic-review/map?phase=initial&feature=${outlineId}`);
  await expect(page.getByText("SYN-001", { exact: true }).first()).toBeVisible();
  await expect(page).toHaveTitle(/Synthetic Review Project Map \| Wamule/);
  await expect.poll(() => page.locator('meta[property="og:title"]').getAttribute("content"))
    .toBe("Synthetic Review Project Map | Wamule");
  await expect.poll(() => page.locator('meta[property="og:url"]').getAttribute("content"))
    .toContain("/p/wamule/synthetic-review/map?phase=initial");
  await page.reload();
  await expect(page.getByText("SYN-001", { exact: true }).first()).toBeVisible();
  await expect(page).toHaveTitle(/Synthetic Review Project Map \| Wamule/);
  await page.getByRole("button", { name: "Get more info about this plot", exact: true }).click();
  const inquiry = page.getByRole("dialog");
  await inquiry.getByRole("combobox", { name: "Reason for inquiry", exact: true }).selectOption("Other");
  await inquiry.getByRole("textbox", { name: "Full Name", exact: true }).fill("Map Link Tester");
  await inquiry.getByRole("textbox", { name: "Email Address", exact: true }).fill("map-link@example.test");
  await inquiry.getByRole("textbox", { name: "What would you like the team to help with?", exact: true }).fill("Please share the current plan notes.");
  await inquiry.getByRole("button", { name: "Send Inquiry", exact: true }).click();
  await expect(inquiry.getByRole("heading", { name: "Inquiry Sent!" })).toBeVisible();
  expect(inquiryPayloads).toHaveLength(1);
  expect(inquiryPayloads[0]).toMatchObject({
    tenant: "wamule",
    project: "synthetic-review",
    phase: "initial",
    specific_map_feature_ref: outlineId,
    interests: ["Other"],
  });
  expect(inquiryPayloads[0].message).toContain("Inquiry reason: Other");
  expect(inquiryPayloads[0].message).toContain("Please share the current plan notes.");
  await inquiry.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Apply with this plot", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`apply_feature=${outlineId}`));
  await expect(page.getByRole("heading", { name: "Project application" })).toBeVisible();
  await expect(page.locator("#application")).toContainText("SYN-001");
  expect(requests.filter((url) => url.pathname.endsWith("/get-public-site-experience")).every((url) => !url.searchParams.has("host"))).toBe(true);
  expect(requests.filter((url) => url.pathname.endsWith("/get-public-project-page")).every((url) => !url.searchParams.has("host"))).toBe(true);
  expect(requests.filter((url) => url.pathname.endsWith("/get-public-lots")).every((url) => !url.searchParams.has("host"))).toBe(true);
  expect(hostnameResolutionCalls).toBe(0);
});

test("standalone map keeps inquiry available while its phase application gate is closed", async ({ page }) => {
  applicationsOpen = false;
  await page.goto(`/p/wamule/synthetic-review/map?phase=initial&feature=${outlineId}`);
  await expect(page.getByText("SYN-001", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Get more info about this plot", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply with this plot", exact: true })).toHaveCount(0);
});
