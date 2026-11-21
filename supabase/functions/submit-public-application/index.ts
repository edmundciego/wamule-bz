import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  validatePublicApplicationPayload,
  type PublicApplicationPayload,
} from "../_shared/public-application-contract.ts";
import { parsePublicLotReference } from "../_shared/public-lot-reference.ts";
import { resolvePublicApplicationSettings } from "../_shared/public-application-settings.mjs";
import { resolvePublicSubmissionScope } from "../_shared/public-submission-scope.mjs";
import { submissionFingerprint } from "../_shared/submission-fingerprint.mjs";
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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const body = (await request.json().catch(() => null)) as PublicApplicationPayload | null;
  const input = validatePublicApplicationPayload(body ?? {});
  if ("error" in input) return json({ error: input.error }, 400);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const resolved = await resolvePublicSubmissionScope(supabase, {
    tenantSlug: input.tenant, projectSlug: input.project, phaseSlug: input.phase,
    hostname: input.hostname, allowTenantAlias: true,
  });
  if (!resolved.ok) {
    const status = resolved.reason === "lookup_failed" ? 503 : 400;
    return json({ error: resolved.reason === "host_mismatch" || resolved.reason === "unverified_hostname"
      ? "This application link does not match a verified public project address."
      : "The selected project phase could not be verified." }, status);
  }
  const applicationScope = resolved.scope;
  const tenantId = applicationScope.tenantId;

  const parts = input.preferred_lot_refs.map((reference) => parsePublicLotReference(reference)!);
  if (parts.some((part) => part.projectSlug !== applicationScope.projectSlug
    || (part.phaseSlug && part.phaseSlug !== applicationScope.phaseSlug))) {
    return json({ error: "Choose preferred lots from the selected published phase." }, 400);
  }
  const [{ data: companySetting, error: companySettingError }, { data: projectSetting, error: projectSettingError }] = await Promise.all([
    supabase.from("business_settings").select("value").eq("tenant_id", tenantId).eq("key", "public_application").maybeSingle(),
    supabase.from("project_settings").select("value").eq("tenant_id", tenantId)
      .eq("project_id", applicationScope.projectId).eq("key", "public_application").maybeSingle(),
  ]);
  if (companySettingError || projectSettingError) {
    console.error("Public application settings lookup failed", safeError(companySettingError ?? projectSettingError));
    return json({ error: "Applications could not be verified right now. Please try again later." }, 503);
  }
  const configuredProjectSettings = projectSetting?.value && typeof projectSetting.value === "object" && !Array.isArray(projectSetting.value)
    ? projectSetting.value as Record<string, unknown>
    : {};
  if (configuredProjectSettings.application_type === "project_application") {
    return json({ error: "Land applications are not enabled for this development." }, 403);
  }
  const effectiveSettings = resolvePublicApplicationSettings(
    companySetting?.value,
    projectSetting?.value,
    applicationScope.phaseId,
  );
  if (!effectiveSettings.noticesComplete) {
    return json({ error: "Application notices are incomplete." }, 503);
  }

  /* Application intake is restricted to this verified active phase and the
     same published package used by the public inventory endpoint. */
  const { data: activeSnapshot, error: snapshotError } = await supabase.from("map_feature_snapshots")
    .select("id").eq("tenant_id", tenantId).eq("project_id", applicationScope.projectId)
    .eq("phase_id", applicationScope.phaseId).eq("is_active", true).maybeSingle();
  if (snapshotError || !activeSnapshot) {
    if (snapshotError) console.error("Public application snapshot lookup failed", safeError(snapshotError));
    return json({ error: "Applications are unavailable for this unpublished phase." }, snapshotError ? 503 : 403);
  }
  const { data: publishedPackage, error: packageError } = await supabase.from("project_map_packages")
    .select("id").eq("tenant_id", tenantId).eq("project_id", applicationScope.projectId)
    .eq("phase_id", applicationScope.phaseId).eq("snapshot_id", activeSnapshot.id)
    .not("published_at", "is", null).maybeSingle();
  if (packageError || !publishedPackage) {
    if (packageError) console.error("Public application publication lookup failed", safeError(packageError));
    return json({ error: "Applications are unavailable for this unpublished phase." }, packageError ? 503 : 403);
  }

  /* Keep all of the visibility checks on the exact selected phase. */
  const { data: publicFeatures, error: featuresError } = await supabase.from("map_features")
    .select("identity_id").eq("tenant_id", tenantId).eq("project_id", applicationScope.projectId)
    .eq("phase_id", applicationScope.phaseId).eq("snapshot_id", activeSnapshot.id)
    .eq("is_active", true).eq("public_visible", true);
  if (featuresError) {
    console.error("Public application feature lookup failed", safeError(featuresError));
    return json({ error: "The public lot list could not be verified. Please try again." }, 503);
  }
  const featureIds = (publicFeatures ?? []).map((feature) => String(feature.identity_id));
  const { data: visibleContent, error: contentError } = featureIds.length
    ? await supabase.from("project_plot_content").select("parcel_id")
      .eq("tenant_id", tenantId).eq("project_id", applicationScope.projectId)
      .eq("phase_id", applicationScope.phaseId).eq("public_visible", true)
      .in("identity_id", featureIds)
    : { data: [], error: null };
  if (contentError) {
    console.error("Public application plot-content lookup failed", safeError(contentError));
    return json({ error: "The public lot list could not be verified. Please try again." }, 503);
  }
  const publicParcelIds = (visibleContent ?? []).map((content) => content.parcel_id)
    .filter((id): id is number => typeof id === "number");

  const lotResolution = await resolveAvailableLots(supabase, tenantId, applicationScope, publicParcelIds, parts);
  if (lotResolution.error === "database") {
    return json({ error: "The current lot list could not be verified. Please try again." }, 503);
  }
  if (!lotResolution.lots) return json({ error: "One or more selected lots are no longer available." }, 400);

  const parcelIds = lotResolution.lots.map((lot) => lot.id).sort((a, b) => a - b);
  const fingerprint = await submissionFingerprint({
    kind: "land_purchase",
    scope: { tenantId, projectId: applicationScope.projectId, phaseId: applicationScope.phaseId },
    applicant: {
      fullName: input.applicant_full_name, address: input.applicant_address, nationality: input.nationality,
      occupation: input.occupation, phone: input.phone, email: input.email, intendedUse: input.intended_use,
      intendedUseOther: input.intended_use_other, parcelCount: input.parcel_count, preferredParcelIds: parcelIds,
      alternateLotPreference: input.alternate_lot_preference, paymentOption: input.payment_option,
      legalNoticeAcknowledged: input.legal_notice_acknowledged,
      applicantAcknowledgementSignature: input.applicant_acknowledgement_signature,
      notes: input.notes, sustainabilityTermsVerified: input.sustainability_terms_verified,
    },
  });
  const submissionReference = input.submission_reference ?? crypto.randomUUID();
  const prior = await findSubmission(supabase, tenantId, submissionReference);
  if (prior.error) return json({ error: "We could not check the earlier submission. Please retry shortly." }, 503);
  if (prior.row) return prior.row.submission_fingerprint === fingerprint
    ? json({ ok: true, deduplicated: true, application_id: prior.row.id, message: "Your application was already received for review." })
    : json({ error: "This submission reference was already used for different application details. Start a new application." }, 409);
  if (!effectiveSettings.applicationsOpen) return json({ error: "Applications are currently closed or unavailable for this phase." }, 403);

  const nameParts = splitApplicantName(input.applicant_full_name);
  const { data: application, error: insertError } = await supabase.from("applications").insert({
    tenant_id: tenantId,
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
    preferred_parcel_ids: parcelIds,
    alternate_lot_preference: input.alternate_lot_preference,
    payment_option: input.payment_option,
    legal_notice_acknowledged: input.legal_notice_acknowledged,
    applicant_acknowledgement_signature: input.applicant_acknowledgement_signature,
    notes: input.notes || null,
    cultural_preservation_review: "Applicant acknowledged the published application notice, reservation terms, and applicant acknowledgement.",
    sustainability_terms_verified: input.sustainability_terms_verified,
    status: "Pending Review",
    submission_reference: submissionReference,
    submission_fingerprint: fingerprint,
  }).select("id").single();

  if (insertError) {
    if (insertError.code === "23505") {
      const raced = await findSubmission(supabase, tenantId, submissionReference);
      if (raced.row) return raced.row.submission_fingerprint === fingerprint
        ? json({ ok: true, deduplicated: true, application_id: raced.row.id, message: "Your application was already received for review." })
        : json({ error: "This submission reference was already used for different application details. Start a new application." }, 409);
    }
    console.error("Public application insert failed", safeError(insertError));
    return json({ error: "We could not save your application. Please try again." }, 500);
  }

  return json({ ok: true, deduplicated: false, application_id: application.id, message: "Your application was submitted for review." }, 201);
});

async function findSubmission(supabase: ReturnType<typeof createClient>, tenantId: string, reference: string) {
  const { data, error } = await supabase.from("applications")
    .select("id,submission_fingerprint").eq("tenant_id", tenantId).eq("submission_reference", reference).maybeSingle();
  return { row: data as { id: number; submission_fingerprint: string } | null, error };
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
