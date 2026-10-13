import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  validatePublicApplicationPayload,
  type PublicApplicationPayload,
} from "../_shared/public-application-contract.ts";
import { parsePublicLotReference } from "../_shared/public-lot-reference.ts";
import {
  applyProjectAndVersionScope,
  chooseResolvedProject,
  normalizeActiveVersionLookup,
} from "../get-public-lots/project-scope.mjs";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type PublishedLot = { id: number; lot_number: string; status: string };
type TenantRow = { id: string; slug: string; inbound_alias: string | null; is_active: boolean };

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const body = (await request.json().catch(() => null)) as PublicApplicationPayload | null;
  const input = validatePublicApplicationPayload(body ?? {});
  if ("error" in input) return json({ error: input.error }, 400);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const tenant = await resolveTenant(supabase, input.tenant);
  if (!tenant) return json({ error: "Unknown development. Please check the application link." }, 400);

  const { data: applicationSetting, error: settingError } = await supabase
    .from("business_settings")
    .select("value")
    .eq("tenant_id", tenant.id)
    .eq("key", "public_application")
    .maybeSingle();
  if (settingError || !applicationSetting) {
    console.error("Public application settings lookup failed", safeError(settingError));
    return json({ error: "Applications could not be verified right now. Please try again later." }, 503);
  }
  const settings = valueObject(applicationSetting.value);
  if (settings.applications_open !== true) return json({ error: "Applications are currently closed." }, 403);

  const parts = input.preferred_lot_refs.map((reference) => parsePublicLotReference(reference)!);
  const lotResolution = await resolveAvailableLots(supabase, tenant.id, parts);
  if (lotResolution.error === "database") {
    return json({ error: "The current lot list could not be verified. Please try again." }, 503);
  }
  if (!lotResolution.lots) return json({ error: "One or more selected lots are no longer available." }, 400);

  const nameParts = splitApplicantName(input.applicant_full_name);
  const { error: insertError } = await supabase.from("applications").insert({
    tenant_id: tenant.id,
    first_name: nameParts.firstName,
    last_name: nameParts.lastName,
    applicant_full_name: input.applicant_full_name,
    applicant_address: input.applicant_address,
    nationality: input.nationality,
    occupation: input.occupation,
    phone: input.phone,
    email: input.email,
    intended_use: input.intended_use,
    intended_use_other: input.intended_use_other || null,
    parcel_count: input.parcel_count,
    preferred_parcel_ids: lotResolution.lots.map((lot) => lot.id),
    alternate_lot_preference: input.alternate_lot_preference,
    payment_option: input.payment_option,
    legal_notice_acknowledged: input.legal_notice_acknowledged,
    applicant_acknowledgement_signature: input.applicant_acknowledgement_signature,
    notes: input.notes || null,
    cultural_preservation_review: "Applicant acknowledged the published application notice, reservation terms, and applicant acknowledgement.",
    sustainability_terms_verified: input.sustainability_terms_verified,
    status: "Pending Review",
    created_by: null,
  });

  if (insertError) {
    console.error("Public application insert failed", safeError(insertError));
    return json({ error: "We could not save your application. Please try again." }, 500);
  }

  return json({ ok: true, message: "Your application was submitted for review." });
});

async function resolveTenant(
  supabase: ReturnType<typeof createClient>,
  slug: string,
): Promise<TenantRow | null> {
  const bySlug = await supabase
    .from("organizations")
    .select("id, slug, inbound_alias, is_active")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();
  if (bySlug.data) return bySlug.data as TenantRow;
  const byAlias = await supabase
    .from("organizations")
    .select("id, slug, inbound_alias, is_active")
    .eq("inbound_alias", slug)
    .eq("is_active", true)
    .maybeSingle();
  if (byAlias.error) console.error("Public application tenant lookup failed", safeError(byAlias.error));
  return (byAlias.data ?? null) as TenantRow | null;
}

async function resolveAvailableLots(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  references: Array<{ projectSlug: string; lotNumber: string }>,
): Promise<{ lots: PublishedLot[] | null; error: "database" | null }> {
  const [{ data: projectRows, error: projectsError }, { data: activeVersion, error: versionError }] = await Promise.all([
    supabase
      .from("projects")
      .select("id, slug, name, is_default, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: true }),
    supabase
      .from("masterplan_versions")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .maybeSingle(),
  ]);
  if (projectsError || versionError) {
    console.error("Public application map scope lookup failed", safeError(projectsError ?? versionError));
    return { lots: null, error: "database" };
  }
  const version = normalizeActiveVersionLookup(activeVersion as { id?: unknown } | null, null);
  if (!version.ok) return { lots: null, error: "database" };

  const projectCache = new Map<string, ReturnType<typeof chooseResolvedProject>>();
  const lots: PublishedLot[] = [];
  for (const reference of references) {
    let project = projectCache.get(reference.projectSlug);
    if (project === undefined) {
      project = chooseResolvedProject(projectRows ?? [], reference.projectSlug);
      projectCache.set(reference.projectSlug, project);
    }
    if (!project) return { lots: null, error: null };

    const { data, error } = await applyProjectAndVersionScope(
      supabase.from("parcels")
        .select("id, lot_number, status")
        .eq("tenant_id", tenantId)
        .eq("lot_number", reference.lotNumber)
        .eq("status", "Available"),
      project,
      version.versionId,
    ).limit(2);
    if (error) {
      console.error("Public application lot resolution failed", safeError(error));
      return { lots: null, error: "database" };
    }
    if (!Array.isArray(data) || data.length !== 1) return { lots: null, error: null };
    lots.push(data[0] as PublishedLot);
  }
  return { lots, error: null };
}

function splitApplicantName(fullName: string) {
  const parts = fullName.trim().split(/\s+/);
  return {
    firstName: parts[0] ?? fullName.trim(),
    lastName: parts.slice(1).join(" ") || parts[0] || "Applicant",
  };
}

function valueObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "Unknown error");
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}
