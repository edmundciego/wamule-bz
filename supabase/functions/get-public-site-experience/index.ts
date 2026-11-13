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
const moduleIds = ["map", "inquiry", "application", "pricing"] as const;
type TemplateId = "wamule-classic" | "hopkins-project";
type SettingRow = { key: string; value: unknown };

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);

  const query = new URL(request.url).searchParams;
  const hostParam = query.get("host");
  const hostname = normalizePublicHostname(hostParam ?? "");
  const requestedTenantSlug = slug(query.get("tenant"));
  const requestedProjectSlug = slug(query.get("project"));
  const explicitPhase = query.has("phase");
  const requestedPhaseSlug = explicitPhase ? slug(query.get("phase")) : null;
  const platformPath = !hostname;
  if ((hostParam !== null && !hostname)
    || (platformPath && (!requestedTenantSlug || !requestedProjectSlug || !requestedPhaseSlug))
    || (explicitPhase && !requestedPhaseSlug)) {
    return json({ error: "This public project address or phase is invalid." }, 400);
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let resolvedTenantSlug = requestedTenantSlug;
  let resolvedProjectSlug = requestedProjectSlug;
  let defaultPhaseSlug: string | null = null;
  if (!platformPath) {
    const { data: bindingData, error: bindingError } = await client.rpc("resolve_public_hostname", { p_hostname: hostname });
    const binding = bindingError ? { resolved: false as const, reason: "resolver_unavailable" } : parsePublicHostnameResolution(bindingData);
    if (!binding.resolved) return json({ error: "This public project address could not be verified." }, 404);
    resolvedTenantSlug = binding.scope.tenantSlug;
    resolvedProjectSlug = binding.scope.projectSlug;
    defaultPhaseSlug = binding.scope.phaseSlug;
  }
  if (!resolvedTenantSlug || !resolvedProjectSlug) return json({ error: "A tenant and project are required." }, 400);

  const { data: tenant, error: tenantError } = await client.from("organizations")
    .select("id,name,slug,is_active").eq("slug", resolvedTenantSlug).eq("is_active", true).maybeSingle();
  if (tenantError || !tenant) return json({ error: "Public project information is unavailable." }, 404);

  const { data: project, error: projectError } = await client.from("projects")
    .select("id,name,slug,map_experience_mode").eq("tenant_id", tenant.id)
    .eq("slug", resolvedProjectSlug).maybeSingle();
  if (projectError || !project) return json({ error: "Public project information is unavailable." }, 404);

  const { data: activePhases, error: phasesError } = await client.from("development_phases")
    .select("id,name,slug,is_active,is_default").eq("tenant_id", tenant.id).eq("project_id", project.id)
    .eq("is_active", true).order("slug", { ascending: true });
  if (phasesError || !Array.isArray(activePhases) || activePhases.length === 0) {
    return json({ error: "Public project phases are unavailable." }, phasesError ? 503 : 404);
  }

  let phaseSlug = requestedPhaseSlug;
  if (!explicitPhase) phaseSlug = defaultPhaseSlug;
  const phase = phaseSlug
    ? activePhases.find((candidate) => candidate.slug === phaseSlug)
    : activePhases.find((candidate) => candidate.is_default === true);
  if (!phase) return json({ error: "The selected project phase is unavailable." }, 404);

  // Path-based tenant routes are public only after that exact phase has an
  // explicitly published Map Studio package. Unpublished maps stay behind
  // authenticated workspace RLS and the private Storage bucket.
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

  const [companySettingsResult, projectSettingsResult, plansResult, methodsResult] = await Promise.all([
    client.from("business_settings").select("key,value").eq("tenant_id", tenant.id)
      .in("key", ["company_profile", "public_application", "lot_phase"]),
    client.from("project_settings").select("key,value").eq("tenant_id", tenant.id).eq("project_id", project.id)
      .in("key", ["tenant_theme", "company_profile", "public_application"]),
    client.from("installment_plans").select("id,name,description,reservation_fee,initial_deposit,final_purchase_price,term_months,monthly_payment,is_active,sort_order")
      .eq("tenant_id", tenant.id).eq("is_active", true).order("sort_order", { ascending: true }),
    client.from("payment_methods").select("id,name,method_type,bank_name,account_name,account_number,currency,instructions,is_active,is_public,sort_order")
      .eq("tenant_id", tenant.id).eq("is_active", true).eq("is_public", true).order("sort_order", { ascending: true }),
  ]);
  if (companySettingsResult.error || projectSettingsResult.error || plansResult.error || methodsResult.error) {
    console.error("Public site projection lookup failed", safeError(companySettingsResult.error ?? projectSettingsResult.error ?? plansResult.error ?? methodsResult.error));
    return json({ error: "Public project settings are unavailable." }, 503);
  }

  const companySettings = settingsByKey(companySettingsResult.data as SettingRow[] ?? []);
  const projectSettings = settingsByKey(projectSettingsResult.data as SettingRow[] ?? []);
  const companyProfile = safeCompanyProfile(companySettings.company_profile, projectSettings.company_profile);
  if (!companyProfile.company_name) return json({ error: "Public company information is incomplete." }, 503);

  const effectiveApplication = resolvePublicApplicationSettings(
    companySettings.public_application,
    projectSettings.public_application,
    phase.id,
  );
  const companyApplication = objectValue(companySettings.public_application);
  const projectApplication = objectValue(projectSettings.public_application);
  const applicationType = projectApplication.application_type === "project_application"
    ? "project_application"
    : "land_purchase";
  const publicApplication = {
    applications_open: effectiveApplication.applicationsOpen && effectiveApplication.noticesComplete,
    notices_complete: effectiveApplication.noticesComplete,
    public_notice_text: effectiveApplication.publicNoticeText,
    application_acknowledgment_text: effectiveApplication.acknowledgmentText,
    default_confirmation_message: cleanText(projectApplication.default_confirmation_message)
      || cleanText(companyApplication.default_confirmation_message),
    show_lot_prices_publicly: companyApplication.show_lot_prices_publicly === true
      && projectApplication.show_lot_prices_publicly === true,
    show_available_lot_count_publicly: companyApplication.show_available_lot_count_publicly === true
      && projectApplication.show_available_lot_count_publicly === true,
  };

  const theme = objectValue(projectSettings.tenant_theme);
  const rawExperience = objectValue(theme.site_experience);
  const fallbackTemplate: TemplateId = project.map_experience_mode === "demo" && tenant.slug === "hopkins-grove"
    ? "hopkins-project"
    : "wamule-classic";
  const templateId: TemplateId = rawExperience.templateId === "wamule-classic" || rawExperience.templateId === "hopkins-project"
    ? rawExperience.templateId
    : fallbackTemplate;
  const defaults = { map: true, inquiry: true, application: true, pricing: true };
  const inputModules = objectValue(rawExperience.enabledModules);
  const enabledModules = Object.fromEntries(moduleIds.map((key) => [
    key,
    typeof inputModules[key] === "boolean" ? inputModules[key] : defaults[key],
  ]));

  return json({
    scope: { tenantSlug: tenant.slug, projectSlug: project.slug, phaseSlug: phase.slug },
    phases: activePhases.map((item) => ({ slug: item.slug, name: item.name })),
    siteExperience: { templateId, applicationType, enabledModules },
    company: companyProfile,
    publicApplication,
    installmentPlans: plansResult.data ?? [],
    paymentMethods: methodsResult.data ?? [],
  }, 200);
});

function settingsByKey(rows: SettingRow[]): Record<string, unknown> {
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function safeCompanyProfile(companyInput: unknown, projectInput: unknown) {
  const company = objectValue(companyInput);
  const project = objectValue(projectInput);
  const field = (key: string, maximum: number) => (cleanText(project[key]) || cleanText(company[key])).slice(0, maximum);
  return {
    company_name: field("company_name", 120).slice(0, 120),
    logo_url: safeHttpsUrl(field("logo_url", 500)),
    short_description: field("short_description", 500).slice(0, 500),
    contact_email: field("contact_email", 254).toLowerCase().slice(0, 254),
    phone_number: field("phone_number", 40).slice(0, 40),
    location_address: field("location_address", 240).slice(0, 240),
    website: safeHttpsUrl(field("website", 500)),
  };
}

function slug(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9-]{0,78}$/.test(normalized) ? normalized : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim() : "";
}

function safeHttpsUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function safeError(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const value = error as { code?: unknown; message?: unknown };
  return [value.code, value.message].filter((part) => typeof part === "string").join(": ").slice(0, 300);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store, max-age=0",
      "CDN-Cache-Control": "no-store",
      "Surrogate-Control": "no-store",
    },
  });
}
