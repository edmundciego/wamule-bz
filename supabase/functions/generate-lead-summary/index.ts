import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const readinessStatuses = new Set([
  "new",
  "needs_follow_up",
  "gathering_information",
  "site_visit_ready",
  "deposit_readiness",
  "application_ready",
  "contract_ready",
  "blocked",
  "closed",
  "inactive",
  "unknown",
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LeadSummaryOutput = {
  summary: string;
  readiness_status: string;
  key_risks: string[];
  missing_information: string[];
  recommended_actions: string[];
  next_best_action: string | null;
  confidence_notes: string | null;
  model: string | null;
  provider: string | null;
};

type LeadContext = {
  lead: Record<string, unknown>;
  activities: Record<string, unknown>[];
  followUps: Record<string, unknown>[];
  siteVisits: Record<string, unknown>[];
  reservations: Record<string, unknown>[];
  application: Record<string, unknown> | null;
  customer: Record<string, unknown> | null;
  parcel: Record<string, unknown> | null;
  applicationReview: Record<string, unknown> | null;
  customerSummary: Record<string, unknown> | null;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  const token = (request.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) {
    return json({ error: "Missing authorization token." }, 401);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: currentUserData, error: currentUserError } = await supabase.auth.getUser(token);
  if (currentUserError || !currentUserData.user) {
    return json({ error: "Invalid authorization token." }, 401);
  }

  const { data: currentProfile, error: profileError } = await supabase
    .from("admin_profiles")
    .select("role")
    .eq("user_id", currentUserData.user.id)
    .maybeSingle();

  if (profileError) {
    return json({ error: profileError.message }, 500);
  }

  if (!["Super Admin", "Admin", "Staff"].includes(String(currentProfile?.role ?? ""))) {
    return json({ error: "Only Super Admin, Admin, or Staff users can generate lead summaries." }, 403);
  }

  const body = await request.json().catch(() => null) as { lead_id?: string } | null;
  const leadId = String(body?.lead_id ?? "").trim();
  if (!leadId) {
    return json({ error: "lead_id is required." }, 400);
  }
  if (!uuidPattern.test(leadId)) {
    return json({ error: "lead_id must be a valid UUID." }, 400);
  }

  const [leadResult, activitiesResult, followUpsResult, siteVisitsResult, reservationsResult, settingsResult] = await Promise.all([
    supabase
      .from("leads")
      .select("*, parcels(id, lot_number, status, dimensions, base_price), applications(*, application_ai_reviews(*)), customers(*, customer_ai_summaries(*))")
      .eq("id", leadId)
      .maybeSingle(),
    supabase
      .from("lead_activities")
      .select("*")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("follow_up_tasks")
      .select("*")
      .eq("lead_id", leadId)
      .order("due_at", { ascending: true, nullsFirst: false }),
    supabase
      .from("site_visits")
      .select("*")
      .eq("lead_id", leadId)
      .order("scheduled_at", { ascending: true }),
    supabase
      .from("lot_reservations")
      .select("*, parcels(id, lot_number, status, dimensions, base_price)")
      .eq("lead_id", leadId)
      .order("updated_at", { ascending: false }),
    supabase
      .from("ai_settings")
      .select("*")
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  const firstError = leadResult.error ??
    activitiesResult.error ??
    followUpsResult.error ??
    siteVisitsResult.error ??
    reservationsResult.error ??
    settingsResult.error;
  if (firstError) {
    return json({ error: firstError.message }, 500);
  }

  if (!leadResult.data) {
    return json({ error: "Lead not found." }, 404);
  }

  const lead = leadResult.data as Record<string, unknown>;
  const application = (lead.applications as Record<string, unknown> | null | undefined) ?? null;
  const customer = (lead.customers as Record<string, unknown> | null | undefined) ?? null;
  const context: LeadContext = {
    lead,
    activities: activitiesResult.data ?? [],
    followUps: followUpsResult.data ?? [],
    siteVisits: siteVisitsResult.data ?? [],
    reservations: reservationsResult.data ?? [],
    application,
    customer,
    parcel: (lead.parcels as Record<string, unknown> | null | undefined) ?? null,
    applicationReview: relationArray(application?.application_ai_reviews)[0] ?? null,
    customerSummary: relationArray(customer?.customer_ai_summaries)[0] ?? null,
  };

  const deterministic = buildDeterministicSummary(context);
  const settings = settingsResult.data;
  const apiKey = Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GOOGLE_API_KEY") ?? "";
  const model = String(settings?.model ?? "gemini-3.1-flash-lite");
  const canUseGemini = Boolean(
    settings?.is_enabled &&
    settings?.provider === "Gemini" &&
    apiKey,
  );

  let summary = deterministic;
  let usedModel = "deterministic-fallback";
  let usedProvider = canUseGemini ? "Gemini" : "deterministic";

  if (canUseGemini) {
    const geminiSummary = await generateGeminiSummary({
      data: summarizeForPrompt(context),
      deterministic,
      apiKey,
      model,
    });
    if (geminiSummary) {
      summary = geminiSummary;
      usedModel = model;
      usedProvider = "Gemini";
    } else {
      usedProvider = "deterministic";
    }
  }

  const sourceSnapshot = buildSourceSnapshot(context);
  const { data: savedSummary, error: saveError } = await supabase
    .from("lead_ai_summaries")
    .insert({
      lead_id: leadId,
      summary: summary.summary,
      readiness_status: summary.readiness_status,
      key_risks: summary.key_risks,
      missing_information: summary.missing_information,
      recommended_actions: summary.recommended_actions,
      next_best_action: summary.next_best_action,
      confidence_notes: summary.confidence_notes,
      source_snapshot: sourceSnapshot,
      model: usedModel,
      provider: usedProvider,
      generated_by: currentUserData.user.id,
      generated_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (saveError) {
    return json({ error: saveError.message }, 500);
  }

  return json({
    summary: savedSummary,
    fallback: usedModel === "deterministic-fallback",
    message: usedModel === "deterministic-fallback"
      ? "Lead Smart Summary generated with deterministic fallback."
      : "Lead Smart Summary generated with Gemini.",
  });
});

function buildDeterministicSummary(context: LeadContext): LeadSummaryOutput {
  const lead = context.lead;
  const name = String(lead.full_name ?? "This buyer").trim() || "This buyer";
  const stage = String(lead.pipeline_stage ?? "unknown");
  const activeReservation = context.reservations.find((reservation) => activeReservationStatuses().has(String(reservation.status)));
  const latestReservation = context.reservations[0] ?? null;
  const openFollowUps = context.followUps.filter((task) => ["open", "in_progress"].includes(String(task.status)));
  const overdueFollowUps = openFollowUps.filter((task) => isBeforeToday(task.due_at));
  const upcomingVisit = context.siteVisits.find((visit) => ["scheduled", "rescheduled"].includes(String(visit.status)) && isTodayOrFuture(visit.scheduled_at));
  const risks: string[] = [];
  const missing: string[] = [];
  const actions: string[] = [];

  if (!lead.assigned_to) {
    risks.push("No assigned staff member is recorded.");
    actions.push("Assign a team member before relying on follow-up ownership.");
  }
  if (!lead.phone && !lead.email && !lead.whatsapp) {
    missing.push("No phone, WhatsApp, or email contact is recorded.");
    actions.push("Add a reliable buyer contact method.");
  }
  if (!String(lead.next_action ?? "").trim()) {
    missing.push("No next action is recorded.");
    actions.push("Add a clear next action for staff follow-up.");
  }
  if (isBeforeToday(lead.next_action_due_at)) {
    risks.push("The lead next action date is overdue.");
    actions.push("Review and update the overdue next action.");
  }
  if (overdueFollowUps.length) {
    risks.push(`${overdueFollowUps.length} open follow-up task(s) are overdue.`);
    actions.push("Prioritize overdue buyer follow-up tasks.");
  }
  if (!openFollowUps.length && !["closed_won", "lost_inactive"].includes(stage)) {
    missing.push("No open follow-up task is recorded.");
    actions.push("Create a manual follow-up task if staff engagement is still needed.");
  }
  if (stage === "site_visit_scheduled" && !upcomingVisit) {
    risks.push("Pipeline stage says site visit scheduled, but no upcoming site visit is recorded.");
    actions.push("Confirm site visit details with the buyer.");
  }
  if (stage === "deposit_pending" && !activeReservation) {
    risks.push("Lead is deposit pending without an active reservation.");
    actions.push("Review reservation and deposit readiness before next steps.");
  }
  if (activeReservation) {
    const depositStatus = String(activeReservation.deposit_status ?? "not_requested");
    if (depositStatus === "pending" && isBeforeToday(activeReservation.deposit_due_at)) {
      risks.push("Reservation deposit is overdue.");
      actions.push("Review deposit readiness with staff before contacting the buyer.");
    } else if (depositStatus === "proof_submitted") {
      risks.push("Deposit proof is submitted and needs staff review.");
      actions.push("Review submitted proof before any manual confirmation.");
    } else if (depositStatus === "confirmed") {
      actions.push("Review whether application, contract, or post-sales next steps are ready.");
    }
  }
  if (!context.application) {
    missing.push("No linked application is recorded.");
  }
  if (!context.customer) {
    missing.push("No linked customer is recorded.");
  }
  if (context.applicationReview?.completeness_status && context.applicationReview.completeness_status !== "Complete") {
    risks.push(`Linked application review is marked ${context.applicationReview.completeness_status}.`);
  }
  if (stage === "closed_won") {
    actions.push("No active sales push is recommended; review handoff details only if needed.");
  }
  if (stage === "lost_inactive") {
    actions.push("No active sales follow-up is recommended unless staff reactivates this lead.");
  }

  const readiness = readinessFor({ stage, lead, activeReservation, latestReservation, upcomingVisit, risks, missing });
  const summaryParts = [
    `${name} is currently in ${labelize(stage)}.`,
    context.parcel?.lot_number ? `Preferred lot context: Lot ${context.parcel.lot_number}.` : "No preferred lot is linked to the lead record.",
    context.application ? "A linked application exists." : "No linked application is recorded.",
    context.customer ? "A linked customer exists." : "No linked customer is recorded.",
    activeReservation ? `Latest active reservation is ${activeReservation.status} with deposit status ${activeReservation.deposit_status}.` : "No active reservation is linked.",
  ];

  return {
    summary: summaryParts.join(" "),
    readiness_status: readiness,
    key_risks: unique(risks).slice(0, 8),
    missing_information: unique(missing).slice(0, 8),
    recommended_actions: unique(actions.length ? actions : ["Keep lead notes, follow-ups, and readiness details current."]).slice(0, 8),
    next_best_action: nextBestAction(stage, actions),
    confidence_notes: context.activities.length
      ? "Generated from current lead details, related activities, tasks, visits, reservations, application, and customer links."
      : "Generated from limited lead data; few or no lead activities are recorded.",
    model: "deterministic-fallback",
    provider: "deterministic",
  };
}

async function generateGeminiSummary({
  data,
  deterministic,
  apiKey,
  model,
}: {
  data: Record<string, unknown>;
  deterministic: LeadSummaryOutput;
  apiKey: string;
  model: string;
}): Promise<LeadSummaryOutput | null> {
  const prompt = [
    "You are a read-only Lead Smart Summary assistant for Wamule Development.",
    "Use only the supplied Wamule CRM data. Do not guess buyer intent, make legal or financial promises, approve applications, confirm deposits, change pipeline stages, create tasks, send messages, or update records.",
    "Return only valid JSON with keys: summary, readiness_status, key_risks, missing_information, recommended_actions, next_best_action, confidence_notes, model, provider.",
    "readiness_status must be one of: new, needs_follow_up, gathering_information, site_visit_ready, deposit_readiness, application_ready, contract_ready, blocked, closed, inactive, unknown.",
    "Keep the output concise, operational, calm, and framed for staff review. Recommendations are manual staff review notes only.",
    "",
    `Deterministic baseline: ${JSON.stringify(deterministic)}`,
    `Lead context: ${JSON.stringify(data)}`,
  ].join("\n");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1000,
            responseMimeType: "application/json",
          },
        }),
      },
    );

    if (!response.ok) return null;
    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    return sanitizeSummary(JSON.parse(text), deterministic, model);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function sanitizeSummary(value: Partial<LeadSummaryOutput>, fallback: LeadSummaryOutput, model: string): LeadSummaryOutput {
  const readiness = String(value.readiness_status ?? fallback.readiness_status ?? "unknown");
  const fallbackReadiness = readinessStatuses.has(fallback.readiness_status) ? fallback.readiness_status : "unknown";
  return {
    summary: cleanText(value.summary, fallback.summary),
    readiness_status: readinessStatuses.has(readiness) ? readiness : fallbackReadiness,
    key_risks: cleanStringArray(value.key_risks, fallback.key_risks),
    missing_information: cleanStringArray(value.missing_information, fallback.missing_information),
    recommended_actions: cleanStringArray(value.recommended_actions, fallback.recommended_actions),
    next_best_action: nullableText(value.next_best_action, fallback.next_best_action),
    confidence_notes: nullableText(value.confidence_notes, fallback.confidence_notes),
    model,
    provider: "Gemini",
  };
}

function summarizeForPrompt(context: LeadContext) {
  const lead = context.lead;
  return {
    lead: pick(lead, ["id", "full_name", "email", "phone", "whatsapp", "source", "pipeline_stage", "buyer_journey_stage", "decision_blocker", "budget_min", "budget_max", "preferred_contact_method", "assigned_to", "next_action", "next_action_due_at", "notes", "lost_reason", "created_at", "updated_at"]),
    parcel: context.parcel ? pick(context.parcel, ["id", "lot_number", "status", "dimensions", "base_price"]) : null,
    application: context.application ? pick(context.application, ["id", "applicant_full_name", "first_name", "last_name", "status", "intended_use", "payment_option", "created_at", "updated_at"]) : null,
    application_review: context.applicationReview ? pick(context.applicationReview, ["summary", "completeness_status", "missing_fields", "risk_flags", "recommended_admin_actions", "updated_at"]) : null,
    customer: context.customer ? pick(context.customer, ["id", "first_name", "last_name", "created_at", "updated_at"]) : null,
    customer_summary: context.customerSummary ? pick(context.customerSummary, ["summary", "account_status", "collections_flags", "missing_items", "recommended_actions", "updated_at"]) : null,
    activities: context.activities.map((row) => pick(row, ["activity_type", "title", "description", "created_at"])),
    follow_ups: context.followUps.map((row) => pick(row, ["title", "description", "due_at", "status", "priority", "completed_at", "updated_at"])),
    site_visits: context.siteVisits.map((row) => pick(row, ["scheduled_at", "status", "visit_type", "location", "notes", "completed_at", "updated_at"])),
    reservations: context.reservations.map((row) => pick(row, ["reservation_code", "status", "deposit_status", "expected_deposit_amount", "deposit_due_at", "reserved_at", "expires_at", "converted_application_id", "converted_contract_id", "updated_at"])),
  };
}

function buildSourceSnapshot(context: LeadContext) {
  return {
    lead_id: context.lead.id,
    lead_updated_at: context.lead.updated_at,
    activity_count: context.activities.length,
    follow_up_count: context.followUps.length,
    site_visit_count: context.siteVisits.length,
    reservation_count: context.reservations.length,
    application_id: context.application?.id ?? null,
    customer_id: context.customer?.id ?? null,
    generated_from: "lead-smart-summary-phase-4d-1",
  };
}

function readinessFor({
  stage,
  lead,
  activeReservation,
  latestReservation,
  upcomingVisit,
  risks,
  missing,
}: {
  stage: string;
  lead: Record<string, unknown>;
  activeReservation: Record<string, unknown> | undefined;
  latestReservation: Record<string, unknown> | null;
  upcomingVisit: Record<string, unknown> | undefined;
  risks: string[];
  missing: string[];
}) {
  if (stage === "closed_won") return "closed";
  if (stage === "lost_inactive") return "inactive";
  if (risks.length >= 3) return "blocked";
  if (stage === "contract_started") return "contract_ready";
  if (stage === "application_started" || lead.application_id) return "application_ready";
  if (activeReservation || latestReservation?.deposit_status === "confirmed" || stage === "deposit_pending") return "deposit_readiness";
  if (upcomingVisit || stage === "site_visit_scheduled") return "site_visit_ready";
  if (missing.length) return "gathering_information";
  if (isBeforeToday(lead.next_action_due_at)) return "needs_follow_up";
  if (stage === "new_lead") return "new";
  return "needs_follow_up";
}

function nextBestAction(stage: string, actions: string[]) {
  if (actions.length) return actions[0];
  if (stage === "closed_won") return "Review handoff details only if staff needs context.";
  if (stage === "lost_inactive") return "No active follow-up unless staff reactivates this lead.";
  return "Review buyer notes and confirm the next manual follow-up.";
}

function activeReservationStatuses() {
  return new Set(["draft", "reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed"]);
}

function isBeforeToday(value: unknown) {
  const date = parseDate(value);
  if (!date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

function isTodayOrFuture(value: unknown) {
  const date = parseDate(value);
  if (!date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date >= today;
}

function parseDate(value: unknown) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function relationArray(value: unknown) {
  return Array.isArray(value) ? value as Record<string, unknown>[] : [];
}

function pick(row: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, row[key] ?? null]));
}

function cleanText(value: unknown, fallback: string) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 4000) : fallback;
}

function nullableText(value: unknown, fallback: string | null) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 1500) : fallback;
}

function cleanStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 10);
  return cleaned.length ? cleaned : fallback;
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders,
  });
}
