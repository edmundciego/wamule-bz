import { expect, test, type Page } from "@playwright/test";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const phaseA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const phaseB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Seed = { role: "Super Admin" | "Staff"; tenantId: string | null; savedTenantId?: string };

async function stubWorkspaceApi(page: Page, seed: Seed) {
  const observedUrls: string[] = [];
  await page.addInitScript(({ userId, role, tenantId, savedTenantId }) => {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const payload = {
      access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: userId, aud: "authenticated", role: "authenticated", iat: now, exp: now + 3600 })}.test-signature`,
      refresh_token: "local-test-refresh",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now + 3600,
      user: { id: userId, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
    };
    localStorage.setItem("sb-kvocwmrcuhiaezlcgzjf-auth-token", JSON.stringify(payload));
    if (savedTenantId) localStorage.setItem(`wamule.active-workspace:${userId}`, JSON.stringify({
      tenantId: savedTenantId,
      projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      phaseId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    }));
    void role;
    void tenantId;
  }, { userId: seed.role === "Super Admin" ? "ffffffff-ffff-4fff-8fff-ffffffffffff" : "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", role: seed.role, tenantId: seed.tenantId, savedTenantId: seed.savedTenantId });

  await page.route("**/rest/v1/**", async (route) => {
    const url = new URL(route.request().url());
    observedUrls.push(`${url.pathname}${url.search}`);
    const table = url.pathname.split("/").at(-1);
    const userId = seed.role === "Super Admin" ? "ffffffff-ffff-4fff-8fff-ffffffffffff" : "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const profile = {
      user_id: userId,
      email: `${seed.role.toLowerCase().replaceAll(" ", ".")}@example.test`,
      full_name: seed.role,
      role: seed.role,
      tenant_id: seed.tenantId,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    let data: unknown = [];
    if (table === "admin_profiles") data = url.searchParams.has("user_id") ? profile : [profile];
    if (table === "organizations") {
      const all = [
        { id: tenantA, name: "Wamule Development", slug: "wamule", is_active: true },
        { id: tenantB, name: "Hopkins Grove", slug: "hopkins-grove", is_active: true },
      ];
      data = all.filter((row) => !url.searchParams.has("id") || url.searchParams.get("id") === `eq.${row.id}`);
    }
    if (table === "projects") {
      const all = [
        { id: projectA, tenant_id: tenantA, name: "Main Development", slug: "main", is_default: true, map_experience_mode: "sales" },
        { id: projectB, tenant_id: tenantB, name: "Hopkins Grove", slug: "grove", is_default: true, map_experience_mode: "demo" },
      ];
      data = all.filter((row) => !url.searchParams.has("tenant_id") || url.searchParams.get("tenant_id") === `eq.${row.tenant_id}`);
    }
    if (table === "development_phases") {
      const all = [
        { id: phaseA, tenant_id: tenantA, project_id: projectA, name: "Initial", slug: "initial", is_default: true, is_active: true },
        { id: phaseB, tenant_id: tenantB, project_id: projectB, name: "Initial", slug: "initial", is_default: true, is_active: true },
      ];
      data = all.filter((row) => (url.searchParams.get("project_id") ?? "").includes(row.project_id));
    }
    if (table === "business_settings") data = { value: { company_name: seed.role === "Super Admin" ? "Hopkins Grove" : "Wamule Development" } };
    if (table === "ai_settings") data = { is_enabled: false };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  return observedUrls;
}

test("Super Admin switches tenant/project/phase, opens the corresponding native map and restores that workspace", async ({ page }, testInfo) => {
  const observed = await stubWorkspaceApi(page, { role: "Super Admin", tenantId: tenantA });
  await page.goto("/leads");
  await expect(page.getByLabel("Workspace tenant")).toHaveValue(tenantA);
  await page.getByLabel("Workspace tenant").selectOption(tenantB);
  await expect(page.getByLabel("Workspace project")).toHaveValue(projectB);
  await expect(page.getByLabel("Workspace phase")).toHaveValue(phaseB);
  await expect(page.getByRole("link", { name: /Open map/ })).toHaveAttribute("href", "/embed/hopkins-grove/grove?phase=initial");
  await expect.poll(() => observed.some((url) => url.includes("/leads?") && url.includes(`tenant_id=eq.${tenantB}`) && url.includes(`project_id=eq.${projectB}`) && url.includes(`phase_id=eq.${phaseB}`))).toBe(true);
  await expect(page.getByText("No leads found")).toBeVisible();
  await expect(page.locator("aside")).toContainText("Hopkins Grove");
  await page.screenshot({ path: testInfo.outputPath("workspace-selector-hopkins.png"), fullPage: true });

  await page.reload();
  await expect(page.getByLabel("Workspace tenant")).toHaveValue(tenantB);
  await expect(page.getByLabel("Workspace project")).toHaveValue(projectB);
  await expect(page.getByLabel("Workspace phase")).toHaveValue(phaseB);
});

test("ordinary staff cannot switch tenant even when storage and URL request another tenant", async ({ page }) => {
  const observed = await stubWorkspaceApi(page, { role: "Staff", tenantId: tenantA, savedTenantId: tenantB });
  await page.goto("/leads?tenant=hopkins");
  const tenantSelect = page.getByLabel("Workspace tenant");
  await expect(tenantSelect).toBeDisabled();
  await expect(tenantSelect).toHaveValue(tenantA);
  await expect(page.getByLabel("Workspace project")).toHaveValue(projectA);
  await expect(page.getByLabel("Workspace phase")).toHaveValue(phaseA);
  await expect.poll(() => observed.some((url) => url.startsWith("/rest/v1/leads?") && url.includes(`tenant_id=eq.${tenantA}`) && url.includes(`project_id=eq.${projectA}`) && url.includes(`phase_id=eq.${phaseA}`))).toBe(true);
  expect(observed.some((url) => url.startsWith("/rest/v1/projects?") && url.includes(`tenant_id=eq.${tenantB}`))).toBe(false);
});
