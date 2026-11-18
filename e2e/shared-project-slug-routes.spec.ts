import { expect, test } from "@playwright/test";

const outlineId = "50000000-0000-4000-8000-000000000031";
const requests: URL[] = [];
let hostnameResolutionCalls = 0;
let applicationsOpen = true;
let mapPublished = true;
let enabledModules = { map: true, inquiry: false, application: true, pricing: false };
const applicationPayloads: Array<Record<string, unknown>> = [];
const inquiryPayloads: Array<Record<string, unknown>> = [];

test.beforeEach(async ({ page }) => {
  requests.length = 0;
  hostnameResolutionCalls = 0;
  applicationsOpen = true;
  mapPublished = true;
  enabledModules = { map: true, inquiry: false, application: true, pricing: false };
  applicationPayloads.length = 0;
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
      projectName: "Synthetic Review Project",
      phases: [{ slug: "initial", name: "Initial" }, { slug: "later", name: "Later" }],
      siteExperience: { templateId: "hopkins-project", applicationType: "project_application", enabledModules },
      company: { company_name: "Wamule", logo_url: "", short_description: "Synthetic review workspace.", contact_email: "review@example.test", phone_number: "+501 600 0000", location_address: "Test site", website: "https://example.test" },
      publicApplication: { applications_open: applicationsOpen, notices_complete: true, allowed_intended_uses: ["Residential", "Other"], max_map_preferences: 2, public_notice_text: "Synthetic notice.", application_acknowledgment_text: "Synthetic acknowledgment.", default_confirmation_message: "Received for review.", show_lot_prices_publicly: false, show_available_lot_count_publicly: false },
      installmentPlans: [], paymentMethods: [],
    } });
  });
  await page.route("**/functions/v1/get-public-project-page**", async (route) => {
    await route.fulfill({ status: 503, json: { error: "Public company information is incomplete." } });
  });
  await page.route("**/functions/v1/get-public-lots**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("tenant")).toBe("wamule");
    expect(url.searchParams.get("project")).toBe("synthetic-review");
    expect(url.searchParams.get("phase")).toBe("initial");
    expect(url.searchParams.has("host")).toBe(false);
    if (!mapPublished) return route.fulfill({ status: 404, json: { error: "The selected phase has no published map." } });
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
  await page.route("**/functions/v1/submit-hopkins-project-application", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    applicationPayloads.push(route.request().postDataJSON() as Record<string, unknown>);
    if (applicationPayloads.length === 1) return route.abort("failed");
    await route.fulfill({ json: { ok: true, application_id: 42, deduplicated: true, message: "Received for review." } });
  });
  await page.route("**/functions/v1/submit-public-inquiry", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    inquiryPayloads.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: { ok: true, leadCreated: true, followUpCreated: true, emailSent: false, emailSuppressed: true } });
  });
});

test("fresh signed-out shared links refresh, show map inquiry, apply with selected plot, and set preview metadata", async ({ page }) => {
  await page.goto("/p/wamule/synthetic-review?phase=initial");
  await expect(page.getByRole("heading", { level: 1, name: "Synthetic Review Project" })).toBeVisible();
  await expect(page.getByRole("main")).toHaveAttribute("data-site-template", "wamule-classic");
  await expect(page.getByRole("region", { name: "Explore the project map" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Request project information" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Project application" })).toBeVisible();
  await expect(page.getByText("Synthetic notice.", { exact: true })).toBeVisible();
  const inlineForm = page.getByRole("form", { name: "Project application" });
  await expect(inlineForm).toHaveCount(1);
  await expect(inlineForm.getByLabel("Applicant Full Name")).toBeVisible();
  await expect(page).toHaveTitle(/Synthetic Review Project \| Wamule/);
  await expect.poll(() => page.locator('meta[property="og:title"]').getAttribute("content"))
    .toBe("Synthetic Review Project | Wamule");
  await expect.poll(() => page.locator('meta[property="og:description"]').getAttribute("content"))
    .toBe("Synthetic review workspace.");
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
  await expect(page).toHaveURL(new RegExp(`/p/wamule/synthetic-review/apply\\?phase=initial&apply_feature=${outlineId}`));
  await expect(page.getByRole("heading", { level: 1, name: "Project application" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Selected map outlines" })).toContainText("SYN-001");
  const dedicatedForm = page.getByRole("form", { name: "Project application" });
  await expect(dedicatedForm).toHaveCount(1);
  await expect(dedicatedForm.getByLabel("Applicant Full Name")).toBeVisible();
  await expect(page.getByRole("heading", { name: "A place to put down roots." })).toHaveCount(0);

  await dedicatedForm.getByLabel("Applicant Full Name").fill("Synthetic Applicant");
  await dedicatedForm.getByLabel("Applicant Address").fill("Staging fixture only");
  await dedicatedForm.getByLabel("Nationality").fill("Belizean");
  await dedicatedForm.getByLabel("Occupation").fill("Tester");
  await dedicatedForm.getByLabel("Telephone Contact").fill("+501 600 0000");
  await dedicatedForm.getByLabel("Email Address").fill("synthetic@example.test");
  await dedicatedForm.getByRole("button", { name: "Continue", exact: true }).click();
  await dedicatedForm.getByRole("radio", { name: "Other", exact: true }).check();
  await dedicatedForm.getByLabel("Other intended use").fill("Review the plan");
  await dedicatedForm.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dedicatedForm.getByRole("button", { name: "Remove SYN-001" })).toBeVisible();
  await dedicatedForm.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dedicatedForm.getByText("Synthetic Applicant", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Payment Preference", exact: true })).toHaveCount(0);
  await dedicatedForm.getByRole("checkbox", { name: /acknowledge the project notice/ }).check();
  await dedicatedForm.getByLabel("Type your full name as acknowledgement").fill("Synthetic Applicant");
  const submit = dedicatedForm.getByRole("button", { name: "Submit project application" });
  await submit.click();
  await expect(dedicatedForm.getByRole("alert")).toBeVisible();
  await submit.click();
  await expect(page.getByRole("heading", { name: "Application received for review" })).toBeVisible();
  expect(applicationPayloads).toHaveLength(2);
  expect(applicationPayloads[1]).toEqual(applicationPayloads[0]);
  expect(applicationPayloads[0]).toMatchObject({
    tenant: "wamule",
    project: "synthetic-review",
    phase: "initial",
    preferred_map_feature_refs: [outlineId],
    intended_use: "Other",
    intended_use_other: "Review the plan",
  });
  expect(applicationPayloads[0]).not.toHaveProperty("payment_option");
  expect(applicationPayloads[0]).not.toHaveProperty("preferred_lot_refs");
  expect(requests.filter((url) => url.pathname.endsWith("/get-public-site-experience")).every((url) => !url.searchParams.has("host"))).toBe(true);
  expect(requests.some((url) => url.pathname.endsWith("/get-public-project-page"))).toBe(false);
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

test("the dedicated application uses application settings with an incomplete marketing profile", async ({ page }) => {
  const originalLink = `/p/wamule/synthetic-review?phase=initial&apply=1&apply_feature=${outlineId}#application`;
  await page.goto(originalLink);
  await expect(page).toHaveURL(/\/synthetic-review\/apply\?phase=initial/);
  await expect(page.getByRole("heading", { level: 1, name: "Project application" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Selected map outlines" })).toContainText("SYN-001");
  await page.reload();
  await expect(page.getByRole("form", { name: "Project application", exact: true })).toHaveCount(1);
  expect(requests.some((url) => url.pathname.endsWith("/get-public-project-page"))).toBe(false);

  applicationsOpen = false;
  await page.reload();
  await expect(page.getByText("Applications are currently closed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit project application" })).toHaveCount(0);
});

test("the Regular homepage hides unpublished widgets and follows project switches", async ({ page }) => {
  applicationsOpen = false;
  mapPublished = false;
  enabledModules.inquiry = true;
  await page.goto("/p/wamule/synthetic-review?phase=initial");
  await expect(page.getByRole("heading", { level: 1, name: "Synthetic Review Project" })).toBeVisible();
  await expect(page.getByRole("main")).toHaveAttribute("data-public-phase", "initial");
  await expect(page.getByText("Applications are currently closed.", { exact: true })).toBeVisible();
  const inquiry = page.getByRole("form", { name: "Request project information" });
  await expect(inquiry).toBeVisible();
  await expect(page.getByRole("link", { name: /Explore map|Apply|Start application/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Explore the project map" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Available lots" })).toHaveCount(0);
  await inquiry.getByLabel("Full name").fill("Homepage Tester");
  await inquiry.getByLabel("Email address").fill("homepage@example.test");
  await inquiry.getByRole("button", { name: "Send inquiry" }).click();
  await expect(page.getByText("Your inquiry was received.")).toBeVisible();
  expect(inquiryPayloads).toHaveLength(1);
  expect(inquiryPayloads[0]).toMatchObject({
    tenant: "wamule",
    project: "synthetic-review",
    phase: "initial",
    interests: ["General project interest"],
  });

  mapPublished = true;
  enabledModules = { map: false, inquiry: false, application: false, pricing: false };
  requests.length = 0;
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Synthetic Review Project" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Explore the project map|Request project information|Project application/ })).toHaveCount(0);
  expect(requests.some((url) => url.pathname.endsWith("/get-public-lots"))).toBe(false);
});

test("the original verified /apply page keeps lot selection, payment preference, and review", async ({ page, baseURL }) => {
  const verifiedOrigin = "http://wamule.example.test";
  const lotRef = "plr2:synthetic-review:initial:LOT-1";
  const purchasePayloads: Array<Record<string, unknown>> = [];
  await page.route(`${verifiedOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const localResponse = await route.fetch({ url: new URL(url.pathname + url.search, baseURL).href });
    await route.fulfill({ response: localResponse });
  });
  await page.route("**/rest/v1/rpc/resolve_public_hostname", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ p_hostname: "wamule.example.test" });
    await route.fulfill({ json: [{
      resolution: "resolved", tenant_slug: "wamule", project_slug: "synthetic-review", phase_slug: "initial",
    }] });
  });
  await page.route("**/functions/v1/get-public-site-experience**", async (route) => {
    expect(new URL(route.request().url()).searchParams.get("host")).toBe("wamule.example.test");
    await route.fulfill({ json: {
      scope: { tenantSlug: "wamule", projectSlug: "synthetic-review", phaseSlug: "initial" },
      projectName: "Synthetic Review Project",
      phases: [{ slug: "initial", name: "Initial" }],
      siteExperience: { templateId: "wamule-classic", applicationType: "land_purchase", enabledModules: { map: false, inquiry: true, application: true, pricing: true } },
      company: { company_name: "Wamule", logo_url: "", short_description: "" },
      publicApplication: { applications_open: true, notices_complete: true, public_notice_text: "Purchase notice.", application_acknowledgment_text: "Synthetic acknowledgment.", default_confirmation_message: "Purchase application received.", show_lot_prices_publicly: false },
      installmentPlans: [{ id: 1, name: "Installments", reservation_fee: 10, final_purchase_price: 5000, monthly_payment: 100, term_months: 50 }],
      paymentMethods: [],
    } });
  });
  await page.route("**/functions/v1/get-public-lots**", async (route) => {
    const request = new URL(route.request().url());
    expect(request.searchParams.get("host")).toBe("wamule.example.test");
    expect(request.searchParams.get("phase")).toBe("initial");
    await route.fulfill({ json: {
      tenant: { slug: "wamule" }, project: { slug: "synthetic-review" }, phase: { slug: "initial" },
      map_experience_mode: "sales",
      parcels: [{ public_ref: lotRef, lot_number: "LOT-1", status: "Available", sales_selectable: true }],
    } });
  });
  await page.route("**/functions/v1/submit-public-application", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    purchasePayloads.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto(`${verifiedOrigin}/?phase=initial`);
  await expect(page.getByRole("main")).toHaveAttribute("data-site-template", "wamule-classic");
  await expect(page.getByRole("heading", { level: 1, name: "Synthetic Review Project" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Available lots", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Explore the project map" })).toHaveCount(0);
  await page.getByRole("link", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL(/\/apply\?phase=initial$/);
  await expect(page.getByRole("heading", { level: 1, name: "Apply for a lot" })).toBeVisible();
  const form = page.getByRole("form", { name: "Apply for a lot" });
  await expect(form).toHaveCount(1);
  await form.getByLabel("Applicant Full Name").fill("Purchase Applicant");
  await form.getByLabel("Applicant Address").fill("Test address");
  await form.getByLabel("Nationality").fill("Belizean");
  await form.getByLabel("Occupation").fill("Tester");
  await form.getByLabel("Telephone Contact").fill("+501 600 0000");
  await form.getByLabel("Email Address").fill("purchase@example.test");
  const next = form.getByRole("button", { name: "Continue", exact: true });
  await next.click();
  await form.getByRole("radio", { name: "Residential", exact: true }).check();
  await form.getByLabel("Number of parcels interested in purchasing").fill("1");
  await next.click();
  await form.getByText("LOT-1", { exact: true }).click();
  await form.getByLabel("Alternative lot option if your first preference is unavailable").fill("Any available lot");
  await next.click();
  await form.getByRole("radio", { name: /Installments/ }).check();
  await next.click();
  await form.getByRole("checkbox", { name: /acknowledge the project notice/ }).check();
  await form.getByLabel("Type your full name as acknowledgement").fill("Purchase Applicant");
  await form.getByRole("button", { name: "Submit application", exact: true }).click();
  await expect(page.getByText("Purchase application received.", { exact: true })).toBeVisible();
  expect(purchasePayloads).toHaveLength(1);
  expect(purchasePayloads[0]).toMatchObject({
    tenant: "wamule", project: "synthetic-review", phase: "initial", hostname: "wamule.example.test",
    preferred_lot_refs: [lotRef], payment_option: "Installments", parcel_count: 1,
  });
  expect(purchasePayloads[0]).not.toHaveProperty("preferred_map_feature_refs");
});
