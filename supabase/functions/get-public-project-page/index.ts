import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const scope = { tenant: "hopkins-grove", project: "hopkins-grove", phase: "initial" } as const;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

type Profile = Record<string, unknown>;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: tenant, error: tenantError } = await client.from("organizations")
    .select("id,name,slug,is_active").eq("slug", scope.tenant).eq("is_active", true).maybeSingle();
  if (tenantError || !tenant) return json({ error: "Hopkins project information is unavailable." }, 503);

  const { data: project, error: projectError } = await client.from("projects")
    .select("id,name,slug,map_experience_mode").eq("tenant_id", tenant.id).eq("slug", scope.project).maybeSingle();
  if (projectError || !project || project.map_experience_mode !== "demo") {
    return json({ error: "Hopkins project information is unavailable." }, 503);
  }

  const { data: phase, error: phaseError } = await client.from("development_phases")
    .select("id,name,slug,is_active").eq("tenant_id", tenant.id).eq("project_id", project.id)
    .eq("slug", scope.phase).eq("is_active", true).maybeSingle();
  if (phaseError || !phase) return json({ error: "Hopkins project phase is not published." }, 503);

  // The public profile is read from this exact project only. No tenant-level
  // or legacy Wamule business_settings fallback is permitted here.
  const [{ data: setting, error: settingError }, { data: applicationSetting, error: applicationSettingError }] = await Promise.all([
    client.from("project_settings").select("value").eq("tenant_id", tenant.id).eq("project_id", project.id)
      .eq("key", "company_profile").maybeSingle(),
    client.from("project_settings").select("value").eq("tenant_id", tenant.id).eq("project_id", project.id)
      .eq("key", "public_application").maybeSingle(),
  ]);
  if (settingError || !setting?.value || typeof setting.value !== "object" || Array.isArray(setting.value)) {
    return json({ error: "Hopkins public company information has not been published." }, 503);
  }
  if (applicationSettingError || !applicationSetting?.value || typeof applicationSetting.value !== "object" || Array.isArray(applicationSetting.value)) {
    return json({ error: "Hopkins project applications have not been configured." }, 503);
  }

  const profile = setting.value as Profile;
  const name = text(profile.company_name, 120);
  const email = text(profile.contact_email, 254).toLowerCase();
  const phone = text(profile.phone_number, 40);
  const website = safeHttpsUrl(profile.website);
  const location = text(profile.location_address, 240);
  const description = text(profile.short_description, 500);
  const publicNotice = text(profile.public_notice_text, 1000);
  const application = applicationSetting.value as Profile;
  const intendedUses = Array.isArray(application.allowed_intended_uses)
    ? application.allowed_intended_uses.map((item) => text(item, 40)).filter((item): item is string => !!item)
    : [];
  const applicationsOpen = application.applications_open === true;
  const noticeVersion = text(application.notice_version, 80);
  const applicationPublicNotice = text(application.public_notice_text, 1200);
  const acknowledgmentText = text(application.application_acknowledgment_text, 1600);
  const maxMapPreferences = Number.isInteger(application.max_map_preferences)
    ? Math.min(10, Math.max(0, Number(application.max_map_preferences)))
    : 5;
  const confirmationMessage = text(application.default_confirmation_message, 500);
  if (!name || !emailPattern.test(email) || !phone || !website || !location || !description || !publicNotice) {
    return json({ error: "Hopkins public company information is incomplete." }, 503);
  }
  if (!noticeVersion || !applicationPublicNotice || !acknowledgmentText || intendedUses.length === 0) {
    return json({ error: "Hopkins application notices or preferences are incomplete." }, 503);
  }

  return json({
    tenant: { name: text(tenant.name, 120), slug: scope.tenant },
    project: { name: text(project.name, 120), slug: scope.project, mapExperienceMode: "demo" },
    phase: { name: text(phase.name, 120), slug: scope.phase },
    company: { name, email, phone, website, location, description, publicNotice },
    applicationSettings: {
      applicationsOpen,
      noticeVersion,
      publicNotice: applicationPublicNotice,
      acknowledgmentText,
      intendedUses,
      maxMapPreferences,
      confirmationMessage,
    },
  }, 200);
});

const emailPattern = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function safeHttpsUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=60, stale-while-revalidate=60" },
  });
}
