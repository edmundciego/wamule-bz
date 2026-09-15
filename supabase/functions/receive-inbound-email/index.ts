import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const masterGeminiKey = Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GOOGLE_API_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_TENANT_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const VISION_MODEL = "gemini-3.1-flash-lite";

const allowedAttachmentMimes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

type InboundAttachment = {
  filename?: unknown;
  name?: unknown;
  content_type?: unknown;
  contentType?: unknown;
  mime_type?: unknown;
  mimeType?: unknown;
  content?: unknown;
  data?: unknown;
  base64?: unknown;
};

type InboundBody = {
  to?: unknown;
  envelope_to?: unknown;
  recipient?: unknown;
  recipients?: unknown;
  from?: unknown;
  envelope_from?: unknown;
  sender?: unknown;
  subject?: unknown;
  text?: unknown;
  text_body?: unknown;
  body_text?: unknown;
  attachments?: unknown;
};

type VisionResult = {
  amount_paid: number;
  currency: string;
  bank_reference_id: string | null;
  payment_method: "Online Transfer" | "Cash";
  payment_date: string | null;
  confidence_score: number | null;
  raw: Record<string, unknown>;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  const body = (await request.json().catch(() => ({}))) as InboundBody;

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // -- 1. Resolve tenant from recipient -------------------------------------
  const recipientRaw = firstAddress(body.to ?? body.envelope_to ?? body.recipient ?? body.recipients);
  const tenantLookup = parseTenantLookup(recipientRaw);

  const organization = await resolveOrganization(supabase, tenantLookup);
  if (!organization) {
    await logAudit(supabase, {
      tenant_id: DEFAULT_TENANT_ID,
      entity_type: "system",
      action: "reviewed",
      title: "Inbound email tenant not found",
      summary: `No organization matched recipient "${recipientRaw || "unknown"}".`,
      metadata: { recipient: recipientRaw },
    });
    return json({ error: "Tenant not found for recipient address." }, 404);
  }
  const tenantId = String(organization.id);

  // -- 2. Sender + customer match --------------------------------------------
  const senderEmail = extractEmail(body.from ?? body.envelope_from ?? body.sender);
  if (!senderEmail) {
    return json({ error: "Sender email is required." }, 400);
  }

  const matchedCustomer = await findCustomerByEmail(supabase, tenantId, senderEmail);
  const customer = matchedCustomer ?? (await ensureUnmatchedCustomer(supabase, tenantId));
  const customerWasMatched = Boolean(matchedCustomer);

  if (!customer) {
    await logAudit(supabase, {
      tenant_id: tenantId,
      entity_type: "payment",
      action: "reviewed",
      title: "Inbound email customer reconciliation needed",
      summary: `Could not establish fallback customer for ${senderEmail}.`,
      metadata: { sender: senderEmail, recipient: recipientRaw },
    });
    return json({ error: "Could not establish customer record." }, 500);
  }

  // -- 3. Attachments ----------------------------------------------------------
  const attachments = normalizeAttachments(body.attachments);
  const processable = attachments.filter((a) => allowedAttachmentMimes.has(a.mime));

  if (!processable.length) {
    await logAudit(supabase, {
      tenant_id: tenantId,
      entity_type: "payment",
      action: "reviewed",
      title: "Inbound email had no processable receipt",
      summary: `Email from ${senderEmail} contained ${attachments.length} attachment(s), none images/PDF.`,
      metadata: { sender: senderEmail, recipient: recipientRaw, subject: cleanText(body.subject, 200) },
    });
    // Still create a lead for manual follow-up so nothing is silently dropped.
    await createReconciliationLead(supabase, tenantId, {
      senderEmail,
      subject: cleanText(body.subject, 200),
      reason: "No image/PDF attachment found.",
    });
    return json({ ok: true, processed: 0, message: "No processable attachments. Lead created for manual review." });
  }

  // -- 4. Per-attachment: upload + Vision + draft rows -------------------------
  const apiKey = String(organization.gemini_api_key ?? "").trim() || masterGeminiKey;
  const results = [];

  for (const attachment of processable) {
    try {
      const result = await processAttachment(supabase, {
        tenantId,
        customerId: Number(customer.id),
        senderEmail,
        subject: cleanText(body.subject, 200),
        textBody: cleanText(body.text ?? body.text_body ?? body.body_text, 2000),
        attachment,
        apiKey,
        customerWasMatched,
      });
      results.push({ ok: true, ...result });
    } catch (error) {
      results.push({
        ok: false,
        filename: attachment.filename,
        error: error instanceof Error ? error.message : "Attachment processing failed.",
      });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  return json({
    ok: succeeded > 0,
    tenant_id: tenantId,
    customer_id: customer.id,
    customer_matched: customerWasMatched,
    processed: succeeded,
    total: processable.length,
    results,
  });
});

async function processAttachment(
  supabase: ReturnType<typeof createClient>,
  input: {
    tenantId: string;
    customerId: number;
    senderEmail: string;
    subject: string;
    textBody: string;
    attachment: { filename: string; mime: string; bytes: Uint8Array };
    apiKey: string;
    customerWasMatched: boolean;
  },
) {
  const stamp = Date.now();
  const safeName = input.attachment.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "receipt";
  const filePath = `${input.tenantId}/${input.customerId}/${stamp}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from("payment-documents")
    .upload(filePath, input.attachment.bytes, {
      contentType: input.attachment.mime,
      upsert: false,
    });
  if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

  // Vision OCR (deterministic fallback when no key or call fails).
  const vision = await runVisionOcr({
    bytes: input.attachment.bytes,
    mime: input.attachment.mime,
    apiKey: input.apiKey,
  });

  // Active contract link when available (staff corrects on review otherwise).
  const contractId = await findActiveContractId(supabase, input.tenantId, input.customerId);

  const amount = Number.isFinite(vision.amount_paid) && vision.amount_paid > 0 ? vision.amount_paid : 0;
  const bankRef = vision.bank_reference_id ? vision.bank_reference_id.toUpperCase().slice(0, 120) : null;

  const { data: transaction, error: txError } = await supabase
    .from("transactions")
    .insert({
      tenant_id: input.tenantId,
      customer_id: input.customerId,
      contract_id: contractId,
      amount,
      transaction_type: "Land Installment",
      collection_method: vision.payment_method,
      bank_reference: vision.payment_method === "Online Transfer" ? bankRef : null,
      receipt_date: vision.payment_date,
      notes: `Auto-ingested from email. Ref: ${bankRef ?? "Pending"}`,
      receipt_notes: input.subject ? `Subject: ${input.subject}` : null,
      status: "needs_review",
    })
    .select("id")
    .single();
  if (txError || !transaction) throw new Error(`Transaction insert failed: ${txError?.message ?? "unknown"}`);

  const { error: docError } = await supabase.from("payment_documents").insert({
    tenant_id: input.tenantId,
    transaction_id: transaction.id,
    customer_id: input.customerId,
    document_type: "Bank Transfer Proof",
    file_path: filePath,
    original_file_name: input.attachment.filename,
    uploaded_by: null,
    parsed_metadata: vision.raw,
    ai_confidence: vision.confidence_score,
  });
  if (docError) throw new Error(`Payment document insert failed: ${docError.message}`);

  await logAudit(supabase, {
    tenant_id: input.tenantId,
    entity_type: "payment",
    action: "created",
    title: "Inbound receipt staged for review",
    summary: `Transaction ${transaction.id} staged needs_review from ${input.senderEmail}. Ref: ${bankRef ?? "Pending"}.`,
    entity_id: String(transaction.id),
    metadata: {
      transaction_id: transaction.id,
      sender: input.senderEmail,
      customer_matched: input.customerWasMatched,
      confidence: vision.confidence_score,
    },
  });

  if (!input.customerWasMatched) {
    await createReconciliationLead(supabase, input.tenantId, {
      senderEmail: input.senderEmail,
      subject: input.subject,
      reason: `Sender did not match a customer; staged under fallback customer ${input.customerId}.`,
    });
  }

  const emailResult = await sendAcknowledgment({
    toEmail: input.senderEmail,
    bankReferenceId: bankRef,
  });

  return {
    transaction_id: transaction.id,
    file_path: filePath,
    amount,
    bank_reference_id: bankRef,
    confidence: vision.confidence_score,
    vision_fallback: vision.raw.fallback === true,
    emailSent: emailResult.ok,
  };
}

// -- Tenant resolution ---------------------------------------------------------

function parseTenantLookup(recipient: string): { alias: string; slugTag: string } {
  const lower = recipient.trim().toLowerCase();
  const plusMatch = lower.match(/\+([a-z0-9-]+)@/);
  return { alias: lower, slugTag: plusMatch?.[1] ?? "" };
}

async function resolveOrganization(
  supabase: ReturnType<typeof createClient>,
  lookup: { alias: string; slugTag: string },
) {
  if (lookup.alias) {
    const { data } = await supabase
      .from("organizations")
      .select("id, slug, inbound_alias, gemini_api_key, is_active")
      .eq("inbound_alias", lookup.alias)
      .eq("is_active", true)
      .maybeSingle();
    if (data) return data as { id: string; slug: string; inbound_alias: string | null; gemini_api_key: string | null };
  }
  if (lookup.slugTag) {
    const { data } = await supabase
      .from("organizations")
      .select("id, slug, inbound_alias, gemini_api_key, is_active")
      .eq("slug", lookup.slugTag)
      .eq("is_active", true)
      .maybeSingle();
    if (data) return data as { id: string; slug: string; inbound_alias: string | null; gemini_api_key: string | null };
  }
  return null;
}

// -- Customer matching ----------------------------------------------------------

async function findCustomerByEmail(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  email: string,
) {
  const { data } = await supabase
    .from("customers")
    .select("id, first_name, last_name, email")
    .eq("tenant_id", tenantId)
    .ilike("email", email)
    .limit(1)
    .maybeSingle();
  return data as { id: number; first_name: string; last_name: string; email: string | null } | null;
}

async function ensureUnmatchedCustomer(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
) {
  const fallbackEmail = "unmatched-inbound@streetside.local";
  const existing = await findCustomerByEmail(supabase, tenantId, fallbackEmail);
  if (existing) return existing;

  const { data: application, error: appError } = await supabase
    .from("applications")
    .insert({
      tenant_id: tenantId,
      first_name: "Unmatched",
      last_name: "Inbound",
      phone: "000-0000",
      email: fallbackEmail,
      status: "Pending Review",
      notes: "System placeholder for inbound-email receipts that did not match a customer.",
    })
    .select("id")
    .single();
  if (appError || !application) return null;

  const { data: customer, error: custError } = await supabase
    .from("customers")
    .insert({
      tenant_id: tenantId,
      application_id: application.id,
      first_name: "Unmatched",
      last_name: "Inbound",
      phone: "000-0000",
      email: fallbackEmail,
      address: "Inbound reconciliation queue",
    })
    .select("id, first_name, last_name, email")
    .single();
  if (custError || !customer) return null;
  return customer as { id: number; first_name: string; last_name: string; email: string | null };
}

async function findActiveContractId(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  customerId: number,
): Promise<number | null> {
  const { data } = await supabase
    .from("contracts")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("is_active", true)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? Number((data as { id: number }).id) : null;
}

async function createReconciliationLead(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  input: { senderEmail: string; subject: string; reason: string },
) {
  await supabase.from("leads").insert({
    tenant_id: tenantId,
    full_name: input.senderEmail,
    email: input.senderEmail,
    source: "inbound_email",
    pipeline_stage: "new_lead",
    buyer_journey_stage: "Inbound Receipt Reconciliation",
    next_action: "Reconcile inbound receipt sender",
    notes: `${input.reason} Subject: ${input.subject || "(none)"}`.slice(0, 2000),
  });
}

// -- Vision ---------------------------------------------------------------------

async function runVisionOcr(input: { bytes: Uint8Array; mime: string; apiKey: string }): Promise<VisionResult> {
  const fallback: VisionResult = {
    amount_paid: 0,
    currency: "BZD",
    bank_reference_id: null,
    payment_method: "Online Transfer",
    payment_date: null,
    confidence_score: null,
    raw: { fallback: true, reason: input.apiKey ? "vision call failed" : "no api key" },
  };
  if (!input.apiKey) return fallback;

  const prompt = [
    "You are a receipt OCR extractor for Belize real-estate bank transfer proofs.",
    "Read the attached receipt image and return ONLY valid JSON with keys:",
    "amount_paid (number), currency (string, default BZD), bank_reference_id (string or null),",
    "payment_method (exactly Online Transfer or Cash), payment_date (YYYY-MM-DD or null),",
    "confidence_score (0.00-1.00).",
    "If a value is unreadable use: amount_paid 0, bank_reference_id null, payment_date null,",
    "confidence_score 0.3 or lower. Never invent a reference. Never include commentary.",
  ].join("\n");

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(VISION_MODEL)}:generateContent?key=${input.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: input.mime, data: base64Encode(input.bytes) } },
            ],
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 600, responseMimeType: "application/json" },
        }),
      },
    );
    if (!response.ok) return fallback;
    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return fallback;
    return sanitizeVision(JSON.parse(text));
  } catch {
    return fallback;
  }
}

function sanitizeVision(value: Record<string, unknown>): VisionResult {
  const amount = Number(value.amount_paid);
  const confidence = value.confidence_score === null || value.confidence_score === undefined
    ? null
    : Math.max(0, Math.min(1, Number(value.confidence_score)));
  return {
    amount_paid: Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : 0,
    currency: typeof value.currency === "string" && value.currency.trim() ? value.currency.trim().slice(0, 8).toUpperCase() : "BZD",
    bank_reference_id: typeof value.bank_reference_id === "string" && value.bank_reference_id.trim()
      ? value.bank_reference_id.trim().slice(0, 120)
      : null,
    payment_method: value.payment_method === "Cash" ? "Cash" : "Online Transfer",
    payment_date: typeof value.payment_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.payment_date)
      ? value.payment_date
      : null,
    confidence_score: confidence !== null && Number.isFinite(confidence) ? Math.round(confidence * 100) / 100 : null,
    raw: value,
  };
}

// -- Acknowledgment email --------------------------------------------------------

async function sendAcknowledgment(input: { toEmail: string; bankReferenceId: string | null }) {
  const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const fromAddress = Deno.env.get("EMAIL_FROM_ADDRESS") ?? "";
  const fromName = Deno.env.get("EMAIL_FROM_NAME") ?? "Wamule Development";
  if (!resendApiKey || !fromAddress) {
    return { ok: false, error: "Email provider is not configured." };
  }
  const ref = input.bankReferenceId || "Pending";
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${fromName} <${fromAddress}>`,
        to: [input.toEmail],
        subject: `Payment Proof Received - Ref #${ref}`,
        text: `We received your payment receipt${input.bankReferenceId ? ` (Ref ${input.bankReferenceId})` : ""}. Our billing team is verifying the transaction.`,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: text.slice(0, 500) || `Resend returned ${response.status}.` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown email error." };
  }
}

// -- Helpers ---------------------------------------------------------------------

async function logAudit(
  supabase: ReturnType<typeof createClient>,
  event: {
    tenant_id: string;
    entity_type: string;
    action: string;
    title: string;
    summary?: string;
    entity_id?: string;
    metadata?: Record<string, unknown>;
  },
) {
  await supabase.from("audit_events").insert({
    tenant_id: event.tenant_id,
    entity_type: event.entity_type,
    entity_id: event.entity_id ?? null,
    action: event.action,
    title: event.title.slice(0, 200),
    summary: event.summary?.slice(0, 2000) ?? null,
    metadata: event.metadata ?? null,
  });
}

function normalizeAttachments(value: unknown): Array<{ filename: string; mime: string; bytes: Uint8Array }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ filename: string; mime: string; bytes: Uint8Array }> = [];
  for (const item of value as InboundAttachment[]) {
    if (!item || typeof item !== "object") continue;
    const mime = String(item.content_type ?? item.contentType ?? item.mime_type ?? item.mimeType ?? "").toLowerCase().split(";")[0].trim();
    if (!allowedAttachmentMimes.has(mime)) continue;
    const raw = item.content ?? item.data ?? item.base64;
    if (typeof raw !== "string" || !raw.length) continue;
    const bytes = base64Decode(stripDataUrlPrefix(raw));
    if (!bytes.length) continue;
    const filename = cleanText(item.filename ?? item.name, 160) || (mime === "application/pdf" ? "receipt.pdf" : "receipt.jpg");
    out.push({ filename, mime, bytes });
    if (out.length >= 5) break;
  }
  return out;
}

function firstAddress(value: unknown): string {
  if (typeof value === "string") return extractEmail(value) || value.trim();
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstAddress(entry);
      if (found) return found;
    }
    return "";
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["address", "email", "value", "text"]) {
      if (typeof record[key] === "string" && String(record[key]).trim()) {
        return extractEmail(record[key]) || String(record[key]).trim();
      }
    }
  }
  return "";
}

function extractEmail(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const angle = text.match(/<([^>]+@[^>]+)>/);
  if (angle?.[1]) return angle[1].trim().toLowerCase();
  const plain = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return plain?.[0]?.trim().toLowerCase() ?? "";
}

function stripDataUrlPrefix(value: string): string {
  const comma = value.indexOf(",");
  if (value.startsWith("data:") && comma > -1) return value.slice(comma + 1);
  return value;
}

function base64Decode(value: string): Uint8Array {
  try {
    const binary = atob(value.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array();
  }
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}
