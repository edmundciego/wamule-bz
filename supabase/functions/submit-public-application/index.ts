import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  validatePublicApplicationPayload,
  type PublicApplicationPayload,
} from "../_shared/public-application-contract.ts";
import { parsePublicLotReference } from "../_shared/public-lot-reference.ts";
import { resolvePublicApplicationSettings } from "../_shared/public-application-settings.mjs";
import { normalizePublicHostname, parsePublicHostnameResolution } from "../_shared/public-hostname.mjs";
import {
  applyProjectAndVersionScope,
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

  const hostname = normalizePublicHostname(input.hostname);
  const { data: bindingData, error: bindingError } = hostname
    ? await supabase.rpc("resolve_public_hostname", { p_hostname: hostname })
    : { data: null, error: new Error("Missing host") };
  const binding = bindingError ? { resolved: false as const } : parsePublicHostnameResolution(bindingData);
  if (!binding.resolved || binding.scope.tenantSlug !== input.tenant || binding.scope.projectSlug !== input.project) {
    return json({ error: "This application link does not match the verified project address." }, 400);
  }

  const parts = input.preferred_lot_refs.map((reference) => parsePublicLotReference(reference)!);
  if (parts.some((part) => part.projectSlug !== input.project || (part.phaseSlug && part.phaseSlug !== input.phase))) {
    return json({ error: "Choose preferred lots from the selected published phase." }, 400);
  }
  const applicationScope = await resolveApplicationScope(supabase, tenant.id, input.project, input.phase);
  if (!applicationScope) return json({ error: "The selected project phase could not be verified." }, 503);
  const [{ data: companySetting, error: companySettingError }, { data: projectSetting, error: projectSettingError }] = await Promise.all([
    supabase.from("business_settings").select("value").eq("tenant_id", tenant.id).eq("key", "public_application").maybeSingle(),
    supabase.from("project_settings").select("value").eq("tenant_id", tenant.id)
      .eq("project_id", applicationScope.projectId).eq("key", "public_application").maybeSingle(),
  ]);
  if (companySettingError || projectSettingError) {
    console.error("Public application settings lookup failed", safeError(companySettingError ?? projectSettingError));
    return json({ error: "Applications could not be verified right now. Please try again later." }, 503);
  }
  const effectiveSettings = resolvePublicApplicationSettings(
    companySetting?.value,
    projectSetting?.value,
    applicationScope.phaseId,
  );
  if (!effectiveSettings.applicationsOpen || !effectiveSettings.noticesComplete) {
    return json({ error: "Applications are currently closed." }, 403);
  }

  /* Application intake is restricted to this verified active phase and the
     same published package used by the public inventory endpoint. */
  const { data: activeSnapshot, error: snapshotError } = await supabase.from("map_feature_snapshots")
    .select("id").eq("tenant_id", tenant.id).eq("project_id", applicationScope.projectId)
    .eq("phase_id", applicationScope.phaseId).eq("is_active", true).maybeSingle();
  if (snapshotError || !activeSnapshot) {
    if (snapshotError) console.error("Public application snapshot lookup failed", safeError(snapshotError));
    return json({ error: "Applications are unavailable for this unpublished phase." }, snapshotError ? 503 : 403);
  }
  const { data: publishedPackage, error: packageError } = await supabase.from("project_map_packages")
    .select("id").eq("tenant_id", tenant.id).eq("project_id", applicationScope.projectId)
    .eq("phase_id", applicationScope.phaseId).eq("snapshot_id", activeSnapshot.id)
    .not("published_at", "is", null).maybeSingle();
  if (packageError || !publishedPackage) {
    if (packageError) console.error("Public application publication lookup failed", safeError(packageError));
    return json({ error: "Applications are unavailable for this unpublished phase." }, packageError ? 503 : 403);
  }

  /* Keep all of the visibility checks on the exact selected phase. */
  const { data: publicFeatures, error: featuresError } = await supabase.from("map_features")
    .select("identity_id").eq("tenant_id", tenant.id).eq("project_id", applicationScope.projectId)
    .eq("phase_id", applicationScope.phaseId).eq("snapshot_id", activeSnapshot.id)
    .eq("is_active", true).eq("public_visible", true);
  if (featuresError) {
    console.error("Public application feature lookup failed", safeError(featuresError));
    return json({ error: "The public lot list could not be verified. Please try again." }, 503);
  }
  const featureIds = (publicFeatures ?? []).map((feature) => String(feature.identity_id));
  const { data: visibleContent, error: contentError } = featureIds.length
    ? await supabase.from("project_plot_content").select("parcel_id")
      .eq("tenant_id", tenant.id).eq("project_id", applicationScope.projectId)
      .eq("phase_id", applicationScope.phaseId).eq("public_visible", true)
      .in("identity_id", featureIds)
    : { data: [], error: null };
  if (contentError) {
    console.error("Public application plot-content lookup failed", safeError(contentError));
    return json({ error: "The public lot list could not be verified. Please try again." }, 503);
  }
  const publicParcelIds = (visibleContent ?? []).map((content) => content.parcel_id)
    .filter((id): id is number => typeof id === "number");

  const lotResolution = await resolveAvailableLots(supabase, tenant.id, applicationScope, publicParcelIds, parts);
  if (lotResolution.error === "database") {
    return json({ error: "The current lot list could not be verified. Please try again." }, 503);
  }
  if (!lotResolution.lots) return json({ error: "One or more selected lots are no longer available." }, 400);

  const nameParts = splitApplicantName(input.applicant_full_name);
  const { error: insertError } = await supabase.from("applications").insert({
    tenant_id: tenant.id,
    project_id: applicationScope.projectId,
    phase_id: applicationScope.phaseId,
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

async function resolveApplicationScope(
  supabase: ReturnType<typeof createClient>, tenantId: string, projectSlug: string, phaseSlug: string,
): Promise<{ projectId: string; projectSlug: string; phaseId: string; phaseSlug: string } | null> {
  const { data: project, error: projectError } = await supabase.from("projects")
    .select("id,slug").eq("tenant_id", tenantId).eq("slug", projectSlug).maybeSingle();
  if (projectError || !project) return null;
  const { data: phase, error: phaseError } = await supabase.from("development_phases")
    .select("id,slug").eq("tenant_id", tenantId).eq("project_id", project.id)
    .eq("slug", phaseSlug).eq("is_active", true).maybeSingle();
  if (phaseError || !phase) return null;
  return { projectId: project.id, projectSlug: project.slug, phaseId: phase.id, phaseSlug: phase.slug };
}

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
  scope: { projectId: string; projectSlug: string; phaseId: string; phaseSlug: string },
  publicParcelIds: number[],
  references: Array<{ projectSlug: string; phaseSlug: string | null; lotNumber: string }>,
): Promise<{ lots: PublishedLot[] | null; error: "database" | null }> {
  if (publicParcelIds.length === 0) return { lots: null, error: null };
  const { data: activeVersion, error: versionError } = await supabase.from("masterplan_versions")
    .select("id").eq("tenant_id", tenantId).eq("project_id", scope.projectId)
    .eq("phase_id", scope.phaseId).eq("is_active", true).maybeSingle();
  if (versionError) {
    console.error("Public application map scope lookup failed", safeError(versionError));
    return { lots: null, error: "database" };
  }
  const version = normalizeActiveVersionLookup(activeVersion as { id?: unknown } | null, null);
  if (!version.ok) return { lots: null, error: "database" };

  const legacyLotNumbers = [...new Set(references
    .filter((reference) => reference.phaseSlug === null)
    .map((reference) => reference.lotNumber))];
  if (legacyLotNumbers.length) {
    const { data: legacyCandidates, error: legacyError } = await supabase.from("parcels")
      .select("lot_number, phase_id")
      .eq("tenant_id", tenantId).eq("project_id", scope.projectId)
      .in("lot_number", legacyLotNumbers);
    if (legacyError) {
      console.error("Public application legacy lot ambiguity lookup failed", safeError(legacyError));
      return { lots: null, error: "database" };
    }
    const phasesByLot = new Map<string, Set<string | null>>();
    for (const candidate of legacyCandidates ?? []) {
      const lotNumber = String(candidate.lot_number);
      const phases = phasesByLot.get(lotNumber) ?? new Set<string | null>();
      phases.add(typeof candidate.phase_id === "string" ? candidate.phase_id : null);
      phasesByLot.set(lotNumber, phases);
    }
    if (legacyLotNumbers.some((lotNumber) => {
      const phases = phasesByLot.get(lotNumber);
      return !phases || phases.size !== 1 || !phases.has(scope.phaseId);
    })) return { lots: null, error: null };
  }

  const lots: PublishedLot[] = [];
  for (const reference of references) {
    if (reference.projectSlug !== scope.projectSlug
      || (reference.phaseSlug !== null && reference.phaseSlug !== scope.phaseSlug)) return { lots: null, error: null };

    const { data, error } = await applyProjectAndVersionScope(
      supabase.from("parcels")
        .select("id, lot_number, status")
        .eq("tenant_id", tenantId)
        .eq("project_id", scope.projectId)
        .eq("phase_id", scope.phaseId)
        .eq("lot_number", reference.lotNumber)
        .in("id", publicParcelIds)
        .eq("status", "Available"),
      { id: scope.projectId, slug: scope.projectSlug, name: "", isDefault: false },
      version.versionId,
    ).eq("needs_review", false).limit(2);
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

function safeError(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "Unknown error");
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders,
      "Cache-Control": "no-store, max-age=0",
      "CDN-Cache-Control": "no-store",
      "Surrogate-Control": "no-store",
    },
  });
}
