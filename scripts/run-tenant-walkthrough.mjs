import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "@playwright/test";

const supabaseUrl = required("SUPABASE_URL");
const anonKey = required("SUPABASE_ANON_KEY");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
const replayDir = required("REPLAY_DIR");
const databaseUrl = new URL(required("SCHEMA_QUERY_DATABASE_URL"));
assert(["localhost", "127.0.0.1", "::1"].includes(databaseUrl.hostname), "Walkthrough database connection must target the disposable local Supabase stack.");
assert(["postgres:", "postgresql:"].includes(databaseUrl.protocol), "Walkthrough database connection must use PostgreSQL.");
const webOrigin = process.env.WALKTHROUGH_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const mailpitApi = process.env.WALKTHROUGH_MAILPIT_API ?? "http://127.0.0.1:54324/api/v1/messages";
const evidencePath = resolve(process.env.WALKTHROUGH_EVIDENCE_PATH ?? "/tmp/wamule-tenant-walkthrough.json");
const stageTimeoutMs = 5 * 60 * 1000;
const runToken = randomUUID();
const tenantSlug = `ci-${runToken.slice(0, 12)}`;
const projectSlug = "review-map";
const phaseSlug = "initial";
const otherPhaseSlug = "later";
const operationId = randomUUID();
const password = `LocalOnly-${randomUUID()}-aA9!`;
const adminEmail = `admin-${runToken.slice(0, 12)}@example.invalid`;
const staffEmail = `staff-${runToken.slice(0, 12)}@example.invalid`;
const operatorEmail = `operator-${runToken.slice(0, 12)}@example.invalid`;
const service = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
const anonymous = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
const report = {
  workflow: "Wamule five-stage tenant walkthrough v1",
  schema_baseline_commit: process.env.WAMULE_SCHEMA_BASE_COMMIT ?? null,
  tested_commit: process.env.GITHUB_SHA ?? null,
  ci_run_id: process.env.GITHUB_RUN_ID ?? null,
  target: "disposable local Supabase CLI stack only",
  database: { postgres_major: 17 },
  tenant: { slug: tenantSlug, project_slug: projectSlug, intended_phase_slug: phaseSlug, other_phase_slug: otherPhaseSlug },
  stages: [],
  result: "running",
};

let browser;
let context;
let adminBrowser;
let adminContext;
let adminPage;
let stageTimedOut = false;
const signedInClients = [];

async function main() {
  try {
    const [appliedBytes, numberedBytes, adminOverlayBytes] = await Promise.all([
      readFile(resolve(replayDir, "applied-migrations.json")),
      readFile(resolve(replayDir, "numbered-migrations.json")),
      readFile(resolve(replayDir, "project-application-admin-settings-overlay.json")),
    ]);
    const appliedLedger = JSON.parse(appliedBytes.toString("utf8"));
    const numberedLedger = JSON.parse(numberedBytes.toString("utf8"));
    const adminOverlay = JSON.parse(adminOverlayBytes.toString("utf8"));
    const versions = (numberedLedger.migrations ?? []).map((entry) => String(entry.version));
    const overlay = numberedLedger.separately_applied_overlay ?? appliedLedger.m1_5_view_security_overlay;
    assert(versions.length === 73 && appliedLedger.applied_migration_count === 73
      && appliedLedger.ordered_manifest_match === true && numberedLedger.ordered_manifest_match === true
      && appliedLedger.inventory_entry_count === 73 && numberedLedger.inventory_entry_count === 73
      && !versions.includes("20261112040000")
      && overlay?.name === "20261105000100_harden_sensitive_view_access.sql"
      && overlay?.included_in_numbered_ledger === false
      && overlay?.sha256 === "d16b6fba02cb210e9e628f5cf11c555f74db7e18fbe6afe663150158cb72d631",
    "The disposable walkthrough requires the exact ordered 73-entry inventory, excludes 20261112040000, and keeps M1.5 separate.");
    const adminMigrationName = "20261115052849_project_application_admin_settings.sql";
    const adminMigrationPath = resolve(dirname(new URL(import.meta.url).pathname), `../supabase/migrations/${adminMigrationName}`);
    const adminMigrationHash = sha256(await readFile(adminMigrationPath));
    assert(adminOverlay.name === adminMigrationName && adminOverlay.hosted_target_used === false
      && adminOverlay.applied_after_inventory_count === 73 && adminOverlay.included_in_numbered_inventory === false
      && adminOverlay.sha256 === adminMigrationHash,
    "The project application Admin RPC migration must be recorded as a separate local-only feature overlay.");
    report.database = {
      postgres_major: 17, numbered_migration_count: versions.length, m1_5_overlay_separate: true,
      numbered_ledger_sha256: sha256(numberedBytes), m1_5_overlay_sha256: overlay.sha256,
      excluded_compatibility_migration: "20261112040000",
      project_application_admin_settings_overlay: { name: adminOverlay.name, sha256: adminOverlay.sha256, local_only: true },
    };
    console.log("[walkthrough] checking that local Mailpit starts empty");
    const mailpitStartCount = await capturedMailCount();
    assert(mailpitStartCount === 0, "Disposable Mailpit did not start empty; refusing to mix pre-existing mail evidence.");
    report.outbound_delivery = { sink: "local Mailpit only", captured_messages_before: mailpitStartCount };
    const scope = await timedStage("1. Create synthetic tenant and phase-limited Staff", async () => {
      const serviceRoleProbe = checked(await service.rpc("provision_workspace_v1", {
        p_manifest: null, p_apply: false,
      }), "Run the read-only service-role onboarding probe");
      assert(serviceRoleProbe?.status === "invalid" && serviceRoleProbe?.writes === 0,
        "The service-role onboarding probe must reject its empty manifest without writes.");
      const operator = await bootstrapSuperAdmin();
      const companyProfile = {
        company_name: "Wamule CI Synthetic Tenant",
        contact_email: "walkthrough@example.invalid",
        phone_number: "+501-000-0000",
        website: "https://example.invalid",
        location_address: "Synthetic CI fixture",
        short_description: "Synthetic tenant for the automated Wamule review walkthrough.",
        public_notice_text: "Synthetic CI notice only. This is not an offer to sell land.",
      };
      const projectApplication = {
        application_type: "project_application",
        applications_open: false,
        show_lot_prices_publicly: false,
        show_available_lot_count_publicly: false,
        notice_version: "synthetic-ci-v1",
        public_notice_text: "Synthetic CI notice only. Applications are reviewed for testing and do not allocate land.",
        application_acknowledgment_text: "I understand this synthetic application is for CI testing only and does not reserve or allocate land.",
        allowed_intended_uses: ["Residential"],
        max_map_preferences: 3,
        default_confirmation_message: "Synthetic CI application received for review.",
      };
      const manifest = {
        schema_version: 1,
        operation_id: operationId,
        company: {
          slug: tenantSlug,
          name: "Wamule CI Synthetic Tenant",
          default_project_slug: projectSlug,
          settings: { company_profile: companyProfile },
        },
        projects: [{
          slug: projectSlug,
          name: "Synthetic Studio Review Project",
          mode: "demo",
          demo_fixture_bundle: null,
          default_phase_slug: phaseSlug,
          settings: {
            company_profile: companyProfile,
            tenant_theme: { site_experience: { templateId: "wamule-classic", enabledModules: { map: true, inquiry: false, application: true, pricing: false } } },
            public_application: projectApplication,
          },
          phases: [
            { slug: phaseSlug, name: "Initial Review Phase" },
            { slug: otherPhaseSlug, name: "Later Review Phase" },
          ],
        }],
      };
      const provisioned = await invoke(operator, "super-admin-console", { action: "provision", manifest, apply: true });
      assert(provisioned.applied === true && ["applied", "replayed"].includes(provisioned.result?.status), "Supported workspace provisioning did not apply.");

      const listed = await invoke(operator, "super-admin-console", { action: "list" });
      const tenant = listed.tenants?.find((item) => item.slug === tenantSlug);
      const project = tenant?.projects?.find((item) => item.slug === projectSlug);
      const phase = project?.phases?.find((item) => item.slug === phaseSlug);
      const otherPhase = project?.phases?.find((item) => item.slug === otherPhaseSlug);
      assert(tenant?.id && project?.id && phase?.id && otherPhase?.id, "Provisioned tenant, project, or phases were not returned by the supported console.");

      const adminUser = await createConfirmedUser(adminEmail, "Wamule CI Synthetic Admin");
      const adminAssignment = await invoke(operator, "super-admin-console", {
        action: "member", target_user_id: adminUser.id, tenant_id: tenant.id, profile_role: "Admin", memberships: [],
      });
      assert(adminAssignment.ok === true, "Synthetic tenant Admin could not be assigned by the authorized member flow.");

      const staffUser = await createConfirmedUser(staffEmail, "Wamule CI Synthetic Staff");
      const staffManifest = {
        ...manifest,
        users: [{
          identity: { mode: "existing", auth_user_id: staffUser.id },
          profile_role: "Staff",
          memberships: [{ project_slug: projectSlug, member_role: "staff", phase_slugs: [phaseSlug] }],
        }],
      };
      const staffOnboarding = await invoke(operator, "super-admin-console", { action: "provision", manifest: staffManifest, apply: true });
      assert(staffOnboarding.applied === true && staffOnboarding.result?.workspace_access_ready === true,
        "The supported M4.3 onboarding flow did not assign phase-limited Staff access.");

      const admin = await signedInClient(adminEmail);
      const staff = await signedInClient(staffEmail);
      const staffMemberships = checked(await staff.from("project_memberships").select("project_id,phase_id,member_role").eq("tenant_id", tenant.id), "Read Staff phase assignments");
      assert(staffMemberships.length === 1 && staffMemberships[0].phase_id === phase.id, "Staff received access outside the one assigned phase.");
      const bindingCount = countLocalHostnameBindings(tenant.id);
      assert(bindingCount === 0, "Synthetic tenant unexpectedly has a hostname binding.");

      report.identities = { admin_user_id: adminUser.id, staff_user_id: staffUser.id, operator_user_id: operator.userId };
      report.stages[0].evidence = {
        tenant_id: tenant.id, project_id: project.id, phase_ids: [phase.id, otherPhase.id],
        staff_memberships: staffMemberships.length, staff_assigned_phase_id: staffMemberships[0].phase_id,
        hostname_binding_count: bindingCount, hostname_binding_count_source: "local PostgreSQL read-only count query",
        service_role_rpc_probe: "passed (read-only, zero writes)",
        onboarding: "supported provision_workspace_v1 and M4.3 member onboarding",
      };
      return { tenantId: tenant.id, projectId: project.id, phaseId: phase.id, otherPhaseId: otherPhase.id, admin, staff, manifest, projectApplication };
    });

    const imported = await timedStage("2. Import reviewed Studio package through authenticated Admin", async () => {
      const asset = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=", "base64");
      const backgroundHash = sha256(asset);
      const datasetId = randomUUID();
      const packageData = {
        format: "wamule-map-package",
        version: "1",
        dataset_id: datasetId,
        revision: 1,
        title: "Wamule CI Synthetic Reviewed Map",
        source: { sha256: sha256(Buffer.from("synthetic CI source image")), format: "image", units: "unknown" },
        canvas: { width: 100, height: 100, background: { mime: "image/png", sha256: backgroundHash } },
        categories: [{ key: "reference", label: "Reference only", color: "#2b6a4c", price_cents: null, currency: null, price_basis: "reference only" }],
        plots: [
          { key: "syn-plot-a", kind: "plot", number: "SYN-001", polygon: [{ x: 5, y: 5 }, { x: 45, y: 5 }, { x: 45, y: 45 }, { x: 5, y: 45 }], category_key: "reference", reviewed: false },
          { key: "syn-plot-b", kind: "plot", number: "SYN-002", polygon: [{ x: 55, y: 55 }, { x: 95, y: 55 }, { x: 95, y: 95 }, { x: 55, y: 95 }], category_key: "reference", reviewed: false },
        ],
      };
      const backgroundPath = `${scope.tenantId}/${scope.projectId}/${scope.phaseId}/${backgroundHash}.png`;
      const upload = await scope.admin.storage.from("project-map-packages").upload(backgroundPath, asset, { contentType: "image/png", upsert: false });
      if (upload.error) throw new Error(`Admin Storage upload failed: ${upload.error.message}`);
      const staged = checked(await scope.admin.rpc("stage_project_map_package", {
        p_tenant_id: scope.tenantId, p_project_id: scope.projectId, p_phase_id: scope.phaseId,
        p_package: packageData, p_background_path: backgroundPath,
      }), "Stage private Map Studio package");
      const stagedRow = Array.isArray(staged) ? staged[0] : staged;
      assert(stagedRow?.id && stagedRow?.snapshot_id && stagedRow?.total === packageData.plots.length, "Map Studio import returned incomplete package evidence.");
      const bucket = checked(await service.storage.getBucket("project-map-packages"), "Verify Map Studio Storage bucket settings");
      assert(bucket?.public === false, "Map Studio Storage bucket is not private.");
      const downloaded = checked(await scope.admin.storage.from("project-map-packages").download(backgroundPath), "Admin Storage background download");
      const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
      assert(downloadedBytes.equals(asset), "Uploaded Studio background did not load back from private Storage.");
      const featureIdentities = checked(await scope.admin.from("map_feature_identities")
        .select("id,feature_key").eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.phaseId)
        .like("feature_key", `studio:${datasetId}:%`).order("feature_key"), "Read imported stable outline identities");
      const keys = featureIdentities.map((row) => String(row.feature_key).split(":").at(-1)).sort();
      assert(JSON.stringify(keys) === JSON.stringify(["syn-plot-a", "syn-plot-b"]), "Imported stable outline keys do not match the reviewed package.");
      const packageRow = checked(await scope.admin.from("project_map_packages")
        .select("id,snapshot_id,package_data,background_path,published_at").eq("id", stagedRow.id).single(), "Verify private imported package");
      assert(packageRow.published_at === null && packageRow.package_data.revision === 1, "Imported package became public before approval.");
      const publicMap = await publicGet("get-public-lots", { tenant: tenantSlug, project: projectSlug, phase: phaseSlug });
      assert(publicMap.response.status === 404, "Anonymous public map endpoint exposed the unpublished package.");
      const anonymousPackage = await anonymous.from("project_map_packages").select("id").eq("id", stagedRow.id);
      assert(anonymousPackage.data?.length !== 1, "Anonymous caller read private package data.");
      const anonymousAsset = await anonymous.storage.from("project-map-packages").download(backgroundPath);
      assert(anonymousAsset.data === null, "Anonymous caller downloaded the private Storage background.");
      report.stages[1].evidence = {
        package_id: stagedRow.id, snapshot_id: stagedRow.snapshot_id, package_revision: packageData.revision,
        outline_count: featureIdentities.length, outline_identity_ids: featureIdentities.map((row) => row.id),
        package_keys_match: true, background_loaded_from_storage: true, background_bucket_private: bucket.public === false,
        published_before_signoff: false, anonymous_map_status: publicMap.response.status,
        anonymous_package_access: anonymousPackage.error ? "denied" : "no rows",
        anonymous_storage_access: anonymousAsset.error ? "denied" : "no object",
      };
      return { packageId: stagedRow.id, snapshotId: stagedRow.snapshot_id, packageData, backgroundPath, featureIdentities };
    });

    await timedStage("3. Configure project application settings in Admin with intake closed", async () => {
      const settingsPage = await ensureAdminPage(scope);
      await settingsPage.goto(`${webOrigin}/settings`, { waitUntil: "domcontentloaded" });
      await settingsPage.getByRole("heading", { name: "Settings", exact: true }).waitFor({ state: "visible", timeout: 30000 });
      await setTenantApplicationGate(settingsPage, false);
      await saveProjectApplicationControls(settingsPage, false);
      const effective = await effectiveIntakeRows(settingsPage);
      assert(/Closed/.test(effective.initial) && /Closed/.test(effective.later),
        `The Admin effective intake view must show both phases closed before publication: ${JSON.stringify(effective)}`);
      const deniedProjectSettings = await scope.admin.from("project_settings").select("key")
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).limit(1);
      assert(deniedProjectSettings.error?.code === "42501", "Authenticated Admin unexpectedly gained direct access to server-only project settings.");
      const projectSettings = checked(await service.from("project_settings").select("key,value")
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).in("key", ["tenant_theme", "public_application"]), "Read scoped project configuration");
      const settingsByKey = Object.fromEntries(projectSettings.map((row) => [row.key, row.value]));
      const appSetting = settingsByKey.public_application;
      const companyApplication = checked(await service.from("business_settings").select("value")
        .eq("tenant_id", scope.tenantId).eq("key", "public_application").single(), "Read tenant-wide application gate after Admin save");
      assert(settingsByKey.tenant_theme?.site_experience?.templateId === "wamule-classic", "Project presentation did not preserve wamule-classic.");
      assert(appSetting.application_type === "project_application" && appSetting.applications_open === false
        && JSON.stringify(appSetting.allowed_phase_ids) === JSON.stringify([scope.phaseId])
        && appSetting.notice_version === "synthetic-ci-v1"
        && appSetting.public_notice_text.includes("Synthetic CI notice only")
        && appSetting.application_acknowledgment_text.includes("CI testing only")
        && JSON.stringify(appSetting.allowed_intended_uses) === JSON.stringify(["Residential"]),
      "Admin did not save the project application type, Initial-only allowlist, required notice, acknowledgment, and intended use.");
      assert(companyApplication?.value?.applications_open === false,
        "The existing tenant-wide application gate was not closed through Admin.");
      const [parcelCount, otherPackages, otherFeatures] = await Promise.all([
        countRows(service, "parcels", { tenant_id: scope.tenantId, project_id: scope.projectId }),
        countRows(scope.admin, "project_map_packages", { tenant_id: scope.tenantId, project_id: scope.projectId, phase_id: scope.otherPhaseId }),
        countRows(scope.admin, "map_feature_identities", { tenant_id: scope.tenantId, project_id: scope.projectId, phase_id: scope.otherPhaseId }),
      ]);
      assert(parcelCount === 0 && otherPackages === 0 && otherFeatures === 0, "Reference-only or other-phase map scope contains sales inventory or map features.");
      const otherPublicMap = await publicGet("get-public-lots", { tenant: tenantSlug, project: projectSlug, phase: otherPhaseSlug });
      assert(otherPublicMap.response.status === 404, "Other phase map was available before publication.");
      const closedBody = submissionBody(tenantSlug, projectSlug, otherPhaseSlug, randomUUID(), []);
      const closedResponse = await postPublic("submit-hopkins-project-application", closedBody);
      assert(closedResponse.status === 403,
        `Other phase intake was not denied while it remained closed (HTTP ${closedResponse.status}: ${closedResponse.body?.error ?? "no error detail"}).`);
      const intendedClosedBody = submissionBody(tenantSlug, projectSlug, phaseSlug, randomUUID(), []);
      const intendedClosedResponse = await postPublic("submit-hopkins-project-application", intendedClosedBody);
      assert(intendedClosedResponse.status === 403,
        `The intended phase intake opened before the public stage (HTTP ${intendedClosedResponse.status}: ${intendedClosedResponse.body?.error ?? "no error detail"}).`);
      report.stages[2].evidence = {
        project_template: settingsByKey.tenant_theme.site_experience.templateId,
        admin_click_path: ["Settings", "Company Profile", "Public Application Settings", "Applications open: off", "Save section", "Project Applications", "Application type: Project application", "Allowed phases: Initial Review Phase only", "Save project application settings"],
        tenant_applications_open: companyApplication.value.applications_open,
        project_application_type: appSetting.application_type, project_applications_open: appSetting.applications_open,
        allowed_phase_ids: appSetting.allowed_phase_ids, effective_intake_by_phase: effective,
        notice_version: appSetting.notice_version, intended_uses: appSetting.allowed_intended_uses,
        intended_phase_intake_open: false,
        project_settings_access: "server-only; authenticated Admin denied by table ACL; scoped values verified through the application service role",
        reference_only_demo_mode: true, saleable_parcel_count: parcelCount,
        other_phase_package_count: otherPackages, other_phase_outline_count: otherFeatures,
        other_phase_public_map_status: otherPublicMap.response.status,
        other_phase_submission_status: closedResponse.status,
        intended_phase_submission_status: intendedClosedResponse.status,
      };
    });

    const staffPreview = await timedStage("4. Preview and sign off with scoped Staff access", async () => {
      const staffPackages = checked(await scope.staff.from("project_map_packages").select("id,snapshot_id,package_data,background_path,published_at")
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.phaseId), "Staff read assigned private package");
      assert(staffPackages.length === 1 && staffPackages[0].id === imported.packageId, "Staff could not read the assigned phase package.");
      const staffMapFeatures = checked(await scope.staff.from("map_features").select("identity_id,demo_label,map_polygon")
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.phaseId)
        .eq("snapshot_id", imported.snapshotId).order("demo_label"), "Staff preview outline geometry");
      assert(staffMapFeatures.length === 2, "Staff preview did not load all package outline geometry.");
      const previewAsset = checked(await scope.staff.storage.from("project-map-packages").download(imported.backgroundPath), "Staff preview private background from Storage");
      assert(Buffer.from(await previewAsset.arrayBuffer()).length > 0, "Staff preview background was empty.");
      const otherStaffMap = await scope.staff.from("project_map_packages").select("id")
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.otherPhaseId);
      const otherStaffFeatures = await scope.staff.from("map_features").select("identity_id")
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.otherPhaseId);
      assert(otherStaffMap.data?.length === 0 && otherStaffFeatures.data?.length === 0,
        "Phase-restricted Staff could read outside their assignment.");
      const selectedIdentity = imported.featureIdentities[0];
      assert(staffMapFeatures.some((feature) => feature.identity_id === selectedIdentity.id), "Selected Staff preview outline is not in the phase map.");
      const snapshot = checked(await scope.admin.from("map_feature_snapshots").select("id,snapshot_version,outline_count,is_active")
        .eq("id", imported.snapshotId).single(), "Record exact map revision for sign-off");
      assert(snapshot.snapshot_version === 1 && snapshot.is_active === false, "Sign-off revision is not the expected unpublished revision 1.");

      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
      const staffPage = await context.newPage();
      await staffPage.goto(`${webOrigin}/login`, { waitUntil: "domcontentloaded" });
      await staffPage.getByLabel("Email", { exact: true }).fill(staffEmail);
      await staffPage.getByLabel("Password", { exact: true }).fill(password);
      await staffPage.getByRole("button", { name: /Sign in/ }).click();
      await staffPage.waitForURL(/\/dashboard$/, { timeout: 30000 });
      const tenantSelect = staffPage.getByLabel("Workspace tenant");
      const projectSelect = staffPage.getByLabel("Workspace project");
      const phaseSelect = staffPage.getByLabel("Workspace phase");
      await phaseSelect.waitFor({ state: "visible", timeout: 30000 });
      const [tenantChoiceCount, projectChoiceCount, phaseOptions] = await Promise.all([
        tenantSelect.locator("option").count(), projectSelect.locator("option").count(), phaseSelect.locator("option").allTextContents(),
      ]);
      assert(tenantChoiceCount === 1 && projectChoiceCount === 1 && phaseOptions.length === 1
        && await tenantSelect.inputValue() === scope.tenantId
        && await projectSelect.inputValue() === scope.projectId
        && await phaseSelect.inputValue() === scope.phaseId
        && phaseOptions[0] === "Initial Review Phase",
      "Normal Staff workspace lookup exposed a tenant, project, or phase outside its assignment.");
      await staffPage.goto(`${webOrigin}/map-review`, { waitUntil: "domcontentloaded" });
      await staffPage.getByRole("heading", { name: "Private map preview", exact: true }).waitFor({ state: "visible", timeout: 30000 });
      await staffPage.getByText(`Map revision: ${snapshot.snapshot_version} · package revision ${imported.packageData.revision}`, { exact: true })
        .waitFor({ state: "visible", timeout: 15000 });
      const selectedFeature = staffMapFeatures.find((feature) => feature.identity_id === selectedIdentity.id);
      assert(selectedFeature, "Staff preview did not return the selected stable outline identity.");
      await staffPage.getByRole("button", { name: `Select outline ${selectedFeature.demo_label}`, exact: true }).last().click();
      await staffPage.getByRole("status", { name: "Selected outline" }).getByText(selectedIdentity.id, { exact: false }).waitFor({ state: "visible", timeout: 10000 });
      await staffPage.screenshot({ path: resolve(dirname(evidencePath), "tenant-walkthrough-private-preview.png"), fullPage: false });

      const anonMap = await publicGet("get-public-lots", { tenant: tenantSlug, project: projectSlug, phase: phaseSlug });
      const anonSite = await publicGet("get-public-site-experience", { tenant: tenantSlug, project: projectSlug, phase: phaseSlug });
      const anonAsset = await anonymous.storage.from("project-map-packages").download(imported.backgroundPath);
      assert(anonMap.response.status === 404 && anonAsset.data === null,
        "Anonymous caller accessed unpublished map data or its private background before sign-off.");
      const anonSiteHasPrivateMapData = ["features", "parcels", "package_data", "background_path", "snapshot_id"]
        .some((key) => Object.hasOwn(anonSite.body, key));
      assert(anonSite.response.status === 200
        && anonSite.body.scope?.tenantSlug === tenantSlug
        && anonSite.body.scope?.projectSlug === projectSlug
        && anonSite.body.scope?.phaseSlug === phaseSlug
        && !anonSiteHasPrivateMapData,
      "The signed-out project link did not return only its public site projection before map publication.");
      const signoff = checked(await scope.admin.rpc("review_project_map_package", { p_package_id: imported.packageId }), "Admin sign off reviewed package");
      const reviewedFeatures = checked(await scope.admin.from("map_features").select("identity_id,provenance")
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.phaseId)
        .eq("snapshot_id", imported.snapshotId), "Verify Admin sign-off markers");
      assert(reviewedFeatures.length === snapshot.outline_count && reviewedFeatures.every((feature) => feature.provenance?.reviewed === true),
        "Map sign-off did not mark every outline in the reviewed revision.");

      await staffPage.getByRole("link", { name: "Sign out", exact: true }).click();
      await staffPage.waitForURL(/\/login$/, { timeout: 15000 });
      const adminPage = await context.newPage();
      await adminPage.goto(`${webOrigin}/login`, { waitUntil: "domcontentloaded" });
      await adminPage.getByLabel("Email", { exact: true }).fill(adminEmail);
      await adminPage.getByLabel("Password", { exact: true }).fill(password);
      await adminPage.getByRole("button", { name: /Sign in/ }).click();
      await adminPage.waitForURL(/\/dashboard$/, { timeout: 30000 });
      await adminPage.getByLabel("Workspace phase").waitFor({ state: "visible", timeout: 30000 });
      assert(await adminPage.getByLabel("Workspace tenant").inputValue() === scope.tenantId
        && await adminPage.getByLabel("Workspace project").inputValue() === scope.projectId
        && await adminPage.getByLabel("Workspace phase").inputValue() === scope.phaseId,
      "Admin reviewer-link creation did not resolve the intended workspace and phase.");
      await adminPage.goto(`${webOrigin}/map-review`, { waitUntil: "domcontentloaded" });
      await adminPage.getByRole("heading", { name: "Private map preview", exact: true }).waitFor({ state: "visible", timeout: 30000 });
      await adminPage.getByRole("heading", { name: "Signed reviewer link", exact: true }).waitFor({ state: "visible", timeout: 15000 });
      await adminPage.getByRole("button", { name: "Create reviewer link", exact: true }).click();
      const primaryLinkUrl = await adminPage.getByLabel("New signed reviewer link").inputValue();
      const primaryToken = primaryLinkUrl.split("#").at(-1) ?? "";
      const primaryTokenParts = primaryToken.split(".");
      assert(primaryLinkUrl.startsWith(`${webOrigin}/review#v1.`) && primaryTokenParts.length === 4
        && UUID(primaryTokenParts[1]), "Admin did not create a signed fragment-only reviewer link.");
      const primaryLinkId = primaryTokenParts[1];
      const primaryLinkList = await invoke(scope.admin, "project-map-review-link", {
        action: "list", tenant_id: scope.tenantId, project_id: scope.projectId, phase_id: scope.phaseId,
      });
      const primaryRecord = primaryLinkList.links?.find((link) => link.id === primaryLinkId);
      assert(primaryRecord?.snapshot_id === imported.snapshotId && primaryRecord?.package_id === imported.packageId,
        "The signed reviewer link was not stored against the exact approved map package and snapshot.");
      const frozenSettings = primaryRecord.settings_snapshot;
      assert(frozenSettings?.phase_slug === phaseSlug && frozenSettings?.template_id === "wamule-classic"
        && frozenSettings?.application_type === "project_application"
        && frozenSettings?.public_application?.applications_open === false
        && frozenSettings?.public_application?.notices_complete === true
        && frozenSettings?.public_application?.intended_uses?.[0] === "Residential"
        && frozenSettings?.public_application?.max_map_preferences === 3,
      "The reviewer link did not freeze the intended phase, application type, presentation, and closed intake settings.");
      const anonymousLinkTable = await anonymous.from("project_map_review_links").select("id").limit(1);
      assert(anonymousLinkTable.error, "Anonymous callers can read the private review-link table directly.");

      const initialResolve = await postPublic("project-map-review-link", { action: "resolve", token: primaryToken });
      assert(initialResolve.status === 200 && initialResolve.body.revision?.snapshot_id === imported.snapshotId
        && initialResolve.body.revision?.snapshot_version === snapshot.snapshot_version
        && initialResolve.body.features?.length === snapshot.outline_count,
      "The signed link did not resolve to the reviewed unpublished snapshot.");
      const resolverHeaders = {
        apikey: anonKey,
        "Content-Type": "application/json",
      };
      const assetResponse = await fetch(`${supabaseUrl}/functions/v1/project-map-review-link`, {
        method: "POST", headers: resolverHeaders,
        body: JSON.stringify({ action: "asset", token: primaryToken }), cache: "no-store",
      });
      const reviewerAssetBytes = Buffer.from(await assetResponse.arrayBuffer());
      assert(assetResponse.status === 200 && reviewerAssetBytes.length > 0
        && assetResponse.headers.get("content-type") === "image/png"
        && /no-store/i.test(assetResponse.headers.get("cache-control") ?? "")
        && /no-referrer/i.test(assetResponse.headers.get("referrer-policy") ?? ""),
      "The reviewer link did not load the private background through a no-store, revocable asset path.");

      const crossPhaseAttempt = await postPublic("project-map-review-link", {
        action: "resolve", token: primaryToken, phase_id: scope.otherPhaseId,
      });
      assert(crossPhaseAttempt.status === 404, "The reviewer link resolved when asked to open another phase.");
      const crossPhaseAssetAttempt = await postPublic("project-map-review-link", {
        action: "asset", token: primaryToken, phase_id: scope.otherPhaseId,
      });
      assert(crossPhaseAssetAttempt.status === 404, "The reviewer link served a private asset when asked to open another phase.");
      const tamperedToken = `${primaryToken.slice(0, -1)}${primaryToken.endsWith("A") ? "B" : "A"}`;
      const tamperedAttempt = await postPublic("project-map-review-link", { action: "resolve", token: tamperedToken });
      assert(tamperedAttempt.status === 404, "A modified reviewer-link signature was accepted.");

      let reviewMeta;
      let applicationsBeforeReviewerPost;
      let leadsBeforeReviewerPost;
      let applicationsAfterReviewerPost;
      let leadsAfterReviewerPost;
      let blockedReviewerSubmission;
      let unsupportedReviewSubmit;
      const reviewerContext = await browser.newContext({ viewport: { width: 1365, height: 900 } });
      try {
        assert((await reviewerContext.cookies()).length === 0, "The signed-out reviewer browser inherited an authenticated cookie.");
        const reviewerPage = await reviewerContext.newPage();
        await reviewerPage.goto(primaryLinkUrl, { waitUntil: "domcontentloaded" });
        await reviewerPage.getByRole("heading", { name: "Synthetic Studio Review Project map review", exact: true })
          .waitFor({ state: "visible", timeout: 30000 });
        await reviewerPage.getByText(`Map revision: ${snapshot.snapshot_version} · package revision ${imported.packageData.revision}`, { exact: true })
          .waitFor({ state: "visible", timeout: 15000 });
        const reviewerBackground = reviewerPage.locator("svg image");
        await reviewerBackground.waitFor({ state: "attached", timeout: 15000 });
        assert((await reviewerBackground.getAttribute("href"))?.startsWith("blob:"),
          "The signed-out reviewer page did not load the private Storage asset into the reviewed map.");
        assert(reviewedFeatures.some((feature) => feature.identity_id === selectedIdentity.id),
          "The reviewed snapshot lost the outline selected during Staff sign-off.");
        await reviewerPage.getByRole("button", { name: `Select outline ${selectedFeature.demo_label}`, exact: true }).last().click();
        await reviewerPage.getByRole("status", { name: "Selected outline" }).getByText(selectedIdentity.id, { exact: false }).waitFor({ state: "visible", timeout: 10000 });
        const selectedPreviewValue = await reviewerPage.getByLabel(/Optional map-outline interests/).inputValue();
        assert(selectedPreviewValue.includes(selectedIdentity.id), "The selected outline was not carried into the read-only form preview.");
        const previewForm = reviewerPage.locator('form[aria-label="Read-only application form preview"]');
        assert(await previewForm.locator('button[type="submit"]').count() === 0
          && await previewForm.locator("fieldset input:enabled").count() === 0,
        "The signed reviewer form preview exposes an editable or submit control.");
        reviewMeta = await reviewerPage.evaluate(() => ({
          robots: document.querySelector('meta[name="robots"]')?.getAttribute("content"),
          referrer: document.querySelector('meta[name="referrer"]')?.getAttribute("content"),
        }));
        assert(reviewMeta.robots?.includes("noindex") && reviewMeta.robots.includes("nofollow")
          && reviewMeta.referrer === "no-referrer", "The signed reviewer route is missing no-index or no-referrer metadata.");
        await reviewerPage.screenshot({ path: resolve(dirname(evidencePath), "tenant-walkthrough-signed-review.png"), fullPage: false });

        applicationsBeforeReviewerPost = await countRows(scope.admin, "applications", {
          tenant_id: scope.tenantId, project_id: scope.projectId, phase_id: scope.phaseId,
        });
        leadsBeforeReviewerPost = await countRows(scope.admin, "leads", {
          tenant_id: scope.tenantId, project_id: scope.projectId, phase_id: scope.phaseId,
        });
        assert(applicationsBeforeReviewerPost === 0 && leadsBeforeReviewerPost === 0,
          "Synthetic applications or leads existed before public intake opened.");
        blockedReviewerSubmission = await postPublic("submit-hopkins-project-application", {
          ...submissionBody(tenantSlug, projectSlug, phaseSlug, randomUUID(), [selectedIdentity.id]),
          reviewer_link_token: primaryToken,
        });
        applicationsAfterReviewerPost = await countRows(scope.admin, "applications", {
          tenant_id: scope.tenantId, project_id: scope.projectId, phase_id: scope.phaseId,
        });
        leadsAfterReviewerPost = await countRows(scope.admin, "leads", {
          tenant_id: scope.tenantId, project_id: scope.projectId, phase_id: scope.phaseId,
        });
        assert(blockedReviewerSubmission.status === 400 && applicationsAfterReviewerPost === 0 && leadsAfterReviewerPost === 0,
          "A reviewer capability submitted an application or changed the application/lead counts.");
        unsupportedReviewSubmit = await postPublic("project-map-review-link", { action: "submit", token: primaryToken });
        assert(unsupportedReviewSubmit.status === 401, "The anonymous reviewer capability reached an Admin or application action.");
        await reviewerPage.goto(`${webOrigin}/dashboard`, { waitUntil: "domcontentloaded" });
        await reviewerPage.waitForURL(/\/login$/, { timeout: 15000 });
      } finally {
        await reviewerContext.close();
      }

      // Revoke a second link through the Admin control and prove that both its
      // map data and private asset paths reject the old bearer capability.
      await adminPage.getByRole("button", { name: "Create reviewer link", exact: true }).click();
      const revokeProbeUrl = await adminPage.getByLabel("New signed reviewer link").inputValue();
      const revokeProbeToken = revokeProbeUrl.split("#").at(-1) ?? "";
      const revokeProbeId = revokeProbeToken.split(".")[1];
      assert(UUID(revokeProbeId), "Admin could not create a second reviewer link for the revocation check.");
      const revokeProbeRow = adminPage.locator(`[data-review-link-id="${revokeProbeId}"]`);
      await revokeProbeRow.getByRole("button", { name: "Revoke reviewer link", exact: true }).click();
      await revokeProbeRow.getByText("Revoked", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
      const revokedResolve = await postPublic("project-map-review-link", { action: "resolve", token: revokeProbeToken });
      const revokedAsset = await postPublic("project-map-review-link", { action: "asset", token: revokeProbeToken });
      assert(revokedResolve.status === 410 && revokedAsset.status === 410,
        "Revoking the reviewer link did not immediately block new map-data and private-asset requests.");

      const expiringLink = await invoke(scope.admin, "project-map-review-link", {
        action: "create", tenant_id: scope.tenantId, project_id: scope.projectId, phase_id: scope.phaseId,
        package_id: imported.packageId, expires_in_seconds: 2,
      });
      assert(typeof expiringLink.token === "string", "The Admin could not create a short-lived link for the expiry check.");
      const expiryWaitStart = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 2400));
      const expiryWaitMs = Math.round(performance.now() - expiryWaitStart);
      const expiredResolve = await postPublic("project-map-review-link", { action: "resolve", token: expiringLink.token });
      assert(expiredResolve.status === 410, "The short-lived reviewer link remained usable after its expiration.");

      const signedOutAdminAction = await postPublic("project-map-review-link", {
        action: "list", tenant_id: scope.tenantId, project_id: scope.projectId, phase_id: scope.phaseId,
      });
      assert(signedOutAdminAction.status === 401, "The reviewer link or anonymous caller reached the Admin link-management action.");
      await adminPage.getByRole("link", { name: "Sign out", exact: true }).click();
      await adminPage.waitForURL(/\/login$/, { timeout: 15000 });

      report.stages[3].evidence = {
        staff_session_authenticated: true, staff_workspace_lookup_verified: true,
        allowed_workspace_choice_counts: { tenants: tenantChoiceCount, projects: projectChoiceCount, phases: phaseOptions.length },
        selected_outline_id: selectedIdentity.id, selected_outline_label: selectedFeature.demo_label,
        revision: { snapshot_id: snapshot.id, snapshot_version: snapshot.snapshot_version, package_revision: imported.packageData.revision },
        settings_reviewed: { tenant_slug: tenantSlug, project_slug: projectSlug, phase_slug: phaseSlug, template_id: "wamule-classic", application_type: "project_application", applications_open: false, reference_only: true },
        staff_phase_package_rows: staffPackages.length, staff_phase_outline_rows: staffMapFeatures.length,
        staff_other_phase_package_rows: otherStaffMap.data?.length ?? 0,
        staff_other_phase_outline_rows: otherStaffFeatures.data?.length ?? 0,
        private_background_loaded_from_storage: true, anonymous_map_status: anonMap.response.status,
        anonymous_site_experience_status: anonSite.response.status, anonymous_storage_access: anonAsset.error ? "denied" : "no object",
        anonymous_site_experience_public_projection_only: !anonSiteHasPrivateMapData,
        admin_signoff: signoff,
        reviewer_link: {
          created_in_admin_ui_before_publication: true,
          signed_out_browser: true,
          link_recorded_in_evidence: false,
          scope_snapshot_id: imported.snapshotId,
          frozen_settings: { template_id: frozenSettings.template_id, application_type: frozenSettings.application_type, applications_open: frozenSettings.public_application.applications_open, notice_version: frozenSettings.public_application.notice_version, max_map_preferences: frozenSettings.public_application.max_map_preferences },
          private_background_loaded_through_revocable_proxy: reviewerAssetBytes.length > 0,
          selected_outline_id: selectedIdentity.id,
          selected_outline_in_form_preview: true,
          no_submit_control: true,
          robots_meta: reviewMeta.robots,
          referrer_meta: reviewMeta.referrer,
          other_phase_status: crossPhaseAttempt.status,
          other_phase_asset_status: crossPhaseAssetAttempt.status,
          modified_signature_status: tamperedAttempt.status,
          protected_admin_route_redirected_to_login: true,
          direct_link_table_access_denied: true,
          application_submit_status: blockedReviewerSubmission.status,
          application_submit_error: blockedReviewerSubmission.body?.error ?? null,
          unsupported_link_submit_action_status: unsupportedReviewSubmit.status,
          applications_before_after_submit: [applicationsBeforeReviewerPost, applicationsAfterReviewerPost],
          leads_before_after_submit: [leadsBeforeReviewerPost, leadsAfterReviewerPost],
          revoked_data_status: revokedResolve.status,
          revoked_asset_status: revokedAsset.status,
          expired_data_status: expiredResolve.status,
          expiry_wait_ms: expiryWaitMs,
          expiry_wait_reason: "Waited for the separately created 2-second test capability to expire before checking the 410 response.",
          admin_link_action_without_session_status: signedOutAdminAction.status,
        },
      };
      await context.close();
      return { selectedFeatureId: selectedIdentity.id, revision: snapshot.snapshot_version, reviewerToken: primaryToken, reviewerLinkId: primaryLinkId, expiredToken: expiringLink.token };
    });

    const submission = await timedStage("5. Publish through Admin, open shared links signed out, and submit idempotently", async () => {
      const settingsPage = await ensureAdminPage(scope);
      await settingsPage.goto(`${webOrigin}/maps`, { waitUntil: "domcontentloaded" });
      await settingsPage.getByRole("heading", { name: "Publish reviewed map package", exact: true }).waitFor({ state: "visible", timeout: 30000 });
      const packageSelect = settingsPage.getByLabel("Map Studio packages for this phase", { exact: true });
      await packageSelect.selectOption(imported.packageId);
      await settingsPage.getByText("Target phase: Initial Review Phase (initial)", { exact: false }).waitFor({ state: "visible", timeout: 15000 });
      await settingsPage.getByText(`Package revision: ${imported.packageData.revision}`, { exact: true }).waitFor({ state: "visible", timeout: 15000 });
      await settingsPage.getByRole("button", { name: "Review publish details", exact: true }).click();
      const publishDialog = settingsPage.getByRole("alertdialog", { name: "Confirm map publication" });
      await publishDialog.getByText(`This publishes revision ${imported.packageData.revision} to phase Initial Review Phase.`, { exact: false })
        .waitFor({ state: "visible", timeout: 10000 });
      await publishDialog.getByLabel(/I confirm this reviewed package should become the displayed map/).check();
      await publishDialog.getByRole("button", { name: "Publish map", exact: true }).click();
      await settingsPage.getByRole("status").filter({ hasText: `Revision ${imported.packageData.revision} is now published for Initial Review Phase. Intake settings were not changed.` })
        .waitFor({ state: "visible", timeout: 20000 });
      const publishedSnapshot = checked(await scope.admin.from("map_feature_snapshots").select("id,snapshot_version,is_active")
        .eq("id", imported.snapshotId).single(), "Verify map revision after Admin publication");
      assert(publishedSnapshot.is_active === true && publishedSnapshot.snapshot_version === staffPreview.revision,
        "Admin publication did not activate the reviewed map revision for Initial.");
      await settingsPage.goto(`${webOrigin}/settings`, { waitUntil: "domcontentloaded" });
      await settingsPage.getByRole("button", { name: "Project Applications", exact: true }).click();
      const closedAfterPublication = await effectiveIntakeRows(settingsPage);
      assert(/Closed/.test(closedAfterPublication.initial) && /Closed/.test(closedAfterPublication.later),
        "Publishing the reviewed map changed an intake gate.");
      await settingsPage.goto(`${webOrigin}/maps`, { waitUntil: "domcontentloaded" });
      await settingsPage.getByRole("heading", { name: "Shared project links", exact: true }).waitFor({ state: "visible", timeout: 30000 });
      const applicationLink = await settingsPage.getByLabel("Shared project application link", { exact: true }).inputValue();
      const mapLink = await settingsPage.getByLabel("Shared project map link", { exact: true }).inputValue();
      const expectedProjectLink = `${webOrigin}/p/${tenantSlug}/${projectSlug}?phase=${phaseSlug}`;
      const expectedMapLink = `${webOrigin}/p/${tenantSlug}/${projectSlug}/map?phase=${phaseSlug}`;
      assert(applicationLink === expectedProjectLink && mapLink === expectedMapLink,
        "Admin shared links do not use the selected tenant, project, and phase slugs.");
      const hostnameBindingCount = countLocalHostnameBindings(scope.tenantId);
      assert(hostnameBindingCount === 0, "Shared project links must work with zero hostname bindings.");

      await settingsPage.goto(`${webOrigin}/settings`, { waitUntil: "domcontentloaded" });
      await saveProjectApplicationControls(settingsPage, true);
      await setTenantApplicationGate(settingsPage, true);
      await settingsPage.getByRole("button", { name: "Project Applications", exact: true }).click();
      const effectiveBeforeSubmit = await effectiveIntakeRows(settingsPage);
      assert(effectiveBeforeSubmit.initial.includes("Initial Review Phase") && /\bOpen\b/.test(effectiveBeforeSubmit.initial)
        && effectiveBeforeSubmit.later.includes("Later Review Phase") && /Closed/.test(effectiveBeforeSubmit.later),
      `Admin effective intake must allow Initial only before submission: ${JSON.stringify(effectiveBeforeSubmit)}`);
      const projectSettingsBeforeSubmit = checked(await service.from("project_settings").select("value")
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).eq("key", "public_application").single(), "Verify project allowlist before public submission");
      const tenantSettingsBeforeSubmit = checked(await service.from("business_settings").select("value")
        .eq("tenant_id", scope.tenantId).eq("key", "public_application").single(), "Verify tenant application gate before public submission");
      assert(projectSettingsBeforeSubmit.value?.applications_open === true
        && JSON.stringify(projectSettingsBeforeSubmit.value?.allowed_phase_ids) === JSON.stringify([scope.phaseId])
        && tenantSettingsBeforeSubmit.value?.applications_open === true,
      "The saved Admin settings do not open only Initial behind both existing gates.");

      const pageSettings = await publicGet("get-public-site-experience", { tenant: tenantSlug, project: projectSlug, phase: phaseSlug });
      assert(pageSettings.response.ok && pageSettings.body.siteExperience?.templateId === "wamule-classic"
        && pageSettings.body.siteExperience?.applicationType === "project_application"
        && pageSettings.body.publicApplication?.applications_open === true,
      "The shared-platform route did not preserve presentation, resolve project application type, or open the intended phase.");
      const otherMap = await publicGet("get-public-lots", { tenant: tenantSlug, project: projectSlug, phase: otherPhaseSlug });
      const otherSite = await publicGet("get-public-site-experience", { tenant: tenantSlug, project: projectSlug, phase: otherPhaseSlug });
      const otherSubmission = await postPublic("submit-hopkins-project-application", submissionBody(tenantSlug, projectSlug, otherPhaseSlug, randomUUID(), []));
      assert(otherMap.response.status === 404
        && otherSite.response.status === 200
        && otherSite.body.publicApplication?.applications_open === false
        && otherSubmission.status === 403,
      "The other phase gained a public map or application path, or its Admin-derived intake gate opened.");
      const mapped = await publicGet("get-public-lots", { tenant: tenantSlug, project: projectSlug, phase: phaseSlug });
      assert(mapped.response.ok && mapped.body.map_experience_mode === "demo" && mapped.body.features?.length === 2,
        "Published shared-platform map did not return the two synthetic outlines.");
      const syn001 = mapped.body.features.find((feature) => feature.demo_label === "SYN-001");
      assert(syn001?.map_feature_ref && syn001.map_feature_ref === staffPreview.selectedFeatureId,
        "SYN-001 is not the same stable outline reviewed by Staff.");
      const reviewerAfterPublication = await postPublic("project-map-review-link", {
        action: "resolve", token: staffPreview.reviewerToken,
      });
      assert(reviewerAfterPublication.status === 200
        && reviewerAfterPublication.body.revision?.snapshot_id === imported.snapshotId
        && reviewerAfterPublication.body.revision?.snapshot_version === staffPreview.revision
        && reviewerAfterPublication.body.scope?.public_application?.applications_open === false,
      "Map publication or intake changes altered the reviewed reviewer-link snapshot.");

      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
      const publicPage = await context.newPage();
      const pageErrors = [];
      const publicFunctionRequests = [];
      context.on("request", (request) => {
        if (request.url().includes("/functions/v1/") || request.url().includes("/rest/v1/rpc/")) {
          publicFunctionRequests.push(request.url());
        }
      });
      publicPage.on("pageerror", (error) => pageErrors.push(error.message));
      const routeState = { first: true, payloads: [], responses: [] };
      await publicPage.route("**/functions/v1/submit-hopkins-project-application", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const posted = route.request().postDataJSON();
        routeState.payloads.push(posted);
        const response = await route.fetch();
        const text = await response.text();
        routeState.responses.push({ status: response.status(), body: JSON.parse(text || "{}") });
        if (routeState.first) {
          routeState.first = false;
          // Simulate a lost response after the real Edge Function committed.
          return route.abort("failed");
        }
        return route.fulfill({ status: response.status(), headers: response.headers(), body: text });
      });
      await publicPage.goto(applicationLink, { waitUntil: "domcontentloaded" });
      await publicPage.getByRole("heading", { name: "Project application", exact: true }).waitFor({ state: "visible", timeout: 30000 });
      await publicPage.getByRole("listbox", { name: /Lots on the map/ }).waitFor({ state: "visible", timeout: 30000 });
      await publicPage.waitForFunction(() => document.title.startsWith("Synthetic Studio Review Project |")
        && document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.startsWith("Synthetic Studio Review Project |"));
      assert(await publicPage.locator('main[data-site-template="wamule-classic"]').count() === 1,
        "Generated signed-out project link did not render the selected project template.");
      await publicPage.getByText("Synthetic CI notice only. Applications are reviewed for testing and do not allocate land.", { exact: true })
        .waitFor({ state: "visible", timeout: 10000 });
      const projectLinkPreviewMetadata = await publicPage.evaluate(() => ({
        title: document.title,
        og_title: document.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? null,
        og_description: document.querySelector('meta[property="og:description"]')?.getAttribute("content") ?? null,
        og_url: document.querySelector('meta[property="og:url"]')?.getAttribute("content") ?? null,
        canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
      }));
      assert(projectLinkPreviewMetadata.og_description?.includes("project team")
        && projectLinkPreviewMetadata.og_url?.includes(`/p/${tenantSlug}/${projectSlug}?phase=${phaseSlug}`),
      "Shared project link did not set project-specific preview metadata.");
      await publicPage.reload({ waitUntil: "domcontentloaded" });
      await publicPage.getByRole("heading", { name: "Project application", exact: true }).waitFor({ state: "visible", timeout: 30000 });
      await publicPage.getByRole("listbox", { name: /Lots on the map/ }).waitFor({ state: "visible", timeout: 30000 });
      await publicPage.waitForFunction(() => document.title.startsWith("Synthetic Studio Review Project |")
        && document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.startsWith("Synthetic Studio Review Project |"));
      const sharedProjectRefreshOk = true;
      const publicMapPage = await context.newPage();
      publicMapPage.on("pageerror", (error) => pageErrors.push(error.message));
      const mapInquiryState = { payloads: [], responses: [] };
      await publicMapPage.route("**/functions/v1/submit-public-inquiry", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const posted = route.request().postDataJSON();
        mapInquiryState.payloads.push(posted);
        const response = await route.fetch();
        const text = await response.text();
        mapInquiryState.responses.push({ status: response.status(), body: JSON.parse(text || "{}") });
        return route.fulfill({ status: response.status(), headers: response.headers(), body: text });
      });
      await publicMapPage.goto(mapLink, { waitUntil: "domcontentloaded" });
      await publicMapPage.getByRole("listbox", { name: /Lots on the map/ }).waitFor({ state: "visible", timeout: 30000 });
      await publicMapPage.getByRole("option", { name: /Select generated map reference SYN-001/ }).waitFor({ state: "visible", timeout: 15000 });
      await publicMapPage.waitForFunction(() => document.title.startsWith("Synthetic Studio Review Project Map |")
        && document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.startsWith("Synthetic Studio Review Project Map |"));
      const mapLinkPreviewMetadata = await publicMapPage.evaluate(() => ({
        title: document.title,
        og_title: document.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? null,
        og_description: document.querySelector('meta[property="og:description"]')?.getAttribute("content") ?? null,
        og_url: document.querySelector('meta[property="og:url"]')?.getAttribute("content") ?? null,
        canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
      }));
      assert(mapLinkPreviewMetadata.og_description?.includes("map")
        && mapLinkPreviewMetadata.og_url?.includes(`/p/${tenantSlug}/${projectSlug}/map?phase=${phaseSlug}`),
      "Shared map link did not set map-specific preview metadata.");
      const [staticProjectHtml, staticMapHtml] = await Promise.all([
        fetch(applicationLink).then((response) => response.text()),
        fetch(mapLink).then((response) => response.text()),
      ]);
      const readStaticPreviewMetadata = (html) => ({
        title: html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? null,
        og_title: html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i)?.[1] ?? null,
        og_description: html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/i)?.[1] ?? null,
      });
      const staticLinkPreviewMetadata = {
        project: readStaticPreviewMetadata(staticProjectHtml),
        map: readStaticPreviewMetadata(staticMapHtml),
        route_specific: false,
      };
      assert(staticLinkPreviewMetadata.project.og_title === "Wamule Development Projects and Maps"
        && staticLinkPreviewMetadata.map.og_title === "Wamule Development Projects and Maps",
      "Static link-preview fallback unexpectedly changed from the public Wamule site metadata.");
      await publicMapPage.reload({ waitUntil: "domcontentloaded" });
      await publicMapPage.getByRole("listbox", { name: /Lots on the map/ }).waitFor({ state: "visible", timeout: 30000 });
      await publicMapPage.getByRole("option", { name: /Select generated map reference SYN-001/ }).waitFor({ state: "visible", timeout: 15000 });
      await publicMapPage.waitForFunction(() => document.title.startsWith("Synthetic Studio Review Project Map |")
        && document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.startsWith("Synthetic Studio Review Project Map |"));
      const sharedMapRefreshOk = true;
      const expiredBackgroundStatus = await publicPage.evaluate(async ({ baseUrl, apiKey, token }) => {
        const response = await fetch(`${baseUrl}/functions/v1/project-map-review-link`, {
          method: "POST",
          headers: { apikey: apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "asset", token }),
          cache: "no-store",
        });
        await response.arrayBuffer();
        return response.status;
      }, { baseUrl: supabaseUrl, apiKey: anonKey, token: staffPreview.expiredToken });
      assert(expiredBackgroundStatus === 410, "Signed-out expired reviewer background request did not return HTTP 410.");
      const publicCookies = await context.cookies();
      const publicStorageKeys = await publicPage.evaluate(() => Object.keys(window.localStorage));
      assert(publicCookies.length === 0 && publicStorageKeys.length === 0,
        "Generated shared project and map links were not exercised in a signed-out browser context.");
      assert(publicFunctionRequests.some((url) => url.includes("get-public-site-experience"))
        && publicFunctionRequests.every((url) => !url.includes("resolve_public_hostname") && !/[?&]host=/.test(url)),
      "Shared slug routes attempted hostname resolution or sent a host selector.");

      await publicMapPage.getByRole("option", { name: /Select generated map reference SYN-001/ }).click();
      await publicMapPage.getByRole("button", { name: "Get more info about this plot", exact: true }).click();
      const inquiryDialog = publicMapPage.getByRole("dialog");
      await inquiryDialog.getByRole("combobox", { name: "Reason for inquiry", exact: true }).selectOption("Other");
      const mapInquiryName = "Wamule CI Synthetic Map Inquiry";
      const mapInquiryEmail = `map-inquiry-${runToken.slice(0, 12)}@example.invalid`;
      const otherReasonText = "Please send the current survey and utility notes.";
      await inquiryDialog.getByRole("textbox", { name: "Full Name", exact: true }).fill(mapInquiryName);
      await inquiryDialog.getByRole("textbox", { name: "Email Address", exact: true }).fill(mapInquiryEmail);
      await inquiryDialog.getByRole("textbox", { name: "What would you like the team to help with?", exact: true }).fill(otherReasonText);
      await inquiryDialog.getByRole("button", { name: "Send Inquiry", exact: true }).click();
      await inquiryDialog.getByRole("heading", { name: "Inquiry Sent!", exact: true }).waitFor({ state: "visible", timeout: 30000 });
      assert(mapInquiryState.payloads.length === 1 && mapInquiryState.responses.length === 1
        && mapInquiryState.responses[0].status === 200 && mapInquiryState.responses[0].body.ok === true
        && mapInquiryState.responses[0].body.emailSent === false && mapInquiryState.responses[0].body.emailSuppressed === true,
      "The map inquiry did not submit once through the existing information-request function with outbound email suppressed.");
      const mapInquiryPayload = mapInquiryState.payloads[0];
      assert(mapInquiryPayload.tenant === tenantSlug && mapInquiryPayload.project === projectSlug
        && mapInquiryPayload.phase === phaseSlug && mapInquiryPayload.specific_map_feature_ref === syn001.map_feature_ref
        && JSON.stringify(mapInquiryPayload.interests) === JSON.stringify(["Other"])
        && mapInquiryPayload.message.includes("Inquiry reason: Other")
        && mapInquiryPayload.message.includes(otherReasonText),
      "The map inquiry did not carry its selected plot, project, phase, and Other reason.");
      const mapInquiryRows = checked(await service.from("leads").select("id,source,project_id,phase_id,parcel_id,map_feature_id,notes,client_reference_id")
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.phaseId)
        .eq("client_reference_id", mapInquiryPayload.client_reference_id), "Verify the map inquiry Lead");
      assert(mapInquiryRows.length === 1 && mapInquiryRows[0].source === "public_inquiry"
        && mapInquiryRows[0].parcel_id === null && mapInquiryRows[0].map_feature_id === syn001.map_feature_ref
        && mapInquiryRows[0].notes?.includes("Specific mapped plot interest: SYN-001")
        && mapInquiryRows[0].notes?.includes("Inquiry reason: Other")
        && mapInquiryRows[0].notes?.includes(otherReasonText),
      "The map inquiry Lead did not retain exactly one selected plot and its reason.");
      const mapInquiryLeadId = mapInquiryRows[0].id;

      await settingsPage.goto(`${webOrigin}/leads`, { waitUntil: "domcontentloaded" });
      const leadSearch = settingsPage.getByLabel("Search leads", { exact: true });
      await leadSearch.waitFor({ state: "visible", timeout: 30000 });
      await leadSearch.fill(mapInquiryEmail);
      const inquiryLeadCard = settingsPage.getByRole("button").filter({ hasText: mapInquiryName }).first();
      await inquiryLeadCard.waitFor({ state: "visible", timeout: 20000 });
      await inquiryLeadCard.click();
      const plotReasonNote = settingsPage.getByText(/Specific mapped plot interest: SYN-001/);
      const otherReasonNote = settingsPage.getByText(/Inquiry reason: Other/);
      await plotReasonNote.first().waitFor({ state: "visible", timeout: 15000 });
      await otherReasonNote.first().waitFor({ state: "visible", timeout: 15000 });
      const mapInquiryPlotVisibleInLeads = await plotReasonNote.count() > 0;
      const mapInquiryReasonVisibleInLeads = await otherReasonNote.count() > 0
        && await settingsPage.getByText(new RegExp(otherReasonText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).count() > 0;
      assert(mapInquiryPlotVisibleInLeads && mapInquiryReasonVisibleInLeads,
        "Admin Leads did not show both the selected plot and inquiry reason.");

      await inquiryDialog.getByRole("button", { name: "Done", exact: true }).click();
      await publicMapPage.screenshot({ path: resolve(dirname(evidencePath), "tenant-walkthrough-shared-map-link.png"), fullPage: false });
      await publicMapPage.getByRole("button", { name: "Apply with this plot", exact: true }).click();
      await publicMapPage.getByRole("heading", { name: "Project application", exact: true }).waitFor({ state: "visible", timeout: 30000 });
      const selectedOutlineInApplication = publicMapPage.locator("#application").getByText("SYN-001", { exact: true });
      await selectedOutlineInApplication.waitFor({ state: "visible", timeout: 15000 });
      const standaloneMapApplySelected = new URL(publicMapPage.url()).searchParams.get("apply_feature") === syn001.map_feature_ref;

      await publicPage.getByRole("option", { name: /Select generated map reference SYN-001/ }).click();
      const removeOutline = publicPage.getByRole("button", { name: "Remove outline from application" });
      await removeOutline.waitFor({ state: "visible", timeout: 10000 });
      await publicPage.getByLabel("Full legal name").fill("Wamule CI Synthetic Applicant");
      await publicPage.getByLabel("Nationality").fill("Synthetic");
      await publicPage.getByLabel("Occupation").fill("CI walkthrough fixture");
      await publicPage.getByLabel("Phone / WhatsApp").fill("+5010000000");
      await publicPage.getByLabel("Email address").fill(`applicant-${runToken.slice(0, 12)}@example.invalid`);
      await publicPage.getByLabel("Intended project use").selectOption("Residential");
      await publicPage.getByLabel("Mailing address").fill("Synthetic CI fixture only");
      await publicPage.getByLabel("I have read and acknowledge the Hopkins project notice and application terms shown above.").check();
      await publicPage.getByLabel("Type your full name to sign").fill("Wamule CI Synthetic Applicant");
      const formButton = publicPage.getByRole("button", { name: "Submit project application" });
      await formButton.click();
      await publicPage.getByRole("alert").first().waitFor({ state: "visible", timeout: 20000 });
      assert(routeState.responses.length === 1 && routeState.responses[0].status === 201
        && routeState.responses[0].body.ok === true && routeState.responses[0].body.deduplicated === false,
      "First actual form request did not commit a new application before its response was dropped.");
      await formButton.click();
      await publicPage.getByRole("heading", { name: "Application received for review" }).waitFor({ state: "visible", timeout: 30000 });
      assert(routeState.responses.length === 2 && routeState.responses[1].status === 200
        && routeState.responses[1].body.deduplicated === true
        && routeState.responses[1].body.application_id === routeState.responses[0].body.application_id,
      "Retry with the same form reference did not return the original application ID.");
      const expectedRefs = [syn001.map_feature_ref];
      assert(JSON.stringify(routeState.payloads[0].preferred_map_feature_refs) === JSON.stringify(expectedRefs),
        "Visible form submission did not preserve the SYN-001 stable map outline ID.");
      assert(UUID(routeState.payloads[0].submission_reference),
        "Public form submission reference is missing or invalid.");
      assert(JSON.stringify(routeState.payloads[0]) === JSON.stringify(routeState.payloads[1]), "Visible retry changed the original application payload.");
      assert(pageErrors.length === 0, "Public application page reported a browser runtime error.");
      const applicationId = Number(routeState.responses[0].body.application_id);
      const applicationsInInitial = await countRows(service, "applications", { tenant_id: scope.tenantId, project_id: scope.projectId, phase_id: scope.phaseId });
      const applicationCountForReference = await countRows(service, "applications", { tenant_id: scope.tenantId, project_id: scope.projectId, phase_id: scope.phaseId, submission_reference: routeState.payloads[0].submission_reference });
      const linkedLeads = checked(await service.from("leads").select("id,application_id").eq("tenant_id", scope.tenantId)
        .eq("project_id", scope.projectId).eq("phase_id", scope.phaseId).eq("application_id", applicationId), "Count linked synthetic lead");
      const leadsInInitial = await countRows(service, "leads", { tenant_id: scope.tenantId, project_id: scope.projectId, phase_id: scope.phaseId });
      assert(applicationsInInitial === 1 && applicationCountForReference === 1 && leadsInInitial === 2
        && linkedLeads.length === 1 && mapInquiryRows.length === 1,
      "Expected one Initial application, its single linked lead, and one separate map inquiry lead.");
      const leadId = linkedLeads[0].id;
      const reservations = await countRows(service, "lot_reservations", { tenant_id: scope.tenantId, application_id: applicationId });
      const transactions = await countRows(scope.admin, "transactions", { tenant_id: scope.tenantId });
      const paymentAllocations = await countRows(scope.admin, "transaction_allocations", { tenant_id: scope.tenantId });
      const feeCharges = await countRows(scope.admin, "fee_charges", { tenant_id: scope.tenantId });
      const emailNotifications = await countRows(service, "email_notifications", { related_table: "applications", related_record_id: String(applicationId) });
      const mailpitEndCount = await capturedMailCount();
      assert(reservations === 0 && transactions === 0 && paymentAllocations === 0 && feeCharges === 0 && emailNotifications === 0,
        "The synthetic project application created a reservation, payment, fee, or outbound message row.");
      assert(mailpitEndCount === mailpitStartCount, "The synthetic walkthrough generated a captured outbound email.");

      await settingsPage.goto(`${webOrigin}/applications`, { waitUntil: "domcontentloaded" });
      await settingsPage.getByRole("heading", { name: "Applications", exact: true }).waitFor({ state: "visible", timeout: 30000 });
      const applicationSummary = settingsPage.getByText(new RegExp(`Application #${applicationId}\\b`));
      await applicationSummary.waitFor({ state: "visible", timeout: 30000 });
      await applicationSummary.click();
      await settingsPage.getByText("Project: Synthetic Studio Review Project", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
      await settingsPage.getByText("Phase: Initial Review Phase", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
      await settingsPage.getByText(/Generated map reference: SYN-001/).waitFor({ state: "visible", timeout: 15000 });
      const applicationMapLink = settingsPage.getByRole("link", { name: "Open this outline on the Initial Review Phase map" });
      const [mapPopup] = await Promise.all([adminContext.waitForEvent("page", { timeout: 15000 }), applicationMapLink.click()]);
      await mapPopup.waitForLoadState("domcontentloaded");
      assert(mapPopup.url().includes(`/p/${tenantSlug}/${projectSlug}/map?phase=${phaseSlug}&feature=${syn001.map_feature_ref}`),
        "Admin application map link did not resolve to the scoped shared-platform route and selected outline.");
      await mapPopup.getByRole("listbox", { name: /Lots on the map/ }).waitFor({ state: "visible", timeout: 30000 });
      assert((await mapPopup.getByRole("option", { name: /SYN-001/ }).getAttribute("aria-selected")) === "true",
        "Admin map link did not select SYN-001.");
      const finalStaffPackages = await scope.staff.from("project_map_packages").select("id")
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.otherPhaseId);
      const finalStaffFeatures = await scope.staff.from("map_features").select("identity_id")
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.otherPhaseId);
      assert(finalStaffPackages.data?.length === 0 && finalStaffFeatures.data?.length === 0,
        "Phase-limited Staff read another phase after publication.");

      await invoke(scope.admin, "project-map-review-link", {
        action: "revoke", tenant_id: scope.tenantId, project_id: scope.projectId,
        phase_id: scope.phaseId, link_id: staffPreview.reviewerLinkId,
      });
      const reviewerAfterRevoke = await postPublic("project-map-review-link", {
        action: "resolve", token: staffPreview.reviewerToken,
      });
      const reviewerAssetAfterRevoke = await postPublic("project-map-review-link", {
        action: "asset", token: staffPreview.reviewerToken,
      });
      assert(reviewerAfterRevoke.status === 410 && reviewerAssetAfterRevoke.status === 410,
        "The primary reviewer link remained usable after Admin revocation.");
      await settingsPage.goto(`${webOrigin}/settings`, { waitUntil: "domcontentloaded" });
      await saveProjectApplicationControls(settingsPage, false);
      await setTenantApplicationGate(settingsPage, false);
      await settingsPage.getByRole("button", { name: "Project Applications", exact: true }).click();
      const finalEffective = await effectiveIntakeRows(settingsPage);
      assert(/Closed/.test(finalEffective.initial) && /Closed/.test(finalEffective.later),
        `Final Admin effective intake must be closed for every phase: ${JSON.stringify(finalEffective)}`);
      const finalProjectSetting = checked(await service.from("project_settings").select("value")
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).eq("key", "public_application").single(), "Verify final project intake closure");
      const finalTenantSetting = checked(await service.from("business_settings").select("value")
        .eq("tenant_id", scope.tenantId).eq("key", "public_application").single(), "Verify final tenant intake closure");
      assert(finalProjectSetting.value?.applications_open === false && finalTenantSetting.value?.applications_open === false,
        "Final Admin saves did not close both intake gates.");
      await settingsPage.getByRole("link", { name: "Sign out", exact: true }).click();
      await settingsPage.waitForURL(/\/login$/, { timeout: 15000 });

      const result = {
        application_id: applicationId,
        lead_id: leadId,
        same_id_on_retry: true,
        retry_deduplicated: true,
        selected_outline_label: "SYN-001",
        selected_outline_id: syn001.map_feature_ref,
        applications_in_initial: applicationsInInitial,
        application_count_for_reference: applicationCountForReference,
        leads_in_initial: leadsInInitial,
        linked_lead_count: linkedLeads.length,
        map_inquiry_lead_id: mapInquiryLeadId,
        map_inquiry_lead_count: mapInquiryRows.length,
        map_inquiry_record_count: mapInquiryRows.length,
        map_inquiry_reason_visible_in_leads: mapInquiryReasonVisibleInLeads,
        map_inquiry_plot_visible_in_leads: mapInquiryPlotVisibleInLeads,
        map_inquiry_email_suppressed: mapInquiryState.responses[0].body.emailSuppressed === true,
        standalone_map_apply_selected_SYN_001: standaloneMapApplySelected,
        outbound_email_rows: emailNotifications,
        payment_transaction_rows: transactions,
        payment_allocation_rows: paymentAllocations,
        fee_charge_rows: feeCharges,
        reservation_rows: reservations,
        final_effective_intake_by_phase: finalEffective,
      };
      report.stages[4].evidence = {
        admin_click_path: ["Maps", "Select a Map Studio package", `Target phase: Initial Review Phase; package revision: ${imported.packageData.revision}`, "Review publish details", "Confirm publication", "Publish map", "Shared project links", "Settings > Project Applications", "Save project application settings", "Settings > Company Profile > Public Application Settings > Applications open > Save section"],
        published_phase: "Initial Review Phase", published_package_revision: imported.packageData.revision,
        published_phase_id: scope.phaseId, published_snapshot_id: imported.snapshotId,
        publication_kept_intake_closed: true,
        other_phase_public_map_status: otherMap.response.status,
        other_phase_site_status: otherSite.response.status,
        other_phase_site_application_open: otherSite.body.publicApplication?.applications_open ?? null,
        other_phase_intake_status: otherSubmission.status,
        shared_application_link: applicationLink,
        shared_map_link: mapLink,
        shared_links_opened_signed_out: true,
        shared_project_refresh_ok: sharedProjectRefreshOk,
        shared_map_refresh_ok: sharedMapRefreshOk,
        project_link_preview_metadata: projectLinkPreviewMetadata,
        map_link_preview_metadata: mapLinkPreviewMetadata,
        static_html_link_preview_metadata: staticLinkPreviewMetadata,
        standalone_map_apply_selected_SYN_001: standaloneMapApplySelected,
        map_inquiry_existing_widget_used: mapInquiryState.responses.length === 1,
        map_inquiry_project: mapInquiryPayload.project,
        map_inquiry_phase: mapInquiryPayload.phase,
        map_inquiry_selected_plot_id: mapInquiryPayload.specific_map_feature_ref,
        map_inquiry_reason: mapInquiryPayload.interests[0],
        admin_map_inquiry_lead_context_verified: mapInquiryReasonVisibleInLeads && mapInquiryPlotVisibleInLeads,
        public_cookie_count: publicCookies.length,
        public_local_storage_key_count: publicStorageKeys.length,
        hostname_resolution_requests: publicFunctionRequests.filter((url) => url.includes("resolve_public_hostname")).length,
        host_selector_requests: publicFunctionRequests.filter((url) => /[?&]host=/.test(url)).length,
        expired_background_request_status: expiredBackgroundStatus,
        hostname_binding_count: hostnameBindingCount,
        public_template_id: pageSettings.body.siteExperience.templateId,
        public_application_type: pageSettings.body.siteExperience.applicationType,
        application_form_seen: true, actual_form_handler: "submit-hopkins-project-application",
        effective_intake_before_submission: effectiveBeforeSubmit,
        first_real_submit_status: routeState.responses[0].status,
        retry_status: routeState.responses[1].status,
        retry_deduplicated: routeState.responses[1].body.deduplicated,
        submission_reference_reused: routeState.payloads[0].submission_reference === routeState.payloads[1].submission_reference,
        submitted_outline_label: "SYN-001",
        submitted_outline_ids: routeState.payloads[0].preferred_map_feature_refs,
        admin_workspace: { project: "Synthetic Studio Review Project", phase: "Initial Review Phase" },
        admin_application_id: applicationId, applications_in_initial: applicationsInInitial,
        application_count_for_reference: applicationCountForReference,
        linked_lead_id: leadId, leads_in_initial: leadsInInitial, linked_lead_count: linkedLeads.length,
        admin_map_link_opened: true, admin_map_link_selected_SYN_001: true,
        reviewer_link_after_publication: {
          remained_on_reviewed_snapshot: reviewerAfterPublication.body.revision.snapshot_id === imported.snapshotId,
          frozen_intake_setting: reviewerAfterPublication.body.scope.public_application.applications_open,
          revoked_after_walkthrough: true,
          revoked_data_status: reviewerAfterRevoke.status,
          revoked_asset_status: reviewerAssetAfterRevoke.status,
        },
        phase_restricted_staff_other_phase_package_rows: finalStaffPackages.data?.length ?? null,
        phase_restricted_staff_other_phase_outline_rows: finalStaffFeatures.data?.length ?? null,
        outbound_email_rows: emailNotifications, payment_transaction_rows: transactions, reservation_rows: reservations,
        payment_allocation_rows: paymentAllocations, fee_charge_rows: feeCharges,
        captured_mailpit_messages_before: mailpitStartCount, captured_mailpit_messages_after: mailpitEndCount,
        final_effective_intake_by_phase: finalEffective,
        tenant_intake_closed_at_end: finalTenantSetting.value.applications_open === false,
        project_intake_closed_at_end: finalProjectSetting.value.applications_open === false,
        browser_session_signed_out: publicCookies.length === 0 && publicStorageKeys.length === 0,
      };
      await publicPage.screenshot({ path: resolve(dirname(evidencePath), "tenant-walkthrough-public-map.png"), fullPage: false });
      report.synthetic_submission = result;
      return result;
    });

    report.result = "passed";
    report.total_machine_runtime_ms = Math.round(report.stages.reduce((total, stage) => total + stage.machine_runtime_ms, 0));
    await saveReport();
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.result = "failed";
    report.failure = cleanFailure(error);
    report.total_machine_runtime_ms = Math.round(report.stages.reduce((total, stage) => total + stage.machine_runtime_ms, 0));
    await saveReport();
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } finally {
    const closeResources = async () => {
      await withTimeout(() => context?.close(), 10000, "Public browser context cleanup").catch(() => {});
      await withTimeout(() => browser?.close(), 10000, "Public browser cleanup").catch(() => {});
      await withTimeout(() => adminContext?.close(), 10000, "Admin browser context cleanup").catch(() => {});
      await withTimeout(() => adminBrowser?.close(), 10000, "Admin browser cleanup").catch(() => {});
      await Promise.all(signedInClients.map((client) =>
        withTimeout(() => client.auth.signOut(), 10000, "Local Auth cleanup").catch(() => {})));
    };
    await closeResources();
    await new Promise((resolve) => process.stdout.write("", resolve));
    process.exit(stageTimedOut ? 124 : (process.exitCode ?? 0));
  }
}

async function timedStage(name, operation) {
  const stage = { name, status: "running", machine_runtime_ms: 0 };
  report.stages.push(stage);
  console.log(`[walkthrough] started: ${name}`);
  const start = performance.now();
  let timer;
  let timedOut = false;
  try {
    const result = await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`Stage exceeded its ${stageTimeoutMs / 1000}-second runtime limit.`));
        }, stageTimeoutMs);
      }),
    ]);
    stage.machine_runtime_ms = Math.round(performance.now() - start);
    stage.status = "passed";
    console.log(`[walkthrough] passed: ${name} (${stage.machine_runtime_ms} ms)`);
    return result;
  } catch (error) {
    stage.machine_runtime_ms = Math.round(performance.now() - start);
    stage.status = "failed";
    stage.error = cleanFailure(error);
    stageTimedOut ||= timedOut;
    console.error(`[walkthrough] failed: ${name} (${stage.machine_runtime_ms} ms): ${stage.error}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureAdminPage(scope) {
  if (!adminPage) {
    adminBrowser = await chromium.launch({ headless: true });
    adminContext = await adminBrowser.newContext({ viewport: { width: 1365, height: 900 } });
    adminPage = await adminContext.newPage();
    await adminPage.goto(`${webOrigin}/login`, { waitUntil: "domcontentloaded" });
    await adminPage.getByLabel("Email", { exact: true }).fill(adminEmail);
    await adminPage.getByLabel("Password", { exact: true }).fill(password);
    await adminPage.getByRole("button", { name: /Sign in/ }).click();
    await adminPage.waitForURL(/\/dashboard$/, { timeout: 30000 });
  }
  await selectAdminWorkspace(adminPage, scope);
  return adminPage;
}

async function selectAdminWorkspace(page, scope) {
  const project = page.getByLabel("Workspace project");
  const phase = page.getByLabel("Workspace phase");
  await project.waitFor({ state: "visible", timeout: 30000 });
  await project.selectOption(scope.projectId);
  await phase.selectOption(scope.phaseId);
  assert(await project.inputValue() === scope.projectId && await phase.inputValue() === scope.phaseId,
    "The Admin workspace selector did not retain the synthetic project and Initial phase.");
}

async function setTenantApplicationGate(page, open) {
  await page.getByRole("button", { name: "Company Profile", exact: true }).click();
  const toggle = page.getByLabel("Applications open", { exact: true });
  await toggle.waitFor({ state: "visible", timeout: 15000 });
  if (open && !(await toggle.isChecked())) await toggle.check();
  if (!open && await toggle.isChecked()) await toggle.uncheck();
  const card = page.getByRole("heading", { name: "Public Application Settings", exact: true }).locator("xpath=../..");
  await card.getByRole("button", { name: "Save section", exact: true }).click();
  await page.getByText("Application settings saved.", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
}

async function saveProjectApplicationControls(page, open) {
  await page.getByRole("button", { name: "Project Applications", exact: true }).click();
  await page.getByRole("heading", { name: "Project application settings", exact: true }).waitFor({ state: "visible", timeout: 20000 });
  await page.getByLabel("Application type", { exact: true }).selectOption("project_application");
  const gate = page.getByLabel(/Open this project/);
  if (open && !(await gate.isChecked())) await gate.check();
  if (!open && await gate.isChecked()) await gate.uncheck();
  const phases = page.getByRole("group", { name: "Allowed phases" });
  const initial = phases.getByLabel(/Initial Review Phase/);
  const later = phases.getByLabel(/Later Review Phase/);
  if (!(await initial.isChecked())) await initial.check();
  if (await later.isChecked()) await later.uncheck();
  await page.getByLabel("Required notice version", { exact: true }).fill("synthetic-ci-v1");
  await page.getByLabel("Public notice", { exact: true }).fill("Synthetic CI notice only. Applications are reviewed for testing and do not allocate land.");
  await page.getByLabel("Applicant acknowledgment", { exact: true }).fill("I understand this synthetic application is for CI testing only and does not reserve or allocate land.");
  await page.getByLabel("Allowed intended uses (one per line)", { exact: true }).fill("Residential");
  await page.getByLabel("Application confirmation message", { exact: true }).fill("Synthetic CI application received for review.");
  await page.getByRole("button", { name: "Save project application settings", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Project application settings saved." }).waitFor({ state: "visible", timeout: 15000 });
}

async function effectiveIntakeRows(page) {
  const heading = page.getByRole("heading", { name: "Effective intake by phase", exact: true });
  await heading.waitFor({ state: "visible", timeout: 15000 });
  const list = heading.locator("xpath=../ul");
  const initial = await list.getByRole("listitem").filter({ hasText: "Initial Review Phase" }).innerText();
  const later = await list.getByRole("listitem").filter({ hasText: "Later Review Phase" }).innerText();
  return { initial, later };
}

async function bootstrapSuperAdmin() {
  const user = await createConfirmedUser(operatorEmail, "Wamule CI Synthetic Operator");
  const { error: profileError } = await service.from("admin_profiles").insert({
    user_id: user.id, email: operatorEmail, full_name: "Wamule CI Synthetic Operator", role: "Super Admin", tenant_id: null,
  });
  if (profileError) throw new Error(`Disposable local Super Admin bootstrap failed: ${profileError.message}`);
  const operator = await signedInClient(operatorEmail);
  return Object.assign(operator, { userId: user.id });
}

async function createConfirmedUser(email, fullName) {
  const { data, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: fullName },
  });
  if (error || !data?.user?.id) throw new Error(`Local synthetic Auth user could not be created: ${error?.message ?? "missing ID"}`);
  return data.user;
}

async function signedInClient(email) {
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Synthetic local Auth sign-in failed: ${error.message}`);
  const { data: userResult, error: userError } = await client.auth.getUser();
  if (userError || !userResult.user?.id) throw new Error("Local Auth session could not be confirmed.");
  signedInClients.push(client);
  return client;
}

async function invoke(client, functionName, body) {
  const { data, error } = await client.functions.invoke(functionName, { body });
  if (error) {
    let detail = error.message;
    const context = error.context;
    if (context && typeof context.text === "function") {
      try {
        const bodyText = await context.clone().text();
        const payload = JSON.parse(bodyText);
        detail = payload.error ?? payload.message ?? payload.msg ?? JSON.stringify(payload);
      } catch {
        try {
          const bodyText = await context.clone().text();
          if (bodyText.trim()) detail = `HTTP ${context.status ?? "error"}: ${bodyText.trim().slice(0, 500)}`;
        } catch { /* Keep the safe SDK message if the response cannot be read. */ }
      }
      if (context.status) detail = `HTTP ${context.status}: ${detail}`;
    }
    detail = String(detail)
      .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[JWT REDACTED]");
    throw new Error(`${functionName} failed: ${detail}`);
  }
  if (data?.ok === false || data?.error) throw new Error(`${functionName} failed: ${data.error ?? "request was rejected"}`);
  return data;
}

function checked(result, operation) {
  if (result?.error) throw new Error(`${operation}: ${result.error.message}`);
  return result?.data;
}

async function countRows(client, table, filters) {
  let query = client.from(table).select("id", { count: "exact", head: true });
  for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
  const result = await query;
  if (result.error) throw new Error(`Count synthetic ${table} rows: ${result.error.message}`);
  return result.count ?? 0;
}

function countLocalHostnameBindings(tenantId) {
  assert(UUID(tenantId), "Hostname binding count requires the synthetic tenant UUID.");
  const result = spawnSync("psql", [
    "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1",
    "-c", `BEGIN READ ONLY; SELECT count(*)::text FROM public.public_hostname_bindings WHERE tenant_id = '${tenantId}'::uuid; COMMIT;`,
  ], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      PGHOST: databaseUrl.hostname,
      PGPORT: databaseUrl.port || "5432",
      PGUSER: decodeURIComponent(databaseUrl.username),
      PGPASSWORD: decodeURIComponent(databaseUrl.password),
      PGDATABASE: decodeURIComponent(databaseUrl.pathname.slice(1)),
      PGSSLMODE: "disable",
      PGPASSFILE: "/dev/null",
    },
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? String(result.stderr ?? "").trim().split(/\r?\n/).slice(0, 3).join(" ");
    throw new Error(`The local read-only hostname binding count query failed${detail ? `: ${cleanFailure(detail)}` : "."}`);
  }
  const countText = result.stdout.trim();
  assert(/^\d+$/.test(countText), "The local hostname binding count query did not return a count.");
  const count = Number(countText);
  assert(Number.isSafeInteger(count), "The local hostname binding count is outside the supported integer range.");
  return count;
}

async function capturedMailCount() {
  return withTimeout(async () => {
    const response = await fetch(mailpitApi, { cache: "no-store" });
    if (!response.ok) throw new Error(`Local Mailpit did not respond with its captured-message list (${response.status}).`);
    const body = await response.json().catch(() => ({}));
    const count = Number(body.total ?? body.count ?? (Array.isArray(body.messages) ? body.messages.length : NaN));
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Local Mailpit returned an unrecognized message count.");
    return count;
  }, 30000, "Local Mailpit read");
}

async function publicGet(functionName, params) {
  return withTimeout(async () => {
    const query = new URLSearchParams(params);
    const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}?${query}`, { headers: { apikey: anonKey }, cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  }, 30000, `Local ${functionName} read`);
}

async function postPublic(functionName, body) {
  return withTimeout(async () => {
    const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }, 30000, `Local ${functionName} submission`);
}

function submissionBody(tenant, project, phase, reference, refs) {
  return {
    tenant, project, phase, hostname: "", submission_reference: reference,
    applicant_full_name: "Wamule CI Synthetic Applicant", applicant_address: "Synthetic CI fixture only",
    nationality: "Synthetic", occupation: "CI walkthrough fixture", phone: "+5010000000",
    email: "applicant@example.invalid", intended_use: "Residential", intended_use_other: "",
    preferred_map_feature_refs: refs, notes: "Synthetic test only.", legal_notice_acknowledged: true,
    applicant_acknowledgement_signature: "Wamule CI Synthetic Applicant",
  };
}

async function saveReport() {
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

async function withTimeout(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its ${timeoutMs / 1000}-second limit.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function cleanFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:https?|postgres(?:ql)?):\/\/[^\s"']+/gi, "[local URL]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[JWT]")
    .slice(0, 500);
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function UUID(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the disposable walkthrough.`);
  return value;
}

main();
