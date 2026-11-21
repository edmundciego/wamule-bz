import { expect, test } from "@playwright/test";

const supabaseUrl = new URL(process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321");
const tenantId = "2cefb56f-b834-4d44-9177-e8abd8abc1c6";
const projectId = "dde17305-2a89-4d58-8d59-c756880eba6b";
const userId = "review-admin";
const publishedPhaseId = "fbc1ae08-ef46-4d80-85f5-8e3a8d049116";
const draftPhaseId = "fixture-draft-phase";
const emptyPhaseId = "fixture-empty-phase";
const phases = [
  { id: publishedPhaseId, name: "Initial", slug: "initial", is_default: true },
  { id: draftPhaseId, name: "Draft phase", slug: "draft-phase", is_default: false },
  { id: emptyPhaseId, name: "Empty phase", slug: "empty-phase", is_default: false },
];
const scope = { tenant_id: tenantId, project_id: projectId };
const publishedAt = "2026-11-11T00:00:00Z";
const publishedSnapshot = {
  ...scope,
  phase_id: publishedPhaseId,
  id: "3269255a-646e-56a1-a776-ecc2ddebc389",
  is_active: true,
  snapshot_version: 3,
  outline_count: 775,
};
const publishedPackageId = "9db38ced-822f-5c48-9688-cc82c8a5956e";
const olderSnapshot = { ...publishedSnapshot, id: "older-snapshot", is_active: false, snapshot_version: 2 };
const draftSnapshot = { ...scope, phase_id: draftPhaseId, id: "draft-snapshot", is_active: false, snapshot_version: 5, outline_count: 1 };

function mapPackage(snapshot: typeof publishedSnapshot, publication: string | null, id = `package-${snapshot.id}`) {
  return {
    ...scope, phase_id: snapshot.phase_id, id, snapshot_id: snapshot.id,
    package_data: { revision: snapshot.snapshot_version, canvas: { width: 100, height: 100 } },
    background_path: null, published_at: publication,
  };
}

function outline(
  snapshot: typeof publishedSnapshot,
  label: string,
  visible = true,
  identityId = label,
  mapPolygon = [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 12, y: 12 }, { x: 10, y: 12 }],
) {
  return {
    ...scope, phase_id: snapshot.phase_id, snapshot_id: snapshot.id, identity_id: identityId,
    is_active: true, public_visible: visible, demo_label: label, provenance: { reviewed: true },
    map_polygon: mapPolygon,
  };
}

test("admin Map Review searches the full snapshot and selects Plot 775 from map and keyboard", async ({ page }, testInfo) => {
  const targetIdentity = "a530dd79-ed13-42da-8948-9fa735aa04bc";
  const targetPolygon = [
    { x: 92.77192982, y: 92.10416667 }, { x: 92.49122807, y: 94.66666667 },
    { x: 95.03508772, y: 95 }, { x: 94.77192982, y: 92.41666667 },
  ];
  const publishedOutlines = Array.from({ length: 775 }, (_, index) => {
    if (index === 774) return outline(publishedSnapshot, "Plot 775", true, targetIdentity, targetPolygon);
    const column = index % 29;
    const row = Math.floor(index / 29);
    const x = 1 + column * 2.8;
    const y = 1 + row * 3.2;
    return outline(publishedSnapshot, `Plot ${index + 1}`, true, `plot-${index + 1}`, [
      { x, y }, { x: x + 2, y }, { x: x + 2, y: y + 2 }, { x, y: y + 2 },
    ]);
  });
  const rowsByTable: Record<string, Array<Record<string, unknown>>> = {
    admin_profiles: [{ user_id: userId, tenant_id: tenantId, role: "Admin" }],
    project_memberships: [],
    organizations: [{ id: tenantId, name: "Hopkins Grove", slug: "hopkins-grove", is_active: true }],
    projects: [{ id: projectId, tenant_id: tenantId, name: "Hopkins Grove", slug: "hopkins-grove", is_default: true, map_experience_mode: "demo" }],
    development_phases: phases.map((phase) => ({ ...scope, ...phase, is_active: true })),
    business_settings: [],
    project_map_packages: [
      mapPackage(olderSnapshot, publishedAt),
      mapPackage(publishedSnapshot, publishedAt, publishedPackageId),
      mapPackage({ ...publishedSnapshot, phase_id: draftPhaseId, id: "draft-phase-live" }, publishedAt),
      mapPackage(draftSnapshot, null),
    ],
    map_feature_snapshots: [
      olderSnapshot, publishedSnapshot,
      { ...publishedSnapshot, phase_id: draftPhaseId, id: "draft-phase-live" },
      draftSnapshot,
    ],
    map_features: [
      outline(olderSnapshot, "Older"),
      ...publishedOutlines,
      outline(publishedSnapshot, "Hidden", false),
      outline(draftSnapshot, "Draft", false),
    ],
    project_plot_content: publishedOutlines.map((feature) => ({
      ...scope, phase_id: publishedPhaseId, identity_id: feature.identity_id,
      plot_number: feature.identity_id === targetIdentity ? "Plot 775" : feature.demo_label, parcel_id: null,
    })),
    masterplan_versions: [],
    parcels: [],
  };
  let reviewerLinkRequests = 0;
  const publicMapRequests: Array<{ phase: string | null; snapshotId: unknown }> = [];
  await page.addInitScript(({ key, id, workspace }) => {
    window.localStorage.setItem(key, JSON.stringify({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id, aud: "authenticated" },
    }));
    window.localStorage.setItem(`wamule.active-workspace:${id}`, JSON.stringify(workspace));
  }, {
    key: `sb-${supabaseUrl.hostname.split(".")[0]}-auth-token`,
    id: userId,
    workspace: { tenantId, projectId, phaseId: publishedPhaseId },
  });

  await page.context().route((url) => url.origin === supabaseUrl.origin, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/rpc/publish_project_map_package")) {
      expect(route.request().postDataJSON()).toEqual({
        p_package_id: "package-draft-snapshot",
        p_expected_active_id: "draft-phase-live",
        p_replace_current: true,
      });
      rowsByTable.map_feature_snapshots.find((row) => row.id === "draft-phase-live")!.is_active = false;
      rowsByTable.map_feature_snapshots.find((row) => row.id === "draft-snapshot")!.is_active = true;
      rowsByTable.project_map_packages.find((row) => row.id === "package-draft-snapshot")!.published_at = publishedAt;
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    }
    if (url.pathname.endsWith("/functions/v1/get-public-site-experience")) {
      expect(url.searchParams.get("tenant")).toBe("hopkins-grove");
      expect(url.searchParams.get("project")).toBe("hopkins-grove");
      expect(url.searchParams.get("phase")).toBe("draft-phase");
      return route.fulfill({ json: {
        scope: { tenantSlug: "hopkins-grove", projectSlug: "hopkins-grove", phaseSlug: "draft-phase" },
        projectName: "Hopkins Grove",
        siteExperience: { applicationType: "land_purchase", enabledModules: { map: true, inquiry: false, application: false, pricing: false } },
        phases: [{ slug: "draft-phase", name: "Draft phase" }],
        company: { company_name: "Hopkins Grove", logo_url: "", short_description: "", contact_email: "", phone_number: "", location_address: "", website: "" },
        publicApplication: { applications_open: false, notices_complete: false, public_notice_text: "", application_acknowledgment_text: "", default_confirmation_message: "", show_lot_prices_publicly: false, show_available_lot_count_publicly: false },
        installmentPlans: [], paymentMethods: [],
      } });
    }
    if (url.pathname.endsWith("/functions/v1/get-public-lots")) {
      const activeSnapshot = rowsByTable.map_feature_snapshots.find((row) => row.phase_id === draftPhaseId && row.is_active === true);
      expect(url.searchParams.get("tenant")).toBe("hopkins-grove");
      expect(url.searchParams.get("project")).toBe("hopkins-grove");
      expect(url.searchParams.get("phase")).toBe("draft-phase");
      publicMapRequests.push({ phase: url.searchParams.get("phase"), snapshotId: activeSnapshot?.id });
      return route.fulfill({ json: {
        tenant: { name: "Hopkins Grove", slug: "hopkins-grove" },
        project: { slug: "hopkins-grove", name: "Hopkins Grove" },
        branding: { company_name: "Hopkins Grove", logo_url: "", short_description: "" },
        phase: { slug: "draft-phase", name: "Draft phase" },
        map_experience_mode: "demo",
        features: [{ map_feature_ref: "published-revision-5-plot", demo_label: "Published revision 5", map_polygon: [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 12, y: 12 }, { x: 10, y: 12 }] }],
        parcels: [],
      } });
    }
    if (url.pathname === "/functions/v1/project-map-review-link") {
      expect(route.request().postDataJSON()).toEqual({ action: "list", ...scope, phase_id: draftPhaseId });
      reviewerLinkRequests++;
      return route.fulfill({ json: { links: [] } });
    }
    const table = url.pathname.split("/").at(-1)!;
    const rows = rowsByTable[table];
    expect(rows, `Unexpected request to ${url.pathname}`).toBeDefined();
    if (["project_map_packages", "map_feature_snapshots", "map_features", "project_plot_content", "parcels"].includes(table)) {
      expect(url.searchParams.get("tenant_id")).toBe(`eq.${tenantId}`);
      expect(url.searchParams.get("project_id")).toBe(`eq.${projectId}`);
      expect([publishedPhaseId, draftPhaseId, emptyPhaseId]).toContain(url.searchParams.get("phase_id")?.slice(3));
    }
    const matching = rows.filter((row) => [...url.searchParams].every(([key, filter]) => {
      if (filter === "is.null") return row[key] === null;
      if (filter === "not.is.null") return row[key] !== null;
      if (filter.startsWith("eq.")) return String(row[key]) === filter.slice(3);
      return true;
    }));
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limitValue = url.searchParams.get("limit");
    const limit = limitValue === null ? null : Number(limitValue);
    const result = limit !== null && Number.isFinite(limit) ? matching.slice(offset, offset + limit) : matching;
    const single = route.request().headers().accept === "application/vnd.pgrst.object+json";
    return route.fulfill({
      headers: limit !== null ? { "content-range": `${offset}-${offset + result.length - 1}/${matching.length}` } : undefined,
      json: single ? result[0] ?? null : result,
    });
  });

  await page.goto("/map-review");
  await expect(page.getByRole("heading", { name: "Current published map" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Map revision details" })).toContainText("Map revision: 3");
  const publishedMap = page.getByRole("group", { name: "Published phase map outlines" });
  await expect(publishedMap.locator("polygon")).toHaveCount(775);
  await expect(page.getByRole("status", { name: "Snapshot outline count" })).toContainText("775 outlines");
  await expect(page.getByRole("button", { name: "Create reviewer link" })).toHaveCount(0);
  expect(reviewerLinkRequests).toBe(0);

  const plotSearch = page.getByLabel("Search plots");
  await expect(page.getByText("Page 1 of 31", { exact: true })).toBeVisible();
  await plotSearch.fill("Plot 775");
  await expect(page.getByRole("status", { name: "Plot search results" })).toContainText("1 of 775 outlines match");
  const plot775Result = page.getByRole("button", { name: "Select Plot 775", exact: false });
  await expect(plot775Result).toBeVisible();
  await plotSearch.focus();
  await page.keyboard.press("Tab");
  await expect(plot775Result).toBeFocused();
  await page.keyboard.press("Enter");
  const selectedPlot = page.getByRole("status", { name: "Selected plot" });
  await expect(selectedPlot).toContainText("Plot 775");
  await expect(selectedPlot).toContainText("Reviewed");
  await expect(selectedPlot).toContainText("No linked lot");
  await page.screenshot({ path: testInfo.outputPath("plot-775-search-results.png"), fullPage: true });

  await plotSearch.fill("");
  const plot775OnMap = publishedMap.getByRole("button", { name: "Select outline Plot 775", exact: true });
  await plot775OnMap.click();
  await expect(plot775OnMap).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Select Plot 775", exact: false })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Page 31 of 31", { exact: true })).toBeVisible();
  await expect(selectedPlot).toContainText("Printed label");
  await expect(selectedPlot).toContainText("Plot 775");
  await expect(selectedPlot).toContainText("No linked lot");
  await plot775OnMap.focus();
  await page.keyboard.press("Enter");
  await expect(selectedPlot).toContainText("Plot 775");
  await page.keyboard.press("ArrowRight");
  await expect(selectedPlot).toContainText("Plot 1");
  await expect(page.getByText("Page 1 of 31", { exact: true })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(selectedPlot).toContainText("Plot 775");
  await expect(page.getByText("Page 31 of 31", { exact: true })).toBeVisible();
  const fullMapViewBox = await publishedMap.getAttribute("viewBox");
  await page.getByRole("button", { name: "Zoom to plot" }).click();
  await expect.poll(() => publishedMap.getAttribute("viewBox")).not.toBe(fullMapViewBox);
  await expect(page.getByRole("region", { name: "Published phase map canvas" }).getByRole("button", { name: "Show full map" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("plot-775-selection.png"), fullPage: true });

  await page.getByLabel("Workspace phase").selectOption(draftPhaseId);
  await expect(page.getByRole("heading", { name: "Private map preview" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Map revision details" })).toContainText("Map revision: 5");
  await expect(page.getByRole("group", { name: "Unpublished phase map outlines" }).locator("polygon")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Create reviewer link" })).toBeEnabled();
  await expect(page.getByText("No reviewer links have been created for this phase.")).toBeVisible();

  await page.getByLabel("Workspace phase").selectOption(emptyPhaseId);
  await expect(page.getByText("No draft or published map is available for this phase.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Open an accessible phase with a map" })).toBeVisible();
  await page.locator("#accessible-map-phase").selectOption(publishedPhaseId);
  await page.getByRole("button", { name: "Open phase map" }).click();
  await expect(page.getByRole("heading", { name: "Current published map" })).toBeVisible();

  await page.getByLabel("Workspace phase").selectOption(draftPhaseId);
  await expect(page.getByRole("link", { name: "Continue to publish this reviewed package" })).toBeVisible();
  await page.getByRole("link", { name: "Continue to publish this reviewed package" }).click();
  await expect(page).toHaveURL(/\/maps\?packageId=package-draft-snapshot$/);
  await expect(page.getByText("Reviewed package handoff:")).toBeVisible();
  await expect(page.getByText("Target tenant and project:").locator(".." )).toContainText("Hopkins Grove · Hopkins Grove");
  await expect(page.getByText("Package revision:").locator(".." )).toContainText("5");
  await page.getByRole("button", { name: "Review publish details" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("revision 5");
  await page.screenshot({ path: testInfo.outputPath("publish-confirmation.png"), fullPage: true });
  await page.getByLabel(/I confirm this reviewed package/).check();
  await page.getByRole("button", { name: "Publish map" }).click();
  await expect(page.getByText("Revision 5 is now published", { exact: false })).toContainText("Revision 5 is now published for Draft phase");
  await expect.poll(() => rowsByTable.map_feature_snapshots.find((row) => row.phase_id === draftPhaseId && row.is_active === true)?.id).toBe("draft-snapshot");

  const popupErrors: string[] = [];
  page.context().on("page", (openedPage) => openedPage.on("pageerror", (error) => popupErrors.push(error.stack ?? error.message)));
  const popupPromise = page.context().waitForEvent("page");
  await page.getByRole("link", { name: "Preview map" }).click();
  const publicPreview = await popupPromise;
  await expect(publicPreview).toHaveURL(/\/p\/hopkins-grove\/hopkins-grove\/map\?phase=draft-phase$/);
  await expect.poll(() => publicMapRequests.length).toBeGreaterThan(0);
  expect(publicMapRequests.every((request) => request.phase === "draft-phase" && request.snapshotId === "draft-snapshot")).toBe(true);
  expect(popupErrors).toEqual([]);
  await expect(publicPreview.locator("main")).toBeVisible();
  await expect(publicPreview.getByText("Hopkins Grove", { exact: true }).first()).toBeVisible();
  await publicPreview.screenshot({ path: testInfo.outputPath("public-phase-preview.png"), fullPage: true });
});
