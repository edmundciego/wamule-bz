import { expect, test } from "@playwright/test";

const supabaseUrl = new URL(process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321");
const tenantId = "review-tenant";
const projectId = "review-project";
const userId = "review-admin";
const phases = [
  { id: "published", name: "Initial phase", is_default: true },
  { id: "draft", name: "Draft phase", is_default: false },
  { id: "empty", name: "Empty phase", is_default: false },
];
const scope = { tenant_id: tenantId, project_id: projectId };
const publishedAt = "2026-11-11T00:00:00Z";
const publishedSnapshot = { ...scope, phase_id: "published", id: "current-snapshot", is_active: true, snapshot_version: 3, outline_count: 1 };
const olderSnapshot = { ...publishedSnapshot, id: "older-snapshot", is_active: false, snapshot_version: 2 };
const draftSnapshot = { ...scope, phase_id: "draft", id: "draft-snapshot", is_active: false, snapshot_version: 5, outline_count: 1 };

function mapPackage(snapshot: typeof publishedSnapshot, publication: string | null) {
  return {
    ...scope, phase_id: snapshot.phase_id, id: `package-${snapshot.id}`, snapshot_id: snapshot.id,
    package_data: { revision: snapshot.snapshot_version, canvas: { width: 100, height: 100 } },
    background_path: null, published_at: publication,
  };
}

function outline(snapshot: typeof publishedSnapshot, label: string, visible = true) {
  return {
    ...scope, phase_id: snapshot.phase_id, snapshot_id: snapshot.id, identity_id: label,
    is_active: true, public_visible: visible, demo_label: label, provenance: { reviewed: true },
    map_polygon: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }],
  };
}

test("admin Map Review shows the active published revision and keeps draft review available", async ({ page }) => {
  const rowsByTable: Record<string, Array<Record<string, unknown>>> = {
    admin_profiles: [{ user_id: userId, tenant_id: tenantId, role: "Admin" }],
    project_memberships: [],
    organizations: [{ id: tenantId, name: "Review Tenant", slug: tenantId, is_active: true }],
    projects: [{ id: projectId, tenant_id: tenantId, name: "Review Project", slug: projectId, is_default: true, map_experience_mode: "demo" }],
    development_phases: phases.map((phase) => ({ ...scope, ...phase, slug: phase.id, is_active: true })),
    business_settings: [],
    project_map_packages: [
      mapPackage(olderSnapshot, publishedAt),
      mapPackage(publishedSnapshot, publishedAt),
      mapPackage({ ...publishedSnapshot, phase_id: "draft", id: "draft-phase-live" }, publishedAt),
      mapPackage(draftSnapshot, null),
    ],
    map_feature_snapshots: [
      olderSnapshot, publishedSnapshot,
      { ...publishedSnapshot, phase_id: "draft", id: "draft-phase-live" },
      draftSnapshot,
    ],
    map_features: [
      outline(olderSnapshot, "Older"),
      outline(publishedSnapshot, "Current"),
      outline(publishedSnapshot, "Hidden", false),
      outline(draftSnapshot, "Draft", false),
    ],
  };
  let reviewerLinkRequests = 0;
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
    workspace: { tenantId, projectId, phaseId: "published" },
  });

  await page.route((url) => url.origin === supabaseUrl.origin, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/functions/v1/project-map-review-link") {
      expect(route.request().postDataJSON()).toEqual({ action: "list", ...scope, phase_id: "draft" });
      reviewerLinkRequests++;
      return route.fulfill({ json: { links: [] } });
    }
    const table = url.pathname.split("/").at(-1)!;
    const rows = rowsByTable[table];
    expect(rows, `Unexpected request to ${url.pathname}`).toBeDefined();
    if (["project_map_packages", "map_feature_snapshots", "map_features"].includes(table)) {
      expect(url.searchParams.get("tenant_id")).toBe(`eq.${tenantId}`);
      expect(url.searchParams.get("project_id")).toBe(`eq.${projectId}`);
      expect(url.searchParams.get("phase_id")).toMatch(/^eq\.(published|draft|empty)$/);
    }
    const matching = rows.filter((row) => [...url.searchParams].every(([key, filter]) => {
      if (filter === "is.null") return row[key] === null;
      if (filter === "not.is.null") return row[key] !== null;
      if (filter.startsWith("eq.")) return String(row[key]) === filter.slice(3);
      return true;
    }));
    const result = url.searchParams.has("limit") ? matching.slice(0, Number(url.searchParams.get("limit"))) : matching;
    const single = route.request().headers().accept === "application/vnd.pgrst.object+json";
    return route.fulfill({ json: single ? result[0] ?? null : result });
  });

  await page.goto("/map-review");
  await expect(page.getByRole("heading", { name: "Current published map" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Map revision details" })).toContainText("Map revision: 3");
  const publishedMap = page.getByRole("img", { name: "Published phase map outlines" });
  await expect(publishedMap.locator("polygon")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Select outline Current", exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Create reviewer link" })).toHaveCount(0);
  expect(reviewerLinkRequests).toBe(0);

  await page.getByLabel("Workspace phase").selectOption("draft");
  await expect(page.getByRole("heading", { name: "Private map preview" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Map revision details" })).toContainText("Map revision: 5");
  await expect(page.getByRole("img", { name: "Unpublished phase map outlines" }).locator("polygon")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Create reviewer link" })).toBeEnabled();
  await expect(page.getByText("No reviewer links have been created for this phase.")).toBeVisible();

  await page.getByLabel("Workspace phase").selectOption("empty");
  await expect(page.getByText("No draft or published map is available for this phase.")).toBeVisible();
  await expect(page.getByRole("img", { name: /phase map outlines/ })).toHaveCount(0);
});
