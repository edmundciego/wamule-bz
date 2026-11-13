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
let stageTimedOut = false;
const signedInClients = [];

async function main() {
  try {
    const [appliedBytes, numberedBytes, runtimeDeltaBytes] = await Promise.all([
      readFile(resolve(replayDir, "applied-migrations.json")),
      readFile(resolve(replayDir, "numbered-migrations.json")),
      readFile(resolve(replayDir, "runtime-delta.json")),
    ]);
    const reviewerOverlayBytes = await readFile(resolve(replayDir, "reviewer-link-overlay.json"));
    const appliedLedger = JSON.parse(appliedBytes.toString("utf8"));
    const numberedLedger = JSON.parse(numberedBytes.toString("utf8"));
    const runtimeDelta = JSON.parse(runtimeDeltaBytes.toString("utf8"));
    const reviewerOverlay = JSON.parse(reviewerOverlayBytes.toString("utf8"));
    const reviewerMigrationName = "20261113050506_shareable_map_reviewer_links.sql";
    const reviewerMigrationPath = resolve(dirname(new URL(import.meta.url).pathname), `../supabase/migrations/${reviewerMigrationName}`);
    const reviewerMigrationHash = sha256(await readFile(reviewerMigrationPath));
    const versions = (numberedLedger.migrations ?? []).map((entry) => String(entry.version));
    const overlay = numberedLedger.separately_applied_overlay;
    assert(versions.length === 71 && appliedLedger.applied_migration_count === 71
      && appliedLedger.ordered_manifest_match === true && numberedLedger.ordered_manifest_match === true
      && versions.at(-2) === "20261112033403" && versions.at(-1) === "20261112033404"
      && overlay?.name === "20261105000100_harden_sensitive_view_access.sql"
      && overlay?.included_in_numbered_ledger === false
      && overlay?.sha256 === "d16b6fba02cb210e9e628f5cf11c555f74db7e18fbe6afe663150158cb72d631",
    "The disposable walkthrough requires the exact 71-entry candidate ledger plus the separate M1.5 view-security overlay.");
    assert(runtimeDelta.applied_after_exact_baseline === true && runtimeDelta.numbered_baseline_count === 71
      && runtimeDelta.migrations?.length === 1
      && runtimeDelta.migrations[0]?.version === "20261112040000"
      && runtimeDelta.migrations[0]?.sha256 === "9773c4d937e914bd2802aed851041babfbe5cf8f2e9ee153b4bad2f723574da5"
      && runtimeDelta.checks?.json_claim_service_role_zero_write_probe === "passed"
      && runtimeDelta.checks?.legacy_claim_service_role_zero_write_probe === "passed"
      && runtimeDelta.checks?.authenticated_claim_rejected === "passed",
    "The local runtime must record the separate hash-pinned PostgREST role-claims compatibility migration after the 71-entry baseline.");
    assert(reviewerOverlay.name === reviewerMigrationName && reviewerOverlay.hosted_target_used === false
      && reviewerOverlay.applied_after_runtime_compatibility_delta === true
      && reviewerOverlay.sha256 === reviewerMigrationHash,
    "The signed reviewer-link schema must be the exact local-only overlay applied after the compatibility delta.");
    report.database = {
      postgres_major: 17, numbered_migration_count: versions.length, m1_5_overlay_separate: true,
      candidate_migration_versions: versions.slice(-2), numbered_ledger_sha256: sha256(numberedBytes),
      m1_5_overlay_sha256: overlay.sha256, runtime_compatibility_delta_count: runtimeDelta.migrations.length,
      runtime_compatibility_delta_version: runtimeDelta.migrations[0].version,
      runtime_compatibility_delta_sha256: runtimeDelta.migrations[0].sha256,
      reviewer_link_schema_overlay: { name: reviewerOverlay.name, sha256: reviewerOverlay.sha256, local_only: true },
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

    await timedStage("3. Configure one reference-only phase with intake closed", async () => {
      const deniedProjectSettings = await scope.admin.from("project_settings").select("key")
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).limit(1);
      assert(deniedProjectSettings.error?.code === "42501", "Authenticated Admin unexpectedly gained direct access to server-only project settings.");
      const projectSettings = checked(await service.from("project_settings").select("key,value")
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).in("key", ["tenant_theme", "public_application"]), "Read scoped project configuration");
      const settingsByKey = Object.fromEntries(projectSettings.map((row) => [row.key, row.value]));
      const appSetting = settingsByKey.public_application;
      assert(settingsByKey.tenant_theme?.site_experience?.templateId === "wamule-classic", "Project presentation did not preserve wamule-classic.");
      assert(appSetting.application_type === "project_application" && appSetting.applications_open === false,
        "Initial project application type or closed intake was not preserved.");
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
        project_application_type: appSetting.application_type, intended_phase_intake_open: false,
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
      assert(anonMap.response.status === 404 && anonSite.response.status === 404 && anonAsset.data === null,
        "Anonymous caller loaded private map data before sign-off.");
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
      return { selectedFeatureId: selectedIdentity.id, revision: snapshot.snapshot_version, reviewerToken: primaryToken, reviewerLinkId: primaryLinkId };
    });

    const submission = await timedStage("5. Publish one shared-platform phase and submit idempotently", async () => {
      const publication = checked(await scope.admin.rpc("publish_project_map_package", {
        p_package_id: imported.packageId, p_expected_active_id: null, p_replace_current: false,
      }), "Publish only the intended phase map");
      assert(publication.published === true && publication.snapshot_id === imported.snapshotId, "Admin publication selected an unexpected map revision.");
      const projectSetting = scope.projectApplication;
      const publicSetting = { ...projectSetting, applications_open: true, allowed_phase_ids: [scope.phaseId] };
      const tenantSetting = { applications_open: true, show_lot_prices_publicly: false, show_available_lot_count_publicly: false };
      const updatedProjectSetting = await service.from("project_settings").update({ value: publicSetting })
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).eq("key", "public_application").select("value").single();
      if (updatedProjectSetting.error) throw new Error(`Open only the allowlisted phase intake through its server-owned configuration: ${updatedProjectSetting.error.message}`);
      const updatedTenantSetting = await scope.admin.from("business_settings").update({ value: tenantSetting })
        .eq("tenant_id", scope.tenantId).eq("key", "public_application").select("value").single();
      if (updatedTenantSetting.error) throw new Error(`Open synthetic tenant application gate: ${updatedTenantSetting.error.message}`);

      const pageSettings = await publicGet("get-public-site-experience", { tenant: tenantSlug, project: projectSlug, phase: phaseSlug });
      assert(pageSettings.response.ok && pageSettings.body.siteExperience?.templateId === "wamule-classic"
        && pageSettings.body.siteExperience?.applicationType === "project_application"
        && pageSettings.body.publicApplication?.applications_open === true,
      "The shared-platform route did not preserve presentation, resolve project application type, or open the intended phase.");
      const otherMap = await publicGet("get-public-lots", { tenant: tenantSlug, project: projectSlug, phase: otherPhaseSlug });
      const otherSite = await publicGet("get-public-site-experience", { tenant: tenantSlug, project: projectSlug, phase: otherPhaseSlug });
      const otherSubmission = await postPublic("submit-hopkins-project-application", submissionBody(tenantSlug, projectSlug, otherPhaseSlug, randomUUID(), []));
      assert(otherMap.response.status === 404 && otherSite.response.status === 404 && otherSubmission.status === 403,
        "The other phase gained a public map or intake path.");
      const mapped = await publicGet("get-public-lots", { tenant: tenantSlug, project: projectSlug, phase: phaseSlug });
      assert(mapped.response.ok && mapped.body.map_experience_mode === "demo" && mapped.body.features?.length === 2,
        "Published shared-platform map did not return the two synthetic outlines.");
      const reviewerAfterPublication = await postPublic("project-map-review-link", {
        action: "resolve", token: staffPreview.reviewerToken,
      });
      assert(reviewerAfterPublication.status === 200
        && reviewerAfterPublication.body.revision?.snapshot_id === imported.snapshotId
        && reviewerAfterPublication.body.revision?.snapshot_version === staffPreview.revision
        && reviewerAfterPublication.body.scope?.public_application?.applications_open === false,
      "The reviewer link changed revision or settings after publication and intake opened.");

      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
      const publicPage = await context.newPage();
      const pageErrors = [];
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
      await publicPage.goto(`${webOrigin}/p/${tenantSlug}/${projectSlug}/${phaseSlug}`, { waitUntil: "domcontentloaded" });
      await publicPage.getByRole("heading", { name: "Project application", exact: true }).waitFor({ state: "visible", timeout: 30000 });
      await publicPage.getByRole("listbox", { name: /Lots on the map/ }).waitFor({ state: "visible", timeout: 30000 });
      const firstPublicLabel = String(mapped.body.features[0].demo_label);
      await publicPage.getByRole("option", { name: new RegExp(`Select generated map reference ${escapeRegex(firstPublicLabel)}`) }).click();
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
      const expectedRefs = [staffPreview.selectedFeatureId];
      assert(JSON.stringify(routeState.payloads[0].preferred_map_feature_refs) === JSON.stringify(expectedRefs),
        "Visible form submission did not preserve the selected stable map outline ID.");
      assert(UUID(routeState.payloads[0].submission_reference),
        "Public form submission reference is missing or invalid.");
      assert(JSON.stringify(routeState.payloads[0]) === JSON.stringify(routeState.payloads[1]), "Visible retry changed the original application payload.");
      assert(pageErrors.length === 0, "Public application page reported a browser runtime error.");
      const applicationId = Number(routeState.responses[0].body.application_id);
      const applicationCounts = await countRows(service, "applications", { tenant_id: scope.tenantId, project_id: scope.projectId, phase_id: scope.phaseId, submission_reference: routeState.payloads[0].submission_reference });
      const linkedLeads = checked(await service.from("leads").select("id,application_id").eq("tenant_id", scope.tenantId)
        .eq("project_id", scope.projectId).eq("phase_id", scope.phaseId).eq("application_id", applicationId), "Count linked synthetic lead");
      assert(applicationCounts === 1 && linkedLeads.length === 1, "Expected exactly one synthetic application and one linked lead.");
      const leadId = linkedLeads[0].id;
      const reservations = await countRows(service, "lot_reservations", { tenant_id: scope.tenantId, application_id: applicationId });
      const transactions = await countRows(service, "transactions", { tenant_id: scope.tenantId });
      const emailNotifications = await countRows(service, "email_notifications", { related_table: "applications", related_record_id: String(applicationId) });
      const mailpitEndCount = await capturedMailCount();
      assert(reservations === 0 && transactions === 0 && emailNotifications === 0,
        "The synthetic project application created a reservation, transaction, or outbound message row.");
      assert(mailpitEndCount === mailpitStartCount, "The synthetic walkthrough generated a captured outbound email.");

      const adminPage = await context.newPage();
      await adminPage.goto(`${webOrigin}/login`, { waitUntil: "domcontentloaded" });
      await adminPage.getByLabel("Email", { exact: true }).fill(adminEmail);
      await adminPage.getByLabel("Password", { exact: true }).fill(password);
      await adminPage.getByRole("button", { name: /Sign in/ }).click();
      await adminPage.waitForURL(/\/dashboard$/, { timeout: 30000 });
      await adminPage.goto(`${webOrigin}/applications`, { waitUntil: "domcontentloaded" });
      await adminPage.getByRole("heading", { name: "Applications", exact: true }).waitFor({ state: "visible", timeout: 30000 });
      const applicationSummary = adminPage.getByText(new RegExp(`Application #${applicationId}\\b`));
      await applicationSummary.waitFor({ state: "visible", timeout: 30000 });
      await applicationSummary.click();
      await adminPage.getByText("Project: Synthetic Studio Review Project", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
      await adminPage.getByText("Phase: Initial Review Phase", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
      await adminPage.getByText(new RegExp(`Generated map reference: ${escapeRegex(firstPublicLabel)}`)).waitFor({ state: "visible", timeout: 15000 });
      const mapLink = adminPage.getByRole("link", { name: "Open this outline on the Initial Review Phase map" });
      const [mapPopup] = await Promise.all([context.waitForEvent("page", { timeout: 15000 }), mapLink.click()]);
      await mapPopup.waitForLoadState("domcontentloaded");
      assert(mapPopup.url().includes(`/p/${tenantSlug}/${projectSlug}/${phaseSlug}?map=1&feature=${staffPreview.selectedFeatureId}`),
        "Admin application map link did not resolve to the scoped shared-platform phase route.");
      await mapPopup.getByRole("listbox", { name: /Lots on the map/ }).waitFor({ state: "visible", timeout: 30000 });
      assert((await mapPopup.getByRole("option", { name: new RegExp(escapeRegex(firstPublicLabel)) }).getAttribute("aria-selected")) === "true",
        "Admin map link did not select the submitted outline.");
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
      await adminPage.getByRole("link", { name: "Sign out", exact: true }).click();
      await adminPage.waitForURL(/\/login$/, { timeout: 15000 });

      const result = {
        application_id: applicationId,
        lead_id: leadId,
        same_id_on_retry: true,
        retry_deduplicated: true,
        selected_outline_id: staffPreview.selectedFeatureId,
        application_count_for_reference: applicationCounts,
        linked_lead_count: linkedLeads.length,
        outbound_email_rows: emailNotifications,
        payment_transaction_rows: transactions,
        reservation_rows: reservations,
      };
      report.stages[4].evidence = {
        published_phase_id: scope.phaseId, published_snapshot_id: imported.snapshotId,
        other_phase_public_map_status: otherMap.response.status,
        other_phase_site_status: otherSite.response.status,
        other_phase_intake_status: otherSubmission.status,
        shared_route: `/p/${tenantSlug}/${projectSlug}/${phaseSlug}`,
        public_template_id: pageSettings.body.siteExperience.templateId,
        public_application_type: pageSettings.body.siteExperience.applicationType,
        application_form_seen: true, actual_form_handler: "submit-hopkins-project-application",
        first_real_submit_status: routeState.responses[0].status,
        retry_status: routeState.responses[1].status,
        retry_deduplicated: routeState.responses[1].body.deduplicated,
        submitted_outline_ids: routeState.payloads[0].preferred_map_feature_refs,
        admin_workspace: { project: "Synthetic Studio Review Project", phase: "Initial Review Phase" },
        admin_application_id: applicationId, linked_lead_id: leadId,
        admin_map_link_opened: true, admin_map_link_selected_outline: true,
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
        captured_mailpit_messages_before: mailpitStartCount, captured_mailpit_messages_after: mailpitEndCount,
        browser_session_signed_out: true,
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
      await withTimeout(() => context?.close(), 10000, "Browser context cleanup").catch(() => {});
      await withTimeout(() => browser?.close(), 10000, "Browser cleanup").catch(() => {});
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
