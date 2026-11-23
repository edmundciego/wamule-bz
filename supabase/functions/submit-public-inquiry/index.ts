import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  lotDisposition,
  validateInquiryPayload,
  type InquiryPayload,
  type ValidInquiry,
} from "../_shared/inquiry-contract.ts";
import { createPublicLotReference, parsePublicLotReference } from "../_shared/public-lot-reference.ts";
import { normalizePublicHostname } from "../_shared/public-hostname.mjs";
import { resolvePublicSubmissionScope } from "../_shared/public-submission-scope.mjs";
import { submissionFingerprint } from "../_shared/submission-fingerprint.mjs";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ParcelOption = {
  id: number;
  tenant_id: string | null;
  lot_number: string | null;
  dimensions: string | null;
  base_price: number | null;
  status: string | null;
};

type PublicProjectScope = { tenantId: string; tenantSlug: string; projectId: string; projectSlug: string; projectName: string; phaseId: string; phaseSlug: string; mapExperienceMode: "sales" | "demo" };

const LEGACY_INQUIRY_SCOPE_ENV = {
  tenantSlug: "WAMULE_LEGACY_INQUIRY_TENANT_SLUG",
  projectSlug: "WAMULE_LEGACY_INQUIRY_PROJECT_SLUG",
  phaseSlug: "WAMULE_LEGACY_INQUIRY_PHASE_SLUG",
} as const;

const LEGACY_INQUIRY_FIELDS = ["name", "email", "phone", "interests", "specific_lot_id", "message", "page_url"] as const;
const LEGACY_INQUIRY_COMPAT_FLAG = "WAMULE_LEGACY_INQUIRY_COMPAT_ENABLED";
const TURNSTILE_FIELD = "turnstile_token";
const TURNSTILE_ACTION = "public_inquiry";
const STAGING_SUPABASE_PROJECT_REF = "kvocwmrcuhiaezlcgzjf";
const STAGING_RECIPIENT_HASHES_ENV = "STAGING_PUBLIC_INQUIRY_RECIPIENT_HASHES";
const STAGING_TEST_SEND_ENABLED_ENV = "STAGING_PUBLIC_INQUIRY_TEST_SEND_ENABLED";
const STAGING_TEST_RECIPIENT_HASH_ENV = "STAGING_PUBLIC_INQUIRY_TEST_RECIPIENT_HASH";
const STAGING_PUBLIC_INQUIRY_RECIPIENT_HASHES: readonly string[] = [
  "e188816c18f7e77bf3f59bfe073f97e65f6cdf082b9fe26821a5d5dde8cc83db",
];
const EXPLICIT_SCOPE_FIELDS = [
  "tenant", "tenant_slug", "tenant_id", "tenantId",
  "project", "project_slug", "project_id", "projectId",
  "phase", "phase_slug", "phase_id", "phaseId",
  "hostname", "host", "address", "applicant_address",
] as const;

type LegacyAdapterLog = {
  invoked: boolean;
  scope: { tenantId: string; projectId: string; phaseId: string } | null;
  outcome: string;
};

Deno.serve(async (request) => {
  const adapterLog: LegacyAdapterLog = { invoked: false, scope: null, outcome: "pending" };
  let response: Response | undefined;
  try {
    response = await handlePublicInquiry(request, adapterLog);
    if (adapterLog.invoked && adapterLog.outcome === "pending") {
      adapterLog.outcome = response.ok ? "accepted" : "rejected";
    }
    return response;
  } catch (error) {
    if (adapterLog.invoked) adapterLog.outcome = "handler_error";
    throw error;
  } finally {
    if (adapterLog.invoked) {
      console.info(JSON.stringify({
        event: "legacy_public_inquiry_adapter",
        request: requestMetadata(request),
        scope: adapterLog.scope,
        outcome: { result: adapterLog.outcome, status: response?.status ?? 500 },
      }));
    }
  }
});

async function handlePublicInquiry(request: Request, adapterLog: LegacyAdapterLog): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  const parsedBody = await request.json().catch(() => ({}));
  const body = isRecord(parsedBody) ? parsedBody as InquiryPayload & Record<string, unknown> : {};
  const isLegacyPayload = isLegacyInquiryPayload(body);
  adapterLog.invoked = isLegacyPayload;

  if (isLegacyPayload && !legacyInquiryCompatibilityEnabled()) {
    adapterLog.outcome = "compatibility_disabled";
    return json({ error: "This inquiry form is temporarily unavailable. Please reload and try again." }, 503);
  }

  if (!isLegacyPayload) {
    const botVerification = await verifyInquiryChallenge(request, body);
    if (botVerification === "unavailable") {
      return json({ error: "The security check is temporarily unavailable. Please try again." }, 503);
    }
    if (botVerification !== "verified") {
      return json({ error: "Complete the security check and try again." }, 403);
    }
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let scopeResolution: Awaited<ReturnType<typeof resolvePublicSubmissionScope>> | null = null;
  let legacyParcelId: number | null = null;
  let suppliedHostname: string | null = null;
  let input: ValidInquiry;
  if (isLegacyPayload) {
    const validation = validateInquiryPayload({ ...body, specific_lot_id: undefined });
    if ("error" in validation) {
      adapterLog.outcome = "invalid_payload";
      return json({ error: validation.error }, 400);
    }
    input = validation;

    const configuredScope = configuredLegacyInquiryScope();
    if (!configuredScope) {
      adapterLog.outcome = "configuration_missing";
      return json({ error: "This inquiry form is not configured for submission." }, 503);
    }
    scopeResolution = await resolvePublicSubmissionScope(supabase, {
      ...configuredScope,
      allowTenantAlias: false,
    });
    if (!scopeResolution.ok) {
      adapterLog.outcome = scopeResolution.reason === "lookup_failed" ? "scope_lookup_failed" : "configured_scope_invalid";
      return json({ error: "This inquiry form is not configured for submission." }, 503);
    }
    adapterLog.scope = {
      tenantId: scopeResolution.scope.tenantId,
      projectId: scopeResolution.scope.projectId,
      phaseId: scopeResolution.scope.phaseId,
    };

    const rawParcelId = body.specific_lot_id;
    if (rawParcelId !== null && rawParcelId !== undefined) {
      if (typeof rawParcelId !== "number" || !Number.isSafeInteger(rawParcelId) || rawParcelId < 1) {
        adapterLog.outcome = "invalid_lot_id";
        return json({ error: "Select an available public lot for this inquiry." }, 400);
      }
      legacyParcelId = rawParcelId;
    }
  } else {
    if (hasExplicitScopeField(body)) {
      const rawLotParts = typeof body.specific_lot_ref === "string"
        ? parsePublicLotReference(body.specific_lot_ref)
        : null;
      const suppliedHostnameValue = body.hostname ?? body.host;
      suppliedHostname = typeof suppliedHostnameValue === "string" && suppliedHostnameValue.trim()
        ? normalizePublicHostname(suppliedHostnameValue)
        : null;
      scopeResolution = await resolvePublicSubmissionScope(supabase, {
        tenantSlug: (body.tenant ?? body.tenant_slug) as string | null | undefined,
        projectSlug: (body.project ?? body.project_slug ?? rawLotParts?.projectSlug) as string | null | undefined,
        phaseSlug: (body.phase ?? body.phase_slug ?? rawLotParts?.phaseSlug) as string | null | undefined,
        hostname: suppliedHostnameValue as string | null | undefined,
        allowTenantAlias: true,
      });
      if (!scopeResolution.ok) {
        const status = scopeResolution.reason === "lookup_failed" ? 503 : 400;
        return json({ error: scopeResolution.reason === "host_mismatch" || scopeResolution.reason === "unverified_hostname"
          ? "This public project address does not match the requested inquiry scope."
          : "The requested public project or phase could not be verified." }, status);
      }
      if (!explicitScopeFieldsAgree(body, scopeResolution.scope)) {
        return json({ error: "The requested public project or phase could not be verified." }, 400);
      }
    }

    const validation = validateInquiryPayload(body);
    if ("error" in validation) return json({ error: validation.error }, 400);
    input = validation;
  }

  const specificLotParts = input.specificLotRef ? parsePublicLotReference(input.specificLotRef) : null;
  if (input.specificLotRef && !specificLotParts) return json({ error: "Select an available public lot for this inquiry." }, 400);
  const safePageUrl = safePublicPageUrl(input.pageUrl, request.headers.get("origin"));

  const lotReferenceProject = specificLotParts?.projectSlug ?? null;
  // Slugs and hosts are selectors only. Resolve one owned active tenant/project/phase
  // here, then the atomic RPC revalidates ownership at write time.
  scopeResolution ??= await resolvePublicSubmissionScope(supabase, {
    tenantSlug: input.tenantSlug, projectSlug: input.projectSlug ?? lotReferenceProject,
    phaseSlug: input.phaseSlug ?? specificLotParts?.phaseSlug ?? null,
    hostname: input.hostname, allowTenantAlias: true,
  });
  if (!scopeResolution.ok) {
    if (isLegacyPayload) adapterLog.outcome = scopeResolution.reason === "lookup_failed" ? "scope_lookup_failed" : "configured_scope_invalid";
    const status = scopeResolution.reason === "lookup_failed" ? 503 : 400;
    return json({ error: scopeResolution.reason === "host_mismatch" || scopeResolution.reason === "unverified_hostname"
      ? "This public project address does not match the requested inquiry scope."
      : "The requested public project or phase could not be verified." }, status);
  }
  const scope = scopeResolution.scope;
  if (isLegacyPayload) {
    adapterLog.scope = { tenantId: scope.tenantId, projectId: scope.projectId, phaseId: scope.phaseId };
  }
  const slugTenantId = scope.tenantId;
  // General inquiries remain available without a published map. Outline
  // selections stay strict; unverifiable lots become general inquiries below.
  let publishedSnapshotId: string | null = null;
  if (input.specificMapFeatureRef) {
    const publication = await verifyPublishedPackage(supabase, slugTenantId, scope);
    if (!publication.ok) return json({ error: publication.message }, publication.status);
    publishedSnapshotId = publication.snapshotId;
  }
  if (input.specificMapFeatureRef) {
    const { data: selectedFeature, error: selectedFeatureError } = await supabase.from("map_features")
      .select("identity_id").eq("tenant_id", slugTenantId).eq("project_id", scope.projectId)
      .eq("phase_id", scope.phaseId).eq("snapshot_id", publishedSnapshotId)
      .eq("identity_id", input.specificMapFeatureRef).eq("is_active", true).eq("public_visible", true).maybeSingle();
    if (selectedFeatureError) {
      return json({ error: "The selected map outline could not be verified. Please try again." }, 503);
    }
    if (!selectedFeature) return json({ error: "Select an outline from the current published map." }, 400);
  }

  const lotRequested = Boolean(input.specificLotRef) || legacyParcelId !== null;
  const unverifiedLotReference = lotRequested
    ? sanitizeUnverifiedLotReference(input.specificLotRef ?? String(legacyParcelId))
    : null;
  const lotReferenceOutsideScope = Boolean(input.specificLotRef && (
    (lotReferenceProject && lotReferenceProject !== scope.projectSlug)
    || (specificLotParts?.phaseSlug && specificLotParts.phaseSlug !== scope.phaseSlug)
  ));

  // A public locator is resolved only inside the already verified tenant,
  // project, and phase. Missing publication, foreign references, demo-mode
  // projects, and unavailable lots are recorded as unverified general inquiries.
  const resolution = !lotRequested || lotReferenceOutsideScope || scope.mapExperienceMode === "demo"
    ? { lot: null, error: null }
    : legacyParcelId !== null
      ? await loadLotByLegacyId(supabase, slugTenantId, legacyParcelId, scope)
      : await loadLotByPublicReference(supabase, slugTenantId, input.specificLotRef!, scope);
  if (resolution.error === "database") {
    if (isLegacyPayload) adapterLog.outcome = "lot_lookup_failed";
    return json({ error: "The current lot list could not be verified. Please try again." }, 503);
  }
  const specificLot = resolution.lot && lotDisposition(resolution.lot.status) !== "unavailable"
    ? resolution.lot
    : null;
  const lotUnverified = lotRequested && !specificLot;
  const specificLotId = specificLot?.id ?? null;
  const waitlist = !!specificLot && lotDisposition(specificLot.status) === "waitlist";
  let fingerprintParcelId = specificLotId ?? resolution.lot?.id ?? null;
  if (lotRequested && fingerprintParcelId === null && !lotReferenceOutsideScope) {
    const fingerprintParcel = await loadScopedParcelIdForFingerprint(
      supabase, slugTenantId, legacyParcelId, specificLotParts, scope,
    );
    if (fingerprintParcel.error === "database") {
      if (isLegacyPayload) adapterLog.outcome = "lot_lookup_failed";
      return json({ error: "The current lot list could not be verified. Please try again." }, 503);
    }
    fingerprintParcelId = fingerprintParcel.id;
  }
  const fingerprint = await submissionFingerprint({
    kind: "public_inquiry",
    scope: { tenantId: scope.tenantId, projectId: scope.projectId, phaseId: scope.phaseId },
    contact: { name: input.name, email: input.email, phone: input.phone },
    content: {
      message: input.message, interests: [...input.interests].sort(),
      parcelId: fingerprintParcelId,
      mapFeatureRef: input.specificMapFeatureRef,
      ...(lotRequested && fingerprintParcelId === null && unverifiedLotReference
        ? { unverifiedLotReference } : {}),
    },
  });
  const requestRef = input.clientReferenceId
    ?? (isLegacyPayload ? `legacy-${fingerprint.slice(0, 56)}` : crypto.randomUUID());
  const duplicateReason = specificLot ? await duplicateReasonForInquiry(supabase, {
    name: input.name, email: input.email, phone: input.phone, parcelId: specificLotId,
  }, scope.projectId) : null;
  const { data: result, error: rpcError } = await supabase.rpc("create_scoped_public_inquiry", {
    p_tenant_id: slugTenantId,
    p_project_id: scope.projectId,
    p_phase_id: scope.phaseId,
    p_name: input.name,
    p_email: input.email,
    p_phone: input.phone || null,
    p_message: input.message || null,
    p_page_url: safePageUrl,
    p_interests: input.interests,
    p_client_reference_id: requestRef,
    p_submission_fingerprint: fingerprint,
    p_parcel_id: specificLotId,
    p_map_feature_id: input.specificMapFeatureRef,
    p_duplicate_reason: duplicateReason,
    p_unverified_lot_reference: unverifiedLotReference,
    p_hostname: suppliedHostname,
  });
  if (rpcError) {
    if (rpcError.code === "P0001" && rpcError.message === "public_inquiry_lead_limit_reached") {
      if (isLegacyPayload) adapterLog.outcome = "lead_limit_reached";
      return json({ error: "This project's inquiry limit has been reached. Please contact the project team directly." }, 429);
    }
    if (isLegacyPayload) adapterLog.outcome = "persistence_failed";
    console.error("Scoped public inquiry RPC failed", safeError(rpcError));
    return json({ error: "We could not verify and save your inquiry. Please try again." }, 503);
  }
  const rpcResult = result as {
    ok?: boolean; conflict?: boolean; deduplicated?: boolean; lead_id?: string; unverified_lot?: boolean;
  } | null;
  if (rpcResult?.conflict) {
    if (isLegacyPayload) adapterLog.outcome = "retry_conflict";
    return json({ error: "This request conflicts with an earlier submission. Please start a new inquiry." }, 409);
  }
  if (rpcResult?.limit_reached) {
    if (isLegacyPayload) adapterLog.outcome = "lead_limit_reached";
    return json({ error: "This project's inquiry limit has been reached. Please contact the project team directly." }, 429);
  }
  if (!rpcResult?.ok || !rpcResult.lead_id) {
    if (isLegacyPayload) adapterLog.outcome = "persistence_failed";
    return json({ error: "We could not save your inquiry. Please try again." }, 503);
  }

  const globalOutboundSuppressed = Deno.env.get("SUPPRESS_OUTBOUND_EMAILS") === "true";
  const confirmationFlag = Deno.env.get("PUBLIC_INQUIRY_CONFIRMATIONS_ENABLED");
  const confirmationsEnabled = confirmationFlag === "true"
    || (isStagingProject() && confirmationFlag !== "false");
  const stagingTestSendAllowed = globalOutboundSuppressed && !isLegacyPayload && confirmationsEnabled
    ? await stagingTestSendRecipientAllowed(input.email)
    : false;
  const stagingTestSendOverrideApplied = !rpcResult.deduplicated && stagingTestSendAllowed;
  const trustedIp = trustedRequesterIp(request);
  let emailSuppressed = isLegacyPayload || !confirmationsEnabled
    || (globalOutboundSuppressed && !stagingTestSendAllowed);
  let emailResult: { ok: boolean; suppressed?: boolean } = { ok: false };
  if (!rpcResult.deduplicated && !emailSuppressed) {
    const company = await loadCompanyContext(supabase, slugTenantId, scope.projectId);
    emailResult = await sendConfirmationEmail({
      supabase, trustedIp, projectId: scope.projectId, toEmail: input.email, companyName: company.companyName,
      projectName: scope.projectName, publicLink: safePageUrl || company.publicLink, waitlist,
    });
    emailSuppressed = Boolean(emailResult.suppressed);
  }
  if (!rpcResult.deduplicated) {
    const emailActivityTitle = emailResult.ok
      ? stagingTestSendOverrideApplied ? "Staging test buyer confirmation email sent" : "Buyer confirmation email sent"
      : emailSuppressed ? "Buyer confirmation email suppressed" : "Buyer confirmation email not sent";
    const emailActivityDescription = emailResult.ok
      ? stagingTestSendOverrideApplied
        ? "The staging-only test switch allowed a recipient-scoped buyer confirmation email."
        : "A public inquiry confirmation email was sent to the buyer."
      : "The inquiry was saved; staff should follow up from this lead.";
    await supabase.from("lead_activities").insert({
      tenant_id: slugTenantId, project_id: scope.projectId, phase_id: scope.phaseId,
      lead_id: rpcResult.lead_id, activity_type: "email",
      title: emailActivityTitle,
      description: emailActivityDescription,
      metadata: {
        source: "public_inquiry", email_sent: emailResult.ok, email_suppressed: emailSuppressed,
        staging_test_send_override: stagingTestSendOverrideApplied,
      },
      created_by: null,
    });
  }
  if (isLegacyPayload) adapterLog.outcome = rpcResult.deduplicated
    ? "deduplicated"
    : lotUnverified || rpcResult.unverified_lot ? "created_unverified_lot" : "created";
  const unverifiedLot = lotUnverified || rpcResult.unverified_lot === true;
  return json({ ok: true, leadCreated: !rpcResult.deduplicated, followUpCreated: true,
    deduplicated: Boolean(rpcResult.deduplicated), emailSent: emailResult.ok, emailSuppressed,
    waitlist, message: unverifiedLot
      ? "We received your inquiry. Our team will follow up with available options."
      : rpcResult.deduplicated ? "Your request was already received. The team will follow up." : emailSuppressed
      ? "Your request was received. The team will follow up using the contact information you provided."
      : emailResult.ok ? "Your request was received and a confirmation email was sent." : "Your request was received. The team will follow up using the contact information you provided." });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLegacyInquiryPayload(body: Record<string, unknown>) {
  const keys = Object.keys(body);
  return keys.length === LEGACY_INQUIRY_FIELDS.length
    && LEGACY_INQUIRY_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(body, field));
}

function legacyInquiryCompatibilityEnabled() {
  const flag = Deno.env.get(LEGACY_INQUIRY_COMPAT_FLAG);
  if (isStagingProject()) {
    if (flag === "false") return false;
    const configured = configuredLegacyInquiryScope();
    return configured?.tenantSlug.toLowerCase() === "wamule"
      && configured.projectSlug.toLowerCase() === "wamule"
      && configured.phaseSlug.toLowerCase() === "default";
  }
  return flag === "true";
}

function isStagingProject() {
  try {
    return new URL(supabaseUrl).hostname.split(".")[0].toLowerCase() === STAGING_SUPABASE_PROJECT_REF;
  } catch {
    return false;
  }
}

async function stagingTestSendRecipientAllowed(toEmail: string): Promise<boolean> {
  if (!isStagingProject() || Deno.env.get(STAGING_TEST_SEND_ENABLED_ENV) !== "true") return false;
  const configuredHash = (Deno.env.get(STAGING_TEST_RECIPIENT_HASH_ENV) ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(configuredHash)) return false;
  const recipientHash = await sha256(toEmail.trim().toLowerCase());
  return recipientHash === configuredHash && stagingRecipientAllowlisted(recipientHash);
}

type BotVerificationResult = "verified" | "rejected" | "unavailable";

async function verifyInquiryChallenge(
  request: Request,
  body: Record<string, unknown>,
): Promise<BotVerificationResult> {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY")?.trim() ?? "";
  const token = typeof body[TURNSTILE_FIELD] === "string" ? body[TURNSTILE_FIELD].trim() : "";
  if (!secret) return "unavailable";
  if (!token || token.length > 2048) return "rejected";

  const origin = request.headers.get("origin");
  let expectedHostname: string;
  try {
    expectedHostname = new URL(origin ?? "").hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "rejected";
  }
  if (!expectedHostname) return "rejected";
  const suppliedHostname = body.hostname ?? body.host;
  if (suppliedHostname !== undefined
    && normalizePublicHostname(suppliedHostname) !== expectedHostname) return "rejected";

  // Turnstile tokens are single-use. Each fresh token gets its own verification
  // key so semantic inquiry retries cannot reuse a previous verification result.
  const idempotencyKey = crypto.randomUUID();
  const form = new URLSearchParams({ secret, response: token, idempotency_key: idempotencyKey });

  let response: Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
  } catch {
    return "unavailable";
  }
  if (!response.ok) return "unavailable";

  const result = await response.json().catch(() => null) as {
    success?: boolean; hostname?: string; action?: string;
  } | null;
  if (!result?.success) return "rejected";
  const verifiedHostname = typeof result.hostname === "string"
    ? result.hostname.trim().toLowerCase().replace(/\.$/, "")
    : "";
  return verifiedHostname === expectedHostname && result.action === TURNSTILE_ACTION
    ? "verified"
    : "rejected";
}

function hasExplicitScopeField(body: Record<string, unknown>) {
  return EXPLICIT_SCOPE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(body, field));
}

function explicitScopeFieldsAgree(
  body: Record<string, unknown>,
  scope: { tenantId: string; tenantSlug: string; projectId: string; projectSlug: string; phaseId: string; phaseSlug: string },
) {
  const matches = (field: string, expected: string, normalize: (value: unknown) => string | null = normalizeScopeText) => {
    if (!Object.prototype.hasOwnProperty.call(body, field)) return true;
    return normalize(body[field]) === normalize(expected);
  };
  const hostnameValues = ["hostname", "host"]
    .filter((field) => Object.prototype.hasOwnProperty.call(body, field))
    .map((field) => normalizePublicHostname(body[field]));
  const hostFieldsAgree = hostnameValues.every((hostname) => hostname !== null && hostname === hostnameValues[0]);

  return matches("tenant", scope.tenantSlug) && matches("tenant_slug", scope.tenantSlug)
    && matches("tenant_id", scope.tenantId) && matches("tenantId", scope.tenantId)
    && matches("project", scope.projectSlug) && matches("project_slug", scope.projectSlug)
    && matches("project_id", scope.projectId) && matches("projectId", scope.projectId)
    && matches("phase", scope.phaseSlug) && matches("phase_slug", scope.phaseSlug)
    && matches("phase_id", scope.phaseId) && matches("phaseId", scope.phaseId)
    && hostFieldsAgree
    // These fields are not public host selectors. Treat them as explicit but
    // unsupported scope input so they can never be silently ignored.
    && !Object.prototype.hasOwnProperty.call(body, "address")
    && !Object.prototype.hasOwnProperty.call(body, "applicant_address");
}

function normalizeScopeText(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() || null : null;
}

function sanitizeUnverifiedLotReference(value: string) {
  return value.replace(/[<>\p{Cc}]/gu, "").replace(/\s+/g, " ").trim().slice(0, 160) || "[empty]";
}

async function loadScopedParcelIdForFingerprint(
  supabase: ReturnType<typeof createClient>, tenantId: string, legacyParcelId: number | null,
  lotParts: ReturnType<typeof parsePublicLotReference>, scope: PublicProjectScope,
): Promise<{ id: number | null; error: "database" | null }> {
  if (lotParts && (lotParts.projectSlug !== scope.projectSlug
    || (lotParts.phaseSlug !== null && lotParts.phaseSlug !== scope.phaseSlug))) {
    return { id: null, error: null };
  }
  if (legacyParcelId === null && !lotParts) return { id: null, error: null };
  let query = supabase.from("parcels").select("id")
    .eq("tenant_id", tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.phaseId);
  query = legacyParcelId !== null ? query.eq("id", legacyParcelId) : query.eq("lot_number", lotParts!.lotNumber);
  const { data, error } = await query.limit(2);
  if (error) return { id: null, error: "database" };
  return Array.isArray(data) && data.length === 1 && typeof data[0].id === "number"
    ? { id: data[0].id, error: null }
    : { id: null, error: null };
}

function configuredLegacyInquiryScope() {
  const tenantSlug = Deno.env.get(LEGACY_INQUIRY_SCOPE_ENV.tenantSlug)?.trim() ?? "";
  const projectSlug = Deno.env.get(LEGACY_INQUIRY_SCOPE_ENV.projectSlug)?.trim() ?? "";
  const phaseSlug = Deno.env.get(LEGACY_INQUIRY_SCOPE_ENV.phaseSlug)?.trim() ?? "";
  if (!tenantSlug && !projectSlug && !phaseSlug && isStagingProject()) {
    return { tenantSlug: "wamule", projectSlug: "wamule", phaseSlug: "default" };
  }
  if (!tenantSlug || !projectSlug || !phaseSlug) return null;
  return { tenantSlug, projectSlug, phaseSlug };
}

function requestMetadata(request: Request) {
  let origin: string | null = null;
  try {
    const header = request.headers.get("origin");
    origin = header ? new URL(header).origin : null;
  } catch {
    origin = null;
  }
  return { method: request.method, path: new URL(request.url).pathname, origin };
}

async function loadLotByLegacyId(
  supabase: ReturnType<typeof createClient>, tenantId: string, parcelId: number, scope: PublicProjectScope,
): Promise<{ lot: ParcelOption | null; error: "database" | null }> {
  const { data: scopedParcel, error: parcelError } = await supabase.from("parcels").select("lot_number")
    .eq("id", parcelId).eq("tenant_id", tenantId).eq("project_id", scope.projectId)
    .eq("phase_id", scope.phaseId).maybeSingle();
  if (parcelError) return { lot: null, error: "database" };
  if (typeof scopedParcel?.lot_number !== "string" || !scopedParcel.lot_number) return { lot: null, error: null };

  const publicReference = createPublicLotReference(scope.projectSlug, scope.phaseSlug, scopedParcel.lot_number);
  if (!publicReference) return { lot: null, error: null };
  const publicResolution = await loadLotByPublicReference(supabase, tenantId, publicReference, scope);
  if (publicResolution.error || publicResolution.lot?.id !== parcelId) {
    return { lot: null, error: publicResolution.error };
  }
  return publicResolution;
}

async function loadLotByPublicReference(
  supabase: ReturnType<typeof createClient>, tenantId: string, reference: string, scope: PublicProjectScope,
): Promise<{ lot: ParcelOption | null; error: "database" | null }> {
  const parts = parsePublicLotReference(reference);
  if (!parts || parts.projectSlug !== scope.projectSlug
    || (parts.phaseSlug !== null && parts.phaseSlug !== scope.phaseSlug)) return { lot: null, error: null };

  if (parts.phaseSlug === null) {
    const { data: legacyCandidates, error: legacyError } = await supabase.from("parcels")
      .select("phase_id").eq("tenant_id", tenantId).eq("project_id", scope.projectId)
      .eq("lot_number", parts.lotNumber);
    if (legacyError) return { lot: null, error: "database" };
    const candidatePhases = new Set((legacyCandidates ?? []).map((row) =>
      typeof row.phase_id === "string" ? row.phase_id : null));
    if (candidatePhases.size !== 1 || !candidatePhases.has(scope.phaseId)) return { lot: null, error: null };
  }
  const publication = await verifyPublishedPackage(supabase, tenantId, scope);
  if (!publication.ok) return { lot: null, error: publication.status === 503 ? "database" : null };
  const { data: features, error: featureError } = await supabase.from("map_features").select("identity_id")
    .eq("tenant_id", tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.phaseId)
    .eq("snapshot_id", publication.snapshotId).eq("is_active", true).eq("public_visible", true);
  if (featureError) return { lot: null, error: "database" };
  const featureIds = (features ?? []).map((feature) => String(feature.identity_id));
  if (!featureIds.length) return { lot: null, error: null };
  const { data: content, error: contentError } = await supabase.from("project_plot_content")
    .select("parcel_id").eq("tenant_id", tenantId).eq("project_id", scope.projectId)
    .eq("phase_id", scope.phaseId).eq("public_visible", true).in("identity_id", featureIds);
  if (contentError) return { lot: null, error: "database" };
  const publicParcelIds = (content ?? []).map((row) => row.parcel_id)
    .filter((id): id is number => typeof id === "number");
  if (!publicParcelIds.length) return { lot: null, error: null };
  const version = await supabase.from("masterplan_versions").select("id")
    .eq("tenant_id", tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.phaseId)
    .eq("is_active", true).maybeSingle();
  if (version.error) return { lot: null, error: "database" };
  let query = supabase.from("parcels").select("id,tenant_id,lot_number,dimensions,base_price,status")
    .eq("tenant_id", tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.phaseId)
    .eq("lot_number", parts.lotNumber).eq("needs_review", false).in("id", publicParcelIds);
  query = version.data?.id
    ? query.or(`masterplan_version_id.is.null,masterplan_version_id.eq.${version.data.id}`)
    : query.is("masterplan_version_id", null);
  const { data, error } = await query.limit(2);
  if (error) return { lot: null, error: "database" };
  if (!Array.isArray(data) || data.length !== 1) return { lot: null, error: null };
  return { lot: data[0] as ParcelOption, error: null };
}

async function verifyPublishedPackage(
  supabase: ReturnType<typeof createClient>, tenantId: string, scope: PublicProjectScope,
): Promise<{ ok: true; snapshotId: string } | { ok: false; status: number; message: string }> {
  const { data: snapshot, error: snapshotError } = await supabase.from("map_feature_snapshots").select("id")
    .eq("tenant_id", tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.phaseId)
    .eq("is_active", true).maybeSingle();
  if (snapshotError) return { ok: false, status: 503, message: "The current published map could not be verified." };
  if (!snapshot) return { ok: false, status: 404, message: "This phase has no published map." };
  const { data: pkg, error: packageError } = await supabase.from("project_map_packages").select("id")
    .eq("tenant_id", tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.phaseId)
    .eq("snapshot_id", snapshot.id).not("published_at", "is", null).maybeSingle();
  if (packageError) return { ok: false, status: 503, message: "The current published map could not be verified." };
  if (!pkg) return { ok: false, status: 404, message: "This phase has no published map." };
  return { ok: true, snapshotId: String(snapshot.id) };
}

async function duplicateReasonForInquiry(
  supabase: ReturnType<typeof createClient>,
  input: { name: string; email: string; phone: string; parcelId: number | null },
  projectId: string,
) {
  const reasons: string[] = [];
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const name = normalizeName(input.name);

  const { data: leads } = await supabase.from("leads").select("full_name,email,phone,parcel_id")
    .eq("project_id", projectId).limit(1000);
  const leadRows = (leads ?? []) as Array<{ full_name: string | null; email: string | null; phone: string | null; parcel_id: number | null }>;

  if (email && leadRows.some((row) => normalizeEmail(row.email) === email)) {
    reasons.push("Same email found on another lead in this project.");
  }

  if (phone && leadRows.some((row) => normalizePhone(row.phone) === phone)) {
    reasons.push("Same phone found on another lead in this project.");
  }

  if (name && input.parcelId && (
    leadRows.some((row) => normalizeName(row.full_name) === name && row.parcel_id === input.parcelId)
  )) {
    reasons.push("Same applicant name and preferred lot found on another lead or application.");
  }

  return reasons.length ? reasons.join(" ") : null;
}

async function loadCompanyContext(supabase: ReturnType<typeof createClient>, tenantId: string, projectId: string) {
  const companyQuery = supabase.from("project_settings").select("value").eq("key", "company_profile").eq("project_id", projectId);
  const publicQuery = supabase.from("business_settings").select("value").eq("key", "public_application");
  companyQuery.eq("tenant_id", tenantId);
  publicQuery.eq("tenant_id", tenantId);
  const [{ data: companySetting }, { data: publicSetting }] = await Promise.all([
    companyQuery.maybeSingle(),
    publicQuery.maybeSingle(),
  ]);
  const company = valueObject(companySetting?.value);
  const publicApplication = valueObject(publicSetting?.value);
  const project = await supabase.from("projects").select("name").eq("id", projectId).eq("tenant_id", tenantId).maybeSingle();
  const companyName = cleanText(company.company_name, 140) || cleanText(project.data?.name, 140) || "Development team";
  return {
    companyName,
    projectName: companyName,
    publicLink: cleanText(publicApplication.public_application_url, 1000) || cleanText(company.website, 1000) || "",
  };
}

// Only use CF-Connecting-IP for the optional per-IP quota after an operator has
// verified that the managed ingress overwrites client-supplied values. Until
// then, recipient and project quotas still apply and the request remains
// eligible for delivery. Never use X-Forwarded-For.
function trustedRequesterIp(request: Request): string | null {
  if (Deno.env.get("SUPABASE_GATEWAY_IP_HEADER_VERIFIED") !== "true") return null;
  return canonicalIpAddress(request.headers.get("cf-connecting-ip"));
}

function canonicalIpAddress(value: string | null): string | null {
  if (!value || value !== value.trim() || value.includes(",") || value.includes("%")) return null;
  const ipv4Parts = value.split(".");
  if (ipv4Parts.length === 4 && ipv4Parts.every((part) => /^\d{1,3}$/.test(part))) {
    const octets = ipv4Parts.map(Number);
    if (octets.every((part) => part >= 0 && part <= 255)) return octets.join(".");
    return null;
  }
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1).toLowerCase()
      : null;
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stagingRecipientAllowlisted(toEmailHash: string) {
  let projectRef = "";
  try {
    projectRef = new URL(supabaseUrl).hostname.split(".")[0].toLowerCase();
  } catch {
    return false;
  }
  if (projectRef !== STAGING_SUPABASE_PROJECT_REF) return true;
  const allowedHashes = [...STAGING_PUBLIC_INQUIRY_RECIPIENT_HASHES,
    ...(Deno.env.get(STAGING_RECIPIENT_HASHES_ENV) ?? "").split(",")]
    .map((hash) => hash.trim().toLowerCase())
    .filter((hash) => /^[0-9a-f]{64}$/.test(hash));
  return allowedHashes.includes(toEmailHash);
}

async function sendConfirmationEmail(input: { supabase: ReturnType<typeof createClient>; trustedIp: string | null; projectId: string; toEmail: string; companyName: string; projectName: string; publicLink: string; waitlist: boolean }) {
  const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const fromAddress = Deno.env.get("EMAIL_FROM_ADDRESS") ?? "";
  const fromName = Deno.env.get("EMAIL_FROM_NAME") ?? input.companyName;
  const replyTo = Deno.env.get("EMAIL_REPLY_TO") ?? Deno.env.get("NOTIFICATION_ADMIN_EMAIL") ?? "";
  if (!resendApiKey || !fromAddress) {
    return { ok: false, suppressed: true, error: "Email provider is not configured." };
  }
  const recipientHash = await sha256(input.toEmail.trim().toLowerCase());
  if (!stagingRecipientAllowlisted(recipientHash)) return { ok: false, suppressed: true };

  // Reserve before the provider call. Failed and timed-out attempts also
  // consume quota; database or quota errors always suppress the email.
  try {
    const { data: reserved, error } = await input.supabase.rpc("reserve_inquiry_confirmation_quota", {
      p_project_id: input.projectId,
      p_recipient_hash: recipientHash,
      p_ip_hash: input.trustedIp ? await sha256(input.trustedIp) : null,
    });
    if (error || reserved !== true) return { ok: false, suppressed: true };
  } catch {
    return { ok: false, suppressed: true };
  }

  const subject = input.waitlist
    ? `You're on the waitlist for ${input.projectName}`
    : `We received your ${input.projectName} information request`;
  const body = [
    "Hello,",
    "",
    input.waitlist
      ? `Thanks — we've added you to the waitlist for ${input.projectName}.`
      : `Thank you for your interest in ${input.projectName}. We received your request for project information.`,
    "",
    input.waitlist
      ? "Our team will contact you if the lot becomes available. Joining the waitlist does not reserve the lot or guarantee availability."
      : "Our team will review your questions and follow up using the contact information you provided.",
    "",
    "This information request does not reserve a lot, guarantee lot availability, or imply application approval.",
    input.publicLink ? `\nYou can return to the live project and application page here: ${input.publicLink}` : "",
    "",
    input.companyName,
  ].filter((line) => line !== null).join("\n");

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${fromName} <${fromAddress}>`,
        to: [input.toEmail],
        subject,
        text: body,
        html: renderPublicInquiryEmail({ subject, body, companyName: input.companyName }),
        reply_to: replyTo || undefined,
      }),
    });

    if (!response.ok) {
      return { ok: false, error: "Email provider request failed." };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Email provider request failed." };
  }
}

function renderPublicInquiryEmail(input: { subject: string; body: string; companyName: string }) {
  const bodyHtml = input.body
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 16px;line-height:1.65;">${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<!doctype html>
<html>
  <body style="margin:0;background:#f7f1e8;color:#2d2317;font-family:Inter,Arial,sans-serif;">
    <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
      <div style="border:1px solid #d7c8b5;background:#fffdf8;border-radius:14px;overflow:hidden;">
        <div style="height:8px;background:#173f2d;"></div>
        <div style="padding:28px;">
          <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8a5a35;">${escapeHtml(input.companyName)}</p>
          <h1 style="margin:0 0 20px;font-size:24px;line-height:1.2;color:#173f2d;">${escapeHtml(input.subject)}</h1>
          ${bodyHtml}
        </div>
      </div>
    </div>
  </body>
</html>`;
}

function cleanText(value: unknown, maxLength: number) {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safePublicPageUrl(pageUrl: string, origin: string | null) {
  const cleanedOrigin = cleanText(origin, 1000);
  if (!cleanedOrigin) return "";
  try {
    const originUrl = new URL(cleanedOrigin);
    const candidate = pageUrl ? new URL(pageUrl, originUrl.origin) : originUrl;
    if (candidate.origin !== originUrl.origin) return originUrl.origin;
    return candidate.toString();
  } catch {
    return "";
  }
}

function valueObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeEmail(value: unknown) {
  return cleanText(value, 254).toLowerCase() || null;
}

function normalizePhone(value: unknown) {
  const normalized = String(value ?? "").replace(/\D/g, "");
  return normalized || null;
}

function normalizeName(value: unknown) {
  return cleanText(value, 160).toLowerCase() || null;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char] ?? char));
}

function safeError(_error: unknown) {
  void _error;
  return "Database operation failed.";
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
