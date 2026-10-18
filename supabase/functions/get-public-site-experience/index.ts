import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const moduleIds = ["map", "inquiry", "application", "pricing"] as const;
type TemplateId = "wamule-classic" | "hopkins-project";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);

  const query = new URL(request.url).searchParams;
  const scope = {
    tenantSlug: slug(query.get("tenant")),
    projectSlug: slug(query.get("project")),
    phaseSlug: slug(query.get("phase")),
  };
  if (!scope.tenantSlug || !scope.projectSlug || !scope.phaseSlug) {
    return json({ error: "A valid tenant, project, and phase are required." }, 400);
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: tenant, error: tenantError } = await client.from("organizations")
    .select("id").eq("slug", scope.tenantSlug).eq("is_active", true).maybeSingle();
  if (tenantError || !tenant) return json({ error: "Public project information is unavailable." }, 404);

  const { data: project, error: projectError } = await client.from("projects")
    .select("id,slug").eq("tenant_id", tenant.id).eq("slug", scope.projectSlug).maybeSingle();
  if (projectError || !project) return json({ error: "Public project information is unavailable." }, 404);

  const { data: phase, error: phaseError } = await client.from("development_phases")
    .select("id,slug,is_active").eq("tenant_id", tenant.id).eq("project_id", project.id)
    .eq("slug", scope.phaseSlug).eq("is_active", true).maybeSingle();
  if (phaseError || !phase) return json({ error: "Public project phase is unavailable." }, 404);

  const { data: theme, error: themeError } = await client.from("project_settings")
    .select("value").eq("tenant_id", tenant.id).eq("project_id", project.id)
    .eq("key", "tenant_theme").maybeSingle();
  if (themeError) return json({ error: "Public site settings are unavailable." }, 503);

  const fallbackTemplate: TemplateId = "wamule-classic";
  const settings = isObject(theme?.value) && isObject(theme.value.site_experience) ? theme.value.site_experience : {};
  const templateId: TemplateId = settings.templateId === "wamule-classic" || settings.templateId === "hopkins-project"
    ? settings.templateId
    : fallbackTemplate;
  const defaults = { map: true, inquiry: true, application: true, pricing: true };
  const inputModules = isObject(settings.enabledModules) ? settings.enabledModules : {};
  const enabledModules = Object.fromEntries(moduleIds.map((key) => [
    key,
    typeof inputModules[key] === "boolean" ? inputModules[key] : defaults[key],
  ]));

  return json({ scope, siteExperience: { templateId, enabledModules, uiRestrictedAccess: settings.uiRestrictedAccess === true } }, 200);
});

function slug(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$|^[a-z0-9]$/.test(normalized) ? normalized : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=30, stale-while-revalidate=30" },
  });
}
