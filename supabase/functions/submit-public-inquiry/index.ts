import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  validateInquiryPayload,
  type InquiryPayload,
  type ValidInquiry,
} from "../_shared/inquiry-contract.ts";

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

  // Optional embed caller tenant (slug or inbound alias). When absent, the
  // tenant-default trigger assigns rows to the default tenant as before.
  const tenantId = await resolveTenantId(supabase, input.tenantSlug);

  // Idempotency: a retry (user double-submit, network retry after a 500)
  // carries the same client_reference_id and must not create a second lead.
  if (input.clientReferenceId) {
    const { data: existing } = await supabase
      .from("leads")
      .select("id")
      .eq("client_reference_id", input.clientReferenceId)
      .maybeSingle();
    if (existing && typeof (existing as { id: unknown }).id !== "undefined") {
      return json({
        ok: true,
        deduplicated: true,
        leadId: String((existing as { id: unknown }).id),
        message: "Your request was already received. Our team will follow up using the contact information you provided.",
      });
    }
  }

  // The lot must be one the public map actually shows: Available in parcels
  // (any lot number), not just the legacy two-digit public view.
  const specificLot = input.specificLotId ? await loadAvailableLot(supabase, input.specificLotId) : null;
  if (input.specificLotId && !specificLot) {
    return json({ error: "Select an available public lot for this inquiry." }, 400);
  }
  if (tenantId && specificLot?.tenant_id && String(specificLot.tenant_id) !== tenantId) {
    return json({ error: "That lot belongs to a different development." }, 400);
  }

  const duplicateReason = await duplicateReasonForInquiry(supabase, {
    name: input.name,
    email: input.email,
    phone: input.phone,
    parcelId: input.specificLotId,
  });
  const now = new Date();
  const dueAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const inquiryNotes = buildInquiryNotes(input, specificLot);

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .insert({
      tenant_id: tenantId,
      full_name: input.name,
      email: input.email,
      phone: input.phone || null,
      parcel_id: input.specificLotId,
      client_reference_id: input.clientReferenceId,
      source: "public_inquiry",
      pipeline_stage: "new_lead",
      buyer_journey_stage: "Public Information Request",
      preferred_contact_method: input.phone ? "Email or Phone / WhatsApp" : "Email",
      assigned_to: null,
      next_action: "Follow up on public project information inquiry",
      next_action_due_at: dueAt,
      notes: inquiryNotes,
      possible_duplicate: Boolean(duplicateReason),
      duplicate_reason: duplicateReason,
      duplicate_checked_at: now.toISOString(),
      created_by: null,
    })
    .select("id")
    .single();

  if (leadError || !lead) {
    // Lost race: same idempotency key inserted concurrently — return it.
    const code = (leadError as { code?: string } | null)?.code;
    if (code === "23505" && input.clientReferenceId) {
      const { data: raced } = await supabase
        .from("leads")
        .select("id")
        .eq("client_reference_id", input.clientReferenceId)
        .maybeSingle();
      if (raced && typeof (raced as { id: unknown }).id !== "undefined") {
        return json({
          ok: true,
          deduplicated: true,
          leadId: String((raced as { id: unknown }).id),
          message: "Your request was already received. Our team will follow up using the contact information you provided.",
        });
      }
    }
    console.error("Public inquiry lead insert failed", safeError(leadError));
    return json({ error: "We could not save your inquiry. Please try again." }, 500);
  }

  const leadId = String(lead.id);
  const { error: activityError } = await supabase.from("lead_activities").insert({
    tenant_id: tenantId,
    lead_id: leadId,
    activity_type: "note",
    title: duplicateReason ? "Public information request received - possible duplicate" : "Public information request received",
    description: duplicateReason ? `${inquiryNotes}\n\nPossible duplicate: ${duplicateReason}` : inquiryNotes,
    metadata: {
      source: "public_inquiry",
      interests: input.interests,
      specific_lot_id: input.specificLotId,
      page_url: safePageUrl,
      possible_duplicate: Boolean(duplicateReason),
      duplicate_reason: duplicateReason,
    },
    created_by: null,
  });
  if (activityError) console.error("Public inquiry activity insert failed", safeError(activityError));

  const { error: taskError } = await supabase.from("follow_up_tasks").insert({
    tenant_id: tenantId,
    lead_id: leadId,
    title: duplicateReason ? "Review possible duplicate public inquiry" : "Follow up on public project information inquiry",
    description: duplicateReason
      ? `Review this public project information inquiry for possible duplicate records. ${duplicateReason}`
      : "Contact the buyer about their public project information request and answer their questions.",
    due_at: dueAt,
    status: "open",
    priority: duplicateReason ? "high" : "normal",
    assigned_to: null,
    created_by: null,
  });
  if (taskError) {
    console.error("Public inquiry follow-up insert failed", safeError(taskError));
    return json({ error: "Your inquiry was saved, but the follow-up task could not be created." }, 500);
  }

  const company = await loadCompanyContext(supabase, tenantId);
  const emailResult = await sendConfirmationEmail({
    toEmail: input.email,
    toName: input.name,
    companyName: company.companyName,
    projectName: company.projectName,
    publicLink: safePageUrl || company.publicLink,
  });

  await supabase.from("lead_activities").insert({
    tenant_id: tenantId,
    lead_id: leadId,
    activity_type: "email",
    title: emailResult.ok ? "Buyer confirmation email sent" : "Buyer confirmation email not sent",
    description: emailResult.ok
      ? "A public inquiry confirmation email was sent to the buyer."
      : "The public inquiry was saved, but the buyer confirmation email could not be sent automatically. Staff should still follow up from this lead.",
    metadata: {
      source: "public_inquiry",
      email_sent: emailResult.ok,
      email_error: emailResult.ok ? null : emailResult.error,
    },
    created_by: null,
  });

  return json({
    ok: true,
    leadCreated: true,
    followUpCreated: true,
    emailSent: emailResult.ok,
    message: emailResult.ok
      ? "Your request was received and a confirmation email was sent."
      : "Your request was received. Our team will follow up using the contact information you provided.",
  });
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

/**
 * The lot must be one the public map actually shows: Available in parcels
 * (any lot number — the legacy two-digit public_parcel_options view excludes
 * real published lots like L-001, which 400'd every genuine inquiry).
 */
async function loadAvailableLot(supabase: ReturnType<typeof createClient>, lotId: number): Promise<ParcelOption | null> {
  const { data, error } = await supabase
    .from("parcels")
    .select("id, tenant_id, lot_number, dimensions, base_price, status")
    .eq("id", lotId)
    .maybeSingle();
  if (error) {
    console.error("Public lot validation failed", safeError(error));
    return null;
  }
  const row = data as ParcelOption | null;
  if (!row || row.status !== "Available") return null;
  return row;
}

async function duplicateReasonForInquiry(
  supabase: ReturnType<typeof createClient>,
  input: { name: string; email: string; phone: string; parcelId: number | null },
) {
  const reasons: string[] = [];
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const name = normalizeName(input.name);

  const [{ data: leads }, { data: applications }] = await Promise.all([
    supabase.from("leads").select("id, full_name, email, phone, parcel_id").limit(1000),
    supabase.from("applications").select("id, applicant_full_name, first_name, last_name, email, phone, preferred_parcel_ids").limit(1000),
  ]);

  const leadRows = (leads ?? []) as Array<{ full_name: string | null; email: string | null; phone: string | null; parcel_id: number | null }>;
  const applicationRows = (applications ?? []) as Array<{
    applicant_full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    preferred_parcel_ids: unknown;
  }>;

  if (email && (
    leadRows.some((row) => normalizeEmail(row.email) === email) ||
    applicationRows.some((row) => normalizeEmail(row.email) === email)
  )) {
    reasons.push("Same email found on another lead or application.");
  }

  if (phone && (
    leadRows.some((row) => normalizePhone(row.phone) === phone) ||
    applicationRows.some((row) => normalizePhone(row.phone) === phone)
  )) {
    reasons.push("Same phone found on another lead or application.");
  }

  if (name && input.parcelId && (
    leadRows.some((row) => normalizeName(row.full_name) === name && row.parcel_id === input.parcelId) ||
    applicationRows.some((row) => normalizeName(applicationName(row)) === name && applicationParcelIds(row.preferred_parcel_ids).includes(input.parcelId!))
  )) {
    reasons.push("Same applicant name and preferred lot found on another lead or application.");
  }

  return reasons.length ? reasons.join(" ") : null;
}

function buildInquiryNotes(input: ValidInquiry, lot: ParcelOption | null) {
  return [
    "Public project information inquiry.",
    input.interests.length ? `Interests: ${input.interests.join(", ")}` : null,
    lot ? `Specific lot interest: Lot ${lot.lot_number}${lot.dimensions ? ` - ${lot.dimensions}` : ""}` : null,
    input.phone ? `Phone / WhatsApp: ${input.phone}` : null,
    input.message ? `Buyer message: ${input.message}` : null,
  ].filter(Boolean).join("\n");
}

async function loadCompanyContext(supabase: ReturnType<typeof createClient>, tenantId: string | null = null) {
  const companyQuery = supabase.from("business_settings").select("value").eq("key", "company_profile");
  const publicQuery = supabase.from("business_settings").select("value").eq("key", "public_application");
  if (tenantId) {
    companyQuery.eq("tenant_id", tenantId);
    publicQuery.eq("tenant_id", tenantId);
  }
  const [{ data: companySetting }, { data: publicSetting }] = await Promise.all([
    companyQuery.maybeSingle(),
    publicQuery.maybeSingle(),
  ]);
  const company = valueObject(companySetting?.value);
  const publicApplication = valueObject(publicSetting?.value);
  const companyName = cleanText(company.company_name, 140) || "Wamule Development";
  return {
    companyName,
    projectName: companyName,
    publicLink: cleanText(publicApplication.public_application_url, 1000) || cleanText(company.website, 1000) || "",
  };
}

async function sendConfirmationEmail(input: { toEmail: string; toName: string; companyName: string; projectName: string; publicLink: string }) {
  const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const fromAddress = Deno.env.get("EMAIL_FROM_ADDRESS") ?? "";
  const fromName = Deno.env.get("EMAIL_FROM_NAME") ?? input.companyName;
  const replyTo = Deno.env.get("EMAIL_REPLY_TO") ?? Deno.env.get("NOTIFICATION_ADMIN_EMAIL") ?? "";
  if (!resendApiKey || !fromAddress) {
    return { ok: false, error: "Email provider is not configured." };
  }

  const subject = `We received your ${input.projectName} information request`;
  const body = [
    `Hi ${input.toName},`,
    "",
    `Thank you for your interest in ${input.projectName}. We received your request for project information.`,
    "",
    "Our team will review your questions and follow up using the contact information you provided.",
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

function applicationName(row: { applicant_full_name: string | null; first_name: string | null; last_name: string | null }) {
  return row.applicant_full_name || `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
}

function applicationParcelIds(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => Number(item)).filter((item) => Number.isInteger(item))
    : [];
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
