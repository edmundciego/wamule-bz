const FINANCE_READ_ROLES = new Set(["Admin", "Super Admin", "Read Only"]);
const FINANCE_AGGREGATE_ROLES = new Set(["Admin", "Super Admin"]);

export function canReadFinance(role) {
  return FINANCE_READ_ROLES.has(role);
}

export function canAggregateCompanyFinance(role) {
  return FINANCE_AGGREGATE_ROLES.has(role);
}

export function effectiveFinanceScope(role, requestedScope) {
  return requestedScope !== "phase" && canAggregateCompanyFinance(role) ? requestedScope : "phase";
}

export function filterAllocationRows(rows, scope, workspace) {
  const selected = scope === "company"
    ? rows.filter((row) => row.tenant_id === workspace.tenantId)
    : scope === "project"
      ? rows.filter((row) => row.tenant_id === workspace.tenantId
        && row.project_id === workspace.projectId
        && ["phase", "project"].includes(row.scope_kind ?? ""))
      : rows.filter((row) => row.tenant_id === workspace.tenantId
        && row.scope_kind === "phase"
        && row.project_id === workspace.projectId
        && row.phase_id === workspace.phaseId);
  return selected.filter((row) => ["applied", "unallocated", "reversal"].includes(row.allocation_kind));
}

export function summarizeAllocationRows(rows) {
  const currencies = new Map();
  const receiptIds = new Set();

  for (const row of rows) {
    const currency = typeof row.currency === "string" && row.currency.trim() ? row.currency.trim().toUpperCase() : null;
    const key = currency ?? "__unknown_currency__";
    const amount = Number(row.amount ?? row.allocation_amount ?? 0);
    if (!Number.isFinite(amount)) continue;
    const summary = currencies.get(key) ?? {
      currency,
      phase: 0,
      project: 0,
      company: 0,
      unallocated: 0,
      total: 0,
      unknownCurrency: currency === null,
    };
    if (row.scope_kind === "phase") summary.phase += amount;
    else if (row.scope_kind === "project") summary.project += amount;
    else if (row.scope_kind === "company") summary.company += amount;
    else if (row.scope_kind === "unallocated") summary.unallocated += amount;
    summary.total += amount;
    currencies.set(key, summary);
    if (row.transaction_id != null) receiptIds.add(String(row.transaction_id));
  }

  return {
    currencies: [...currencies.values()].sort((a, b) => (a.currency ?? "ZZZ").localeCompare(b.currency ?? "ZZZ")),
    receiptCount: receiptIds.size,
    allocationCount: rows.length,
  };
}

export function summarizeFeeCharges(charges, allocations) {
  const paidByCharge = new Map();
  for (const row of allocations) {
    if (row.fee_charge_id == null) continue;
    const key = `${row.fee_charge_id}:${String(row.currency ?? "").toUpperCase()}`;
    paidByCharge.set(key, (paidByCharge.get(key) ?? 0) + Number(row.amount ?? row.allocation_amount ?? 0));
  }

  const totals = new Map();
  for (const charge of charges) {
    if (charge.status !== "open") continue;
    const currency = typeof charge.currency === "string" && charge.currency.trim() ? charge.currency.trim().toUpperCase() : null;
    const key = currency ?? "__unknown_currency__";
    const amount = Number(charge.amount ?? 0);
    if (!Number.isFinite(amount)) continue;
    const paid = paidByCharge.get(`${charge.id}:${currency ?? ""}`) ?? 0;
    const entry = totals.get(key) ?? { currency, assessed: 0, collected: 0, outstanding: 0, unknownCurrency: currency === null };
    entry.assessed += amount;
    entry.collected += paid;
    entry.outstanding += Math.max(amount - paid, 0);
    totals.set(key, entry);
  }
  return [...totals.values()].sort((a, b) => (a.currency ?? "ZZZ").localeCompare(b.currency ?? "ZZZ"));
}

export function summarizeAmountsByCurrency(rows, amountKey) {
  const totals = new Map();
  for (const row of rows) {
    const rawCurrency = row.currency;
    const currency = typeof rawCurrency === "string" && rawCurrency.trim() ? rawCurrency.trim().toUpperCase() : null;
    const key = currency ?? "__unknown_currency__";
    const amount = Number(row[amountKey] ?? 0);
    if (!Number.isFinite(amount)) continue;
    const entry = totals.get(key) ?? { currency, amount: 0, unknownCurrency: currency === null };
    entry.amount += amount;
    totals.set(key, entry);
  }
  return [...totals.values()].sort((a, b) => (a.currency ?? "ZZZ").localeCompare(b.currency ?? "ZZZ"));
}

export function formatCurrencyAmount(amount, currency) {
  if (currency == null || !String(currency).trim()) {
    return `${Number(amount ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (currency unverified)`;
  }
  try {
    return new Intl.NumberFormat("en-BZ", { style: "currency", currency: String(currency).toUpperCase() }).format(Number(amount ?? 0));
  } catch {
    return `${String(currency).toUpperCase()} ${Number(amount ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}
