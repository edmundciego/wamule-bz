import { expect, test, type Page } from "@playwright/test";

// All backend traffic is synthetic and intercepted. No hosted tenant is used.
const wamuleId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
async function fixtures(
  page: Page,
  options: {
    pricing?: boolean;
    unavailable?: boolean;
    modules?: Partial<{ map: boolean; inquiry: boolean; application: boolean }>;
  } = {},
) {
  const requests: URL[] = [];
  const writes: string[] = [];
  await page.route("https://tenant-homepage.invalid/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const fulfill = (
      options: NonNullable<Parameters<typeof route.fulfill>[0]>,
    ) =>
      route.fulfill({
        ...options,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers":
            "apikey,authorization,content-type,x-client-info",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          ...options.headers,
        },
      });
    if (route.request().method() === "OPTIONS") return fulfill({ status: 204 });
    if (route.request().method() !== "GET") {
      writes.push(url.pathname);
      return fulfill({
        status: 405,
        json: { error: "Read-only browser fixture" },
      });
    }
    if (url.pathname.endsWith("get-public-site-experience")) {
      if (options.unavailable)
        return fulfill({
          status: 503,
          json: { error: "Fixture settings unavailable" },
        });
      return fulfill({
        json: {
          scope: {
            tenantSlug: url.searchParams.get("tenant"),
            projectSlug: url.searchParams.get("project"),
            phaseSlug: url.searchParams.get("phase"),
          },
          siteExperience: {
            templateId: "wamule-classic",
            enabledModules: {
              map: options.modules?.map ?? true,
              inquiry: options.modules?.inquiry ?? true,
              application: options.modules?.application ?? true,
              pricing: options.pricing ?? true,
            },
          },
        },
      });
    }
    if (url.pathname.includes("/rest/v1/")) {
      expect(url.searchParams.get("tenant_id")).toBe(`eq.${wamuleId}`);
      if (!url.pathname.endsWith("business_settings"))
        return fulfill({ json: [] });
      return fulfill({
        json: [
          {
            tenant_id: wamuleId,
            key: "company_profile",
            value: {
              company_name: "Fixture Wamule Development",
              short_description: "Synthetic Wamule project content",
              logo_url: "/favicon/android-chrome-192x192.png",
            },
          },
          {
            tenant_id: wamuleId,
            key: "public_application",
            value: {
              applications_open: true,
              lot_map_tenant_slug: "wamule",
              show_lot_prices_publicly: true,
            },
          },
          {
            tenant_id: wamuleId,
            key: "lot_phase",
            value: {
              phase_name: "Phase 1",
              default_lot_price: 25000,
              default_lot_size: "65 x 101 or 75 x 101 ft",
              public_availability_display: true,
            },
          },
        ],
      });
    }
    if (url.pathname.endsWith("get-public-project-page"))
      return fulfill({
        json: {
          tenant: { name: "Hopkins Grove", slug: "hopkins-grove" },
          project: {
            name: "Hopkins Grove",
            slug: "hopkins-grove",
            mapExperienceMode: "demo",
          },
          phase: { name: "Initial phase", slug: "initial" },
          company: {
            name: "Fixture Ceiba",
            email: "demo@example.test",
            phone: "000",
            website: "https://example.test",
            location: "Hopkins Village",
            description: "Synthetic Hopkins project content",
            publicNotice: "Map references are preferences only.",
          },
          applicationSettings: {
            applicationsOpen: true,
            noticeVersion: "fixture-1",
            publicNotice: "Synthetic project-interest notice.",
            acknowledgmentText:
              "I acknowledge this is a project-interest request.",
            intendedUses: ["Residential"],
            maxMapPreferences: 5,
            confirmationMessage: "Fixture confirmation",
          },
        },
      });
    if (url.pathname.endsWith("get-public-lots")) {
      if (url.searchParams.has("catalog_only"))
        return fulfill({ json: { map_package_catalog: null } });
      const hopkins = url.searchParams.get("tenant") === "hopkins-grove";
      expect(url.searchParams.get("project")).toBe(
        hopkins ? "hopkins-grove" : "wamule",
      );
      expect(url.searchParams.get("phase")).toBe(
        hopkins ? "initial" : "default",
      );
      const polygon = (index: number) => {
        const x = 5 + (index % 5) * 18;
        const y = 5 + Math.floor(index / 5) * 21;
        return [
          { x, y },
          { x: x + 12, y },
          { x: x + 12, y: y + 12 },
          { x, y: y + 12 },
        ];
      };
      return fulfill({
        json: {
          tenant: {
            name: hopkins ? "Hopkins Grove" : "Fixture Wamule Development",
            slug: hopkins ? "hopkins-grove" : "wamule",
          },
          project: {
            name: hopkins ? "Hopkins Grove" : "Wamule",
            slug: hopkins ? "hopkins-grove" : "wamule",
          },
          phase: { slug: hopkins ? "initial" : "default" },
          branding: {},
          theme: {},
          masterplan_image_url: null,
          map_experience_mode: hopkins ? "demo" : "sales",
          parcels: hopkins
            ? []
            : Array.from({ length: 20 }, (_, i) => ({
                public_ref: `p1_wamule_lot${i + 1}`,
                lot_number: `${i + 1}`,
                status: "Available",
                sales_selectable: true,
                price: 25000,
                dimensions: "65 x 101 ft",
                map_polygon: polygon(i),
              })),
          features: hopkins
            ? [
                {
                  map_feature_ref: "11111111-1111-4111-8111-111111111111",
                  demo_label: "Plot 001",
                  map_polygon: polygon(8),
                },
              ]
            : [],
        },
      });
    }
    return fulfill({ json: [] });
  });
  return { requests, writes };
}

for (const width of [1440, 390, 320]) {
  test(`shared page and separate workflows at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const traffic = await fixtures(page);
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/",
      "/hopkins",
      "/apply",
      "/hopkins/application",
      "/",
    ]) {
      await page.goto(path);
      const hopkins = path.includes("hopkins");
      await expect(page.locator("main[data-site-template]")).toHaveAttribute(
        "data-site-template",
        "wamule-classic",
      );
      await expect(page.locator("main[data-site-template]")).toHaveAttribute(
        "data-public-tenant",
        hopkins ? "hopkins-grove" : "wamule",
      );
      await expect(page.locator("h1")).toContainText(
        hopkins ? "Hopkins Grove" : "Fixture Wamule",
      );
      await expect(page.locator("#lot-preferences")).toBeAttached();
      await expect(page.locator("#request-info")).toBeAttached();
      await expect(page.locator("#notice")).toBeAttached();
      await expect(page.locator('#lots svg[aria-label="Interactive lot map"]')).toBeAttached();
      await expect(page.locator("#application")).toBeAttached();
      if (path === "/" || path === "/hopkins") {
        await page.screenshot({
          path: testInfo.outputPath(`${hopkins ? "hopkins" : "wamule"}-homepage-${width}.png`),
          fullPage: true,
        });
      }
      if (hopkins) {
        await expect(
          page.getByRole("button", { name: /Map Preferences/ }).first(),
        ).toBeAttached();
        await expect(
          page.getByRole("button", { name: /Payment Preference/ }),
        ).toHaveCount(0);
        await expect(page.locator("#lot-preferences")).not.toContainText(
          "20 available",
        );
      } else {
        await expect(
          page.getByRole("button", { name: /Payment Preference/ }),
        ).toBeAttached();
        await expect(page.locator("#lot-preferences")).toContainText(
          "20 available",
        );
        await expect(
          page.locator("main[data-site-template]"),
        ).not.toContainText("Fixture Ceiba");
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      ).toBe(true);
    }
    expect(errors).toEqual([]);
    expect(traffic.writes).toEqual([]);
  });
}

test("failed settings do not flash tenant content or enabled forms", async ({
  page,
}) => {
  const traffic = await fixtures(page, { unavailable: true });
  for (const path of ["/", "/hopkins"]) {
    await page.goto(path);
    await expect(
      page.getByText(
        "Project homepage settings are temporarily unavailable. Please try again.",
      ),
    ).toBeVisible();
    await expect(page.locator("main[data-site-template]")).toHaveCount(0);
    await expect(page.locator("#application")).toHaveCount(0);
  }
  expect(
    traffic.requests.some(
      (url) =>
        url.pathname.includes("/rest/v1/") ||
        url.pathname.endsWith("get-public-project-page"),
    ),
  ).toBe(false);
});

test("map selections reach each tenant's own application preferences", async ({ page }) => {
  const traffic = await fixtures(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/");
  const wamuleOutline = page.getByRole("option", { name: /Lot 1,/ }).first();
  await wamuleOutline.click();
  await expect(wamuleOutline).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Remove Lot 1" })).toBeVisible();
  await page.getByRole("link", { name: /Start application/ }).click();
  await page.getByRole("button", { name: "Preferred Lot" }).click();
  await expect(page.locator('#application svg[aria-label="Interactive lot map"]')).toBeAttached();
  await expect(page.locator('#application [role="option"][aria-selected="true"]')).toHaveCount(1);

  await page.goto("/hopkins");
  const hopkinsOutline = page.getByRole("option", { name: /Select map reference/i }).first();
  await hopkinsOutline.click();
  await expect(page.getByRole("button", { name: /Remove map preference/ })).toBeAttached();
  await page.getByRole("button", { name: "Map Preferences" }).click();
  const savedPreferences = await page.evaluate(() => localStorage.getItem(
    "wamule:public-experience:v1:map-preferences:hopkins-grove:hopkins-grove:initial",
  ));
  expect(savedPreferences).toContain("11111111-1111-4111-8111-111111111111");
  await expect(page.getByRole("button", { name: "Map Preferences" })).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await expect(page.getByRole("button", { name: "Map Preferences" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Remove map preference/ })).toBeAttached();
  await page.goto("/hopkins/application");
  await expect(page.getByRole("button", { name: "Map Preferences" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "About You" }).click();
  await page.locator('input[name="applicant_full_name"]').fill("Synthetic Browser Applicant");
  await page.locator('input[name="applicant_address"]').fill("1 Test Street");
  await page.locator('input[name="nationality"]').fill("Belizean");
  await page.locator('input[name="occupation"]').fill("QA Tester");
  await page.locator('input[name="phone"]').fill("+5010000000");
  await page.locator('input[name="email"]').fill("synthetic@example.test");
  await page.getByRole("button", { name: /^2 Project Interest$/ }).click();
  await page.locator('input[name="intended_use"][value="Residential"]').check({ force: true });
  await page.getByRole("button", { name: "Additional Details" }).click();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("checkbox").check();
  await page.locator('input[name="applicant_acknowledgement_signature"]').fill("Synthetic Browser Applicant");
  await page.getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByText("Local preview complete. No application was saved or sent.")).toBeVisible();
  expect(traffic.writes).toEqual([]);
});

test("public modules hide prices, inquiries, and application sections independently", async ({ page }) => {
  const traffic = await fixtures(page, {
    pricing: false,
    modules: { inquiry: false, application: false },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/hopkins");
  await expect(page.locator("#request-info")).toHaveCount(0);
  await expect(page.locator("#application")).toHaveCount(0);
  await expect(page.locator("#lots")).toBeAttached();
  await expect(page.locator("#lot-preferences")).toContainText("Plot Categories");
  await expect(page.locator("#lot-preferences")).not.toContainText("& Prices");
  await expect(page.getByText(/\$25K|\$2,500/)).toHaveCount(0);
  const outline = page.getByRole("option", { name: /Select map reference/i }).first();
  await outline.click();
  await expect(page.getByRole("button", { name: /Ask the team about this plot/ })).toHaveCount(0);
  expect(traffic.writes).toEqual([]);
});

for (const width of [1440, 390, 320]) {
  test(`both application map steps fit at ${width}px`, async ({ page }, testInfo) => {
    const traffic = await fixtures(page);
    await page.setViewportSize({ width, height: 844 });

    await page.goto("/apply");
    await page.getByRole("button", { name: "Preferred Lot" }).click();
    await expect(page.locator('#application svg[aria-label="Interactive lot map"]')).toBeAttached();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`wamule-application-map-${width}.png`),
      fullPage: true,
    });

    await page.goto("/hopkins/application");
    await page.getByRole("button", { name: "Map Preferences" }).click();
    await expect(page.locator('#application svg[aria-label="Interactive lot map"]')).toBeAttached();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`hopkins-application-map-${width}.png`),
      fullPage: true,
    });
    expect(traffic.writes).toEqual([]);
  });
}
