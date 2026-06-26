import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type CompletenessStatus = "Complete" | "Needs Review" | "Missing Information" | "Lot Conflict";

type ReviewPayload = {
  summary: string;
  completeness_status: CompletenessStatus;
  missing_fields: string[];
  risk_flags: string[];
  recommended_admin_actions: string[];
  model: string;
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

  if (!["Super Admin", "Admin"].includes(String(currentProfile?.role ?? ""))) {
    return json({ error: "Only Super Admin or Admin users can generate AI application reviews." }, 403);
  }

  const body = await request.json().catch(() => null) as { application_id?: number } | null;
  const applicationId = Number(body?.application_id ?? 0);
  if (!applicationId) {
    return json({ error: "application_id is required." }, 400);
  }

  const { data: application, error: applicationError } = await supabase
    .from("applications")
    .select("*, parcels(id, lot_number, dimensions, status, base_price)")
    .eq("id", applicationId)
    .maybeSingle();

  if (applicationError) {
    return json({ error: applicationError.message }, 500);
  }

  if (!application) {
    return json({ error: "Application not found." }, 404);
  }

  const { data: linkedLead } = await supabase
    .from("leads")
    .select("id, pipeline_stage, source, next_action, next_action_due_at, assigned_to")
    .eq("application_id", application.id)
    .maybeSingle();

  const preferredParcelIds = Array.isArray(application.preferred_parcel_ids)
    ? application.preferred_parcel_ids.map((id: unknown) => Number(id)).filter(Boolean)
    : [];

  const { data: preferredLots, error: lotsError } = preferredParcelIds.length
    ? await supabase
      .from("parcels")
      .select("id, lot_number, dimensions, status, base_price")
      .in("id", preferredParcelIds)
    : { data: [], error: null };

  if (lotsError) {
    return json({ error: lotsError.message }, 500);
  }

  const { data: settings } = await supabase
    .from("ai_settings")
    .select("*")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  const deterministic = buildDeterministicReview(application, preferredLots ?? [], linkedLead);
  const apiKey = Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GOOGLE_API_KEY") ?? "";
  const aiEnabled = Boolean(settings?.is_enabled && settings?.application_summary_enabled && apiKey);
  let review: ReviewPayload = deterministic;

  if (aiEnabled) {
    const geminiReview = await generateGeminiReview({
      application,
      linkedLead,
      preferredLots: preferredLots ?? [],
      deterministic,
      apiKey,
      model: String(settings?.model ?? "gemini-3.1-flash-lite"),
    });
    if (geminiReview) review = normalizeReviewForWorkflow(geminiReview, deterministic, application);
  }

  const { data: savedReview, error: saveError } = await supabase
    .from("application_ai_reviews")
    .upsert({
      application_id: application.id,
      summary: review.summary,
      completeness_status: review.completeness_status,
      missing_fields: review.missing_fields,
      risk_flags: review.risk_flags,
      recommended_admin_actions: review.recommended_admin_actions,
      model: review.model,
      generated_by: currentUserData.user.id,
    }, { onConflict: "application_id" })
    .select("*")
    .single();

  if (saveError) {
    return json({ error: saveError.message }, 500);
  }

  return json({ review: savedReview, fallback: !aiEnabled || review.model === deterministic.model });
});

function buildDeterministicReview(application: Record<string, unknown>, preferredLots: Array<Record<string, unknown>>, linkedLead?: Record<string, unknown> | null): ReviewPayload {
  const name = String(application.applicant_full_name || `${application.first_name ?? ""} ${application.last_name ?? ""}`).trim() || "Applicant";
  const intendedUse = String(application.intended_use || "unspecified use");
  const paymentOption = String(application.payment_option || "unspecified payment option");
  const missingFields = requiredMissingFields(application);
  const riskFlags: string[] = [];
  const actions: string[] = [];
  const assignedLot = application.parcels as Record<string, unknown> | null;
  const applicationStatus = String(application.status ?? "Pending Review");
  const isApproved = applicationStatus === "Approved";
  const assignedLotId = Number(assignedLot?.id ?? application.parcel_id ?? 0);
  const unavailablePreferredLots = preferredLots.filter((lot) =>
    lot.status !== "Available" && !(isApproved && Number(lot.id) === assignedLotId)
  );
  const availablePreferredLots = preferredLots.filter((lot) => lot.status === "Available");
  const assignedLotConflict = Boolean(!isApproved && assignedLot?.status && assignedLot.status !== "Available");
  const noAvailablePreferredLot = !isApproved && preferredLots.length > 0 && availablePreferredLots.length === 0;
  const approvedWithoutAssignedLot = isApproved && !assignedLot;
  const hasLotConflict = assignedLotConflict || noAvailablePreferredLot;
  const lotIssues = unavailablePreferredLots.map((lot) => `Preferred Lot ${lot.lot_number} is ${lot.status}.`);

  if (!preferredLots.length) {
    riskFlags.push("No preferred lot selected.");
    actions.push(isApproved ? "Confirm the approved lot record is linked correctly." : "Ask applicant to identify preferred lot options before approval review.");
  }

  if (approvedWithoutAssignedLot) {
    riskFlags.push("Application is approved but no assigned lot is linked.");
    actions.push("Review the approved application and confirm the customer lot assignment record.");
  }

  if (assignedLotConflict) {
    riskFlags.push(`Assigned Lot ${assignedLot.lot_number} is currently ${assignedLot.status}.`);
  }

  if (noAvailablePreferredLot) {
    riskFlags.push(...lotIssues);
  } else if (unavailablePreferredLots.length) {
    riskFlags.push(
      `${unavailablePreferredLots.map((lot) => `Lot ${lot.lot_number} (${lot.status})`).join(", ")} unavailable; available preferred option remains: ${availablePreferredLots.map((lot) => `Lot ${lot.lot_number}`).join(", ")}.`,
    );
  }

  if (String(application.intended_use || "") === "Other" && !String(application.intended_use_other || "").trim()) {
    riskFlags.push("Intended use is Other without a description.");
  }

  if (!application.legal_notice_acknowledged) {
    riskFlags.push("Legal notice acknowledgement is missing.");
  }

  if (!application.sustainability_terms_verified) {
    riskFlags.push("Community and sustainability terms acknowledgement is missing.");
  }

  if (missingFields.length) {
    actions.push(`Request missing information: ${missingFields.join(", ")}.`);
  }

  if (noAvailablePreferredLot) {
    actions.push("Review preferred lot availability and ask applicant for alternate options.");
  } else if (unavailablePreferredLots.length) {
    actions.push(isApproved
      ? "Review preferred lot history only if the approved lot assignment looks inconsistent."
      : "Confirm which available preferred lot the applicant wants to proceed with before final manual approval.");
  }

  if (!actions.length) {
    actions.push(isApproved
      ? "No AI follow-up required unless the approved customer or lot record looks inconsistent."
      : "Admin should verify details, confirm lot availability, and proceed with normal manual review.");
  }

  const completenessStatus = chooseStatus(missingFields, riskFlags, hasLotConflict);
  const leadContext = linkedLead
    ? ` Linked lead stage: ${stageLabel(String(linkedLead.pipeline_stage ?? ""))}; source: ${linkedLead.source ?? "not recorded"}; next action: ${linkedLead.next_action ?? "not recorded"}.`
    : " No linked lead was found for this application.";

  return {
    summary: `${name} ${isApproved ? "has an approved application" : "applied"} for ${intendedUse} with ${paymentOption}. Preferred lots: ${preferredLots.map((lot) => `Lot ${lot.lot_number} (${lot.status})`).join(", ") || "none listed"}.${leadContext}`,
    completeness_status: completenessStatus,
    missing_fields: missingFields,
    risk_flags: riskFlags,
    recommended_admin_actions: actions,
    model: "deterministic-fallback",
  };
}

function normalizeReviewForWorkflow(review: ReviewPayload, deterministic: ReviewPayload, application: Record<string, unknown>): ReviewPayload {
  const isApproved = application.status === "Approved";
  if (isApproved && deterministic.completeness_status === "Complete") {
    return deterministic;
  }

  if (!isApproved) return review;

  return {
    ...review,
    recommended_admin_actions: review.recommended_admin_actions.map((action) =>
      action
        .replace(/before proceeding with (manual )?approval/gi, "when reviewing the approved record")
        .replace(/before final manual approval/gi, "when reviewing the approved record")
        .replace(/proceed with approval/gi, "review the approved record"),
    ),
  };
}

function requiredMissingFields(application: Record<string, unknown>) {
  const checks: Array<[string, unknown]> = [
    ["Applicant full name", application.applicant_full_name || `${application.first_name ?? ""} ${application.last_name ?? ""}`.trim()],
    ["Phone", application.phone],
    ["Email", application.email],
    ["Address", application.applicant_address],
    ["Nationality", application.nationality],
    ["Occupation", application.occupation],
    ["Intended use", application.intended_use],
    ["Number of parcels", application.parcel_count],
    ["Preferred lot", Array.isArray(application.preferred_parcel_ids) && application.preferred_parcel_ids.length ? "selected" : ""],
    ["Alternate lot preference", application.alternate_lot_preference],
    ["Payment option", application.payment_option],
    ["Applicant acknowledgement signature", application.applicant_acknowledgement_signature],
  ];

  return checks
    .filter(([, value]) => !String(value ?? "").trim())
    .map(([label]) => label);
}

function chooseStatus(missingFields: string[], riskFlags: string[], hasLotConflict: boolean): CompletenessStatus {
  if (hasLotConflict) return "Lot Conflict";
  if (missingFields.length >= 3) return "Missing Information";
  if (missingFields.length > 0 || riskFlags.length > 0) return "Needs Review";
  return "Complete";
}

async function generateGeminiReview({
  application,
  linkedLead,
  preferredLots,
  deterministic,
  apiKey,
  model,
}: {
  application: Record<string, unknown>;
  linkedLead?: Record<string, unknown> | null;
  preferredLots: Array<Record<string, unknown>>;
  deterministic: ReviewPayload;
  apiKey: string;
  model: string;
}): Promise<ReviewPayload | null> {
  const prompt = [
    "You are a read-only admin review assistant for Wamule Development land applications.",
    "You must not approve, decline, edit, reserve lots, create customers, or make final decisions.",
    "Return only JSON with: summary, completeness_status, missing_fields, risk_flags, recommended_admin_actions.",
    "completeness_status must be one of: Complete, Needs Review, Missing Information, Lot Conflict.",
    "Use Lot Conflict only when the application has no available preferred lot option, or when an assigned lot is already Reserved/Sold/unavailable.",
    "If one preferred lot is Sold/Reserved but another preferred lot is Available, do not call it Lot Conflict; describe it as an availability note and ask admin to confirm the available option manually.",
    "If application.status is Approved, do not use pre-approval language such as before proceeding with approval.",
    "For Approved applications, a Sold/Reserved assigned lot can be expected after approval or purchase and must not be treated as a conflict by itself.",
    "For Approved applications, focus on record consistency and only recommend cleanup if source records are inconsistent.",
    "Keep recommended_admin_actions advisory and manual.",
    "",
    `Deterministic checks: ${JSON.stringify(deterministic)}`,
    `Application: ${JSON.stringify(redactApplication(application))}`,
    `Linked lead: ${JSON.stringify(redactLead(linkedLead))}`,
    `Preferred lots: ${JSON.stringify(preferredLots)}`,
  ].join("\n");

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 700,
            responseMimeType: "application/json",
          },
        }),
      },
    );

    if (!response.ok) return null;
    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    const parsed = JSON.parse(text) as Partial<ReviewPayload>;
    return {
      summary: String(parsed.summary || deterministic.summary),
      completeness_status: normalizeStatus(parsed.completeness_status, deterministic.completeness_status),
      missing_fields: normalizeStringArray(parsed.missing_fields, deterministic.missing_fields),
      risk_flags: normalizeStringArray(parsed.risk_flags, deterministic.risk_flags),
      recommended_admin_actions: normalizeStringArray(parsed.recommended_admin_actions, deterministic.recommended_admin_actions),
      model,
    };
  } catch {
    return null;
  }
}

function redactLead(lead: Record<string, unknown> | null | undefined) {
  if (!lead) return null;
  return {
    id: lead.id,
    pipeline_stage: lead.pipeline_stage,
    source: lead.source,
    next_action_present: Boolean(lead.next_action),
    next_action_due_at: lead.next_action_due_at,
    assigned: Boolean(lead.assigned_to),
  };
}

function stageLabel(stage: string) {
  if (stage === "application_started") return "New Application";
  return stage.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function redactApplication(application: Record<string, unknown>) {
  return {
    id: application.id,
    applicant_full_name: application.applicant_full_name,
    first_name: application.first_name,
    last_name: application.last_name,
    phone_present: Boolean(application.phone),
    email_present: Boolean(application.email),
    applicant_address_present: Boolean(application.applicant_address),
    nationality: application.nationality,
    occupation: application.occupation,
    intended_use: application.intended_use,
    intended_use_other: application.intended_use_other,
    parcel_count: application.parcel_count,
    preferred_parcel_ids: application.preferred_parcel_ids,
    alternate_lot_preference: application.alternate_lot_preference,
    payment_option: application.payment_option,
    legal_notice_acknowledged: application.legal_notice_acknowledged,
    sustainability_terms_verified: application.sustainability_terms_verified,
    status: application.status,
    selected_lot: application.parcels,
  };
}

function normalizeStatus(value: unknown, fallback: CompletenessStatus): CompletenessStatus {
  return ["Complete", "Needs Review", "Missing Information", "Lot Conflict"].includes(String(value))
    ? String(value) as CompletenessStatus
    : fallback;
}

function normalizeStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders,
  });
}
