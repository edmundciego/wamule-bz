import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeWorkspaceTenant } from "../_shared/workspace-auth.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AccountStatus = "Good Standing" | "Due Soon" | "Overdue" | "Needs Review" | "Missing Documents" | "No Active Contract";

type CustomerSummaryOutput = {
  summary: string;
  account_status: AccountStatus;
  balance_summary: string;
  payment_summary: string;
  collections_flags: Array<Record<string, unknown> | string>;
  missing_items: Array<Record<string, unknown> | string>;
  recommended_actions: Array<Record<string, unknown> | string>;
  draft_follow_up_message: string;
};

type AccountData = {
  customer: Record<string, unknown>;
  application: Record<string, unknown> | null;
  contracts: Record<string, unknown>[];
  activeContracts: Record<string, unknown>[];
  contractFinancials: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  paymentAllocations: Record<string, unknown>[];
  feeCharges: Record<string, unknown>[];
  paymentDocuments: Record<string, unknown>[];
  paymentRequests: Record<string, unknown>[];
  paymentMethods: Record<string, unknown>[];
  feeTypes: Record<string, unknown>[];
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

  const body = await request.json().catch(() => null) as { customer_id?: number; tenant_id?: string; generationId?: string } | null;
  // Customer summaries include balances, payment history and financial
  // documents, which M3.1 reserves to Tenant Admin/Super Admin.
  const workspaceAuth = await authorizeWorkspaceTenant(supabase, currentUserData.user.id, body?.tenant_id, ["Super Admin", "Admin"]);
  if (!workspaceAuth.ok) return json({ error: workspaceAuth.error }, workspaceAuth.status);
  const tenantId = workspaceAuth.tenantId;
  const customerId = Number(body?.customer_id ?? 0);
  const generationId = String(body?.generationId ?? "").trim();
  if (!Number.isSafeInteger(customerId) || customerId <= 0) {
    return json({ error: "customer_id must be a positive integer." }, 400);
  }
  if (!uuidPattern.test(generationId)) {
    return json({ error: "generationId must be a valid UUID and remain unchanged when retrying this generation." }, 400);
  }

  const { data: customerScope, error: customerScopeError } = await supabase.from("customers")
    .select("id,tenant_id").eq("id", customerId).eq("tenant_id", tenantId).maybeSingle();
  if (customerScopeError) return json({ error: customerScopeError.message }, 500);
  if (!customerScope) return json({ error: "Customer not found." }, 404);

  const claimArgs = {
    p_summary_kind: "customer",
    p_tenant_id: tenantId,
    p_parent_id: String(customerId),
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
      message: "This customer summary is already being generated. Retry shortly with the same generationId.",
    }, 202);
  }
  if (claim?.status === "completed") {
    const completedResult = claim.summary_id
      ? await supabase.from("customer_ai_summaries").select("*")
        .eq("id", claim.summary_id).eq("tenant_id", tenantId).eq("customer_id", customerId).eq("generation_id", generationId).maybeSingle()
      : { data: null, error: null };
    if (completedResult.error) return json({ error: completedResult.error.message }, 500);
    if (!completedResult.data) return json({ error: "The completed customer summary generation could not be found." }, 500);
    return json({
      summary: completedResult.data,
      fallback: String(completedResult.data.model ?? "") === "deterministic-fallback",
      message: "Customer summary generation recovered from its saved result.",
    });
  }
  if (claim?.status !== "claimed" || !claim.claim_token) {
    return json({ error: "A valid customer summary generation claim could not be established." }, 500);
  }
  let generationCompleted = false;
  try {

  const [customerResult, settingsResult, paymentMethodsResult, feeTypesResult] = await Promise.all([
    supabase
      .from("customers")
      .select(
        "*, applications(*, parcels(*)), contracts(*, parcels(*), transactions(*, payment_documents(*))), transactions(*, payment_documents(*)), payment_documents(*, transactions(id, receipt_number, amount, transaction_type, created_at)), payment_requests(*)",
      )
      .eq("id", customerId)
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    supabase
      .from("ai_settings")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("payment_methods")
      .select("id, name, method_type, is_active, is_public")
      .eq("tenant_id", tenantId)
      .order("sort_order", { ascending: true }),
    supabase
      .from("fee_types")
      .select("id, name, default_amount, frequency, is_required, is_active")
      .eq("tenant_id", tenantId)
      .order("sort_order", { ascending: true }),
  ]);

  const firstError = customerResult.error ?? settingsResult.error ?? paymentMethodsResult.error ?? feeTypesResult.error;
  if (firstError) {
    return json({ error: firstError.message }, 500);
  }

  if (!customerResult.data) {
    return json({ error: "Customer not found." }, 404);
  }

  const customer = customerResult.data as Record<string, unknown>;
  const contractIds = relationArray(customer.contracts)
    .filter((contract) => contract.is_active === true && String(contract.status) === "active")
    .map((contract) => Number(contract.id)).filter(Number.isFinite);
  const [contractFinancialsResult, allocationsResult, feeChargesResult] = await Promise.all([
    contractIds.length
      ? supabase.from("contract_financial_summary")
        .select("contract_id,customer_id,total_posted_land_paid,remaining_balance,project_id,phase_id,currency,reservation_settled_credit")
        .in("contract_id", contractIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("transaction_allocations")
      .select("id,transaction_id,customer_id,amount,currency,scope_kind,allocation_kind,contract_id,reservation_id,fee_charge_id,project_id,phase_id,allocation_reason")
      .eq("tenant_id", tenantId).eq("customer_id", customerId),
    supabase.from("fee_charges")
      .select("id,fee_type_id,amount,currency,scope_kind,project_id,phase_id,status,due_at")
      .eq("tenant_id", tenantId).eq("customer_id", customerId),
  ]);
  const financeError = contractFinancialsResult.error ?? allocationsResult.error ?? feeChargesResult.error;
  if (financeError) return json({ error: financeError.message }, 500);

  const accountData = buildAccountData({
    customer,
    paymentMethods: paymentMethodsResult.data ?? [],
    feeTypes: feeTypesResult.data ?? [],
    contractFinancials: contractFinancialsResult.data ?? [],
    paymentAllocations: allocationsResult.data ?? [],
    feeCharges: feeChargesResult.data ?? [],
  });
  const deterministic = buildDeterministicSummary(accountData);
  const settings = settingsResult.data;
  const apiKey = Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GOOGLE_API_KEY") ?? "";
  const model = String(settings?.model ?? "gemini-3.1-flash-lite");
  const canUseGemini = Boolean(
    settings?.is_enabled &&
    settings?.collections_assistant_enabled &&
    settings?.provider === "Gemini" &&
    apiKey && accountData.activeContracts.length <= 1,
  );

  let summary = deterministic;
  let usedModel = "deterministic-fallback";

  if (canUseGemini) {
    const geminiSummary = await generateGeminiSummary({
      data: summarizeForPrompt(accountData),
      deterministic,
      apiKey,
      model,
    });
    if (!geminiSummary) {
      return json({ error: "Gemini did not return a valid customer summary. Retry with the same generationId." }, 502);
    }
    summary = geminiSummary;
    usedModel = model;
  }

  const { data: savedSummary, error: saveError } = await supabase
    .from("customer_ai_summaries")
    .upsert({
      tenant_id: tenantId,
      customer_id: customerId,
      generation_id: generationId,
      summary: summary.summary,
      account_status: summary.account_status,
      balance_summary: summary.balance_summary,
      payment_summary: summary.payment_summary,
      collections_flags: summary.collections_flags,
      missing_items: summary.missing_items,
      recommended_actions: summary.recommended_actions,
      draft_follow_up_message: summary.draft_follow_up_message,
      model: usedModel,
      generated_by: currentUserData.user.id,
    }, { onConflict: "customer_id" })
    .select("*")
    .single();

  if (saveError) {
    return json({ error: saveError.message }, 500);
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
      ? "Customer summary generated with deterministic fallback."
      : "Customer summary generated with Gemini.",
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
        if (releaseError) console.error("Customer summary claim release failed", releaseError.message);
      } catch (releaseError) {
        console.error("Customer summary claim release failed", releaseError);
      }
    }
  }
});

function buildAccountData({
  customer,
  paymentMethods,
  feeTypes,
  contractFinancials,
  paymentAllocations,
  feeCharges,
}: {
  customer: Record<string, unknown>;
  paymentMethods: Record<string, unknown>[];
  feeTypes: Record<string, unknown>[];
  contractFinancials: Record<string, unknown>[];
  paymentAllocations: Record<string, unknown>[];
  feeCharges: Record<string, unknown>[];
}): AccountData {
  const contracts = relationArray(customer.contracts);
  const activeContracts = contracts.filter((contract) => contract.is_active === true && String(contract.status) === "active");
  return {
    customer,
    application: (customer.applications as Record<string, unknown> | null | undefined) ?? null,
    contracts,
    activeContracts,
    contractFinancials,
    payments: relationArray(customer.transactions),
    paymentAllocations,
    feeCharges,
    paymentDocuments: relationArray(customer.payment_documents),
    paymentRequests: relationArray(customer.payment_requests),
    paymentMethods,
    feeTypes,
  };
}

function buildDeterministicSummary(data: AccountData): CustomerSummaryOutput {
  const customer = data.customer;
  const name = customerName(customer);
  const postedPayments = data.payments.filter((payment) => String(payment.status).toLowerCase() === "posted");
  const financialTransactionIds = new Set(data.payments
    .filter((payment) => ["posted", "voided"].includes(String(payment.status).toLowerCase()))
    .map((payment) => Number(payment.id)));
  const contractSummaries = data.activeContracts.map((contract) => {
    const financial = data.contractFinancials.find((row) => Number(row.contract_id) === Number(contract.id));
    const contractAllocations = data.paymentAllocations.filter((allocation) =>
      Number(allocation.contract_id) === Number(contract.id)
      && ["applied", "reversal"].includes(String(allocation.allocation_kind))
      && financialTransactionIds.has(Number(allocation.transaction_id))
      && allocation.currency === contract.currency
    );
    const allocatedPaymentCredit = contractAllocations.reduce((sum, allocation) => sum + Number(allocation.amount ?? 0), 0);
    const reservationSettledCredit = Number(financial?.reservation_settled_credit ?? 0);
    const totalPaid = allocatedPaymentCredit + reservationSettledCredit;
    const remainingBalance = Number(financial?.remaining_balance ?? contract.final_purchase_price ?? 0);
    const dueDate = dueDateForCurrentCycle(contract, new Date());
    const dueSoon = dueDate ? daysBetween(startOfDay(new Date()), dueDate) >= 0 && daysBetween(startOfDay(new Date()), dueDate) <= 7 : false;
    const overdue = Boolean(dueDate && dueDate < startOfDay(new Date()) && remainingBalance > 0
      && !expectedPaymentSatisfied(contract, totalPaid, dueDate));
    const recentPayment = contractAllocations.some((allocation) => {
      const payment = data.payments.find((row) => Number(row.id) === Number(allocation.transaction_id));
      return payment && String(payment.status).toLowerCase() === "posted"
        && daysBetween(new Date(String(payment.created_at)), new Date()) <= 45;
    });
    return { contract, financial, allocatedPaymentCredit, reservationSettledCredit, totalPaid, remainingBalance, dueDate, dueSoon, overdue, recentPayment };
  });
  const lastPayment = [...postedPayments].sort((a, b) => dateTime(b.created_at) - dateTime(a.created_at))[0] ?? null;
  const missingReceiptPayments = postedPayments.filter((payment) => !payment.manual_receipt_number);
  const missingProofPayments = postedPayments.filter((payment) => isTransfer(payment) && !relationArray(payment.payment_documents).length);
  const openRequests = data.paymentRequests.filter((request) => ["Draft", "Sent"].includes(String(request.status)));
  const overdueRequests = openRequests.filter((request) => startOfDay(new Date(String(request.due_date))) < startOfDay(new Date()));
  const dueDate = contractSummaries.map((item) => item.dueDate).filter(Boolean)
    .sort((a, b) => (a?.getTime() ?? Infinity) - (b?.getTime() ?? Infinity))[0] ?? null;
  const dueSoon = contractSummaries.some((item) => item.dueSoon);
  const overdue = contractSummaries.some((item) => item.overdue);
  const noRecentPaymentContracts = contractSummaries.filter((item) => item.remainingBalance > 0 && !item.recentPayment);
  const openFeeCharges = data.feeCharges.filter((charge) => String(charge.status).toLowerCase() === "open");

  const flags: CustomerSummaryOutput["collections_flags"] = [];
  const missingItems: CustomerSummaryOutput["missing_items"] = [];
  const actions: CustomerSummaryOutput["recommended_actions"] = [];

  if (contractSummaries.length === 0) {
    flags.push(item("No active contract", "No active contract is recorded for this customer."));
    actions.push(item("Review account setup", "Confirm whether a contract should be created or linked before collections follow-up."));
  }
  for (const { contract } of contractSummaries) {
    if (!contract.signed_contract_file_path) {
      flags.push(item("Contract missing signed upload", `Contract #${contract.id} has no signed contract upload.`));
      missingItems.push(item("Signed contract upload", `Upload or attach the signed contract for Contract #${contract.id}.`));
    }
  }
  if (contractSummaries.length > 0 && contractSummaries.every((row) => row.totalPaid === 0)) {
    flags.push(item("No payments recorded", "No payments are recorded for this account."));
    actions.push(item("Confirm first payment status", "Check whether the initial deposit or first installment has been paid."));
  }
  if (dueSoon) flags.push(item("Payment due soon", `Next payment date is ${formatDate(dueDate?.toISOString())}.`));
  if (overdue) flags.push(item("Payment overdue", `Payment due date appears overdue: ${formatDate(dueDate?.toISOString())}.`));
  if (missingReceiptPayments.length) {
    flags.push(item("Missing manual receipt numbers", `${missingReceiptPayments.length} payments are missing manual receipt numbers.`));
    missingItems.push(item("Manual receipt numbers", "Enter receipt book numbers for payments missing receipt numbers."));
  }
  if (missingProofPayments.length) {
    flags.push(item("Missing payment proof", `${missingProofPayments.length} transfer payments are missing uploaded proof.`));
    missingItems.push(item("Transfer proof", "Upload or confirm bank transfer proof for transfer payments."));
  }
  if (openRequests.length) flags.push(item("Open payment requests", `${openRequests.length} payment requests are still open.`));
  if (overdueRequests.length) flags.push(item("Overdue payment requests", `${overdueRequests.length} payment requests are past due.`));
  for (const { contract } of contractSummaries) {
    const lot = contract.parcels as Record<string, unknown> | null | undefined;
    if (lot?.status && !["Reserved", "Sold"].includes(String(lot.status))) {
      flags.push(item("Lot status needs review", `Contract #${contract.id} Lot ${lot.lot_number ?? "N/A"} is marked ${lot.status}, which may not match an active customer contract.`));
    }
  }
  if (noRecentPaymentContracts.length) flags.push(item("No recent payment", `${noRecentPaymentContracts.length} active contract(s) with a balance have no exact-contract allocation in the last 45 days.`));
  if (openFeeCharges.length) flags.push(item("Open assessed fees", `${openFeeCharges.length} assessed fee charge(s) remain open across their stated currencies and scopes.`));

  for (const row of contractSummaries.filter((item) => item.remainingBalance > 0)) {
    actions.push(item("Review balance with customer", `Confirm payment plan status for Contract #${row.contract.id}: ${formatCurrency(row.remainingBalance, String(row.contract.currency ?? ""))}.`));
  }
  if (openRequests.length) actions.push(item("Follow up on open payment request", `Review ${openRequests.length} open payment request(s) before contacting the customer.`));
  if (!actions.length) actions.push(item("Monitor account", "No urgent collections action was detected from current records."));

  const accountStatus = chooseStatus({ hasContract: contractSummaries.length > 0, overdue, overdueRequests, dueSoon, missingItems, flags });
  const lots = contractSummaries.map(({ contract }) => {
    const lot = contract.parcels as Record<string, unknown> | null | undefined;
    return lot?.lot_number ? `Lot ${lot.lot_number} (Contract #${contract.id})` : null;
  }).filter(Boolean);
  const lotText = lots.length ? lots.join(", ") : assignedApplicationLot(data.application);
  const balanceSummary = contractSummaries.length
    ? contractSummaries.map(({ contract, allocatedPaymentCredit, reservationSettledCredit, totalPaid, remainingBalance }) =>
      `Contract #${contract.id} (${String(contract.currency ?? "currency unverified")}): ${formatCurrency(allocatedPaymentCredit, String(contract.currency ?? ""))} in exact-contract payment allocations plus ${formatCurrency(reservationSettledCredit, String(contract.currency ?? ""))} in reservation-settled credit; total contract credit ${formatCurrency(totalPaid, String(contract.currency ?? ""))} of ${formatCurrency(Number(contract.final_purchase_price ?? 0), String(contract.currency ?? ""))}; remaining ${formatCurrency(remainingBalance, String(contract.currency ?? ""))}.`
    ).join(" ")
    : `${name} does not have an active contract, so no contract balance can be calculated.`;
  const paymentSummary = lastPayment
    ? `Latest posted receipt was ${formatCurrency(Number(lastPayment.amount ?? 0), String(lastPayment.currency ?? ""))} for ${lastPayment.transaction_type ?? "payment"} on ${formatDate(String(lastPayment.created_at))} by ${lastPayment.collection_method ?? "unknown method"}. Receipt amounts are not added across obligations.`
    : "No payments are recorded for this customer.";

  return {
    summary: `${name} is assigned to ${lotText || "no lot on record"}. Account status is ${accountStatus}. ${balanceSummary}`,
    account_status: accountStatus,
    balance_summary: balanceSummary,
    payment_summary: paymentSummary,
    collections_flags: flags.length ? flags : [item("No urgent collections flags", "No urgent collections issues were detected from current records.")],
    missing_items: missingItems,
    recommended_actions: actions,
    draft_follow_up_message: buildFollowUpMessage(name, accountStatus, dueDate, openRequests.length),
  };
}

async function generateGeminiSummary({
  data,
  deterministic,
  apiKey,
  model,
}: {
  data: Record<string, unknown>;
  deterministic: CustomerSummaryOutput;
  apiKey: string;
  model: string;
}): Promise<CustomerSummaryOutput | null> {
  const prompt = [
    "You are a read-only customer account and collections assistant for Wamule Development.",
    "Summarize only the supplied system data. Do not update records, log payments, create requests, send emails, send WhatsApp messages, change balances, change lot status, or make legal threats.",
    "Return only valid JSON with keys: summary, account_status, balance_summary, payment_summary, collections_flags, missing_items, recommended_actions, draft_follow_up_message.",
    "account_status must be one of: Good Standing, Due Soon, Overdue, Needs Review, Missing Documents, No Active Contract.",
    "Tone must be professional, clear, practical, respectful, Belize/Caribbean business-friendly, and collections-aware.",
    "Do not use legal threats, final notices, or aggressive language.",
    "Avoid saying: Thank you for your prompt attention to this matter.",
    "Use this preferred closing once at the end of the draft message: Please contact us when convenient so we can confirm or update the account file. Thank you, and please let us know if you have any questions.",
    "If the account is Due Soon or Missing Documents, do not imply that the customer is overdue or in default.",
    "Never add amounts from different contracts or currencies. Respect each supplied contract, phase, allocation, and currency as a separate account line.",
    "",
    `Deterministic baseline: ${JSON.stringify(deterministic)}`,
    `Customer account data: ${JSON.stringify(data)}`,
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
            maxOutputTokens: 1200,
            responseMimeType: "application/json",
          },
        }),
      },
    );

    if (!response.ok) return null;
    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    return sanitizeSummary(JSON.parse(text), deterministic);
  } catch {
    return null;
  }
}

function sanitizeSummary(value: Partial<CustomerSummaryOutput>, fallback: CustomerSummaryOutput): CustomerSummaryOutput {
  return {
    summary: cleanText(value.summary, fallback.summary),
    account_status: fallback.account_status,
    balance_summary: cleanText(value.balance_summary, fallback.balance_summary),
    payment_summary: cleanText(value.payment_summary, fallback.payment_summary),
    collections_flags: cleanArray(value.collections_flags, fallback.collections_flags),
    missing_items: cleanArray(value.missing_items, fallback.missing_items),
    recommended_actions: cleanArray(value.recommended_actions, fallback.recommended_actions),
    draft_follow_up_message: cleanFollowUpMessage(value.draft_follow_up_message, fallback.draft_follow_up_message),
  };
}

function summarizeForPrompt(data: AccountData) {
  const financialTransactionIds = new Set(data.payments
    .filter((payment) => ["posted", "voided"].includes(String(payment.status).toLowerCase()))
    .map((payment) => Number(payment.id)));
  const contracts = data.activeContracts.map((contract) => {
    const financial = data.contractFinancials.find((row) => Number(row.contract_id) === Number(contract.id));
    const lot = contract.parcels as Record<string, unknown> | null | undefined;
    const contractAllocations = data.paymentAllocations.filter((allocation) =>
      Number(allocation.contract_id) === Number(contract.id)
      && allocation.currency === contract.currency
      && ["applied", "reversal"].includes(String(allocation.allocation_kind))
      && ["posted", "voided"].includes(String(data.payments.find((payment) => Number(payment.id) === Number(allocation.transaction_id))?.status).toLowerCase())
    );
    const allocatedPaymentCredit = contractAllocations.reduce((sum, allocation) => sum + Number(allocation.amount ?? 0), 0);
    const reservationSettledCredit = Number(financial?.reservation_settled_credit ?? 0);
    return {
      id: contract.id,
      project_id: contract.project_id,
      phase_id: contract.phase_id,
      lot_number: lot?.lot_number ?? null,
      currency: contract.currency ?? null,
      final_purchase_price: contract.final_purchase_price,
      initial_deposit: contract.initial_deposit,
      monthly_payment: contract.monthly_payment,
      term_months: contract.term_months,
      start_date: contract.start_date,
      payment_due_day: contract.payment_due_day,
      signed_contract_uploaded: Boolean(contract.signed_contract_file_path),
      allocated_payment_credit: allocatedPaymentCredit,
      total_contract_credit: allocatedPaymentCredit + reservationSettledCredit,
      remaining_balance: financial?.remaining_balance ?? contract.final_purchase_price,
      reservation_settled_credit: reservationSettledCredit,
    };
  });
  const allocations = data.paymentAllocations
    .filter((allocation) => financialTransactionIds.has(Number(allocation.transaction_id))
      && ["applied", "reversal"].includes(String(allocation.allocation_kind)))
    .map((allocation) => ({
      id: allocation.id,
      transaction_id: allocation.transaction_id,
      amount: allocation.amount,
      currency: allocation.currency,
      scope_kind: allocation.scope_kind,
      contract_id: allocation.contract_id,
      reservation_id: allocation.reservation_id,
      fee_charge_id: allocation.fee_charge_id,
      project_id: allocation.project_id,
      phase_id: allocation.phase_id,
    }));
  const allocatedTransactionIds = new Set(allocations.map((allocation) => Number(allocation.transaction_id)));
  return {
    customer: {
      id: data.customer.id,
      name: customerName(data.customer),
      phone_present: Boolean(data.customer.phone),
      email_present: Boolean(data.customer.email),
      address_present: Boolean(data.customer.address),
      application_id: data.customer.application_id,
    },
    contracts,
    payment_allocations: allocations,
    fee_charges: data.feeCharges.map((charge) => pick(charge, ["id", "amount", "currency", "scope_kind", "project_id", "phase_id", "status", "due_at"])),
    payments: data.payments.filter((payment) => allocatedTransactionIds.has(Number(payment.id))).map((payment) => ({
      id: payment.id,
      transaction_type: payment.transaction_type,
      collection_method: payment.collection_method,
      currency: payment.currency ?? null,
      bank_reference_present: Boolean(payment.bank_reference),
      manual_receipt_number_present: Boolean(payment.manual_receipt_number),
      uploaded_document_count: relationArray(payment.payment_documents).length,
      created_at: payment.created_at,
    })),
    payment_requests: data.paymentRequests.map((request) => ({
      id: request.id,
      amount_due: request.amount_due,
      currency: request.currency ?? null,
      project_id: request.project_id ?? null,
      phase_id: request.phase_id ?? null,
      contract_id: request.contract_id ?? null,
      due_date: request.due_date,
      reason: request.reason,
      status: request.status,
    })),
    active_payment_methods: data.paymentMethods.filter((method) => method.is_active).map((method) => method.name),
    active_fee_types: data.feeTypes.filter((fee) => fee.is_active).map((fee) => fee.name),
  };
}

function chooseStatus({
  hasContract,
  overdue,
  overdueRequests,
  dueSoon,
  missingItems,
  flags,
}: {
  hasContract: boolean;
  overdue: boolean;
  overdueRequests: Record<string, unknown>[];
  dueSoon: boolean;
  missingItems: CustomerSummaryOutput["missing_items"];
  flags: CustomerSummaryOutput["collections_flags"];
}): AccountStatus {
  if (!hasContract) return "No Active Contract";
  if (overdue || overdueRequests.length) return "Overdue";
  if (missingItems.length) return "Missing Documents";
  if (dueSoon) return "Due Soon";
  if (flags.length) return "Needs Review";
  return "Good Standing";
}

function buildFollowUpMessage(name: string, status: AccountStatus, dueDate: Date | null, openRequests: number) {
  const firstName = name.split(" ")[0] || name;
  const closing = "Please contact us when convenient so we can confirm or update the account file. Thank you, and please let us know if you have any questions.";
  if (status === "Overdue") {
    return `Good morning ${firstName}, this is a quick update from Wamule Development regarding your account. Our records show a payment item that may need follow-up. ${closing}`;
  }
  if (status === "Due Soon") {
    return `Good morning ${firstName}, this is a friendly update from Wamule Development. Our records show your next payment date is coming up${dueDate ? ` around ${formatDate(dueDate.toISOString())}` : ""}. ${closing}`;
  }
  if (status === "Missing Documents") {
    return `Good morning ${firstName}, this is a quick note from Wamule Development. We are reviewing account documents and may need to confirm or update one item on file. ${closing}`;
  }
  if (openRequests > 0) {
    return `Good morning ${firstName}, this is a quick follow-up from Wamule Development. Our records show an open payment request on your account. ${closing}`;
  }
  return `Good morning ${firstName}, this is a quick update from Wamule Development regarding your account. Our records are available for review. ${closing}`;
}

function cleanText(value: unknown, fallback: string) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 5000) : fallback;
}

function cleanFollowUpMessage(value: unknown, fallback: string) {
  const preferredClosing = "Please contact us when convenient so we can confirm or update the account file. Thank you, and please let us know if you have any questions.";
  const text = cleanText(value, fallback)
    .replace(/Thank you for your prompt attention to this matter\.?/gi, "Thank you.")
    .replace(/Please contact us when convenient if you have any questions\.\s*Thank you, and please let us know if you have any questions\./gi, preferredClosing)
    .replace(/Please let us know if you would like us to confirm your account details\.\s*Thank you, and please let us know if you have any questions\./gi, preferredClosing);
  return text.slice(0, 5000);
}

function cleanArray(value: unknown, fallback: CustomerSummaryOutput["collections_flags"]) {
  if (!Array.isArray(value)) return fallback;
  return value.slice(0, 40).map((entry) => {
    if (typeof entry === "string") return entry.slice(0, 1000);
    if (!entry || typeof entry !== "object") return String(entry ?? "").slice(0, 1000);
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>).map(([key, itemValue]) => [key, String(itemValue ?? "").slice(0, 1000)]));
  });
}

function item(title: string, detail: string) {
  return { title, detail };
}

function relationArray(value: unknown) {
  return Array.isArray(value) ? value as Record<string, unknown>[] : [];
}

function isTransfer(payment: Record<string, unknown>) {
  return ["Online Transfer", "Bank Transfer"].includes(String(payment.collection_method));
}

function customerName(customer: Record<string, unknown>) {
  return String(`${customer.first_name ?? ""} ${customer.last_name ?? ""}`).trim() || "Unknown customer";
}

function assignedApplicationLot(application: Record<string, unknown> | null) {
  const lot = application?.parcels as Record<string, unknown> | null | undefined;
  return lot?.lot_number ? `Lot ${lot.lot_number}` : "";
}

function dueDateForCurrentCycle(contract: Record<string, unknown>, today: Date) {
  const current = startOfDay(today);
  const start = startOfDay(new Date(String(contract.start_date)));
  const dueDay = Math.max(1, Math.min(31, Number(contract.payment_due_day ?? 1)));
  const firstDue = dueDateForMonth(start.getFullYear(), start.getMonth(), dueDay);

  if (firstDue < start) firstDue.setMonth(firstDue.getMonth() + 1);
  if (current <= firstDue) return firstDue;

  const cycleDue = dueDateForMonth(current.getFullYear(), current.getMonth(), dueDay);
  if (cycleDue < firstDue) return firstDue;
  return cycleDue;
}

function expectedPaymentSatisfied(contract: Record<string, unknown>, totalPaid: number, dueDate: Date) {
  const start = startOfDay(new Date(String(contract.start_date)));
  const dueDay = Math.max(1, Math.min(31, Number(contract.payment_due_day ?? 1)));
  const firstDue = dueDateForMonth(start.getFullYear(), start.getMonth(), dueDay);
  if (firstDue < start) firstDue.setMonth(firstDue.getMonth() + 1);

  const dueCycles = monthsBetween(firstDue, dueDate) + 1;
  const expected = Math.min(
    Number(contract.final_purchase_price ?? 0),
    Number(contract.initial_deposit ?? 0) + Math.max(0, dueCycles) * Number(contract.monthly_payment ?? 0),
  );
  return totalPaid >= expected;
}

function dueDateForMonth(year: number, month: number, dueDay: number) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(dueDay, lastDay));
}

function monthsBetween(start: Date, end: Date) {
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBetween(start: Date, end: Date) {
  return Math.ceil((startOfDay(end).getTime() - startOfDay(start).getTime()) / 86400000);
}

function dateTime(value: unknown) {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function formatDate(value: string | undefined) {
  if (!value) return "not set";
  return new Intl.DateTimeFormat("en-BZ", { dateStyle: "medium" }).format(new Date(value));
}

function formatCurrency(value: number, currency: string) {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return `${Number(value).toFixed(2)} (currency unverified)`;
  return new Intl.NumberFormat("en-BZ", { style: "currency", currency: code }).format(Number(value ?? 0));
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders,
  });
}
