import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
  activeContract: Record<string, unknown> | null;
  payments: Record<string, unknown>[];
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

  const { data: currentProfile, error: profileError } = await supabase
    .from("admin_profiles")
    .select("role")
    .eq("user_id", currentUserData.user.id)
    .maybeSingle();

  if (profileError) {
    return json({ error: profileError.message }, 500);
  }

  const role = String(currentProfile?.role ?? "");
  if (!["Super Admin", "Admin", "Staff"].includes(role)) {
    return json({ error: "Only Super Admin, Admin, or Staff users can generate customer AI summaries." }, 403);
  }

  const body = await request.json().catch(() => null) as { customer_id?: number } | null;
  const customerId = Number(body?.customer_id ?? 0);
  if (!customerId) {
    return json({ error: "customer_id is required." }, 400);
  }

  const [customerResult, settingsResult, paymentMethodsResult, feeTypesResult] = await Promise.all([
    supabase
      .from("customers")
      .select(
        "*, applications(*, parcels(*)), contracts(*, parcels(*), transactions(*, payment_documents(*))), transactions(*, payment_documents(*)), payment_documents(*, transactions(id, receipt_number, amount, transaction_type, created_at)), payment_requests(*)",
      )
      .eq("id", customerId)
      .maybeSingle(),
    supabase
      .from("ai_settings")
      .select("*")
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("payment_methods")
      .select("id, name, method_type, is_active, is_public")
      .order("sort_order", { ascending: true }),
    supabase
      .from("fee_types")
      .select("id, name, default_amount, frequency, is_required, is_active")
      .order("sort_order", { ascending: true }),
  ]);

  const firstError = customerResult.error ?? settingsResult.error ?? paymentMethodsResult.error ?? feeTypesResult.error;
  if (firstError) {
    return json({ error: firstError.message }, 500);
  }

  if (!customerResult.data) {
    return json({ error: "Customer not found." }, 404);
  }

  const accountData = buildAccountData({
    customer: customerResult.data as Record<string, unknown>,
    paymentMethods: paymentMethodsResult.data ?? [],
    feeTypes: feeTypesResult.data ?? [],
  });
  const deterministic = buildDeterministicSummary(accountData);
  const settings = settingsResult.data;
  const apiKey = Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GOOGLE_API_KEY") ?? "";
  const model = String(settings?.model ?? "gemini-3.1-flash-lite");
  const canUseGemini = Boolean(
    settings?.is_enabled &&
    settings?.collections_assistant_enabled &&
    settings?.provider === "Gemini" &&
    apiKey,
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
    if (geminiSummary) {
      summary = geminiSummary;
      usedModel = model;
    }
  }

  const { data: savedSummary, error: saveError } = await supabase
    .from("customer_ai_summaries")
    .upsert({
      customer_id: customerId,
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

  return json({
    summary: savedSummary,
    fallback: usedModel === "deterministic-fallback",
    message: usedModel === "deterministic-fallback"
      ? "Customer summary generated with deterministic fallback."
      : "Customer summary generated with Gemini.",
  });
});

function buildAccountData({
  customer,
  paymentMethods,
  feeTypes,
}: {
  customer: Record<string, unknown>;
  paymentMethods: Record<string, unknown>[];
  feeTypes: Record<string, unknown>[];
}): AccountData {
  const contracts = relationArray(customer.contracts);
  const activeContract = contracts.find((contract) => Boolean(contract.is_active)) ?? contracts[0] ?? null;
  return {
    customer,
    application: (customer.applications as Record<string, unknown> | null | undefined) ?? null,
    contracts,
    activeContract,
    payments: relationArray(customer.transactions),
    paymentDocuments: relationArray(customer.payment_documents),
    paymentRequests: relationArray(customer.payment_requests),
    paymentMethods,
    feeTypes,
  };
}

function buildDeterministicSummary(data: AccountData): CustomerSummaryOutput {
  const customer = data.customer;
  const name = customerName(customer);
  const contract = data.activeContract;
  const landPayments = data.payments.filter((payment) => ["Down Payment", "Land Installment"].includes(String(payment.transaction_type)));
  const totalPaid = sum(landPayments, "amount");
  const finalPrice = Number(contract?.final_purchase_price ?? 0);
  const remainingBalance = contract ? Math.max(finalPrice - totalPaid, 0) : 0;
  const lastPayment = [...data.payments].sort((a, b) => dateTime(b.created_at) - dateTime(a.created_at))[0] ?? null;
  const missingReceiptPayments = data.payments.filter((payment) => !payment.manual_receipt_number);
  const missingProofPayments = data.payments.filter((payment) => isTransfer(payment) && !relationArray(payment.payment_documents).length);
  const openRequests = data.paymentRequests.filter((request) => ["Draft", "Sent"].includes(String(request.status)));
  const overdueRequests = openRequests.filter((request) => startOfDay(new Date(String(request.due_date))) < startOfDay(new Date()));
  const dueDate = contract ? dueDateForCurrentCycle(contract, new Date()) : null;
  const dueSoon = dueDate ? daysBetween(startOfDay(new Date()), dueDate) >= 0 && daysBetween(startOfDay(new Date()), dueDate) <= 7 : false;
  const overdue = dueDate ? dueDate < startOfDay(new Date()) && remainingBalance > 0 : false;
  const noRecentPayment = contract && remainingBalance > 0 && (!lastPayment || daysBetween(new Date(String(lastPayment.created_at)), new Date()) > 45);
  const lot = contract?.parcels as Record<string, unknown> | null | undefined;

  const flags: CustomerSummaryOutput["collections_flags"] = [];
  const missingItems: CustomerSummaryOutput["missing_items"] = [];
  const actions: CustomerSummaryOutput["recommended_actions"] = [];

  if (!contract) {
    flags.push(item("No active contract", "No active contract is recorded for this customer."));
    actions.push(item("Review account setup", "Confirm whether a contract should be created or linked before collections follow-up."));
  }
  if (contract && !contract.signed_contract_file_path) {
    flags.push(item("Contract missing signed upload", `Contract #${contract.id} has no signed contract upload.`));
    missingItems.push(item("Signed contract upload", `Upload or attach the signed contract for Contract #${contract.id}.`));
  }
  if (contract && data.payments.length === 0) {
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
  if (contract && lot?.status && !["Reserved", "Sold"].includes(String(lot.status))) {
    flags.push(item("Lot status needs review", `Lot ${lot.lot_number ?? "N/A"} is marked ${lot.status}, which may not match an active customer contract.`));
  }
  if (noRecentPayment) flags.push(item("No recent payment", "Customer has a remaining land balance and no payment in the last 45 days."));

  if (remainingBalance > 0) actions.push(item("Review balance with customer", `Confirm payment plan status for remaining balance of ${money(remainingBalance)}.`));
  if (openRequests.length) actions.push(item("Follow up on open payment request", `Review ${openRequests.length} open payment request(s) before contacting the customer.`));
  if (!actions.length) actions.push(item("Monitor account", "No urgent collections action was detected from current records."));

  const accountStatus = chooseStatus({ contract, overdue, overdueRequests, dueSoon, missingItems, flags });
  const lotText = lot?.lot_number ? `Lot ${lot.lot_number}` : assignedApplicationLot(data.application);
  const balanceSummary = contract
    ? `${name} has ${money(totalPaid)} recorded toward a ${money(finalPrice)} land contract, leaving an estimated land balance of ${money(remainingBalance)}.`
    : `${name} does not have an active contract, so no contract balance can be calculated.`;
  const paymentSummary = lastPayment
    ? `Last payment was ${money(Number(lastPayment.amount ?? 0))} for ${lastPayment.transaction_type ?? "payment"} on ${formatDate(String(lastPayment.created_at))} by ${lastPayment.collection_method ?? "unknown method"}.`
    : "No payments are recorded for this customer.";

  return {
    summary: `${name} is assigned to ${lotText || "no lot on record"}. Account status is ${accountStatus}. ${balanceSummary}`,
    account_status: accountStatus,
    balance_summary: balanceSummary,
    payment_summary: paymentSummary,
    collections_flags: flags.length ? flags : [item("No urgent collections flags", "No urgent collections issues were detected from current records.")],
    missing_items: missingItems,
    recommended_actions: actions,
    draft_follow_up_message: buildFollowUpMessage(name, accountStatus, remainingBalance, dueDate, openRequests.length),
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
    account_status: normalizeStatus(value.account_status, fallback.account_status),
    balance_summary: cleanText(value.balance_summary, fallback.balance_summary),
    payment_summary: cleanText(value.payment_summary, fallback.payment_summary),
    collections_flags: cleanArray(value.collections_flags, fallback.collections_flags),
    missing_items: cleanArray(value.missing_items, fallback.missing_items),
    recommended_actions: cleanArray(value.recommended_actions, fallback.recommended_actions),
    draft_follow_up_message: cleanText(value.draft_follow_up_message, fallback.draft_follow_up_message),
  };
}

function summarizeForPrompt(data: AccountData) {
  const contract = data.activeContract;
  const landPayments = data.payments.filter((payment) => ["Down Payment", "Land Installment"].includes(String(payment.transaction_type)));
  const totalPaid = sum(landPayments, "amount");
  const remainingBalance = contract ? Math.max(Number(contract.final_purchase_price ?? 0) - totalPaid, 0) : null;
  return {
    customer: {
      id: data.customer.id,
      name: customerName(data.customer),
      phone_present: Boolean(data.customer.phone),
      email_present: Boolean(data.customer.email),
      address_present: Boolean(data.customer.address),
      application_id: data.customer.application_id,
    },
    lot: contract?.parcels ?? data.application?.parcels ?? null,
    contract: contract ? {
      id: contract.id,
      is_active: contract.is_active,
      final_purchase_price: contract.final_purchase_price,
      initial_deposit: contract.initial_deposit,
      monthly_payment: contract.monthly_payment,
      term_months: contract.term_months,
      start_date: contract.start_date,
      payment_due_day: contract.payment_due_day,
      signed_contract_uploaded: Boolean(contract.signed_contract_file_path),
      remaining_balance: remainingBalance,
    } : null,
    payments: data.payments.map((payment) => ({
      id: payment.id,
      amount: payment.amount,
      transaction_type: payment.transaction_type,
      collection_method: payment.collection_method,
      bank_reference_present: Boolean(payment.bank_reference),
      manual_receipt_number_present: Boolean(payment.manual_receipt_number),
      uploaded_document_count: relationArray(payment.payment_documents).length,
      created_at: payment.created_at,
    })),
    payment_requests: data.paymentRequests.map((request) => ({
      id: request.id,
      amount_due: request.amount_due,
      due_date: request.due_date,
      reason: request.reason,
      status: request.status,
    })),
    active_payment_methods: data.paymentMethods.filter((method) => method.is_active).map((method) => method.name),
    active_fee_types: data.feeTypes.filter((fee) => fee.is_active).map((fee) => fee.name),
  };
}

function chooseStatus({
  contract,
  overdue,
  overdueRequests,
  dueSoon,
  missingItems,
  flags,
}: {
  contract: Record<string, unknown> | null;
  overdue: boolean;
  overdueRequests: Record<string, unknown>[];
  dueSoon: boolean;
  missingItems: CustomerSummaryOutput["missing_items"];
  flags: CustomerSummaryOutput["collections_flags"];
}): AccountStatus {
  if (!contract) return "No Active Contract";
  if (overdue || overdueRequests.length) return "Overdue";
  if (missingItems.length) return "Missing Documents";
  if (dueSoon) return "Due Soon";
  if (flags.length) return "Needs Review";
  return "Good Standing";
}

function buildFollowUpMessage(name: string, status: AccountStatus, balance: number, dueDate: Date | null, openRequests: number) {
  const firstName = name.split(" ")[0] || name;
  if (status === "Overdue") {
    return `Good morning ${firstName}, this is a quick update from Wamule Development regarding your account. Our records show a balance of ${money(balance)} and a payment item that may need follow-up. Please contact us when convenient so we can confirm the payment status or make any needed updates to your account.`;
  }
  if (status === "Due Soon") {
    return `Good morning ${firstName}, this is a friendly update from Wamule Development. Our records show your next payment date is coming up${dueDate ? ` around ${formatDate(dueDate.toISOString())}` : ""}. Please let us know if you would like us to confirm your account details.`;
  }
  if (openRequests > 0) {
    return `Good morning ${firstName}, this is a quick follow-up from Wamule Development. Our records show an open payment request on your account. Please contact us when convenient so we can confirm the status.`;
  }
  return `Good morning ${firstName}, this is a quick update from Wamule Development regarding your account. Our records are available for review, and you may contact us if you would like to confirm any payment or document details.`;
}

function normalizeStatus(value: unknown, fallback: AccountStatus): AccountStatus {
  const status = String(value ?? "");
  return ["Good Standing", "Due Soon", "Overdue", "Needs Review", "Missing Documents", "No Active Contract"].includes(status)
    ? status as AccountStatus
    : fallback;
}

function cleanText(value: unknown, fallback: string) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 5000) : fallback;
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

function sum(rows: Record<string, unknown>[], field: string) {
  return rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
}

function customerName(customer: Record<string, unknown>) {
  return String(`${customer.first_name ?? ""} ${customer.last_name ?? ""}`).trim() || "Unknown customer";
}

function assignedApplicationLot(application: Record<string, unknown> | null) {
  const lot = application?.parcels as Record<string, unknown> | null | undefined;
  return lot?.lot_number ? `Lot ${lot.lot_number}` : "";
}

function dueDateForCurrentCycle(contract: Record<string, unknown>, today: Date) {
  const day = Number(contract.payment_due_day ?? 1);
  const due = new Date(today.getFullYear(), today.getMonth(), Math.max(1, Math.min(31, day)));
  if (due < startOfDay(today)) return due;
  return due;
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

function money(value: number) {
  return new Intl.NumberFormat("en-BZ", { style: "currency", currency: "BZD" }).format(Number(value ?? 0));
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders,
  });
}
