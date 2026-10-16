#!/usr/bin/env node
/**
 * Atomic hosted-tenant/project/phase bootstrap. Auth users are never created
 * or invited; pass an existing user UUID. No writes occur in dry-run mode.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROD_PROJECT_REF = "mtjlvzrtihslcftxnlso";
const DEFAULT_CONFIG = "map-input/hosted-pilot/hopkins-grove.json";

function argsFrom(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    if (["dry-run", "apply", "help"].includes(name)) args[name] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
      args[name] = value;
    }
  }
  return args;
}

function projectRefFromUrl(value) {
  const url = new URL(value);
  if (["localhost", "127.0.0.1"].includes(url.hostname)) return "local";
  const host = url.hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
  if (!host) throw new Error("SUPABASE_URL must be a Supabase project URL; custom hosts require a reviewed project-ref resolver.");
  return host[1];
}

function validateConfig(config) {
  for (const [label, value] of [
    ["tenant.slug", config.tenant?.slug], ["project.slug", config.project?.slug], ["phase.slug", config.phase?.slug],
  ]) if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) throw new Error(`${label} is invalid.`);
  if (!config.tenant.name?.trim() || !config.project.name?.trim() || !config.phase.name?.trim()) throw new Error("Tenant, project, and phase names are required.");
  if (!config.theme || typeof config.theme !== "object" || !config.company_profile || typeof config.company_profile !== "object") throw new Error("Theme and company profile objects are required.");
  if (config.project.map_experience_mode !== "demo") throw new Error("The Hopkins pilot project must be explicitly configured as demo mode.");
  if (!["owner", "admin", "staff", "read_only"].includes(config.membership_role)) throw new Error("membership_role is invalid.");
}

async function main() {
  const args = argsFrom(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/tenant-onboard.mjs [--config path] --staff-user-id <existing-auth-user-uuid> (--dry-run|--apply) [--expected-project-ref <ref>]");
    return;
  }
  if (Boolean(args["dry-run"]) === Boolean(args.apply)) throw new Error("Specify exactly one of --dry-run or --apply.");
  const configPath = resolve(args.config ?? DEFAULT_CONFIG);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  validateConfig(config);
  if (!args["staff-user-id"] || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args["staff-user-id"])) {
    throw new Error("Pass --staff-user-id for an existing Auth account. This command never creates or invites users.");
  }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (args.apply) {
    if (!url || !serviceKey) throw new Error("--apply requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment; never pass secrets as CLI arguments.");
    const actualRef = projectRefFromUrl(url);
    if (actualRef === PROD_PROJECT_REF) throw new Error("The production Wamule project is blocked by this onboarding utility.");
    if (!args["expected-project-ref"] || args["expected-project-ref"] !== actualRef) throw new Error("--apply requires --expected-project-ref to exactly match the configured backend.");
  }
  console.log(`[tenant:onboard] ${args.apply ? "APPLY" : "DRY RUN"}: ${config.tenant.slug}/${config.project.slug}/${config.phase.slug}`);
  console.log("[tenant:onboard] existing Auth account required; no invite or user creation; project map mode=demo; prices and sale status are not set.");
  console.log(`[tenant:onboard] config: ${configPath}`);
  if (!url || !serviceKey) {
    if (args.apply) throw new Error("Hosted onboarding cannot continue without service-role configuration.");
    console.log("[tenant:onboard] offline validation complete; zero backend reads or writes.");
    return;
  }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const user = await supabase.auth.admin.getUserById(args["staff-user-id"]);
  if (user.error || !user.data.user) throw new Error("The supplied account was not found in the configured Auth project.");
  if (args["dry-run"]) {
    console.log("[tenant:onboard] read-only check: existing Auth account found; would call the atomic onboarding RPC. No writes performed.");
    return;
  }
  const { data, error } = await supabase.rpc("onboard_project_tenant", {
    p_tenant_slug: config.tenant.slug,
    p_tenant_name: config.tenant.name,
    p_project_slug: config.project.slug,
    p_project_name: config.project.name,
    p_phase_slug: config.phase.slug,
    p_phase_name: config.phase.name,
    p_theme: config.theme,
    p_company_profile: config.company_profile,
    p_staff_user_id: args["staff-user-id"],
    p_member_role: config.membership_role,
    p_demo_mode: true,
  });
  if (error) throw new Error(`Atomic tenant onboarding failed: ${error.message}`);
  console.log(`[tenant:onboard] created/reused isolated Hopkins demo scope (${data?.created_or_reused ? "ready" : "unknown result"}); user UUID and credentials omitted.`);
}

main().catch((error) => {
  console.error(`[tenant:onboard] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
