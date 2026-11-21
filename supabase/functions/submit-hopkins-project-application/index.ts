import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateHopkinsProjectApplicationPayload } from "../_shared/hopkins-project-application-contract.mjs";
import { resolvePublicApplicationSettings } from "../_shared/public-application-settings.mjs";
import { resolvePublicSubmissionScope } from "../_shared/public-submission-scope.mjs";
import { submissionFingerprint } from "../_shared/submission-fingerprint.mjs";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ProjectApplicationSettings = {
  applications_open?: boolean;
  notice_version?: string;
  public_notice_text?: string;
  application_acknowledgment_text?: string;
  allowed_intended_uses?: string[];
  max_map_preferences?: number;
  default_confirmation_message?: string;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const body = await request.json().catch(() => null);
  const preliminary = validateHopkinsProjectApplicationPayload(body, 10, null);
  if ("error" in preliminary) return json({ error: preliminary.error }, 400);
  const input = preliminary as {
    tenant: string; project: string; phase: string; hostname: string; submission_reference: string;
    applicant_full_name: string; applicant_address: string; nationality: string; occupation: string;
    phone: string; email: string; intended_use: string; intended_use_other: string;
    preferred_map_feature_refs: string[]; notes: string; legal_notice_acknowledged: true;
    applicant_acknowledgement_signature: string;
  };

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const resolved = await resolvePublicSubmissionScope(client, {
    tenantSlug: input.tenant, projectSlug: input.project, phaseSlug: input.phase,
    hostname: input.hostname, allowTenantAlias: true,
  });
  if (!resolved.ok) {
    const status = resolved.reason === "lookup_failed" ? 503 : 400;
    return json({ error: resolved.reason === "host_mismatch" || resolved.reason === "unverified_hostname"
      ? "This application link does not match a verified public project address."
      : "Hopkins Grove applications are temporarily unavailable." }, status);
  }
  const scope = resolved.scope;
  const { tenantId, projectId, phaseId } = scope;

  const [{ data: companySettings, error: companyError }, { data: settingsRow, error: settingError }] = await Promise.all([
    client.from("business_settings").select("value").eq("tenant_id", tenantId).eq("key", "public_application").maybeSingle(),
    client.from("project_settings").select("value").eq("tenant_id", tenantId).eq("project_id", projectId)
      .eq("key", "public_application").maybeSingle(),
  ]);
  if (companyError || settingError || !settingsRow?.value || typeof settingsRow.value !== "object" || Array.isArray(settingsRow.value)) {
    console.error("Hopkins application configuration lookup failed", safeError(settingError));
    return json({ error: "Hopkins applications are not configured yet." }, 503);
  }
  const settings = {
    ...objectValue(companySettings?.value),
    ...objectValue(settingsRow.value),
  } as ProjectApplicationSettings;
  if (objectValue(settingsRow.value).application_type !== "project_application") {
    return json({ error: "Project applications are not enabled for this development." }, 403);
  }
  const effective = resolvePublicApplicationSettings(companySettings?.value, settingsRow.value, phaseId);
  const maxMapPreferences = boundedInteger(settings.max_map_preferences, 0, 10, 5);
  const inputValidation = validateHopkinsProjectApplicationPayload(body, maxMapPreferences, settings.allowed_intended_uses);
  if ("error" in inputValidation) return json({ error: inputValidation.error }, 400);
  if (!effective.noticesComplete || !settings.notice_version
    || !Array.isArray(settings.allowed_intended_uses)
    || !settings.allowed_intended_uses.includes(input.intended_use)) {
    return json({ error: "Hopkins application notices or preferences are incomplete." }, 503);
  }

  const fingerprint = await submissionFingerprint({
    kind: "project_application",
    scope: { tenantId, projectId, phaseId },
    notice: {
      version: settings.notice_version,
      publicText: effective.publicNoticeText,
      acknowledgmentText: effective.acknowledgmentText,
    },
    applicant: {
      fullName: input.applicant_full_name, address: input.applicant_address, nationality: input.nationality,
      occupation: input.occupation, phone: input.phone, email: input.email, intendedUse: input.intended_use,
      intendedUseOther: input.intended_use_other,
      preferredMapFeatureRefs: [...input.preferred_map_feature_refs].sort(), notes: input.notes,
      legalNoticeAcknowledged: input.legal_notice_acknowledged,
      applicantAcknowledgementSignature: input.applicant_acknowledgement_signature,
    },
  });
  const prior = await findSubmission(client, tenantId, input.submission_reference);
  if (prior.error) return json({ error: "We could not check the earlier submission. Please retry shortly." }, 503);
  if (prior.row) return prior.row.submission_fingerprint === fingerprint
    ? json({ ok: true, deduplicated: true, application_id: prior.row.id, message: settings.default_confirmation_message ?? "Your application was received for staff review." })
    : json({ error: "This submission reference was already used for different application details. Start a new application." }, 409);
  if (!effective.applicationsOpen) return json({ error: "Project applications are currently closed." }, 403);

  const { data: activeSnapshot, error: snapshotError } = await client.from("map_feature_snapshots")
    .select("id").eq("tenant_id", tenantId).eq("project_id", projectId).eq("phase_id", phaseId)
    .eq("is_active", true).maybeSingle();
  if (snapshotError || !activeSnapshot) {
    console.error("Hopkins active map snapshot lookup failed", safeError(snapshotError));
    return json({ error: "Hopkins applications require a published active phase map." }, snapshotError ? 503 : 403);
  }
  const { data: publishedPackage, error: packageError } = await client.from("project_map_packages")
    .select("id").eq("tenant_id", tenantId).eq("project_id", projectId).eq("phase_id", phaseId)
    .eq("snapshot_id", activeSnapshot.id).not("published_at", "is", null).maybeSingle();
  if (packageError || !publishedPackage) {
    console.error("Hopkins map publication lookup failed", safeError(packageError));
    return json({ error: "Hopkins applications require a published active phase map." }, packageError ? 503 : 403);
  }

  if (input.preferred_map_feature_refs.length > 0) {
    const { data: features, error: featureError } = await client.from("map_features")
      .select("identity_id").eq("tenant_id", tenantId).eq("project_id", projectId).eq("phase_id", phaseId)
      .eq("snapshot_id", activeSnapshot.id).eq("is_active", true).eq("public_visible", true)
      .in("identity_id", input.preferred_map_feature_refs);
    const found = new Set((features ?? []).map((feature) => String(feature.identity_id).toLowerCase()));
    if (featureError) {
      console.error("Hopkins map preference validation failed", safeError(featureError));
      return json({ error: "The selected Hopkins map references could not be verified. Please try again." }, 503);
    }
    if (found.size !== input.preferred_map_feature_refs.length
      || input.preferred_map_feature_refs.some((ref) => !found.has(ref.toLowerCase()))) {
      return json({ error: "One or more selected outlines are not part of the current Hopkins public map." }, 400);
    }
  }

  const nameParts = splitApplicantName(input.applicant_full_name);
  const { data: application, error: insertError } = await client.from("applications").insert({
    tenant_id: tenantId,
    project_id: projectId,
    phase_id: phaseId,
    application_kind: "project_application",
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
    parcel_id: null,
    parcel_count: null,
    preferred_parcel_ids: [],
    preferred_map_feature_refs: input.preferred_map_feature_refs,
    alternate_lot_preference: null,
    payment_option: null,
    legal_notice_acknowledged: true,
    applicant_acknowledgement_signature: input.applicant_acknowledgement_signature,
    project_notice_version: settings.notice_version,
    project_public_notice_snapshot: effective.publicNoticeText,
    project_acknowledgment_snapshot: effective.acknowledgmentText,
    project_notice_acknowledged_at: new Date().toISOString(),
    cultural_preservation_review: null,
    sustainability_terms_verified: false,
    notes: input.notes || null,
    status: "Pending Review",
    submission_reference: input.submission_reference,
    submission_fingerprint: fingerprint,
  }).select("id").single();

  if (insertError) {
    if (insertError.code === "23505") {
      const raced = await findSubmission(client, tenantId, input.submission_reference);
      if (raced.row) return raced.row.submission_fingerprint === fingerprint
        ? json({ ok: true, deduplicated: true, application_id: raced.row.id, message: settings.default_confirmation_message ?? "Your application was received for staff review." })
        : json({ error: "This submission reference was already used for different application details. Start a new application." }, 409);
    }
    console.error("Hopkins project application insert failed", safeError(insertError));
    return json({ error: "We could not save your Hopkins application. Please try again." }, 500);
  }

  return json({
    ok: true,
    deduplicated: false,
    application_id: application.id,
    message: settings.default_confirmation_message ?? "Your application was received for staff review.",
  }, 201);
});

async function findSubmission(client: ReturnType<typeof createClient>, tenantId: string, reference: string) {
  const { data, error } = await client.from("applications")
    .select("id,submission_fingerprint").eq("tenant_id", tenantId).eq("submission_reference", reference).maybeSingle();
  return { row: data as { id: number; submission_fingerprint: string } | null, error };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function splitApplicantName(fullName: string) {
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0] ?? "Applicant", lastName: parts.slice(1).join(" ") || "Applicant" };
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = typeof value === "number" && Number.isInteger(value) ? value : fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function safeError(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const value = error as { code?: unknown; message?: unknown };
  return [value.code, value.message].filter((part) => typeof part === "string").join(": ").slice(0, 300);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
