import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeWorkspaceTenant } from "../_shared/workspace-auth.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const readinessStatuses = new Set([
  "not_started",
  "in_progress",
  "missing_documents",
  "agreement_review",
  "signature_pending",
  "payment_setup_pending",
  "collections_ready",
  "blocked",
  "ready",
  "completed",
  "unknown",
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PostSalesSummaryOutput = {
  summary: string;
  readiness_status: string;
  key_blockers: string[];
  missing_information: string[];
  recommended_actions: string[];
  next_best_action: string | null;
  confidence_notes: string | null;
  model: string | null;
  provider: string | null;
};

type PostSalesContext = {
  checklist: Record<string, unknown>;
  tasks: Record<string, unknown>[];
  activities: Record<string, unknown>[];
  customer: Record<string, unknown> | null;
  application: Record<string, unknown> | null;
  contract: Record<string, unknown> | null;
  lead: Record<string, unknown> | null;
  reservation: Record<string, unknown> | null;
  payments: Record<string, unknown>[];
  paymentDocuments: Record<string, unknown>[];
  paymentRequests: Record<string, unknown>[];
  paymentAllocations: Record<string, unknown>[];
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
  const callerSupabase = createClient(supabaseUrl, serviceRoleKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: currentUserData, error: currentUserError } = await supabase.auth.getUser(token);
  if (currentUserError || !currentUserData.user) {
    return json({ error: "Invalid authorization token." }, 401);
  }

  const body = await request.json().catch(() => null) as { checklist_id?: string; tenant_id?: string; generationId?: string } | null;
  // Post-sales summaries contain contract/payment data and are Admin/Super
  // Admin operations under the M3.1 contract.
  const workspaceAuth = await authorizeWorkspaceTenant(supabase, currentUserData.user.id, body?.tenant_id, ["Super Admin", "Admin"]);
  if (!workspaceAuth.ok) return json({ error: workspaceAuth.error }, workspaceAuth.status);
  const tenantId = workspaceAuth.tenantId;
  const checklistId = String(body?.checklist_id ?? "").trim();
  const generationId = String(body?.generationId ?? "").trim();
  if (!checklistId) {
    return json({ error: "checklist_id is required." }, 400);
  }
  if (!uuidPattern.test(checklistId)) {
    return json({ error: "checklist_id must be a valid UUID." }, 400);
  }
  if (!uuidPattern.test(generationId)) {
    return json({ error: "generationId must be a valid UUID and remain unchanged when retrying this generation." }, 400);
  }

  const { data: checklistData, error: checklistError } = await supabase
    .from("post_sales_checklists")
    .select("*")
    .eq("id", checklistId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (checklistError) {
    return json({ error: checklistError.message }, 500);
  }
  if (!checklistData) {
    return json({ error: "Post-sales checklist not found." }, 404);
  }

  const { data: resolvedScope, error: scopeError } = await supabase.rpc("active_post_sales_checklist_scope", {
    p_checklist_id: checklistId,
    p_expected_tenant_id: tenantId,
  });
  if (scopeError) {
    console.error("Post-sales summary scope could not be verified", safeError(scopeError));
    return json({ error: "The selected post-sales workspace could not be verified." }, 403);
  }
  const verifiedScope = Array.isArray(resolvedScope) ? resolvedScope[0] : resolvedScope;
  if (!verifiedScope || verifiedScope.tenant_id !== tenantId) {
    return json({ error: "Post-sales summaries require an active, verified workspace scope." }, 403);
  }

  const checklist = checklistData as Record<string, unknown>;
  const customerId = numberOrNull(checklist.customer_id);
  const applicationId = numberOrNull(checklist.application_id);
  const contractId = numberOrNull(checklist.contract_id);
  const leadId = stringOrNull(checklist.lead_id);
  const reservationId = stringOrNull(checklist.reservation_id);
  const projectId = stringOrNull(verifiedScope.project_id);
  const phaseId = stringOrNull(verifiedScope.phase_id);
  if (!projectId || !phaseId) {
    return json({ error: "Post-sales AI requires a checklist linked to one verified project and phase." }, 403);
  }

  const claimArgs = {
    p_summary_kind: "post_sales",
    p_tenant_id: tenantId,
    p_parent_id: checklistId,
    p_generation_id: generationId,
    p_actor_id: currentUserData.user.id,
  };
  const { data: claimData, error: claimError } = await supabase.rpc("claim_ai_summary_generation_v1", claimArgs);
  if (claimError) return json({ error: claimError.message }, 500);
  const claim = (Array.isArray(claimData) ? claimData[0] : claimData) as {
    status?: string;
    claim_token?: string | null;
    summary_id?: string | null;
  } | null;
  if (claim?.status === "in_progress") {
    return json({
      status: "in_progress",
      generation_id: generationId,
      message: "This post-sales summary is already being generated. Retry shortly with the same generationId.",
    }, 202);
  }
  if (claim?.status === "completed") {
    const completedResult = claim.summary_id
      ? await supabase.from("post_sales_ai_summaries").select("*")
        .eq("id", claim.summary_id).eq("tenant_id", tenantId).eq("checklist_id", checklistId).eq("generation_id", generationId).maybeSingle()
      : { data: null, error: null };
    if (completedResult.error) return json({ error: completedResult.error.message }, 500);
    if (!completedResult.data) return json({ error: "The completed post-sales summary generation could not be found." }, 500);
    return json({
      summary: completedResult.data,
      fallback: String(completedResult.data.model ?? "") === "deterministic-fallback",
      message: "Post-Sales Smart Summary generation recovered from its saved result.",
    });
  }
  if (claim?.status !== "claimed" || !claim.claim_token) {
    return json({ error: "A valid post-sales summary generation claim could not be established." }, 500);
  }
  let generationCompleted = false;
  try {

  const [applicationResult, contractResult, leadResult, reservationResult, applicationCustomerResult] = await Promise.all([
    applicationId
      ? supabase
        .from("applications")
        .select("id,tenant_id,project_id,phase_id,applicant_full_name,first_name,last_name,status,intended_use,created_at,updated_at,application_ai_reviews(*)")
        .eq("id", applicationId)
        .eq("tenant_id", tenantId)
        .eq("project_id", projectId)
        .eq("phase_id", phaseId)
        .maybeSingle()
      : resolvedResult(null),
    contractId
      ? supabase
        .from("contracts")
        .select("*, parcels(id, lot_number, status, dimensions)")
        .eq("id", contractId)
        .eq("tenant_id", tenantId)
        .eq("project_id", projectId)
        .eq("phase_id", phaseId)
        .maybeSingle()
      : resolvedResult(null),
    leadId
      ? supabase
        .from("leads")
        .select("*")
        .eq("id", leadId)
        .eq("tenant_id", tenantId)
        .eq("project_id", projectId)
        .eq("phase_id", phaseId)
        .maybeSingle()
      : resolvedResult(null),
    reservationId
      ? supabase
        .from("lot_reservations")
        .select("*, parcels(id, lot_number, status, dimensions)")
        .eq("id", reservationId)
        .eq("tenant_id", tenantId)
        .eq("project_id", projectId)
        .eq("phase_id", phaseId)
        .maybeSingle()
      : resolvedResult(null),
    applicationId
      ? callerSupabase.from("customer_applications")
        .select("customer_id")
        .eq("tenant_id", tenantId)
        .eq("application_id", applicationId)
        .eq("is_primary", true)
        .maybeSingle()
      : resolvedResult(null),
  ]);

  // The checklist scope resolver follows its verified parent graph. Require
  // every supplied sales parent to match that same active scope before any AI
  // provider request or summary write. A customer-only company record does
  // not choose an arbitrary contract/phase.
  const parentError = applicationResult.error ?? contractResult.error ?? leadResult.error ?? reservationResult.error ?? applicationCustomerResult.error;
  if (parentError) return json({ error: parentError.message }, 500);
  if ((applicationId && !applicationResult.data) || (contractId && !contractResult.data)
    || (leadId && !leadResult.data) || (reservationId && !reservationResult.data)) {
    return json({ error: "A linked post-sales record is outside the checklist's verified project and phase." }, 403);
  }
  const effectiveCustomerId = customerId ?? numberOrNull(applicationCustomerResult.data?.customer_id);

  const [tasksResult, activitiesResult, customerResult, settingsResult] = await Promise.all([
    loadPostSalesTasks(supabase, checklist),
    supabase
      .from("post_sales_activities")
      .select("*")
      .eq("checklist_id", checklistId)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(30),
    effectiveCustomerId
      ? supabase
        .from("customers")
        .select("id,tenant_id,first_name,last_name,phone,email,created_at,updated_at")
        .eq("id", effectiveCustomerId)
        .eq("tenant_id", tenantId)
        .maybeSingle()
      : resolvedResult(null),
    supabase
      .from("ai_settings")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  const contextError = tasksResult.error ?? activitiesResult.error ?? customerResult.error ?? settingsResult.error;
  if (contextError) return json({ error: contextError.message }, 500);

  const allocationCustomerId = effectiveCustomerId ?? numberOrNull(contractResult.data?.customer_id)
    ?? numberOrNull(reservationResult.data?.customer_id);
  const { data: allAllocations, error: allocationsError } = allocationCustomerId
    ? await supabase.from("transaction_allocations")
      .select("id,tenant_id,transaction_id,customer_id,amount,currency,scope_kind,allocation_kind,contract_id,reservation_id,fee_charge_id,project_id,phase_id,allocation_reason")
      .eq("tenant_id", tenantId).eq("customer_id", allocationCustomerId)
    : { data: [], error: null };
  if (allocationsError) return json({ error: allocationsError.message }, 500);
  const paymentAllocations = ((allAllocations ?? []) as Record<string, unknown>[]).filter((allocation) =>
    (contractId !== null && Number(allocation.contract_id) === contractId)
    || (reservationId !== null && String(allocation.reservation_id) === reservationId)
    || (allocation.fee_charge_id !== null && allocation.scope_kind === "phase"
      && allocation.project_id === projectId && allocation.phase_id === phaseId)
  );
  const transactionIds = [...new Set(paymentAllocations.map((allocation) => Number(allocation.transaction_id)).filter(Number.isFinite))];
  const [paymentsResult, paymentDocumentsResult, paymentRequestsResult] = await Promise.all([
    transactionIds.length
      ? supabase.from("transactions")
        .select("id,tenant_id,customer_id,receipt_number,amount,currency,transaction_type,status,created_at,collection_method,contract_id")
        .eq("tenant_id", tenantId).eq("customer_id", allocationCustomerId).in("id", transactionIds)
      : resolvedResult([]),
    transactionIds.length
      ? supabase.from("payment_documents")
        .select("id,tenant_id,customer_id,transaction_id,document_type,file_path,original_file_name,created_at")
        .eq("tenant_id", tenantId).eq("customer_id", allocationCustomerId).in("transaction_id", transactionIds)
      : resolvedResult([]),
    contractId
      ? supabase.from("payment_requests")
        .select("id,tenant_id,customer_id,contract_id,fee_charge_id,project_id,phase_id,scope_kind,currency,amount_due,due_date,status,reason")
        .eq("tenant_id", tenantId).eq("customer_id", allocationCustomerId).eq("contract_id", contractId)
      : projectId && phaseId && allocationCustomerId
      ? supabase.from("payment_requests")
        .select("id,tenant_id,customer_id,contract_id,fee_charge_id,project_id,phase_id,scope_kind,currency,amount_due,due_date,status,reason")
        .eq("tenant_id", tenantId).eq("customer_id", allocationCustomerId).eq("project_id", projectId).eq("phase_id", phaseId)
      : resolvedResult([]),
  ]);
  const financeError = paymentsResult.error ?? paymentDocumentsResult.error ?? paymentRequestsResult.error;
  if (financeError) return json({ error: financeError.message }, 500);

  const customer = (customerResult.data as Record<string, unknown> | null | undefined) ?? null;
  const contract = (contractResult.data as Record<string, unknown> | null | undefined) ?? null;

  const context: PostSalesContext = {
    checklist,
    tasks: tasksResult.data ?? [],
    activities: activitiesResult.data ?? [],
    customer,
    application: (applicationResult.data as Record<string, unknown> | null | undefined) ??
      null,
    contract,
    lead: (leadResult.data as Record<string, unknown> | null | undefined) ?? null,
    reservation: (reservationResult.data as Record<string, unknown> | null | undefined) ?? null,
    payments: paymentsResult.data ?? [],
    paymentDocuments: paymentDocumentsResult.data ?? [],
    paymentRequests: paymentRequestsResult.data ?? [],
    paymentAllocations,
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
    if (!geminiSummary) {
      return json({ error: "Gemini did not return a valid summary. Retry with the same generationId." }, 502);
    }
    summary = geminiSummary;
    usedModel = model;
    usedProvider = "Gemini";
  }

  const summaryPayload = {
      tenant_id: tenantId,
      checklist_id: checklistId,
      generation_id: generationId,
      customer_id: effectiveCustomerId,
      application_id: applicationId,
      contract_id: contractId,
      lead_id: leadId,
      reservation_id: reservationId,
      summary: summary.summary,
      readiness_status: summary.readiness_status,
      key_blockers: summary.key_blockers,
      missing_information: summary.missing_information,
      recommended_actions: summary.recommended_actions,
      next_best_action: summary.next_best_action,
      confidence_notes: summary.confidence_notes,
      source_snapshot: buildSourceSnapshot(context),
      model: usedModel,
      provider: usedProvider,
      generated_by: currentUserData.user.id,
      generated_at: new Date().toISOString(),
  };
  const savedResult = await supabase.from("post_sales_ai_summaries")
    .upsert(summaryPayload, { onConflict: "tenant_id,checklist_id,generation_id", ignoreDuplicates: true })
    .select("*").maybeSingle();
  let savedSummary = savedResult.data;
  let saveError = savedResult.error?.message ?? null;
  if (!saveError && !savedSummary) {
    const recovered = await supabase.from("post_sales_ai_summaries").select("*")
      .eq("tenant_id", tenantId).eq("checklist_id", checklistId).eq("generation_id", generationId).maybeSingle();
    savedSummary = recovered.data;
    saveError = recovered.error?.message ?? (recovered.data ? null : "The concurrent post-sales summary generation could not be recovered.");
  }

  if (saveError) {
    return json({ error: saveError }, 500);
  }

  const { error: completeError } = await supabase.rpc("complete_ai_summary_generation_v1", {
    p_summary_kind: claimArgs.p_summary_kind,
    p_tenant_id: claimArgs.p_tenant_id,
    p_parent_id: claimArgs.p_parent_id,
    p_generation_id: claimArgs.p_generation_id,
    p_claim_token: claim.claim_token,
    p_summary_id: String(savedSummary.id),
  });
  if (completeError) return json({ error: completeError.message }, 500);
  generationCompleted = true;

  return json({
    summary: savedSummary,
    fallback: usedModel === "deterministic-fallback",
    message: usedModel === "deterministic-fallback"
      ? "Post-Sales Smart Summary generated with deterministic fallback."
      : "Post-Sales Smart Summary generated with Gemini.",
  });
  } finally {
    if (!generationCompleted) {
      try {
        const { error: releaseError } = await supabase.rpc("release_ai_summary_generation_v1", {
          p_summary_kind: claimArgs.p_summary_kind,
          p_tenant_id: claimArgs.p_tenant_id,
          p_parent_id: claimArgs.p_parent_id,
          p_generation_id: claimArgs.p_generation_id,
          p_claim_token: claim.claim_token,
        });
        if (releaseError) console.error("Post-sales summary claim release failed", releaseError.message);
      } catch (releaseError) {
        console.error("Post-sales summary claim release failed", releaseError);
      }
    }
  }
});

async function loadPostSalesTasks(supabase: ReturnType<typeof createClient>, checklist: Record<string, unknown>) {
  const customerId = numberOrNull(checklist.customer_id);
  const applicationId = numberOrNull(checklist.application_id);
  const contractId = numberOrNull(checklist.contract_id);
  const leadId = stringOrNull(checklist.lead_id);
  const reservationId = stringOrNull(checklist.reservation_id);
  const query = supabase
    .from("post_sales_tasks")
    .select("*")
    .eq("tenant_id", String(checklist.tenant_id ?? ""))
    .order("due_at", { ascending: true, nullsFirst: false });

  if (contractId) return query.eq("contract_id", contractId);
  if (applicationId) return query.eq("application_id", applicationId);
  if (leadId) return query.eq("lead_id", leadId);
  if (reservationId) return query.eq("reservation_id", reservationId);
  // A customer can have records in multiple phases. Without a linked sale
  // parent, do not use a company-wide customer task list for a phase summary.
  if (customerId) return resolvedResult([]);
  return { data: [], error: null };
}

function buildDeterministicSummary(context: PostSalesContext): PostSalesSummaryOutput {
  const checklist = context.checklist;
  const customerName = context.customer
    ? `${String(context.customer.first_name ?? "").trim()} ${String(context.customer.last_name ?? "").trim()}`.trim() || "This customer"
    : "This customer";
  const openTasks = context.tasks.filter((task) => ["open", "in_progress", "blocked"].includes(String(task.status)));
  const overdueTasks = openTasks.filter((task) => isBeforeToday(task.due_at));
  const blockers: string[] = [];
  const missing: string[] = [];
  const actions: string[] = [];

  if (!checklist.assigned_to) {
    missing.push("No assigned post-sales staff member is recorded.");
    actions.push("Assign a team member for post-sales ownership.");
  }
  if (String(checklist.status) === "blocked") {
    blockers.push("Checklist status is blocked.");
    actions.push("Review the blocker before moving the customer forward.");
  }
  if (String(checklist.document_status) === "missing_documents") {
    missing.push("Required post-sales documents are missing.");
    actions.push("Request missing documents through the normal staff process.");
  }
  if (String(checklist.document_status) === "pending_review") {
    blockers.push("Submitted documents are pending staff review.");
    actions.push("Review submitted documents before marking document readiness complete.");
  }
  if (String(checklist.document_status) === "blocked") {
    blockers.push("Document readiness is blocked.");
  }
  if (String(checklist.agreement_status) === "ready_for_review") {
    blockers.push("Agreement is ready for staff review.");
    actions.push("Review the agreement before sending it for signature.");
  }
  if (String(checklist.agreement_status) === "sent_for_signature") {
    blockers.push("Agreement is sent for signature.");
    actions.push("Follow up on signed agreement status through the normal process.");
  }
  if (String(checklist.agreement_status) === "blocked") {
    blockers.push("Agreement readiness is blocked.");
  }
  if (String(checklist.payment_setup_status) === "pending") {
    blockers.push("Payment setup details are pending.");
    actions.push("Confirm payment setup details before collections handoff.");
  }
  if (String(checklist.payment_setup_status) === "ready") {
    actions.push("Confirm whether payment setup can be marked active by staff.");
  }
  if (String(checklist.payment_setup_status) === "blocked") {
    blockers.push("Payment setup is blocked.");
  }
  if (String(checklist.collections_handoff_status) === "ready") {
    actions.push("Hand off to collections when staff confirms readiness.");
  }
  if (String(checklist.collections_handoff_status) === "blocked") {
    blockers.push("Collections handoff is blocked.");
  }
  if (overdueTasks.length) {
    blockers.push(`${overdueTasks.length} open post-sales task(s) are overdue.`);
    actions.push("Prioritize overdue post-sales tasks.");
  }
  if (openTasks.length) {
    actions.push(`Review ${openTasks.length} open post-sales task(s).`);
  }
  if (!context.customer) missing.push("No linked customer context was found.");
  if (!context.application) missing.push("No linked application context was found.");
  if (!context.contract) missing.push("No linked contract context was found.");
  if (context.reservation?.deposit_status === "confirmed" && String(checklist.collections_handoff_status) !== "handed_off") {
    actions.push("Reservation deposit is confirmed; review remaining post-sales handoff steps.");
  }

  const readiness = readinessFor(checklist, blockers, missing);
  const summaryParts = [
    `${customerName} post-sales checklist is ${labelize(String(checklist.status ?? "unknown"))}.`,
    `Documents are ${labelize(String(checklist.document_status ?? "unknown"))}.`,
    `Agreement is ${labelize(String(checklist.agreement_status ?? "unknown"))}.`,
    `Payment setup is ${labelize(String(checklist.payment_setup_status ?? "unknown"))}.`,
    `Collections handoff is ${labelize(String(checklist.collections_handoff_status ?? "unknown"))}.`,
  ];

  return {
    summary: summaryParts.join(" "),
    readiness_status: readiness,
    key_blockers: unique(blockers).slice(0, 8),
    missing_information: unique(missing).slice(0, 8),
    recommended_actions: unique(actions.length ? actions : ["Keep post-sales checklist, tasks, and handoff notes current."]).slice(0, 8),
    next_best_action: nextBestAction(checklist, actions),
    confidence_notes: context.activities.length
      ? "Generated from current post-sales checklist, tasks, activity history, and linked customer workflow records."
      : "Generated from checklist and related records; few or no post-sales activities are recorded.",
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
  deterministic: PostSalesSummaryOutput;
  apiKey: string;
  model: string;
}): Promise<PostSalesSummaryOutput | null> {
  const prompt = [
    "You are a read-only Post-Sales Smart Summary assistant for Wamule Development.",
    "Use only the supplied Wamule CRM data. Do not guess buyer intent, make legal or financial promises, approve applications, confirm deposits, mark documents approved, say a contract is signed unless source data says so, say payment setup is active unless source data says so, say collections handoff is complete unless source data says so, change post-sales statuses, create tasks, send messages, or update records.",
    "Return only valid JSON with keys: summary, readiness_status, key_blockers, missing_information, recommended_actions, next_best_action, confidence_notes, model, provider.",
    "readiness_status must be one of: not_started, in_progress, missing_documents, agreement_review, signature_pending, payment_setup_pending, collections_ready, blocked, ready, completed, unknown.",
    "Keep the output concise, operational, calm, and framed for staff review. Recommendations are manual staff review notes only.",
    "",
    `Deterministic baseline: ${JSON.stringify(deterministic)}`,
    `Post-sales context: ${JSON.stringify(data)}`,
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

function sanitizeSummary(value: Partial<PostSalesSummaryOutput>, fallback: PostSalesSummaryOutput, model: string): PostSalesSummaryOutput {
  const readiness = String(value.readiness_status ?? fallback.readiness_status ?? "unknown");
  const fallbackReadiness = readinessStatuses.has(fallback.readiness_status) ? fallback.readiness_status : "unknown";
  return {
    summary: cleanText(value.summary, fallback.summary),
    readiness_status: readinessStatuses.has(readiness) ? readiness : fallbackReadiness,
    key_blockers: cleanStringArray(value.key_blockers, fallback.key_blockers),
    missing_information: cleanStringArray(value.missing_information, fallback.missing_information),
    recommended_actions: cleanStringArray(value.recommended_actions, fallback.recommended_actions),
    next_best_action: nullableText(value.next_best_action, fallback.next_best_action),
    confidence_notes: nullableText(value.confidence_notes, fallback.confidence_notes),
    model,
    provider: "Gemini",
  };
}

function summarizeForPrompt(context: PostSalesContext) {
  return {
    checklist: pick(context.checklist, ["id", "customer_id", "application_id", "contract_id", "lead_id", "reservation_id", "status", "agreement_status", "document_status", "collections_handoff_status", "payment_setup_status", "assigned_to", "started_at", "completed_at", "notes", "created_at", "updated_at"]),
    customer: context.customer ? pick(context.customer, ["id", "first_name", "last_name", "phone", "email", "created_at", "updated_at"]) : null,
    application: context.application ? pick(context.application, ["id", "applicant_full_name", "first_name", "last_name", "status", "payment_option", "created_at", "updated_at"]) : null,
    contract: context.contract ? pick(context.contract, ["id", "customer_id", "parcel_id", "signed_contract_file_path", "is_active", "start_date", "created_at", "updated_at"]) : null,
    lead: context.lead ? pick(context.lead, ["id", "pipeline_stage", "next_action", "next_action_due_at", "assigned_to", "updated_at"]) : null,
    reservation: context.reservation ? pick(context.reservation, ["id", "status", "deposit_status", "deposit_due_at", "deposit_paid_at", "converted_application_id", "converted_contract_id", "updated_at"]) : null,
    tasks: context.tasks.map((row) => pick(row, ["title", "description", "task_type", "status", "priority", "due_at", "assigned_to", "completed_at", "updated_at"])),
    activities: context.activities.map((row) => pick(row, ["activity_type", "title", "description", "created_at"])),
    payment_context: {
      payment_count: context.payments.length,
      payment_document_count: context.paymentDocuments.length,
      open_payment_request_count: context.paymentRequests.filter((request) => !["Paid", "Cancelled"].includes(String(request.status))).length,
      allocations: context.paymentAllocations.map((allocation) => pick(allocation, [
        "amount", "currency", "scope_kind", "allocation_kind", "contract_id", "reservation_id", "fee_charge_id", "project_id", "phase_id",
      ])),
    },
  };
}

function buildSourceSnapshot(context: PostSalesContext) {
  return {
    checklist_id: context.checklist.id,
    checklist_updated_at: context.checklist.updated_at,
    task_count: context.tasks.length,
    activity_count: context.activities.length,
    customer_id: context.customer?.id ?? null,
    application_id: context.application?.id ?? null,
    contract_id: context.contract?.id ?? null,
    lead_id: context.lead?.id ?? null,
    reservation_id: context.reservation?.id ?? null,
    payment_count: context.payments.length,
    payment_document_count: context.paymentDocuments.length,
    payment_request_count: context.paymentRequests.length,
    payment_allocation_count: context.paymentAllocations.length,
    generated_from: "post-sales-smart-summary-phase-4d-2",
  };
}

function readinessFor(checklist: Record<string, unknown>, blockers: string[], missing: string[]) {
  if (String(checklist.status) === "completed") return "completed";
  if (String(checklist.status) === "blocked" || blockers.length >= 3) return "blocked";
  if (String(checklist.document_status) === "missing_documents") return "missing_documents";
  if (String(checklist.agreement_status) === "ready_for_review") return "agreement_review";
  if (String(checklist.agreement_status) === "sent_for_signature") return "signature_pending";
  if (String(checklist.payment_setup_status) === "pending") return "payment_setup_pending";
  if (String(checklist.collections_handoff_status) === "ready") return "collections_ready";
  if (
    String(checklist.document_status) === "complete" &&
    String(checklist.agreement_status) === "signed" &&
    ["ready", "active"].includes(String(checklist.payment_setup_status))
  ) return "ready";
  if (String(checklist.status) === "not_started") return "not_started";
  if (missing.length) return "in_progress";
  if (String(checklist.status) === "in_progress") return "in_progress";
  return "unknown";
}

function nextBestAction(checklist: Record<string, unknown>, actions: string[]) {
  if (actions.length) return actions[0];
  if (String(checklist.status) === "completed") return "No active post-sales action is recommended unless staff needs to review history.";
  return "Review checklist status, task list, and handoff readiness.";
}

function isBeforeToday(value: unknown) {
  const date = parseDate(value);
  if (!date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

function parseDate(value: unknown) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
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

function numberOrNull(value: unknown) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function stringOrNull(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function resolvedResult<T>(data: T) {
  return Promise.resolve({ data, error: null });
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders,
  });
}
