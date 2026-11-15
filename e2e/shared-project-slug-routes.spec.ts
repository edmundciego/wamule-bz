import { expect, test } from "@playwright/test";

const outlineId = "50000000-0000-4000-8000-000000000031";
const requests: URL[] = [];
let hostnameResolutionCalls = 0;

test.beforeEach(async ({ page }) => {
  requests.length = 0;
  hostnameResolutionCalls = 0;
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
      publicApplication: { applications_open: true, notices_complete: true, public_notice_text: "Synthetic notice.", application_acknowledgment_text: "Synthetic acknowledgment.", default_confirmation_message: "Received for review.", show_lot_prices_publicly: false, show_available_lot_count_publicly: false },
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
});

test("signed-out shared project and map URLs load by slugs without a hostname binding", async ({ page }) => {
  await page.goto("/p/wamule/synthetic-review?phase=initial");
  await expect(page.getByText("Synthetic Review Project", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Project application" })).toBeVisible();
  await expect(page.getByText("version review-v1")).toBeVisible();

  await page.goto(`/p/wamule/synthetic-review/map?phase=initial&feature=${outlineId}`);
  await expect(page.getByText("SYN-001", { exact: true }).first()).toBeVisible();
  expect(requests.filter((url) => url.pathname.endsWith("/get-public-site-experience")).every((url) => !url.searchParams.has("host"))).toBe(true);
  expect(requests.filter((url) => url.pathname.endsWith("/get-public-project-page")).every((url) => !url.searchParams.has("host"))).toBe(true);
  expect(requests.filter((url) => url.pathname.endsWith("/get-public-lots")).every((url) => !url.searchParams.has("host"))).toBe(true);
  expect(hostnameResolutionCalls).toBe(0);
});
