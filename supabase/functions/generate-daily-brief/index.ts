import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type BriefOutput = {
  summary: string;
  applications_summary: string;
  lots_summary: string;
  payments_summary: string;
  contracts_summary: string;
  collections_summary: string;
  alerts: Array<Record<string, unknown> | string>;
  recommended_actions: Array<Record<string, unknown> | string>;
};

type CurrentIssue = {
  source_type: string;
  source_key: string;
  title: string;
  details: string;
  severity: "Info" | "Amber" | "Red";
  related_table: string | null;
  related_record_id: string | null;
};

type OperationalData = {
  periodStart: Date;
  periodEnd: Date;
  applications: Record<string, unknown>[];
  customers: Record<string, unknown>[];
  lots: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  paymentDocuments: Record<string, unknown>[];
  contracts: Record<string, unknown>[];
  paymentRequests: Record<string, unknown>[];
  leads: Record<string, unknown>[];
  followUps: Record<string, unknown>[];
  siteVisits: Record<string, unknown>[];
  reservations: Record<string, unknown>[];
  postSalesChecklists: Record<string, unknown>[];
  postSalesTasks: Record<string, unknown>[];
  actionItems: Record<string, unknown>[];
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
    return json({ error: "Only Super Admin or Admin users can generate daily briefs." }, 403);
  }

  const body = await request.json().catch(() => null) as { period_start?: string; period_end?: string } | null;
  const period = parsePeriod(body?.period_start, body?.period_end);
  if (!period.ok) {
    return json({ error: period.error }, 400);
  }
  const { periodStart, periodEnd } = period;

  const [
    applicationsResult,
    customersResult,
    lotsResult,
    paymentsResult,
    paymentDocumentsResult,
    contractsResult,
    requestsResult,
    leadsResult,
    followUpsResult,
    siteVisitsResult,
    reservationsResult,
    postSalesChecklistsResult,
    postSalesTasksResult,
    actionItemsResult,
    settingsResult,
  ] = await Promise.all([
    supabase
      .from("applications")
      .select("*, parcels(id, lot_number, status), application_ai_reviews(*)")
      .order("created_at", { ascending: false }),
    supabase
      .from("customers")
      .select("id, first_name, last_name, created_at, updated_at")
      .order("updated_at", { ascending: false }),
    supabase
      .from("parcels")
      .select("id, lot_number, dimensions, zoning, status, base_price, created_at, updated_at")
      .order("lot_number", { ascending: true }),
    supabase
      .from("transactions")
      .select("*, customers(first_name, last_name), contracts(parcels(lot_number)), payment_documents(id, document_type)")
      .order("created_at", { ascending: false }),
    supabase
      .from("payment_documents")
      .select("id, transaction_id, document_type, file_path, uploaded_by, created_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("contracts")
      .select("*, customers(first_name, last_name), parcels(lot_number), transactions(amount, transaction_type, created_at)")
      .order("created_at", { ascending: false }),
    supabase
      .from("payment_requests")
      .select("*, customers(first_name, last_name)")
      .order("due_date", { ascending: true }),
    supabase
      .from("leads")
      .select("*, parcels(id, lot_number, status)")
      .order("updated_at", { ascending: false }),
    supabase
      .from("follow_up_tasks")
      .select("*")
      .order("due_at", { ascending: true, nullsFirst: false }),
    supabase
      .from("site_visits")
      .select("*")
      .order("scheduled_at", { ascending: true }),
    supabase
      .from("lot_reservations")
      .select("*, parcels(id, lot_number, status)")
      .order("updated_at", { ascending: false }),
    supabase
      .from("post_sales_checklists")
      .select("*")
      .order("updated_at", { ascending: false }),
    supabase
      .from("post_sales_tasks")
      .select("*")
      .order("due_at", { ascending: true, nullsFirst: false }),
    supabase
      .from("brief_action_items")
      .select("*")
      .order("last_seen_on", { ascending: false }),
    supabase
      .from("ai_settings")
      .select("*")
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  const firstError = applicationsResult.error ??
    customersResult.error ??
    lotsResult.error ??
    paymentsResult.error ??
    paymentDocumentsResult.error ??
    contractsResult.error ??
    requestsResult.error ??
    leadsResult.error ??
    followUpsResult.error ??
    siteVisitsResult.error ??
    reservationsResult.error ??
    postSalesChecklistsResult.error ??
    postSalesTasksResult.error ??
    actionItemsResult.error ??
    settingsResult.error;
  if (firstError) {
    return json({ error: firstError.message }, 500);
  }

  const operationalData: OperationalData = {
    periodStart,
    periodEnd,
    applications: applicationsResult.data ?? [],
    customers: customersResult.data ?? [],
    lots: lotsResult.data ?? [],
    payments: paymentsResult.data ?? [],
    paymentDocuments: paymentDocumentsResult.data ?? [],
    contracts: contractsResult.data ?? [],
    paymentRequests: requestsResult.data ?? [],
    leads: leadsResult.data ?? [],
    followUps: followUpsResult.data ?? [],
    siteVisits: siteVisitsResult.data ?? [],
    reservations: reservationsResult.data ?? [],
    postSalesChecklists: postSalesChecklistsResult.data ?? [],
    postSalesTasks: postSalesTasksResult.data ?? [],
    actionItems: actionItemsResult.data ?? [],
  };

  const currentIssues = buildCurrentIssues(operationalData);
  const deterministic = buildDeterministicBrief(operationalData, currentIssues);
  const settings = settingsResult.data;
  const apiKey = Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GOOGLE_API_KEY") ?? "";
  const model = String(settings?.model ?? "gemini-3.1-flash-lite");
  const canUseGemini = Boolean(
    settings?.is_enabled &&
    settings?.daily_brief_enabled &&
    settings?.provider === "Gemini" &&
    apiKey,
  );

  let brief = deterministic;
  let usedModel = "deterministic-fallback";

  if (canUseGemini) {
    const geminiBrief = await generateGeminiBrief({
      data: summarizeForPrompt(operationalData),
      deterministic,
      apiKey,
      model,
    });
    if (geminiBrief) {
      brief = withSourceActions(geminiBrief, currentIssues);
      usedModel = model;
    }
  }

  const { data: savedBrief, error: saveError } = await supabase
    .from("ai_daily_briefs")
    .insert({
      brief_date: isoDate(periodStart),
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      summary: brief.summary,
      applications_summary: brief.applications_summary,
      lots_summary: brief.lots_summary,
      payments_summary: brief.payments_summary,
      contracts_summary: brief.contracts_summary,
      collections_summary: brief.collections_summary,
      alerts: brief.alerts,
      recommended_actions: brief.recommended_actions,
      model: usedModel,
      status: "Generated",
      generated_by: currentUserData.user.id,
    })
    .select("*")
    .single();

  if (saveError) {
    return json({ error: saveError.message }, 500);
  }

  const actionItems = await syncBriefActionItems(supabase, savedBrief, currentIssues);

  return json({
    brief: savedBrief,
    action_items: actionItems,
    fallback: usedModel === "deterministic-fallback",
    message: usedModel === "deterministic-fallback"
      ? "Daily brief generated with deterministic fallback."
      : "Daily brief generated with Gemini.",
  });
});

function parsePeriod(periodStartInput?: string, periodEndInput?: string) {
  if (periodStartInput || periodEndInput) {
    const start = periodStartInput ? startOfDay(new Date(periodStartInput)) : startOfDay(new Date());
    const end = periodEndInput ? endOfDay(new Date(periodEndInput)) : endOfDay(start);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return { ok: false as const, error: "Invalid period_start or period_end." };
    }
    return { ok: true as const, periodStart: start, periodEnd: end };
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const periodStart = startOfDay(yesterday);
  return { ok: true as const, periodStart, periodEnd: endOfDay(periodStart) };
}

function buildDeterministicBrief(data: OperationalData, currentIssues: CurrentIssue[]): BriefOutput {
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 7);

  const periodApplications = data.applications.filter((row) => inPeriod(row.created_at, data.periodStart, data.periodEnd));
  const periodUpdatedApplications = data.applications.filter((row) => updatedInPeriod(row, data.periodStart, data.periodEnd));
  const periodCustomers = data.customers.filter((row) => inPeriod(row.created_at, data.periodStart, data.periodEnd));
  const periodUpdatedCustomers = data.customers.filter((row) => updatedInPeriod(row, data.periodStart, data.periodEnd));
  const pendingApplications = data.applications.filter((row) => row.status === "Pending Review");
  const incompleteApplications = data.applications.filter((row) => missingApplicationFields(row).length > 0);
  const flaggedReviews = data.applications.filter((row) => {
    const review = firstReview(row.application_ai_reviews);
    return ["Missing Information", "Needs Review", "Lot Conflict"].includes(String(review?.completeness_status ?? ""));
  });
  const lotInterest = buildLotInterest(data.applications, data.lots);
  const conflictApplications = data.applications.filter((row) => row.status === "Pending Review" && applicationHasUnavailableLot(row, data.lots));
  const approvedWithoutPostSales = data.applications.filter((row) =>
    row.status === "Approved" && !data.postSalesChecklists.some((checklist) => Number(checklist.application_id) === Number(row.id))
  );

  const availableLots = data.lots.filter((lot) => lot.status === "Available");
  const reservedLots = data.lots.filter((lot) => lot.status === "Reserved");
  const soldLots = data.lots.filter((lot) => lot.status === "Sold");
  const recentlyUpdatedLots = data.lots.filter((lot) => inPeriod(lot.updated_at, data.periodStart, data.periodEnd));

  const periodPayments = data.payments.filter((row) => inPeriod(row.created_at, data.periodStart, data.periodEnd));
  const periodPaymentDocuments = data.paymentDocuments.filter((row) => inPeriod(row.created_at, data.periodStart, data.periodEnd));
  const collected = sum(periodPayments, "amount");
  const cashTotal = sum(periodPayments.filter((row) => row.collection_method === "Cash"), "amount");
  const transferTotal = sum(periodPayments.filter((row) => ["Online Transfer", "Bank Transfer"].includes(String(row.collection_method))), "amount");
  const missingReceipts = data.payments.filter((row) => !row.manual_receipt_number);
  const missingProof = data.payments.filter((row) => ["Online Transfer", "Bank Transfer"].includes(String(row.collection_method)) && !relationArray(row.payment_documents).length);
  const duplicateRefs = duplicateBankReferences(data.payments);
  const incompletePayments = data.payments.filter((row) => !row.manual_receipt_number || (["Online Transfer", "Bank Transfer"].includes(String(row.collection_method)) && !row.bank_reference));

  const periodContracts = data.contracts.filter((row) => inPeriod(row.created_at, data.periodStart, data.periodEnd));
  const periodUpdatedContracts = data.contracts.filter((row) => updatedInPeriod(row, data.periodStart, data.periodEnd));
  const activeContracts = data.contracts.filter((row) => Boolean(row.is_active));
  const missingSignedContracts = activeContracts.filter((row) => !row.signed_contract_file_path);
  const incompleteContracts = data.contracts.filter((row) => !row.customer_id || !row.parcel_id || !row.start_date || !row.payment_due_day);
  const startingSoon = data.contracts.filter((row) => daysFromToday(String(row.start_date)) >= 0 && daysFromToday(String(row.start_date)) <= 7);
  const noRecentPayment = activeContracts.filter((row) => !hasRecentPayment(row, 45));

  const dueRows = activeContracts.map((contract) => ({ contract, dueDate: dueDateForCurrentCycle(contract, today) }));
  const dueToday = dueRows.filter((row) => isSameDay(row.dueDate, today));
  const dueThisWeek = dueRows.filter((row) => row.dueDate > today && row.dueDate <= weekEnd);
  const overdue = dueRows.filter((row) => row.dueDate < today && outstandingBalance(row.contract) > 0);
  const outstanding = activeContracts.reduce((total, contract) => total + outstandingBalance(contract), 0);
  const openPaymentRequests = data.paymentRequests.filter((row) => ["Draft", "Sent"].includes(String(row.status)));
  const periodPaymentRequests = data.paymentRequests.filter((row) => inPeriod(row.created_at, data.periodStart, data.periodEnd));
  const periodUpdatedPaymentRequests = data.paymentRequests.filter((row) => updatedInPeriod(row, data.periodStart, data.periodEnd));
  const overduePaymentRequests = openPaymentRequests.filter((row) => isBefore(row.due_date, today));

  const periodLeads = data.leads.filter((row) => inPeriod(row.created_at, data.periodStart, data.periodEnd));
  const periodUpdatedLeads = data.leads.filter((row) => updatedInPeriod(row, data.periodStart, data.periodEnd));
  const periodPublicApplicationLeads = periodLeads.filter((row) => row.source === "Public Application Form");
  const assignedLeads = data.leads.filter((row) => Boolean(row.assigned_to));
  const unassignedLeads = data.leads.filter((row) => !row.assigned_to && !["closed_won", "lost_inactive"].includes(String(row.pipeline_stage)));
  const leadsByStage = countBy(data.leads, "pipeline_stage");
  const leadsNeedingFollowUp = data.leads.filter((row) =>
    !["closed_won", "lost_inactive"].includes(String(row.pipeline_stage)) && Boolean(row.next_action)
  );
  const overdueLeadNextActions = data.leads.filter((row) =>
    !["closed_won", "lost_inactive"].includes(String(row.pipeline_stage)) && isBefore(row.next_action_due_at, today)
  );
  const familyDecisionLeads = data.leads.filter((row) => row.pipeline_stage === "family_decision");
  const paymentPlanReviewLeads = data.leads.filter((row) => row.pipeline_stage === "payment_plan_review");
  const depositPendingLeads = data.leads.filter((row) => row.pipeline_stage === "deposit_pending");

  const openFollowUps = data.followUps.filter((row) => ["open", "in_progress"].includes(String(row.status)));
  const dueTodayFollowUps = openFollowUps.filter((row) => isWithin(row.due_at, today, tomorrow));
  const overdueFollowUps = openFollowUps.filter((row) => isBefore(row.due_at, today));
  const completedFollowUps = data.followUps.filter((row) => row.status === "completed" && inPeriod(row.completed_at ?? row.updated_at, data.periodStart, data.periodEnd));
  const urgentFollowUps = openFollowUps.filter((row) => ["high", "urgent"].includes(String(row.priority)));

  const openSiteVisits = data.siteVisits.filter((row) => ["scheduled", "rescheduled"].includes(String(row.status)));
  const siteVisitsToday = openSiteVisits.filter((row) => isWithin(row.scheduled_at, today, tomorrow));
  const upcomingSiteVisits = openSiteVisits.filter((row) => isWithin(row.scheduled_at, today, weekEnd));
  const completedSiteVisits = data.siteVisits.filter((row) => row.status === "completed" && inPeriod(row.completed_at ?? row.updated_at, data.periodStart, data.periodEnd));
  const missedSiteVisits = data.siteVisits.filter((row) => ["no_show", "cancelled"].includes(String(row.status)) && inPeriod(row.updated_at, data.periodStart, data.periodEnd));

  const activeReservations = data.reservations.filter((row) => activeReservationStatuses().has(String(row.status)));
  const periodReservations = data.reservations.filter((row) => inPeriod(row.created_at, data.periodStart, data.periodEnd));
  const expiringSoonReservations = activeReservations.filter((row) => isWithinInclusive(row.expires_at, today, addDays(today, 3)));
  const expiredReservations = activeReservations.filter((row) => isBefore(row.expires_at, today));
  const releasedCancelledReservations = data.reservations.filter((row) => ["released", "cancelled"].includes(String(row.status)) && inPeriod(row.updated_at, data.periodStart, data.periodEnd));

  const depositPendingReservations = activeReservations.filter((row) => row.deposit_status === "pending" || row.status === "deposit_pending");
  const depositOverdueReservations = activeReservations.filter((row) =>
    row.deposit_status === "overdue" || (row.deposit_status === "pending" && isBefore(row.deposit_due_at, today))
  );
  const proofSubmittedReservations = activeReservations.filter((row) => row.deposit_status === "proof_submitted");
  const depositConfirmedReservations = activeReservations.filter((row) => row.deposit_status === "confirmed" || row.status === "deposit_confirmed");
  const readyNextStepReservations = depositConfirmedReservations.filter((row) => !row.converted_application_id && !row.converted_contract_id);

  const openPostSalesTasks = data.postSalesTasks.filter((row) => ["open", "in_progress", "blocked"].includes(String(row.status)));
  const overduePostSalesTasks = openPostSalesTasks.filter((row) => isBefore(row.due_at, today));
  const blockedPostSalesChecklists = data.postSalesChecklists.filter((row) => row.status === "blocked");
  const agreementsReady = data.postSalesChecklists.filter((row) => ["ready_for_review", "sent_for_signature"].includes(String(row.agreement_status)));
  const documentsPending = data.postSalesChecklists.filter((row) => ["missing_documents", "pending_review"].includes(String(row.document_status)));
  const paymentSetupPending = data.postSalesChecklists.filter((row) => row.payment_setup_status === "pending");
  const handoffReady = data.postSalesChecklists.filter((row) => row.collections_handoff_status === "ready");
  const currentIssueKeys = new Set(currentIssues.map((issue) => issue.source_key));
  const existingOpenIssues = data.actionItems.filter((item) =>
    ["Open", "In Progress"].includes(String(item.status)) && isManagedSourceKey(item.source_key)
  );
  const existingOpenKeys = new Set(existingOpenIssues.map((item) => String(item.source_key)));
  const newIssues = currentIssues.filter((issue) => !existingOpenKeys.has(issue.source_key));
  const repeatedIssues = currentIssues.filter((issue) => existingOpenKeys.has(issue.source_key));
  const resolvedIssues = existingOpenIssues.filter((item) => !currentIssueKeys.has(String(item.source_key)));

  const alerts: BriefOutput["alerts"] = [];
  const recommendedActions: BriefOutput["recommended_actions"] = [];

  alerts.push(section("Activity During Period", [
    `${periodApplications.length} new applications/leads and ${periodUpdatedApplications.length} updated applications/leads.`,
    `${periodLeads.length} new CRM leads, including ${periodPublicApplicationLeads.length} created from public applications, and ${periodUpdatedLeads.length} updated CRM leads.`,
    `${periodCustomers.length} customers created and ${periodUpdatedCustomers.length} customers updated.`,
    `${periodContracts.length} contracts created and ${periodUpdatedContracts.length} contracts updated.`,
    `${periodPayments.length} payments logged, ${periodPaymentDocuments.length} payment documents uploaded, ${periodPaymentRequests.length} payment requests created, and ${periodUpdatedPaymentRequests.length} payment requests updated.`,
    `${recentlyUpdatedLots.length} lots updated during the period.`,
  ].join(" ")));
  alerts.push(section("Current Snapshot", [
    `${data.lots.length} total lots: ${availableLots.length} available, ${reservedLots.length} reserved, ${soldLots.length} sold.`,
    `${pendingApplications.length} pending applications/leads. ${leadsNeedingFollowUp.length} leads need staff follow-up, including ${overdueLeadNextActions.length} overdue follow-ups.`,
    `${activeContracts.length} active contracts across ${new Set(activeContracts.map((row) => row.customer_id).filter(Boolean)).size} customers.`,
    `Outstanding land balance is ${money(outstanding)}.`,
    `${openPaymentRequests.length} open payment requests.`,
    `${missingReceipts.length} payments missing manual receipt numbers.`,
    `${missingProof.length} transfer payments missing proof.`,
    `${missingSignedContracts.length} contracts missing signed uploads.`,
  ].join(" ")));
  alerts.push(section("Open Items / Carryover", `${currentIssues.length} current source-backed issues remain open after rechecking source records. ${missingReceipts.length} missing receipt numbers, ${missingProof.length} missing transfer proof, ${missingSignedContracts.length} missing signed contracts, ${conflictApplications.length} unavailable preferred lots, ${overdue.length} overdue accounts, and ${openPaymentRequests.length} open payment requests.`));
  alerts.push(section("Compared to Previous Brief", `${newIssues.length} new source-backed issues, ${repeatedIssues.length} repeated unresolved issues, and ${resolvedIssues.length} issues appear resolved from source records. Payment total for this period is ${money(collected)}. Outstanding land balance is ${money(outstanding)}. Lot status snapshot: ${availableLots.length} available, ${reservedLots.length} reserved, ${soldLots.length} sold. Applications/leads: ${periodApplications.length} new applications/leads and ${periodUpdatedApplications.length} updated applications/leads.`));
  alerts.push(section("Sales Activity", `${periodLeads.length} new leads in the period, including ${periodPublicApplicationLeads.length} from public applications. ${assignedLeads.length} assigned leads and ${unassignedLeads.length} unassigned active leads. Pipeline stages: ${formatCounts(leadsByStage)}. ${leadsNeedingFollowUp.length} leads need follow-up and ${overdueLeadNextActions.length} leads have overdue next actions. ${familyDecisionLeads.length} family decision, ${paymentPlanReviewLeads.length} payment plan review, and ${depositPendingLeads.length} deposit pending leads.`));
  alerts.push(section("Buyer Follow-ups", `${dueTodayFollowUps.length} follow-ups due today. ${overdueFollowUps.length} overdue follow-ups. ${completedFollowUps.length} completed during the period. ${urgentFollowUps.length} high or urgent open follow-ups.`));
  alerts.push(section("Site Visits", `${siteVisitsToday.length} site visits today. ${upcomingSiteVisits.length} upcoming visits in the next 7 days. ${completedSiteVisits.length} completed during the period. ${missedSiteVisits.length} no-show or cancelled visits during the period.`));
  alerts.push(section("Reservation Readiness", `${activeReservations.length} active reservations. ${periodReservations.length} new reservations in the period. ${expiringSoonReservations.length} expiring within 3 days. ${expiredReservations.length} active reservations past expiry. ${releasedCancelledReservations.length} released or cancelled during the period.`));
  alerts.push(section("Deposit Readiness", `${depositPendingReservations.length} deposit pending. ${depositOverdueReservations.length} deposit overdue. ${proofSubmittedReservations.length} proof submitted. ${depositConfirmedReservations.length} deposit confirmed. ${readyNextStepReservations.length} reservations may be ready for application or contract next step.`));
  alerts.push(section("Post-Sales Blockers", `${openPostSalesTasks.length} open post-sales tasks. ${overduePostSalesTasks.length} overdue post-sales tasks. ${blockedPostSalesChecklists.length} blocked checklists. ${agreementsReady.length} agreements ready for review or signature. ${documentsPending.length} documents missing or pending review. ${paymentSetupPending.length} payment setups pending.`));
  alerts.push(section("Collections Handoff", `${handoffReady.length} customers are ready for collections handoff. ${overdue.length} active contracts appear overdue. ${overduePaymentRequests.length} open payment requests are past due.`));

  if (flaggedReviews.length) alerts.push(alert("amber", "Applications need review", `${flaggedReviews.length} applications have AI review flags.`));
  if (lotInterest.filter((row) => row.count > 1).length) alerts.push(alert("amber", "Lot interest conflicts", `${lotInterest.filter((row) => row.count > 1).length} lots have multiple applicant interest.`));
  if (conflictApplications.length) alerts.push(alert("red", "Unavailable preferred lots", `${conflictApplications.length} applications selected reserved or sold lots.`));
  if (missingReceipts.length) alerts.push(alert("amber", "Missing receipt numbers", `${missingReceipts.length} payments need manual receipt numbers.`));
  if (missingProof.length) alerts.push(alert("amber", "Missing transfer proof", `${missingProof.length} transfer payments need uploaded proof.`));
  if (missingSignedContracts.length) alerts.push(alert("amber", "Missing signed contracts", `${missingSignedContracts.length} contracts are missing signed uploads.`));
  if (overdue.length) alerts.push(alert("red", "Overdue accounts", `${overdue.length} active contracts appear overdue.`));
  if (overdueFollowUps.length) alerts.push(alert("red", "Overdue buyer follow-ups", `${overdueFollowUps.length} sales follow-up tasks are overdue.`));
  if (expiringSoonReservations.length) alerts.push(alert("amber", "Reservations expiring soon", `${expiringSoonReservations.length} active reservations expire within 3 days.`));
  if (depositOverdueReservations.length) alerts.push(alert("red", "Deposits overdue", `${depositOverdueReservations.length} active reservations have overdue deposit readiness.`));
  if (proofSubmittedReservations.length) alerts.push(alert("amber", "Deposit proof submitted", `${proofSubmittedReservations.length} deposits have proof submitted for review.`));
  if (overduePostSalesTasks.length) alerts.push(alert("red", "Post-sales tasks overdue", `${overduePostSalesTasks.length} post-sales tasks are overdue.`));
  if (documentsPending.length) alerts.push(alert("amber", "Post-sales documents pending", `${documentsPending.length} checklists have missing or pending documents.`));
  if (handoffReady.length) alerts.push(alert("amber", "Collections handoff ready", `${handoffReady.length} customers are ready for collections handoff.`));

  overdueFollowUps.slice(0, 5).forEach((row) => recommendedActions.push(action("Follow up on overdue lead task", String(row.title ?? "Sales follow-up task"), "follow_up_task", row.id)));
  urgentFollowUps.slice(0, 5).forEach((row) => recommendedActions.push(action("Review high-priority buyer follow-up", String(row.title ?? "Sales follow-up task"), "follow_up_task", row.id)));
  expiringSoonReservations.slice(0, 5).forEach((row) => recommendedActions.push(action("Review reservation expiring soon", reservationLabel(row), "reservation", row.id)));
  expiredReservations.slice(0, 5).forEach((row) => recommendedActions.push(action("Review expired active reservation", reservationLabel(row), "reservation", row.id)));
  depositOverdueReservations.slice(0, 5).forEach((row) => recommendedActions.push(action("Review overdue deposit readiness", reservationLabel(row), "reservation", row.id)));
  proofSubmittedReservations.slice(0, 5).forEach((row) => recommendedActions.push(action("Review deposit proof submission", reservationLabel(row), "reservation", row.id)));
  overduePostSalesTasks.slice(0, 5).forEach((row) => recommendedActions.push(action("Review overdue post-sales task", String(row.title ?? "Post-sales task"), "post_sales_task", row.id)));
  documentsPending.slice(0, 5).forEach((row) => recommendedActions.push(action("Request or review post-sales documents", `Checklist #${row.id}`, "post_sales_checklist", row.id)));
  handoffReady.slice(0, 5).forEach((row) => recommendedActions.push(action("Hand off ready customer to collections", `Checklist #${row.id}`, "post_sales_checklist", row.id)));
  overduePaymentRequests.slice(0, 5).forEach((row) => recommendedActions.push(action("Review overdue payment request", `${customerName(row.customers)} request #${row.id}`, "payment_request", row.id)));
  approvedWithoutPostSales.slice(0, 5).forEach((row) => recommendedActions.push(action("Start post-sales checklist when ready", applicantName(row), "application", row.id)));
  pendingApplications.slice(0, 5).forEach((row) => recommendedActions.push(action("Review pending application", applicantName(row), "application", row.id)));
  incompleteApplications.slice(0, 5).forEach((row) => recommendedActions.push(action("Request missing application information", `${applicantName(row)}: ${missingApplicationFields(row).join(", ")}`, "application", row.id)));
  conflictApplications.slice(0, 5).forEach((row) => recommendedActions.push(action("Resolve preferred lot conflict", applicantName(row), "application", row.id)));
  missingReceipts.slice(0, 5).forEach((row) => recommendedActions.push(action("Enter manual receipt number", `${customerName(row.customers)} payment #${row.id}`, "payment", row.id)));
  missingProof.slice(0, 5).forEach((row) => recommendedActions.push(action("Upload or confirm transfer proof", `${customerName(row.customers)} payment #${row.id}`, "payment", row.id)));
  missingSignedContracts.slice(0, 5).forEach((row) => recommendedActions.push(action("Upload signed contract", `${customerName(row.customers)} contract #${row.id}`, "contract", row.id)));
  overdue.slice(0, 5).forEach(({ contract }) => recommendedActions.push(action("Contact overdue customer", `${customerName(contract.customers)} on Lot ${nestedLot(contract)}`, "customer", contract.customer_id)));
  currentIssues.forEach((issue) => recommendedActions.push(action(issue.title, issue.details, issue.related_table ?? issue.source_type, issue.related_record_id, issue.source_key)));

  if (!alerts.filter((item) => !isSection(item)).length) alerts.push(alert("green", "No urgent alerts", "No urgent operational alerts were detected from the available records."));
  if (!recommendedActions.length) recommendedActions.push(action("Monitor operations", "No immediate manual follow-up was detected for this period.", "brief"));

  return {
    summary: `${periodApplications.length} new applications/leads, ${periodUpdatedApplications.length} updated applications/leads, ${periodLeads.length} new CRM leads (${periodPublicApplicationLeads.length} from public applications), ${periodPayments.length} payments totaling ${money(collected)}, and ${periodContracts.length} new contracts were recorded for the selected period. Current snapshot shows ${leadsNeedingFollowUp.length} leads needing follow-up and ${currentIssues.length} source-backed open items, including ${newIssues.length} new and ${repeatedIssues.length} repeated unresolved issues.`,
    applications_summary: `${periodApplications.length} new applications/leads. ${periodUpdatedApplications.length} applications/leads updated during the period. ${pendingApplications.length} pending applications/leads. ${incompleteApplications.length} applications are missing key information. ${flaggedReviews.length} applications have AI review flags. ${lotInterest.filter((row) => row.count > 1).length} lots have multiple applicant interest. ${conflictApplications.length} active applications selected unavailable lots. ${approvedWithoutPostSales.length} approved applications do not have a linked post-sales checklist.`,
    lots_summary: `${data.lots.length} total lots: ${availableLots.length} available, ${reservedLots.length} reserved, ${soldLots.length} sold. ${recentlyUpdatedLots.length} lots were updated during the period. ${lotInterest.filter((row) => row.count > 1).length} lots have multiple applicant interest. Reservations: ${activeReservations.length} active, ${expiringSoonReservations.length} expiring soon, ${expiredReservations.length} needing expiry review.`,
    payments_summary: `${periodPayments.length} payments logged during the period. Total collected: ${money(collected)}. Cash: ${money(cashTotal)}. Transfers: ${money(transferTotal)}. ${missingReceipts.length} payments are missing manual receipt numbers. ${missingProof.length} transfer payments are missing uploaded proof. ${duplicateRefs.length} duplicate bank references were detected. ${incompletePayments.length} payments look incomplete.`,
    contracts_summary: `${periodContracts.length} new contracts. ${activeContracts.length} active contracts. ${missingSignedContracts.length} contracts are missing signed uploads. ${incompleteContracts.length} contracts have incomplete fields. ${startingSoon.length} contracts start within 7 days. ${noRecentPayment.length} active contracts have no payment in the last 45 days. Post-sales: ${openPostSalesTasks.length} open tasks, ${overduePostSalesTasks.length} overdue tasks, ${blockedPostSalesChecklists.length} blocked checklists.`,
    collections_summary: `${dueToday.length} customers due today. ${dueThisWeek.length} customers due this week. ${overdue.length} overdue accounts detected. Outstanding land balance is ${money(outstanding)}. ${openPaymentRequests.length} open payment requests, including ${overduePaymentRequests.length} overdue. ${missingReceipts.length} customers/payments have missing receipt numbers. ${missingProof.length} payments are missing proof. ${handoffReady.length} post-sales records are ready for collections handoff.`,
    alerts,
    recommended_actions: recommendedActions,
  };
}

async function generateGeminiBrief({
  data,
  deterministic,
  apiKey,
  model,
}: {
  data: Record<string, unknown>;
  deterministic: BriefOutput;
  apiKey: string;
  model: string;
}): Promise<BriefOutput | null> {
  const prompt = [
    "You are a read-only daily operations brief assistant for Wamule Development.",
    "Summarize only the supplied system data. Do not approve applications, reserve lots, create customers, create contracts, log payments, send email, or update records.",
    "Return only valid JSON with keys: summary, applications_summary, lots_summary, payments_summary, contracts_summary, collections_summary, alerts, recommended_actions.",
    "alerts and recommended_actions must be arrays. Preserve any alert objects with kind='section' from the deterministic baseline so the UI can render expanded operating sections. Keep tone professional, clear, operational, concise, and action-oriented.",
    "",
    `Deterministic baseline: ${JSON.stringify(deterministic)}`,
    `Operational data: ${JSON.stringify(data)}`,
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
            maxOutputTokens: 1400,
            responseMimeType: "application/json",
          },
        }),
      },
    );

    if (!response.ok) return null;
    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    return sanitizeBrief(JSON.parse(text), deterministic);
  } catch {
    return null;
  }
}

function sanitizeBrief(value: Partial<BriefOutput>, fallback: BriefOutput): BriefOutput {
  return {
    summary: cleanText(value.summary, fallback.summary),
    applications_summary: cleanText(value.applications_summary, fallback.applications_summary),
    lots_summary: cleanText(value.lots_summary, fallback.lots_summary),
    payments_summary: cleanText(value.payments_summary, fallback.payments_summary),
    contracts_summary: cleanText(value.contracts_summary, fallback.contracts_summary),
    collections_summary: cleanText(value.collections_summary, fallback.collections_summary),
    alerts: mergeSectionItems(cleanArray(value.alerts, fallback.alerts), fallback.alerts),
    recommended_actions: cleanArray(value.recommended_actions, fallback.recommended_actions),
  };
}

function summarizeForPrompt(data: OperationalData) {
  const brief = buildDeterministicBrief(data, buildCurrentIssues(data));
  return {
    period_start: data.periodStart.toISOString(),
    period_end: data.periodEnd.toISOString(),
    counts: {
      applications: data.applications.length,
      lots: data.lots.length,
      payments: data.payments.length,
      contracts: data.contracts.length,
      payment_requests: data.paymentRequests.length,
      leads: data.leads.length,
      follow_ups: data.followUps.length,
      site_visits: data.siteVisits.length,
      reservations: data.reservations.length,
      post_sales_checklists: data.postSalesChecklists.length,
      post_sales_tasks: data.postSalesTasks.length,
    },
    deterministic_findings: brief,
  };
}

function buildCurrentIssues(data: OperationalData): CurrentIssue[] {
  const today = startOfDay(new Date());
  const issues: CurrentIssue[] = [];
  const activeContracts = data.contracts.filter((row) => Boolean(row.is_active));
  const activeApplications = data.applications.filter((row) => row.status === "Pending Review");
  const lotsById = new Map(data.lots.map((lot) => [Number(lot.id), lot]));

  data.payments
    .filter((row) => !String(row.manual_receipt_number ?? "").trim())
    .forEach((row) => issues.push({
      source_type: "Missing receipt numbers",
      source_key: `missing-receipt-number:transaction:${row.id}`,
      title: "Enter manual receipt number",
      details: `${customerName(row.customers)} payment #${row.id}`,
      severity: "Amber",
      related_table: "transactions",
      related_record_id: stringId(row.id),
    }));

  data.payments
    .filter((row) => ["Online Transfer", "Bank Transfer"].includes(String(row.collection_method)) && !relationArray(row.payment_documents).length)
    .forEach((row) => issues.push({
      source_type: "Missing transfer proof",
      source_key: `missing-proof:transaction:${row.id}`,
      title: "Upload or confirm transfer proof",
      details: `${customerName(row.customers)} payment #${row.id}`,
      severity: "Amber",
      related_table: "transactions",
      related_record_id: stringId(row.id),
    }));

  activeContracts
    .filter((row) => !String(row.signed_contract_file_path ?? "").trim())
    .forEach((row) => issues.push({
      source_type: "Missing signed contracts",
      source_key: `missing-signed-contract:contract:${row.id}`,
      title: "Upload signed contract",
      details: `${customerName(row.customers)} contract #${row.id}`,
      severity: "Amber",
      related_table: "contracts",
      related_record_id: stringId(row.id),
    }));

  activeApplications
    .filter((row) => applicationHasUnavailableLot(row, data.lots))
    .forEach((row) => issues.push({
      source_type: "Lot conflicts",
      source_key: `lot-conflict:application:${row.id}`,
      title: "Resolve unavailable preferred lot",
      details: `${applicantName(row)} selected ${preferredLotLabel(row, lotsById)}.`,
      severity: "Red",
      related_table: "applications",
      related_record_id: stringId(row.id),
    }));

  activeContracts
    .map((contract) => ({ contract, dueDate: dueDateForCurrentCycle(contract, today) }))
    .filter((row) => row.dueDate < today && outstandingBalance(row.contract) > 0)
    .forEach(({ contract }) => issues.push({
      source_type: "Overdue accounts",
      source_key: `overdue-account:customer:${contract.customer_id}:contract:${contract.id}`,
      title: "Review overdue account",
      details: `${customerName(contract.customers)} on Lot ${nestedLot(contract)} appears overdue.`,
      severity: "Red",
      related_table: "customers",
      related_record_id: stringId(contract.customer_id),
    }));

  data.paymentRequests
    .filter((row) => ["Draft", "Sent"].includes(String(row.status)))
    .forEach((row) => issues.push({
      source_type: "Open payment requests",
      source_key: `open-payment-request:payment_request:${row.id}`,
      title: "Review open payment request",
      details: `${customerName(row.customers)} request #${row.id}`,
      severity: isBefore(row.due_date, today) ? "Red" : "Info",
      related_table: "payment_requests",
      related_record_id: stringId(row.id),
    }));

  return dedupeIssues(issues);
}

function dedupeIssues(issues: CurrentIssue[]) {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (seen.has(issue.source_key)) return false;
    seen.add(issue.source_key);
    return true;
  });
}

function withSourceActions(brief: BriefOutput, issues: CurrentIssue[]): BriefOutput {
  const existingKeys = new Set(
    brief.recommended_actions
      .map((item) => typeof item === "object" && item ? String((item as Record<string, unknown>).source_key ?? "") : "")
      .filter(Boolean),
  );
  const issueActions = issues
    .filter((issue) => !existingKeys.has(issue.source_key))
    .map((issue) => action(issue.title, issue.details, issue.related_table ?? issue.source_type, issue.related_record_id, issue.source_key));
  return { ...brief, recommended_actions: [...issueActions, ...brief.recommended_actions] };
}

function missingApplicationFields(row: Record<string, unknown>) {
  const checks: Array<[string, unknown]> = [
    ["Name", row.applicant_full_name || `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim()],
    ["Phone", row.phone],
    ["Email", row.email],
    ["Address", row.applicant_address],
    ["Intended use", row.intended_use],
    ["Preferred lot", Array.isArray(row.preferred_parcel_ids) && row.preferred_parcel_ids.length ? "selected" : ""],
    ["Payment option", row.payment_option],
    ["Applicant signature", row.applicant_acknowledgement_signature],
  ];
  if (!row.legal_notice_acknowledged) checks.push(["Legal acknowledgement", ""]);
  if (!row.sustainability_terms_verified) checks.push(["Sustainability acknowledgement", ""]);
  return checks.filter(([, value]) => !String(value ?? "").trim()).map(([label]) => label);
}

function buildLotInterest(applications: Record<string, unknown>[], lots: Record<string, unknown>[]) {
  const lotById = new Map(lots.map((lot) => [Number(lot.id), String(lot.lot_number ?? lot.id)]));
  const counts = new Map<number, number>();
  applications.forEach((row) => {
    if (!Array.isArray(row.preferred_parcel_ids)) return;
    row.preferred_parcel_ids.forEach((id) => counts.set(Number(id), (counts.get(Number(id)) ?? 0) + 1));
  });
  return [...counts.entries()].map(([id, count]) => ({ id, lot_number: lotById.get(id) ?? String(id), count }));
}

function applicationHasUnavailableLot(row: Record<string, unknown>, lots: Record<string, unknown>[]) {
  if (!Array.isArray(row.preferred_parcel_ids)) return false;
  const lotById = new Map(lots.map((lot) => [Number(lot.id), lot]));
  return row.preferred_parcel_ids.some((id) => {
    const lot = lotById.get(Number(id));
    return lot && lot.status !== "Available";
  });
}

function duplicateBankReferences(payments: Record<string, unknown>[]) {
  const refs = new Map<string, number>();
  payments.forEach((row) => {
    const ref = String(row.bank_reference ?? "").trim().toUpperCase();
    if (!ref) return;
    refs.set(ref, (refs.get(ref) ?? 0) + 1);
  });
  return [...refs.entries()].filter(([, count]) => count > 1);
}

function firstReview(value: unknown) {
  return relationArray(value)[0] as Record<string, unknown> | undefined;
}

function relationArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function inPeriod(value: unknown, start: Date, end: Date) {
  const date = new Date(String(value ?? ""));
  return !Number.isNaN(date.getTime()) && date >= start && date <= end;
}

function isBefore(value: unknown, date: Date) {
  const parsed = new Date(String(value ?? ""));
  return !Number.isNaN(parsed.getTime()) && parsed < date;
}

function isWithin(value: unknown, start: Date, end: Date) {
  const parsed = new Date(String(value ?? ""));
  return !Number.isNaN(parsed.getTime()) && parsed >= start && parsed < end;
}

function isWithinInclusive(value: unknown, start: Date, end: Date) {
  const parsed = new Date(String(value ?? ""));
  return !Number.isNaN(parsed.getTime()) && parsed >= start && parsed <= end;
}

function sum(rows: Record<string, unknown>[], field: string) {
  return rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
}

function hasRecentPayment(contract: Record<string, unknown>, days: number) {
  const cutoff = addDays(new Date(), -days);
  return relationArray(contract.transactions).some((transaction) => new Date(String((transaction as Record<string, unknown>).created_at)) >= cutoff);
}

function outstandingBalance(contract: Record<string, unknown>) {
  const paid = relationArray(contract.transactions)
    .filter((transaction) => ["Down Payment", "Land Installment"].includes(String((transaction as Record<string, unknown>).transaction_type)))
    .reduce((total, transaction) => total + Number((transaction as Record<string, unknown>).amount ?? 0), 0);
  return Math.max(Number(contract.final_purchase_price ?? 0) - paid, 0);
}

function dueDateForCurrentCycle(contract: Record<string, unknown>, today: Date) {
  const day = Number(contract.payment_due_day ?? 1);
  const due = new Date(today.getFullYear(), today.getMonth(), Math.max(1, Math.min(31, day)));
  if (due < today && outstandingBalance(contract) <= 0) due.setMonth(due.getMonth() + 1);
  return due;
}

function daysFromToday(dateValue: string) {
  const date = startOfDay(new Date(dateValue));
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  return Math.ceil((date.getTime() - startOfDay(new Date()).getTime()) / 86400000);
}

function applicantName(row: Record<string, unknown>) {
  return String(row.applicant_full_name || `${row.first_name ?? ""} ${row.last_name ?? ""}`).trim() || "Unknown applicant";
}

function customerName(customer: unknown) {
  const row = customer as Record<string, unknown> | null | undefined;
  return String(`${row?.first_name ?? ""} ${row?.last_name ?? ""}`).trim() || "Unknown customer";
}

function nestedLot(contract: Record<string, unknown>) {
  return String((contract.parcels as Record<string, unknown> | null | undefined)?.lot_number ?? "N/A");
}

function action(title: string, detail: string, recordType: string, recordId?: unknown, sourceKey?: string) {
  return { title, detail, record_type: recordType, record_id: recordId ?? null, source_key: sourceKey ?? null };
}

function alert(severity: string, title: string, detail: string) {
  return { severity, title, detail };
}

function section(title: string, detail: string) {
  return { kind: "section", title, detail, severity: "info" };
}

function isSection(item: Record<string, unknown> | string) {
  return typeof item === "object" && item !== null && item.kind === "section";
}

function cleanText(value: unknown, fallback: string) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 5000) : fallback;
}

function cleanArray(value: unknown, fallback: BriefOutput["alerts"]) {
  if (!Array.isArray(value)) return fallback;
  return value.slice(0, 50).map((item) => {
    if (typeof item === "string") return item.slice(0, 1000);
    if (!item || typeof item !== "object") return String(item ?? "").slice(0, 1000);
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, entry]) => [key, String(entry ?? "").slice(0, 1000)]));
  });
}

function countBy(rows: Record<string, unknown>[], field: string) {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const key = String(row[field] ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function formatCounts(counts: Record<string, number>) {
  const entries = Object.entries(counts);
  if (!entries.length) return "none";
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${labelize(key)} ${count}`)
    .join(", ");
}

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activeReservationStatuses() {
  return new Set(["draft", "reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed"]);
}

function reservationLabel(row: Record<string, unknown>) {
  const lot = row.parcels as Record<string, unknown> | null | undefined;
  return `${String(row.reservation_code ?? "Reservation")} ${lot?.lot_number ? `- Lot ${lot.lot_number}` : ""}`.trim();
}

function money(value: number) {
  return new Intl.NumberFormat("en-BZ", { style: "currency", currency: "BZD" }).format(value);
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date: Date) {
  const end = startOfDay(date);
  end.setDate(end.getDate() + 1);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return end;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders,
  });
}

async function syncBriefActionItems(
  supabase: ReturnType<typeof createClient>,
  brief: Record<string, unknown>,
  currentIssues: CurrentIssue[],
) {
  const seenDate = String(brief.brief_date ?? isoDate(new Date()));
  const currentIssueKeys = new Set(currentIssues.map((issue) => issue.source_key));
  const { data: openExisting } = await supabase
    .from("brief_action_items")
    .select("*")
    .in("status", ["Open", "In Progress"]);

  const staleItems = (openExisting ?? []).filter((item: Record<string, unknown>) =>
    isManagedSourceKey(item.source_key) && !currentIssueKeys.has(String(item.source_key))
  );
  for (const item of staleItems) {
    await supabase
      .from("brief_action_items")
      .update({
        status: "Done",
        resolved_at: new Date().toISOString(),
        last_seen_on: seenDate,
      })
      .eq("id", item.id);
  }

  const sourceBacked = currentIssues.map((issue) => actionItemFromIssue(issue, brief, seenDate));
  const normalized = sourceBacked;

  const saved: Record<string, unknown>[] = [];
  for (const item of normalized) {
    const { data: existing } = await supabase
      .from("brief_action_items")
      .select("*")
      .eq("source_key", item.source_key)
      .in("status", ["Open", "In Progress"])
      .maybeSingle();

    if (existing?.id) {
      const { data } = await supabase
        .from("brief_action_items")
        .update({
          brief_id: brief.id,
          title: item.title,
          details: item.details,
          severity: item.severity,
          source_type: item.source_type,
          related_table: item.related_table,
          related_record_id: item.related_record_id,
          last_seen_on: seenDate,
        })
        .eq("id", existing.id)
        .select("*")
        .single();
      if (data) saved.push(data);
      continue;
    }

    const { data: previouslyClosed } = await supabase
      .from("brief_action_items")
      .select("id")
      .eq("source_key", item.source_key)
      .in("status", ["Done", "Dismissed"])
      .limit(1);
    if (previouslyClosed?.length) continue;

    const { data } = await supabase
      .from("brief_action_items")
      .insert(item)
      .select("*")
      .single();
    if (data) saved.push(data);
  }
  return saved;
}

function actionItemFromIssue(issue: CurrentIssue, brief: Record<string, unknown>, seenDate: string) {
  return {
    brief_id: brief.id,
    source_type: issue.source_type,
    source_key: issue.source_key,
    title: issue.title,
    details: issue.details,
    severity: issue.severity,
    status: "Open",
    related_table: issue.related_table,
    related_record_id: issue.related_record_id,
    first_seen_on: seenDate,
    last_seen_on: seenDate,
  };
}

function isManagedSourceKey(value: unknown) {
  const key = String(value ?? "");
  return [
    "missing-receipt-number:",
    "missing-proof:",
    "missing-signed-contract:",
    "lot-conflict:",
    "overdue-account:",
    "open-payment-request:",
  ].some((prefix) => key.startsWith(prefix));
}

function updatedInPeriod(row: Record<string, unknown>, start: Date, end: Date) {
  return inPeriod(row.updated_at, start, end) && !sameInstant(row.created_at, row.updated_at);
}

function sameInstant(a: unknown, b: unknown) {
  const first = new Date(String(a ?? ""));
  const second = new Date(String(b ?? ""));
  return !Number.isNaN(first.getTime()) && !Number.isNaN(second.getTime()) && first.getTime() === second.getTime();
}

function stringId(value: unknown) {
  return value == null ? null : String(value);
}

function preferredLotLabel(row: Record<string, unknown>, lotsById: Map<number, Record<string, unknown>>) {
  if (!Array.isArray(row.preferred_parcel_ids)) return "an unavailable lot";
  const labels = row.preferred_parcel_ids.map((id) => {
    const lot = lotsById.get(Number(id));
    return lot ? `Lot ${lot.lot_number ?? id} (${lot.status ?? "unknown"})` : `Lot ${id}`;
  });
  return labels.join(", ") || "an unavailable lot";
}

function mergeSectionItems(current: BriefOutput["alerts"], fallback: BriefOutput["alerts"]) {
  const currentSections = current.filter(isSection);
  const fallbackSections = fallback.filter(isSection);
  const currentTitles = new Set(currentSections.map((item) => String((item as Record<string, unknown>).title ?? "")));
  const missingSections = fallbackSections.filter((item) => !currentTitles.has(String((item as Record<string, unknown>).title ?? "")));
  return [...missingSections, ...current];
}
