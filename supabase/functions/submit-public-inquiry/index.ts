import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  lotDisposition,
  validateInquiryPayload,
  type InquiryPayload,
} from "../_shared/inquiry-contract.ts";
import { parsePublicLotReference } from "../_shared/public-lot-reference.ts";
import { shouldSuppressPublicInquiryEmail } from "../_shared/public-inquiry-email-policy.mjs";

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

type PublicProjectScope = { projectId: string; projectSlug: string; projectName: string; phaseId: string; phaseSlug: string; mapExperienceMode: "sales" | "demo" };

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  const body = (await request.json().catch(() => ({}))) as InquiryPayload;
  const input = validateInquiryPayload(body);
  if ("error" in input) return json({ error: input.error }, 400);
  const safePageUrl = safePublicPageUrl(input.pageUrl, request.headers.get("origin"));

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Scope slugs are selectors only. The service resolves them to tenant,
  // project, and phase IDs, then the server-only RPC revalidates ownership.
  const slugTenantId = await resolveTenantId(supabase, input.tenantSlug);
  if (!slugTenantId) return json({ error: "Unknown development. Please check the listing link." }, 400);
  const lotReferenceProject = input.specificLotRef ? parsePublicLotReference(input.specificLotRef)?.projectSlug ?? null : null;
  if (input.projectSlug && lotReferenceProject && input.projectSlug !== lotReferenceProject) {
    return json({ error: "The selected lot does not match the requested development." }, 400);
  }
  const scopeResolution = await resolveProjectPhase(supabase, slugTenantId, input.projectSlug ?? lotReferenceProject, input.phaseSlug);
  if (!scopeResolution.ok) return json({ error: scopeResolution.message }, scopeResolution.status);
  const scope = scopeResolution.scope;
  if (input.specificLotRef && scope.mapExperienceMode === "demo") {
    return json({ error: "This demonstration map does not provide sellable inventory. Please send a general project inquiry." }, 400);
  }

  // A public locator is resolved inside exactly the selected project/phase.
  const resolution = input.specificLotRef
    ? await loadLotByPublicReference(supabase, slugTenantId, input.specificLotRef, scope)
    : { lot: null, error: null };
  if (resolution.error === "database") {
    return json({ error: "The current lot list could not be verified. Please try again." }, 503);
  }
  if (input.specificLotRef && !resolution.lot) {
    return json({ error: "Select an available public lot for this inquiry." }, 400);
  }
  const specificLot = resolution.lot;
  const specificLotId = specificLot?.id ?? null;
  if (specificLot && lotDisposition(specificLot.status) === "unavailable") {
    return json({ error: "That lot is no longer available." }, 400);
  }
  const waitlist = !!specificLot && lotDisposition(specificLot.status) === "waitlist";
  const requestRef = input.clientReferenceId ?? crypto.randomUUID();
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
    p_parcel_id: specificLotId,
    p_map_feature_id: input.specificMapFeatureRef,
    p_duplicate_reason: duplicateReason,
  });
  if (rpcError) {
    console.error("Scoped public inquiry RPC failed", safeError(rpcError));
    return json({ error: "We could not verify and save your inquiry. Please try again." }, 503);
  }
  const rpcResult = result as { ok?: boolean; conflict?: boolean; deduplicated?: boolean; lead_id?: string } | null;
  if (rpcResult?.conflict) return json({ error: "This request conflicts with an earlier submission. Please start a new inquiry." }, 409);
  if (!rpcResult?.ok || !rpcResult.lead_id) return json({ error: "We could not save your inquiry. Please try again." }, 503);

  const suppressEmail = shouldSuppressPublicInquiryEmail(
    scope.mapExperienceMode,
    Deno.env.get("SUPPRESS_OUTBOUND_EMAILS"),
  );
  let emailResult: { ok: boolean; error?: string } = { ok: false, error: "not-sent" };
  if (!rpcResult.deduplicated && !suppressEmail) {
    const company = await loadCompanyContext(supabase, slugTenantId, scope.projectId);
    emailResult = await sendConfirmationEmail({
      toEmail: input.email, toName: input.name, companyName: company.companyName,
      projectName: scope.projectName, publicLink: safePageUrl || company.publicLink, waitlist,
    });
  }
  if (!rpcResult.deduplicated) {
    await supabase.from("lead_activities").insert({
      tenant_id: slugTenantId, project_id: scope.projectId, phase_id: scope.phaseId,
      lead_id: rpcResult.lead_id, activity_type: "email",
      title: suppressEmail ? "Buyer confirmation email suppressed in automated test mode" : emailResult.ok ? "Buyer confirmation email sent" : "Buyer confirmation email not sent",
      description: suppressEmail ? "Automated test configuration suppressed outbound communication." : emailResult.ok
        ? "A public inquiry confirmation email was sent to the buyer."
        : "The inquiry was saved; staff should follow up from this lead.",
      metadata: { source: "public_inquiry", email_sent: emailResult.ok, email_suppressed: suppressEmail }, created_by: null,
    });
  }
  return json({ ok: true, leadCreated: !rpcResult.deduplicated, followUpCreated: true,
    deduplicated: Boolean(rpcResult.deduplicated), emailSent: emailResult.ok, emailSuppressed: suppressEmail,
    waitlist, message: rpcResult.deduplicated ? "Your request was already received. The team will follow up." : suppressEmail
      ? "Your request was received. The team will follow up using the contact information you provided."
      : emailResult.ok ? "Your request was received and a confirmation email was sent." : "Your request was received. The team will follow up using the contact information you provided." });
});

async function resolveTenantId(
  supabase: ReturnType<typeof createClient>,
  slug: string | null,
): Promise<string | null> {
  if (!slug) return null;
  const bySlug = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();
  if (bySlug.data) return String((bySlug.data as { id: string }).id);
  const byAlias = await supabase
    .from("organizations")
    .select("id")
    .eq("inbound_alias", slug)
    .eq("is_active", true)
    .maybeSingle();
  if (byAlias.error) console.error("Inquiry tenant alias lookup failed", safeError(byAlias.error));
  return byAlias.data ? String((byAlias.data as { id: string }).id) : null;
}

async function resolveProjectPhase(
  supabase: ReturnType<typeof createClient>, tenantId: string, projectSlug: string | null, phaseSlug: string | null,
): Promise<{ ok: true; scope: PublicProjectScope } | { ok: false; status: number; message: string }> {
  const projects = await supabase.from("projects").select("id,slug,name,is_default,map_experience_mode")
    .eq("tenant_id", tenantId).order("created_at", { ascending: true });
  if (projects.error) return { ok: false, status: 503, message: "Could not resolve the selected development." };
  const rows = (projects.data ?? []) as Array<{ id: string; slug: string; name: string; is_default: boolean; map_experience_mode: "sales" | "demo" }>;
  const project = projectSlug ? rows.find((row) => row.slug.toLowerCase() === projectSlug) : rows.find((row) => row.is_default);
  if (!project) return { ok: false, status: 404, message: "Development not found." };
  const phases = await supabase.from("development_phases").select("id,slug,name,is_default,is_active")
    .eq("tenant_id", tenantId).eq("project_id", project.id).eq("is_active", true);
  if (phases.error) return { ok: false, status: 503, message: "Could not resolve the selected development phase." };
  const phaseRows = (phases.data ?? []) as Array<{ id: string; slug: string; name: string; is_default: boolean }>;
  const phase = phaseSlug ? phaseRows.find((row) => row.slug.toLowerCase() === phaseSlug) : phaseRows.find((row) => row.is_default);
  if (!phase) return { ok: false, status: 404, message: "Development phase not found." };
  return { ok: true, scope: { projectId: project.id, projectSlug: project.slug, projectName: project.name, phaseId: phase.id, phaseSlug: phase.slug, mapExperienceMode: project.map_experience_mode === "demo" ? "demo" : "sales" } };
}

async function loadLotByPublicReference(
  supabase: ReturnType<typeof createClient>, tenantId: string, reference: string, scope: PublicProjectScope,
): Promise<{ lot: ParcelOption | null; error: "database" | null }> {
  const parts = parsePublicLotReference(reference);
  if (!parts || parts.projectSlug !== scope.projectSlug) return { lot: null, error: null };
  const version = await supabase.from("masterplan_versions").select("id")
    .eq("tenant_id", tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.phaseId)
    .eq("is_active", true).maybeSingle();
  if (version.error) return { lot: null, error: "database" };
  let query = supabase.from("parcels").select("id,tenant_id,lot_number,dimensions,base_price,status")
    .eq("tenant_id", tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.phaseId)
    .eq("lot_number", parts.lotNumber);
  query = version.data?.id
    ? query.or(`masterplan_version_id.is.null,masterplan_version_id.eq.${version.data.id}`)
    : query.is("masterplan_version_id", null);
  const { data, error } = await query.limit(2);
  if (error) return { lot: null, error: "database" };
  if (!Array.isArray(data) || data.length !== 1) return { lot: null, error: null };
  return { lot: data[0] as ParcelOption, error: null };
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

async function sendConfirmationEmail(input: { toEmail: string; toName: string; companyName: string; projectName: string; publicLink: string; waitlist: boolean }) {
  const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const fromAddress = Deno.env.get("EMAIL_FROM_ADDRESS") ?? "";
  const fromName = Deno.env.get("EMAIL_FROM_NAME") ?? input.companyName;
  const replyTo = Deno.env.get("EMAIL_REPLY_TO") ?? Deno.env.get("NOTIFICATION_ADMIN_EMAIL") ?? "";
  if (!resendApiKey || !fromAddress) {
    return { ok: false, error: "Email provider is not configured." };
  }

  const subject = input.waitlist
    ? `You're on the waitlist for ${input.projectName}`
    : `We received your ${input.projectName} information request`;
  const body = [
    `Hi ${input.toName},`,
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
        to: [`${input.toName} <${input.toEmail}>`],
        subject,
        text: body,
        html: renderPublicInquiryEmail({ subject, body, companyName: input.companyName }),
        reply_to: replyTo || undefined,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: text.slice(0, 500) || `Email provider returned ${response.status}.` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown email error." };
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

function safeError(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "Unknown error");
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}
