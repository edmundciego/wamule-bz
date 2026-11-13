import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolvePublicApplicationSettings } from "../_shared/public-application-settings.mjs";
import { normalizePublicHostname, parsePublicHostnameResolution } from "../_shared/public-hostname.mjs";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
type RecordValue = Record<string, unknown>;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);

  const params = new URL(request.url).searchParams;
  const hostParam = params.get("host");
  const hostname = normalizePublicHostname(hostParam ?? "");
  const tenantSlug = slug(params.get("tenant"));
  const projectSlug = slug(params.get("project"));
  const phaseSlug = slug(params.get("phase"));
  const platformPath = !hostname;
  if ((hostParam !== null && !hostname) || !tenantSlug || !projectSlug || !phaseSlug) {
    return json({ error: "A verified host or explicit tenant, project, and phase are required." }, 400);
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  if (!platformPath) {
    const { data: bindingData, error: bindingError } = await client.rpc("resolve_public_hostname", { p_hostname: hostname });
    const binding = bindingError ? { resolved: false as const } : parsePublicHostnameResolution(bindingData);
    if (!binding.resolved || binding.scope.tenantSlug !== tenantSlug || binding.scope.projectSlug !== projectSlug) {
      return json({ error: "This project page does not match the verified public host." }, 404);
    }
  }

  const { data: tenant, error: tenantError } = await client.from("organizations")
    .select("id,name,slug,is_active").eq("slug", tenantSlug).eq("is_active", true).maybeSingle();
  if (tenantError || !tenant) return json({ error: "Public project information is unavailable." }, 503);
  const { data: project, error: projectError } = await client.from("projects")
    .select("id,name,slug,map_experience_mode").eq("tenant_id", tenant.id)
    .eq("slug", projectSlug).maybeSingle();
  if (projectError || !project || project.map_experience_mode !== "demo") {
    return json({ error: "Public project information is unavailable." }, 503);
  }
  const { data: phase, error: phaseError } = await client.from("development_phases")
    .select("id,name,slug,is_active").eq("tenant_id", tenant.id).eq("project_id", project.id)
    .eq("slug", phaseSlug).eq("is_active", true).maybeSingle();
  if (phaseError || !phase) return json({ error: "The selected project phase is not active." }, 404);

  if (platformPath) {
    const { data: snapshot, error: snapshotError } = await client.from("map_feature_snapshots")
      .select("id").eq("tenant_id", tenant.id).eq("project_id", project.id).eq("phase_id", phase.id)
      .eq("is_active", true).maybeSingle();
    if (snapshotError) return json({ error: "The public phase could not be verified." }, 503);
    if (!snapshot) return json({ error: "This phase is not published." }, 404);
    const { data: packageRow, error: packageError } = await client.from("project_map_packages")
      .select("id").eq("tenant_id", tenant.id).eq("project_id", project.id).eq("phase_id", phase.id)
      .eq("snapshot_id", snapshot.id).not("published_at", "is", null).maybeSingle();
    if (packageError) return json({ error: "The public phase could not be verified." }, 503);
    if (!packageRow) return json({ error: "This phase is not published." }, 404);
  }

  const [{ data: companyRows, error: companyError }, { data: projectRows, error: projectSettingsError }] = await Promise.all([
    client.from("business_settings").select("key,value").eq("tenant_id", tenant.id)
      .in("key", ["company_profile", "public_application"]),
    client.from("project_settings").select("key,value").eq("tenant_id", tenant.id).eq("project_id", project.id)
      .in("key", ["company_profile", "public_application"]),
  ]);
  if (companyError || projectSettingsError) return json({ error: "Public project settings are unavailable." }, 503);
  const companySettings = settingsByKey(companyRows ?? []);
  const projectSettings = settingsByKey(projectRows ?? []);
  const companyProfile = mergeProfile(companySettings.company_profile, projectSettings.company_profile);
  const companyName = text(companyProfile.company_name, 120);
  const email = text(companyProfile.contact_email, 254).toLowerCase();
  const phone = text(companyProfile.phone_number, 40);
  const website = safeHttpsUrl(companyProfile.website);
  const location = text(companyProfile.location_address, 240);
  const description = text(companyProfile.short_description, 500);
  const publicNotice = text(companyProfile.public_notice_text, 1000);
  if (!companyName || !emailPattern.test(email) || !phone || !website || !location || !description || !publicNotice) {
    return json({ error: "Public company information is incomplete." }, 503);
  }

  const effective = resolvePublicApplicationSettings(companySettings.public_application, projectSettings.public_application, phase.id);
  const companyApp = objectValue(companySettings.public_application);
  const projectApp = objectValue(projectSettings.public_application);
  const noticeVersion = text(projectApp.notice_version ?? companyApp.notice_version, 80);
  const allowedUses = arrayText(projectApp.allowed_intended_uses ?? companyApp.allowed_intended_uses, 40);
  const publicApplication = {
    applicationsOpen: effective.applicationsOpen && effective.noticesComplete,
    noticeVersion,
    publicNotice: effective.publicNoticeText,
    acknowledgmentText: effective.acknowledgmentText,
    intendedUses: allowedUses,
    maxMapPreferences: boundedInteger(projectApp.max_map_preferences ?? companyApp.max_map_preferences, 0, 10, 5),
    confirmationMessage: text(projectApp.default_confirmation_message ?? companyApp.default_confirmation_message, 500),
  };
  if (!publicApplication.noticeVersion || !publicApplication.publicNotice || !publicApplication.acknowledgmentText || !allowedUses.length) {
    return json({ error: "Public project notices or preferences are incomplete." }, 503);
  }

  return json({
    tenant: { name: text(tenant.name, 120), slug: tenant.slug },
    project: { name: text(project.name, 120), slug: project.slug, mapExperienceMode: "demo" },
    phase: { name: text(phase.name, 120), slug: phase.slug },
    company: { name: companyName, email, phone, website, location, description, publicNotice },
    applicationSettings: publicApplication,
  }, 200);
});

const emailPattern = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

function settingsByKey(rows: Array<{ key: string; value: unknown }>): Record<string, unknown> {
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function mergeProfile(companyInput: unknown, projectInput: unknown): RecordValue {
  const company = objectValue(companyInput);
  const project = objectValue(projectInput);
  return Object.fromEntries(["company_name", "contact_email", "phone_number", "website", "location_address", "short_description", "public_notice_text"]
    .map((key) => [key, project[key] ?? company[key]]));
}
function slug(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9-]{0,78}$/.test(normalized) ? normalized : null;
}
function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, limit) : "";
}
function arrayText(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.map((item) => text(item, limit)).filter(Boolean).slice(0, 20) : [];
}
function safeHttpsUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try { const url = new URL(value); return url.protocol === "https:" ? url.toString() : ""; } catch { return ""; }
}
function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = typeof value === "number" && Number.isInteger(value) ? value : fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store, max-age=0", "CDN-Cache-Control": "no-store", "Surrogate-Control": "no-store" },
  });
}
