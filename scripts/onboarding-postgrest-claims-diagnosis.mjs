#!/usr/bin/env node
/** Diagnose the service-role claim through local PostgREST and the actual console function only. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = required("SUPABASE_URL");
const ANON_KEY = required("SUPABASE_ANON_KEY");
const SERVICE_ROLE_KEY = required("SUPABASE_SERVICE_ROLE_KEY");
const DB_URL = required("SCHEMA_QUERY_DATABASE_URL");
const REPLAY_DIR = required("REPLAY_DIR");
const EVIDENCE_PATH = resolve(process.env.ONBOARDING_DIAGNOSIS_EVIDENCE_PATH || resolve(REPLAY_DIR, "onboarding-postgrest-diagnosis.json"));
const DRAFT_PATH = resolve(new URL("../supabase/migrations/20261114054243_onboarding_postgrest_role_claims.sql", import.meta.url).pathname);
const DRAFT_SHA256 = "303d7d7c16890cfa90bdcbd301b55d14ea99c5dd6c8cd1b031b7dcbaf64a412b";
const GUARD_MESSAGE = "Workspace provisioning is restricted to the trusted service role.";
const dbUrl = new URL(DB_URL);
assert(["localhost", "127.0.0.1", "::1"].includes(dbUrl.hostname), "Refusing a non-local PostgreSQL target.");
assert(["postgres:", "postgresql:"].includes(dbUrl.protocol), "The diagnosis database URL must be PostgreSQL.");
assert(["localhost", "127.0.0.1", "::1"].includes(new URL(SUPABASE_URL).hostname), "Refusing a non-local Supabase API target.");

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const report = {
  mode: "disposable-local-supabase-postgrest-onboarding-diagnosis",
  hosted_target_used: false,
  tested_commit: process.env.GITHUB_SHA || null,
  baseline: null,
  before_probe: null,
  patch: { applied: false },
  after_probe: null,
  console_preview: null,
  workspace: null,
  staff_assignment: null,
  direct_service_rpc_denials: [],
  outcome: "running",
};

async function main() {
  const baseline = JSON.parse(await readFile(resolve(REPLAY_DIR, "onboarding-postgrest-baseline.json"), "utf8"));
  const applied = JSON.parse(await readFile(resolve(REPLAY_DIR, "applied-migrations.json"), "utf8"));
  const numbered = JSON.parse(await readFile(resolve(REPLAY_DIR, "numbered-migrations.json"), "utf8"));
  const versions = (numbered.migrations || []).map((entry) => String(entry.version));
  assert(baseline.hosted_target_used === false && baseline.compatibility_delta_applied === false, "The baseline is not marked as local-only and compatibility-delta-free.");
  assert(baseline.numbered_migration_count === 72 && baseline.ordered_manifest_match === true, "The ordered 72-entry baseline is required before probing.");
  assert(applied.applied_migration_count === 72 && applied.ordered_manifest_match === true && versions.length === 72, "Applied and numbered ledgers do not match at 72 entries.");
  assert(versions.slice(-3).join(",") === "20261112033403,20261112033404,20261113050506", "The final three numbered migrations are not in the reviewed order.");
  assert(!versions.includes("20261112040000"), "The broad compatibility delta must remain outside this replay.");
  assert(baseline.m1_5_overlay?.included_in_numbered_ledger === false, "M1.5 must remain a separate overlay.");
  report.baseline = {
    numbered_migration_count: 72,
    ordered_manifest_match: true,
    last_three_versions: versions.slice(-3),
    m1_5_overlay_separate: true,
    compatibility_delta_applied: false,
    reviewer_sha256: baseline.reviewer_migration?.sha256 || null,
  };

  const before = await rpcProbe(SERVICE_ROLE_KEY, SERVICE_ROLE_KEY, "provision_workspace_v1", { p_manifest: null, p_apply: false });
  report.before_probe = before;
  if (before.sqlstate === "42501" && before.message === GUARD_MESSAGE) {
    const migrationBytes = await readFile(DRAFT_PATH);
    const actualHash = sha256(migrationBytes);
    if (actualHash !== DRAFT_SHA256) throw new Error("Conditional onboarding repair hash mismatch: " + actualHash);
    report.patch.sha256 = actualHash;
    report.patch.condition = "pre-repair PostgREST returned SQLSTATE 42501 and the trusted-service-role guard message";
    const applyResult = spawnSync("psql", [DB_URL, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", DRAFT_PATH], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PGPASSWORD: undefined },
    });
    if (applyResult.error || applyResult.status !== 0) {
      const detail = sanitize((applyResult.stderr || applyResult.error?.message || "psql migration failed").slice(0, 1200));
      throw new Error("Failing command: psql <local database URL> -X -q -v ON_ERROR_STOP=1 -f supabase/migrations/20261114054243_onboarding_postgrest_role_claims.sql; " + detail);
    }
    report.patch.applied = true;
    const after = await rpcProbe(SERVICE_ROLE_KEY, SERVICE_ROLE_KEY, "provision_workspace_v1", { p_manifest: null, p_apply: false });
    report.after_probe = after;
    assertInvalidZeroWrite(after, "Post-repair PostgREST service-role probe");
    await runOnboardingFlow();
    report.outcome = "confirmed_claim_fix_and_onboarding_passed";
    await saveReport();
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (before.http_status === 200 && before.application_status === "invalid" && before.writes === 0) {
    report.patch.condition = "not met; service-role probe accepted the caller";
    const operator = await createSuperAdmin();
    const preview = await consoleRequest(operator.token, buildManifest(), false);
    report.console_preview = summarizeConsole(preview);
    if (preview.http_status === 200 && preview.body?.ok === true
        && preview.body?.preflight?.status === "dry_run" && preview.body?.preflight?.writes === 0) {
      report.outcome = "guard_accepted_console_preview_plan_returned";
    } else {
      report.outcome = "guard_accepted_console_preview_error_captured";
    }
    await saveReport();
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  throw new Error("The baseline probe returned neither the expected trusted-service-role rejection nor status=invalid with writes=0.");
}

async function runOnboardingFlow() {
  await verifyServiceOnlyRpcDenials();
  const operator = await createSuperAdmin();
  const manifest = buildManifest();
  const previewResponse = await consoleRequest(operator.token, manifest, false);
  report.console_preview = summarizeConsole(previewResponse);
  assert(previewResponse.http_status === 200 && previewResponse.body?.ok === true, "Actual super-admin-console preview failed: " + (report.console_preview.message || "no sanitized detail"));
  const preflight = previewResponse.body?.preflight;
  assert(preflight?.status === "dry_run" && preflight?.writes === 0 && preflight?.can_apply === true && previewResponse.body?.applied === false,
    "Console preview did not return a valid zero-write provisioning plan.");

  const applyResponse = await consoleRequest(operator.token, manifest, true);
  assert(applyResponse.http_status === 200 && applyResponse.body?.ok === true && applyResponse.body?.applied === true,
    "Supported console apply failed: " + sanitize(applyResponse.body?.error || "no sanitized detail"));
  const firstRows = await workspaceRows(manifest.company.slug, manifest.projects[0].slug);
  assert(firstRows.tenants.length === 1 && firstRows.projects.length === 1 && firstRows.phases.length === 2,
    "The first apply did not create exactly one synthetic workspace, project, and two phases.");
  const firstIds = idsFromRows(firstRows);

  const retryResponse = await consoleRequest(operator.token, manifest, true);
  assert(retryResponse.http_status === 200 && retryResponse.body?.ok === true && retryResponse.body?.applied === true,
    "Same-operation retry failed: " + sanitize(retryResponse.body?.error || "no sanitized detail"));
  const secondRows = await workspaceRows(manifest.company.slug, manifest.projects[0].slug);
  assert(secondRows.tenants.length === 1 && secondRows.projects.length === 1 && secondRows.phases.length === 2,
    "The retry created duplicate workspace rows.");
  const secondIds = idsFromRows(secondRows);
  assert(JSON.stringify(firstIds) === JSON.stringify(secondIds), "The same-operation retry did not reuse the original workspace and phase IDs.");

  report.workspace = {
    preview: { status: preflight.status, writes: preflight.writes, can_apply: preflight.can_apply },
    first_apply_status: applyResponse.body?.result?.status || null,
    retry_status: retryResponse.body?.result?.status || null,
    retry_reused_same_ids: true,
    tenant_id: firstIds.tenant_id,
    project_id: firstIds.project_id,
    phase_ids: firstIds.phase_ids,
    tenant_count: firstRows.tenants.length,
    project_count: firstRows.projects.length,
    phase_count: firstRows.phases.length,
  };

  const staffEmail = "staff-" + randomUUID().slice(0, 12) + "@example.invalid";
  const staffPassword = "LocalOnly-" + randomUUID() + "-aA9!";
  const staffCreate = await service.auth.admin.createUser({
    email: staffEmail,
    password: staffPassword,
    email_confirm: true,
    user_metadata: { full_name: "Synthetic Phase-limited Staff" },
  });
  if (staffCreate.error || !staffCreate.data?.user?.id) throw new Error("Disposable synthetic Staff Auth identity could not be created: " + sanitize(staffCreate.error?.message || "missing user"));
  const staffManifest = {
    ...manifest,
    users: [{
      identity: { mode: "existing", auth_user_id: staffCreate.data.user.id },
      profile_role: "Staff",
      memberships: [{ project_slug: manifest.projects[0].slug, member_role: "staff", phase_slugs: ["initial"] }],
    }],
  };
  const staffPreview = await consoleRequest(operator.token, staffManifest, false);
  assert(staffPreview.http_status === 200 && staffPreview.body?.ok === true
      && staffPreview.body?.preflight?.status === "dry_run" && staffPreview.body?.preflight?.writes === 0,
    "Phase-limited Staff preview failed or did not remain zero-write: " + sanitize(staffPreview.body?.error || "no sanitized detail"));
  const staffApply = await consoleRequest(operator.token, staffManifest, true);
  assert(staffApply.http_status === 200 && staffApply.body?.ok === true && staffApply.body?.applied === true
      && staffApply.body?.result?.workspace_access_ready === true,
    "Supported phase-limited Staff assignment failed: " + sanitize(staffApply.body?.error || staffApply.body?.result?.error || "no sanitized detail"));
  const membershipResult = await service.from("project_memberships").select("project_id,phase_id,member_role")
    .eq("tenant_id", firstIds.tenant_id).eq("user_id", staffCreate.data.user.id);
  if (membershipResult.error) throw new Error("Could not read synthetic Staff memberships: " + sanitize(membershipResult.error.message));
  const membershipRows = membershipResult.data || [];
  assert(membershipRows.length === 1 && membershipRows[0].project_id === firstIds.project_id
    && membershipRows[0].phase_id === firstIds.phase_ids[0] && membershipRows[0].member_role === "staff",
  "Staff received access outside the assigned phase or did not receive the intended assignment.");
  report.staff_assignment = {
    status: staffApply.body?.result?.status || null,
    phase_limited: true,
    membership_count: membershipRows.length,
    assigned_phase_id: membershipRows[0].phase_id,
  };
}

async function verifyServiceOnlyRpcDenials() {
  const operator = await createSuperAdmin();
  const calls = [
    ["provision_workspace_v1", { p_manifest: null, p_apply: false }],
    ["prepare_workspace_identity_onboarding_v1", { p_manifest: null }],
    ["record_workspace_identity_onboarding_v1", { p_manifest: null, p_auth_user_id: null }],
  ];
  const denials = [];
  for (const [name, args] of calls) {
    const anon = await rpcProbe(ANON_KEY, ANON_KEY, name, args);
    const authenticated = await rpcProbe(ANON_KEY, operator.token, name, args);
    for (const result of [anon, authenticated]) {
      assert((result.http_status === 401 || result.http_status === 403) && result.sqlstate === "42501",
        "A direct non-service call to " + name + " was not denied with SQLSTATE 42501.");
    }
    denials.push({ routine: name, anon: { http_status: anon.http_status, sqlstate: anon.sqlstate, message: anon.message }, authenticated: { http_status: authenticated.http_status, sqlstate: authenticated.sqlstate, message: authenticated.message } });
  }
  report.direct_service_rpc_denials = denials;
}

async function createSuperAdmin() {
  const suffix = randomUUID().slice(0, 12);
  const email = "operator-" + suffix + "@example.invalid";
  const password = "LocalOnly-" + randomUUID() + "-aA9!";
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Synthetic CI Super Admin" },
  });
  if (created.error || !created.data?.user?.id) throw new Error("Disposable synthetic Super Admin Auth identity could not be created: " + sanitize(created.error?.message || "missing user"));
  const profile = await service.from("admin_profiles").insert({
    user_id: created.data.user.id,
    email,
    full_name: "Synthetic CI Super Admin",
    role: "Super Admin",
    tenant_id: null,
  });
  if (profile.error) throw new Error("Disposable Super Admin profile bootstrap failed: " + sanitize(profile.error.message));
  const signedIn = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const login = await signedIn.auth.signInWithPassword({ email, password });
  if (login.error || !login.data?.session?.access_token) throw new Error("Disposable Super Admin sign-in failed: " + sanitize(login.error?.message || "no session"));
  return { user_id: created.data.user.id, token: login.data.session.access_token };
}

function buildManifest() {
  const operationId = randomUUID();
  const tenantSlug = "ci-onboarding-" + operationId.slice(0, 12);
  const projectSlug = "review-project";
  const companyProfile = {
    company_name: "Wamule CI Synthetic Tenant",
    contact_email: "walkthrough@example.invalid",
    phone_number: "+501-000-0000",
    website: "https://example.invalid",
    location_address: "Synthetic CI fixture",
    short_description: "Synthetic onboarding diagnosis only.",
    public_notice_text: "Synthetic CI notice only. This is not an offer to sell land.",
  };
  const publicApplication = {
    application_type: "project_application",
    applications_open: false,
    show_lot_prices_publicly: false,
    show_available_lot_count_publicly: false,
    notice_version: "synthetic-ci-v1",
    public_notice_text: "Synthetic CI application only.",
    application_acknowledgment_text: "Synthetic CI application only; no land is allocated.",
    allowed_intended_uses: ["Residential"],
    max_map_preferences: 3,
    default_confirmation_message: "Synthetic CI application received.",
  };
  return {
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
      name: "Synthetic Onboarding Diagnosis Project",
      mode: "demo",
      demo_fixture_bundle: null,
      default_phase_slug: "initial",
      settings: {
        company_profile: companyProfile,
        tenant_theme: { site_experience: { templateId: "wamule-classic", enabledModules: { map: true, inquiry: false, application: true, pricing: false } } },
        public_application: publicApplication,
      },
      phases: [
        { slug: "initial", name: "Initial Review Phase" },
        { slug: "later", name: "Later Review Phase" },
      ],
    }],
  };
}

async function workspaceRows(tenantSlug, projectSlug) {
  const tenants = await service.from("organizations").select("id,slug").eq("slug", tenantSlug);
  if (tenants.error) throw new Error("Could not read synthetic tenant count.");
  const tenantId = tenants.data?.[0]?.id;
  const projects = tenantId
    ? await service.from("projects").select("id,tenant_id,slug").eq("tenant_id", tenantId).eq("slug", projectSlug)
    : { data: [], error: null };
  if (projects.error) throw new Error("Could not read synthetic project count.");
  const phases = tenantId && projects.data?.[0]?.id
    ? await service.from("development_phases").select("id,project_id,slug").eq("tenant_id", tenantId).eq("project_id", projects.data[0].id)
    : { data: [], error: null };
  if (phases.error) throw new Error("Could not read synthetic phase count.");
  return { tenants: tenants.data || [], projects: projects.data || [], phases: phases.data || [] };
}

function idsFromRows(rows) {
  const tenantId = rows.tenants[0]?.id;
  const projectId = rows.projects[0]?.id;
  const phases = rows.phases.slice().sort((a, b) => a.slug.localeCompare(b.slug));
  assert(tenantId && projectId && phases.length === 2, "Synthetic workspace rows are incomplete.");
  return { tenant_id: tenantId, project_id: projectId, phase_ids: phases.map((phase) => phase.id) };
}

async function consoleRequest(token, manifest, apply) {
  const response = await fetch(SUPABASE_URL + "/functions/v1/super-admin-console", {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "provision", manifest, apply }),
    cache: "no-store",
  });
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  return { http_status: response.status, body };
}

function summarizeConsole(result) {
  const body = result.body || {};
  const preflight = body.preflight || {};
  return {
    http_status: result.http_status,
    ok: body.ok === true,
    action: body.action || null,
    applied: body.applied === true,
    preflight_status: preflight.status || null,
    preflight_writes: Number.isInteger(preflight.writes) ? preflight.writes : null,
    can_apply: preflight.can_apply === true,
    result_status: body.result?.status || null,
    sanitized_error: sanitize(body.error || body.result?.error || ""),
  };
}

async function rpcProbe(apiKey, bearer, name, args) {
  const response = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + encodeURIComponent(name), {
    method: "POST",
    headers: {
      apikey: apiKey,
      Authorization: "Bearer " + bearer,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  const message = body.message || body.error || body.msg || "";
  return {
    http_status: response.status,
    sqlstate: typeof body.code === "string" ? body.code : null,
    message: sanitize(message),
    application_status: typeof body.status === "string" ? body.status : null,
    writes: Number.isInteger(body.writes) ? body.writes : null,
  };
}

async function saveReport() {
  await writeFile(EVIDENCE_PATH, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function sanitize(value) {
  return String(value || "")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[JWT REDACTED]")
    .replace(/(?:service_role|anon)_key\s*[:=]\s*\S+/gi, "[KEY REDACTED]")
    .slice(0, 500);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required for the local diagnosis.");
  return value;
}

main().catch(async (error) => {
  report.outcome = "failed";
  report.failure = sanitize(error instanceof Error ? error.message : error);
  await saveReport().catch(() => {});
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
});
