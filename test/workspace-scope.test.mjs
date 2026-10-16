import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const root = new URL("..", import.meta.url);

async function loadScopeHelpers() {
  const source = await readFile(new URL("src/lib/workspaceScope.ts", root), "utf8");
  const javascript = ts.transpile(source, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 });
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

const workspaces = [
  { tenantId: "wamule", tenantName: "Wamule", tenantSlug: "wamule", projectId: "north", projectName: "North", projectSlug: "north", phaseId: "one", phaseName: "Phase One", phaseSlug: "phase-one", mapExperienceMode: "sales", isDefaultProject: true, isDefaultPhase: true },
  { tenantId: "hopkins", tenantName: "Hopkins Grove", tenantSlug: "hopkins-grove", projectId: "grove", projectName: "Grove", projectSlug: "grove", phaseId: "first", phaseName: "Initial", phaseSlug: "initial", mapExperienceMode: "demo", isDefaultProject: true, isDefaultPhase: true },
];

test("workspace choice resolution never honors another tenant from a non-super-admin saved selection", async () => {
  const { accessibleWorkspaceChoices, preferredWorkspace } = await loadScopeHelpers();
  const staffProfile = { user_id: "staff-1", role: "Staff", tenant_id: "wamule" };
  const allowed = accessibleWorkspaceChoices(workspaces, staffProfile);
  assert.deepEqual(allowed.map(({ tenantId }) => tenantId), ["wamule"]);
  assert.equal(preferredWorkspace(allowed, { tenantId: "hopkins", projectId: "grove", phaseId: "first" })?.tenantId, "wamule");
  assert.deepEqual(accessibleWorkspaceChoices(workspaces, { ...staffProfile, tenant_id: null }), []);
});

test("Super Admin profiles retain their current tenant assignment while selecting other tenants", async () => {
  const { accessibleWorkspaceChoices, preferredWorkspace, workspaceScopeKey } = await loadScopeHelpers();
  const superAdmin = { user_id: "sa-1", role: "Super Admin", tenant_id: "wamule" };
  const allowed = accessibleWorkspaceChoices(workspaces, superAdmin);
  assert.equal(allowed.length, 2);
  assert.equal(preferredWorkspace(allowed, { tenantId: "hopkins", projectId: "grove", phaseId: "first" })?.tenantId, "hopkins");
  assert.notEqual(workspaceScopeKey(workspaces[0]), workspaceScopeKey(workspaces[1]));
  assert.notEqual(workspaceScopeKey(workspaces[1]), workspaceScopeKey({ ...workspaces[1], phaseId: "second" }));
});

test("workspace settings defaults and workspace-owned settings surfaces follow the selected tenant", async () => {
  const { workspaceCompanyDefaults, workspaceApplicationDefaults } = await loadScopeHelpers();
  const hopkinsCompany = workspaceCompanyDefaults("Hopkins Grove");
  const hopkinsApplication = workspaceApplicationDefaults("Hopkins Grove");
  assert.equal(hopkinsCompany.company_name, "Hopkins Grove");
  assert.equal(hopkinsCompany.location_address, "");
  assert.match(hopkinsApplication.public_notice_text, /Hopkins Grove/);
  assert.doesNotMatch(hopkinsApplication.public_notice_text, /Wamule/);

  const [settings, embed, masterplan, layout] = await Promise.all([
    readFile(new URL("src/pages/SettingsPage.tsx", root), "utf8"),
    readFile(new URL("src/components/admin/settings/WordPressEmbedSnippet.tsx", root), "utf8"),
    readFile(new URL("src/components/admin/settings/MasterplanUpload.tsx", root), "utf8"),
    readFile(new URL("src/components/layout/AdminLayout.tsx", root), "utf8"),
  ]);
  assert.match(settings, /business_settings"\)\.select\("\*"\)\.eq\("tenant_id", tenantId!/);
  assert.match(settings, /tenantId=\{tenantId\}/);
  assert.match(settings, /tenantSlug=\{workspace\?\.tenantSlug/);
  assert.match(settings, /projectSlug=\{workspace\?\.projectSlug/);
  assert.match(masterplan, /fileTenantId !== tenantId/);
  assert.match(embed, /setProject\(projectSlug \?\? ""\)/);
  assert.doesNotMatch(embed, /from\("admin_profiles"\)/);
  assert.match(layout, /useCompanyProfile\(workspace\?\.tenantId \?\? null, workspace\?\.tenantName \?\? null\)/);
});

test("native map and lead pages are explicitly scoped and workspace changes discard cached data", async () => {
  const [provider, selector, leads, lots, context, migration] = await Promise.all([
    readFile(new URL("src/components/auth/WorkspaceScope.tsx", root), "utf8"),
    readFile(new URL("src/components/auth/WorkspaceScope.tsx", root), "utf8"),
    readFile(new URL("src/pages/LeadsPage.tsx", root), "utf8"),
    readFile(new URL("src/pages/LotsPage.tsx", root), "utf8"),
    readFile(new URL("src/lib/workspaceScope.ts", root), "utf8"),
    readFile(new URL("supabase/migrations/20261014000000_project_phase_hosted_pilot.sql", root), "utf8"),
  ]);
  assert.match(provider, /projectsQuery = projectsQuery\.eq\("tenant_id", profile\.tenant_id!\)/);
  assert.match(provider, /organizationsQuery = organizationsQuery\.eq\("id", profile\.tenant_id!\)/);
  assert.match(provider, /queryClient\.removeQueries\(/);
  assert.match(selector, /disabled=\{!canSelectTenant\}/);
  assert.match(selector, /\/embed\/\$\{encodeURIComponent\(workspace\.tenantSlug\)\}\/\$\{encodeURIComponent\(workspace\.projectSlug\)\}/);
  assert.match(leads, /\.eq\("tenant_id", workspace!\.tenantId\)\s*\.eq\("project_id", workspace!\.projectId\)\s*\.eq\("phase_id", workspace!\.phaseId\)/);
  assert.match(leads, /parcels!leads_parcel_scope_fkey\(id, lot_number, status\)/);
  assert.match(leads, /phase_id: workspace!\.phaseId/);
  assert.match(lots, /\.eq\("tenant_id", workspace!\.tenantId\)\.eq\("project_id", workspace!\.projectId\)\.eq\("phase_id", workspace!\.phaseId\)/);
  assert.match(context, /profile\.role === "Super Admin"/);
  assert.match(migration, /create policy project_phase_read_scope on public\.%I as restrictive for select/);
  assert.match(migration, /public\.user_has_project_access\(tenant_id, project_id, phase_id\)/);
});
