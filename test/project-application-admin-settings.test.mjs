import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("project application Admin controls use scoped authorized RPCs and preserve independent gates", async () => {
  const migration = await read("../supabase/migrations/20261115052849_project_application_admin_settings.sql");
  const settings = await read("../src/components/admin/settings/ProjectApplicationSettings.tsx");
  assert.match(migration, /create or replace function public\.get_project_application_settings/);
  assert.match(migration, /create or replace function public\.save_project_application_settings/);
  assert.match(migration, /v_role not in \('Super Admin', 'Admin'\)/);
  assert.match(migration, /v_profile_tenant is distinct from p_tenant_id/);
  assert.match(migration, /coalesce\(public\.project_settings\.value, '\{\}'::jsonb\) \|\| excluded\.value/);
  assert.match(migration, /dp\.project_id = p_project_id and dp\.is_active = true/);
  assert.doesNotMatch(migration, /publish_project_map_package/, "application settings must not publish maps");
  assert.match(settings, /resolvePublicApplicationSettings/);
  assert.match(settings, /Effective intake by phase/);
  assert.match(settings, /Open this project’s intake gate/);
  assert.match(settings, /Allowed phases/);
  assert.match(settings, /<Select aria-label="Application type"/);
  assert.match(settings, /aria-label="Required notice version"/);
  assert.match(settings, /aria-label="Public notice"/);
  assert.match(settings, /aria-label="Applicant acknowledgment"/);
  assert.match(settings, /aria-label="Allowed intended uses \(one per line\)"/);
  assert.match(settings, /aria-label="Application confirmation message"/);
});

test("map publishing displays phase and package revision before the existing guarded RPC", async () => {
  const publisher = await read("../src/components/admin/maps/ProjectMapPackagePublisher.tsx");
  const mapMigration = await read("../supabase/migrations/20261019194346_map_studio_packages_and_project_plot_content.sql");
  assert.match(publisher, /<Select aria-label="Map Studio packages for this phase"/);
  assert.match(publisher, /Target phase:/);
  assert.match(publisher, /Package revision:/);
  assert.match(publisher, /role="alertdialog"/);
  assert.match(publisher, /p_expected_active_id:/);
  assert.match(publisher, /publish_project_map_package/);
  assert.match(publisher, /fullyReviewed/);
  assert.match(mapMigration, /perform public\.assert_map_package_scope\(pkg\.tenant_id,pkg\.project_id,pkg\.phase_id\)/);
  assert.match(mapMigration, /current_id is distinct from p_expected_active_id/);
  assert.match(mapMigration, /Review every imported boundary before publishing/);
});

test("shared links use slug routes without hostname lookup and preserve outline deep links", async () => {
  const route = await read("../src/pages/public/SharedProjectRoute.tsx");
  const app = await read("../src/App.tsx");
  const site = await read("../supabase/functions/get-public-site-experience/index.ts");
  const projectPage = await read("../supabase/functions/get-public-project-page/index.ts");
  const applications = await read("../src/pages/ApplicationsPage.tsx");
  assert.match(app, /path="\/p\/:tenant_slug\/:project_slug"/);
  assert.match(app, /path="\/p\/:tenant_slug\/:project_slug\/map"/);
  assert.match(route, /hostname=""/);
  assert.match(site, /if \(hostname\) \{/);
  assert.match(projectPage, /if \(hostname\) \{/);
  assert.match(applications, /\/p\/\$\{encodeURIComponent\(workspace\.tenantSlug\)\}\/\$\{encodeURIComponent\(workspace\.projectSlug\)\}\/map/);
});
