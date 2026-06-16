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

type OperationalData = {
  periodStart: Date;
  periodEnd: Date;
  applications: Record<string, unknown>[];
  lots: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  contracts: Record<string, unknown>[];
  paymentRequests: Record<string, unknown>[];
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

  const [applicationsResult, lotsResult, paymentsResult, contractsResult, requestsResult, settingsResult] = await Promise.all([
    supabase
      .from("applications")
      .select("*, parcels(id, lot_number, status), application_ai_reviews(*)")
      .order("created_at", { ascending: false }),
    supabase
      .from("parcels")
      .select("id, lot_number, dimensions, zoning, status, base_price, created_at, updated_at")
      .order("lot_number", { ascending: true }),
    supabase
      .from("transactions")
      .select("*, customers(first_name, last_name), contracts(parcels(lot_number)), payment_documents(id, document_type)")
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
      .from("ai_settings")
      .select("*")
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  const firstError = applicationsResult.error ?? lotsResult.error ?? paymentsResult.error ?? contractsResult.error ?? requestsResult.error ?? settingsResult.error;
  if (firstError) {
    return json({ error: firstError.message }, 500);
  }

  const operationalData: OperationalData = {
    periodStart,
    periodEnd,
    applications: applicationsResult.data ?? [],
    lots: lotsResult.data ?? [],
    payments: paymentsResult.data ?? [],
    contracts: contractsResult.data ?? [],
    paymentRequests: requestsResult.data ?? [],
  };

  const deterministic = buildDeterministicBrief(operationalData);
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
      brief = geminiBrief;
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

  return json({
    brief: savedBrief,
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

function buildDeterministicBrief(data: OperationalData): BriefOutput {
  const periodApplications = data.applications.filter((row) => inPeriod(row.created_at, data.periodStart, data.periodEnd));
  const pendingApplications = data.applications.filter((row) => row.status === "Pending Review");
  const incompleteApplications = data.applications.filter((row) => missingApplicationFields(row).length > 0);
  const flaggedReviews = data.applications.filter((row) => {
    const review = firstReview(row.application_ai_reviews);
    return ["Missing Information", "Needs Review", "Lot Conflict"].includes(String(review?.completeness_status ?? ""));
  });
  const lotInterest = buildLotInterest(data.applications, data.lots);
  const conflictApplications = data.applications.filter((row) => applicationHasUnavailableLot(row, data.lots));

  const availableLots = data.lots.filter((lot) => lot.status === "Available");
  const reservedLots = data.lots.filter((lot) => lot.status === "Reserved");
  const soldLots = data.lots.filter((lot) => lot.status === "Sold");
  const recentlyUpdatedLots = data.lots.filter((lot) => inPeriod(lot.updated_at, data.periodStart, data.periodEnd));

  const periodPayments = data.payments.filter((row) => inPeriod(row.created_at, data.periodStart, data.periodEnd));
  const collected = sum(periodPayments, "amount");
  const cashTotal = sum(periodPayments.filter((row) => row.collection_method === "Cash"), "amount");
  const transferTotal = sum(periodPayments.filter((row) => ["Online Transfer", "Bank Transfer"].includes(String(row.collection_method))), "amount");
  const missingReceipts = data.payments.filter((row) => !row.manual_receipt_number);
  const missingProof = data.payments.filter((row) => ["Online Transfer", "Bank Transfer"].includes(String(row.collection_method)) && !relationArray(row.payment_documents).length);
  const duplicateRefs = duplicateBankReferences(data.payments);
  const incompletePayments = data.payments.filter((row) => !row.manual_receipt_number || (["Online Transfer", "Bank Transfer"].includes(String(row.collection_method)) && !row.bank_reference));

  const periodContracts = data.contracts.filter((row) => inPeriod(row.created_at, data.periodStart, data.periodEnd));
  const activeContracts = data.contracts.filter((row) => Boolean(row.is_active));
  const missingSignedContracts = data.contracts.filter((row) => !row.signed_contract_file_path);
  const incompleteContracts = data.contracts.filter((row) => !row.customer_id || !row.parcel_id || !row.start_date || !row.payment_due_day);
  const startingSoon = data.contracts.filter((row) => daysFromToday(String(row.start_date)) >= 0 && daysFromToday(String(row.start_date)) <= 7);
  const noRecentPayment = activeContracts.filter((row) => !hasRecentPayment(row, 45));

  const today = startOfDay(new Date());
  const weekEnd = addDays(today, 7);
  const dueRows = activeContracts.map((contract) => ({ contract, dueDate: dueDateForCurrentCycle(contract, today) }));
  const dueToday = dueRows.filter((row) => isSameDay(row.dueDate, today));
  const dueThisWeek = dueRows.filter((row) => row.dueDate > today && row.dueDate <= weekEnd);
  const overdue = dueRows.filter((row) => row.dueDate < today && outstandingBalance(row.contract) > 0);
  const outstanding = activeContracts.reduce((total, contract) => total + outstandingBalance(contract), 0);
  const openPaymentRequests = data.paymentRequests.filter((row) => ["Draft", "Sent"].includes(String(row.status)));

  const alerts: BriefOutput["alerts"] = [];
  const recommendedActions: BriefOutput["recommended_actions"] = [];

  if (flaggedReviews.length) alerts.push(alert("amber", "Applications need review", `${flaggedReviews.length} applications have AI review flags.`));
  if (lotInterest.filter((row) => row.count > 1).length) alerts.push(alert("amber", "Lot interest conflicts", `${lotInterest.filter((row) => row.count > 1).length} lots have multiple applicant interest.`));
  if (conflictApplications.length) alerts.push(alert("red", "Unavailable preferred lots", `${conflictApplications.length} applications selected reserved or sold lots.`));
  if (missingReceipts.length) alerts.push(alert("amber", "Missing receipt numbers", `${missingReceipts.length} payments need manual receipt numbers.`));
  if (missingProof.length) alerts.push(alert("amber", "Missing transfer proof", `${missingProof.length} transfer payments need uploaded proof.`));
  if (missingSignedContracts.length) alerts.push(alert("amber", "Missing signed contracts", `${missingSignedContracts.length} contracts are missing signed uploads.`));
  if (overdue.length) alerts.push(alert("red", "Overdue accounts", `${overdue.length} active contracts appear overdue.`));

  pendingApplications.slice(0, 5).forEach((row) => recommendedActions.push(action("Review pending application", applicantName(row), "application", row.id)));
  incompleteApplications.slice(0, 5).forEach((row) => recommendedActions.push(action("Request missing application information", `${applicantName(row)}: ${missingApplicationFields(row).join(", ")}`, "application", row.id)));
  conflictApplications.slice(0, 5).forEach((row) => recommendedActions.push(action("Resolve preferred lot conflict", applicantName(row), "application", row.id)));
  missingReceipts.slice(0, 5).forEach((row) => recommendedActions.push(action("Enter manual receipt number", `${customerName(row.customers)} payment #${row.id}`, "payment", row.id)));
  missingProof.slice(0, 5).forEach((row) => recommendedActions.push(action("Upload or confirm transfer proof", `${customerName(row.customers)} payment #${row.id}`, "payment", row.id)));
  missingSignedContracts.slice(0, 5).forEach((row) => recommendedActions.push(action("Upload signed contract", `${customerName(row.customers)} contract #${row.id}`, "contract", row.id)));
  overdue.slice(0, 5).forEach(({ contract }) => recommendedActions.push(action("Contact overdue customer", `${customerName(contract.customers)} on Lot ${nestedLot(contract)}`, "customer", contract.customer_id)));

  if (!alerts.length) alerts.push(alert("green", "No urgent alerts", "No urgent operational alerts were detected from the available records."));
  if (!recommendedActions.length) recommendedActions.push(action("Monitor operations", "No immediate manual follow-up was detected for this period.", "brief"));

  return {
    summary: `${periodApplications.length} new applications, ${periodPayments.length} payments totaling ${money(collected)}, and ${periodContracts.length} new contracts were recorded for the selected period. ${alerts.length} alert items are listed for admin review.`,
    applications_summary: `${periodApplications.length} new applications. ${pendingApplications.length} pending applications. ${incompleteApplications.length} applications are missing key information. ${flaggedReviews.length} applications have AI review flags. ${lotInterest.filter((row) => row.count > 1).length} lots have multiple applicant interest. ${conflictApplications.length} applications selected unavailable lots.`,
    lots_summary: `${data.lots.length} total lots: ${availableLots.length} available, ${reservedLots.length} reserved, ${soldLots.length} sold. ${recentlyUpdatedLots.length} lots were updated during the period. ${lotInterest.filter((row) => row.count > 1).length} lots have multiple applicant interest.`,
    payments_summary: `${periodPayments.length} payments logged during the period. Total collected: ${money(collected)}. Cash: ${money(cashTotal)}. Transfers: ${money(transferTotal)}. ${missingReceipts.length} payments are missing manual receipt numbers. ${missingProof.length} transfer payments are missing uploaded proof. ${duplicateRefs.length} duplicate bank references were detected. ${incompletePayments.length} payments look incomplete.`,
    contracts_summary: `${periodContracts.length} new contracts. ${activeContracts.length} active contracts. ${missingSignedContracts.length} contracts are missing signed uploads. ${incompleteContracts.length} contracts have incomplete fields. ${startingSoon.length} contracts start within 7 days. ${noRecentPayment.length} active contracts have no payment in the last 45 days.`,
    collections_summary: `${dueToday.length} customers due today. ${dueThisWeek.length} customers due this week. ${overdue.length} overdue accounts detected. Outstanding land balance is ${money(outstanding)}. ${openPaymentRequests.length} open payment requests. ${missingReceipts.length} customers/payments have missing receipt numbers. ${missingProof.length} payments are missing proof.`,
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
    "alerts and recommended_actions must be arrays. Keep tone professional, clear, operational, concise, and action-oriented.",
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
    alerts: cleanArray(value.alerts, fallback.alerts),
    recommended_actions: cleanArray(value.recommended_actions, fallback.recommended_actions),
  };
}

function summarizeForPrompt(data: OperationalData) {
  const brief = buildDeterministicBrief(data);
  return {
    period_start: data.periodStart.toISOString(),
    period_end: data.periodEnd.toISOString(),
    counts: {
      applications: data.applications.length,
      lots: data.lots.length,
      payments: data.payments.length,
      contracts: data.contracts.length,
      payment_requests: data.paymentRequests.length,
    },
    deterministic_findings: brief,
  };
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

function action(title: string, detail: string, recordType: string, recordId?: unknown) {
  return { title, detail, record_type: recordType, record_id: recordId ?? null };
}

function alert(severity: string, title: string, detail: string) {
  return { severity, title, detail };
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
