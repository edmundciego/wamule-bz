#!/usr/bin/env node
/** Owner-operated Hopkins production onboarding, guarded and retry-safe. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const PRODUCTION_REF = "mtjlvzrtihslcftxnlso";
const OWNER_EMAIL = "ed-admin@wamuledevelopment.com";
const ACK = "I understand this creates the Hopkins workspace in Wamule production";
const DEFAULT_CONFIG = "map-input/hosted-pilot/hopkins-grove.json";
const DEFAULT_PACKAGE = "artifacts/hopkins-owner-pilot-release-20261016";

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument ${key}.`);
    const name = key.slice(2);
    if (["dry-run", "apply", "allow-production", "defer-public-settings", "help"].includes(name)) parsed[name] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
      parsed[name] = value;
    }
  }
  return parsed;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  return value;
}
function jsonEqual(a, b) { return JSON.stringify(stableJson(a)) === JSON.stringify(stableJson(b)); }

async function findOwner(auth) {
  const matches = [];
  for (let page = 1; page <= 10; page++) {
    const result = await auth.admin.listUsers({ page, perPage: 200 });
    if (result.error) throw new Error(`Read-only production Auth lookup failed: ${result.error.message}`);
    const users = result.data.users ?? [];
    matches.push(...users.filter((user) => user.email?.toLowerCase() === OWNER_EMAIL));
    if (users.length < 200) break;
  }
  if (matches.length !== 1) throw new Error(`Expected exactly one existing production Auth account for ${OWNER_EMAIL}; found ${matches.length}. No onboarding call was made.`);
  const user = matches[0];
  if (user.banned_until || user.deleted_at || !user.email_confirmed_at) {
    throw new Error("The existing production owner account is not confirmed and active; no onboarding call was made.");
  }
  return user;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node scripts/tenant-onboard-production.mjs --dry-run --expected-project-ref ${PRODUCTION_REF}\n` +
      `Apply requires --apply --allow-production --expected-project-ref ${PRODUCTION_REF} --ack-production-text "${ACK}". ` +
      `Use --defer-public-settings only for the pre-application-migration bootstrap phase.`);
    return;
  }
  if (Boolean(args["dry-run"]) === Boolean(args.apply)) throw new Error("Specify exactly one of --dry-run or --apply.");
  if (args["expected-project-ref"] !== PRODUCTION_REF) throw new Error(`--expected-project-ref must equal ${PRODUCTION_REF}.`);
  if (args.apply && (!args["allow-production"] || args["ack-production-text"] !== ACK)) {
    throw new Error("Production onboarding requires --allow-production and the exact --ack-production-text phrase.");
  }

  const config = JSON.parse(readFileSync(resolve(args.config ?? DEFAULT_CONFIG), "utf8"));
  const packageDir = resolve(args.package ?? DEFAULT_PACKAGE);
  const settings = JSON.parse(readFileSync(resolve(packageDir, "hopkins-public-site-settings.json"), "utf8"));
  if (config.tenant.slug !== "hopkins-grove" || config.project.slug !== "hopkins-grove" || config.phase.slug !== "initial") {
    throw new Error("The onboarding config is not the reviewed Hopkins tenant/project/phase.");
  }
  if (config.project.map_experience_mode !== "demo" || settings.public_application?.outbound_notifications_enabled !== false) {
    throw new Error("The reviewed Hopkins project must remain demo-only with outbound notifications disabled.");
  }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Read-only Auth verification requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the protected production environment.");
  if (new URL(url).hostname !== `${PRODUCTION_REF}.supabase.co`) throw new Error("The configured Supabase backend is not exact Wamule production.");
  const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const user = await findOwner(db.auth);
  const { data: profiles, error: profileError } = await db.from("admin_profiles")
    .select("role,tenant_id").eq("user_id", user.id);
  if (profileError || profiles?.length !== 1 || profiles[0].role !== "Super Admin") {
    throw new Error(`The existing ${OWNER_EMAIL} profile is missing, ambiguous, or not Super Admin; no onboarding call was made.`);
  }

  const { data: tenantMatches, error: tenantError } = await db.from("organizations")
    .select("id,name,is_active").eq("slug", config.tenant.slug);
  if (tenantError) throw new Error(`Read-only tenant preflight failed: ${tenantError.message}`);
  if ((tenantMatches ?? []).some((tenant) => !tenant.is_active || tenant.name !== config.tenant.name)) {
    throw new Error("A conflicting or inactive Hopkins tenant exists; no onboarding call was made.");
  }
  if ((tenantMatches ?? []).length > 1) throw new Error("Hopkins tenant slug is ambiguous; no onboarding call was made.");

  if (args["dry-run"]) {
    console.log(JSON.stringify({ dry_run: true, writes_performed: false, project_ref: PRODUCTION_REF,
      owner_email: OWNER_EMAIL, existing_role: "Super Admin", current_profile_tenant_preserved: true,
      target: "hopkins-grove/hopkins-grove/initial", map_mode: "demo",
      outbound_notifications_enabled: false, public_application_settings: "insert only if missing; refuse differences" }, null, 2));
    return;
  }

  const onboard = await db.rpc("onboard_project_tenant", {
    p_tenant_slug: config.tenant.slug,
    p_tenant_name: config.tenant.name,
    p_project_slug: config.project.slug,
    p_project_name: config.project.name,
    p_phase_slug: config.phase.slug,
    p_phase_name: config.phase.name,
    p_theme: config.theme,
    p_company_profile: config.company_profile,
    p_staff_user_id: user.id,
    p_member_role: config.membership_role,
    p_demo_mode: true
  });
  if (onboard.error) throw new Error(`Atomic Hopkins workspace onboarding failed: ${onboard.error.message}`);
  const scope = onboard.data;
  if (args["defer-public-settings"]) {
    console.log(JSON.stringify({ project_ref: PRODUCTION_REF, workspace_ready: true, owner_email: OWNER_EMAIL,
      existing_super_admin_preserved: true, tenant_slug: config.tenant.slug, project_slug: config.project.slug,
      phase_slug: config.phase.slug, public_application_settings: "deferred until final application migration",
      outbound_notifications_enabled: false }, null, 2));
    return;
  }
  const { data: existingSetting, error: settingLookupError } = await db.from("project_settings")
    .select("value").eq("tenant_id", scope.tenant_id).eq("project_id", scope.project_id).eq("key", "public_application").maybeSingle();
  if (settingLookupError) throw new Error(`Workspace was created, but Hopkins public-application settings could not be read: ${settingLookupError.message}. Retry after resolving the setting access issue.`);
  if (existingSetting && !jsonEqual(existingSetting.value, settings.public_application)) {
    throw new Error("Workspace was created, but existing Hopkins public-application settings differ from the reviewed package; they were preserved unchanged.");
  }
  if (!existingSetting) {
    const insertSetting = await db.from("project_settings").insert({
      tenant_id: scope.tenant_id, project_id: scope.project_id, key: "public_application", value: settings.public_application
    });
    if (insertSetting.error) {
      const retryLookup = await db.from("project_settings").select("value").eq("tenant_id", scope.tenant_id)
        .eq("project_id", scope.project_id).eq("key", "public_application").maybeSingle();
      if (retryLookup.error || !retryLookup.data || !jsonEqual(retryLookup.data.value, settings.public_application)) {
        throw new Error(`Workspace was created, but reviewed Hopkins public settings were not installed: ${insertSetting.error.message}. The script is safe to rerun after resolving the setting state.`);
      }
    }
  }
  console.log(JSON.stringify({ project_ref: PRODUCTION_REF, workspace_ready: true, owner_email: OWNER_EMAIL,
    existing_super_admin_preserved: true, tenant_slug: config.tenant.slug, project_slug: config.project.slug,
    phase_slug: config.phase.slug, public_application_settings: "verified", outbound_notifications_enabled: false }, null, 2));
}

main().catch((error) => {
  console.error(`[hopkins-production-onboarding] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
