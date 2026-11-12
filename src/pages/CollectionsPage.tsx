import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "../components/ui/Badge";
import { useWorkspaceScope } from "../components/auth/workspaceScopeContext";
import { getSessionAndProfile } from "../lib/data";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { SmartInsightsPanel } from "../components/ui/SmartInsightsPanel";
import { ErrorState, LoadingState } from "../components/ui/State";
import { accountDueDate, startOfDay } from "../lib/accountDates";
import { canAggregateCompanyFinance, canReadFinance, effectiveFinanceScope, formatCurrencyAmount, summarizeAllocationRows, summarizeAmountsByCurrency, summarizeFeeCharges } from "../lib/financialReporting.mjs";
import { collectionsOperationsInsights } from "../lib/smartInsights";
import { supabase } from "../lib/supabase";
import { workspaceScopeKey } from "../lib/workspaceScope";
import { cn, formatDate } from "../lib/utils";

type ContractCollectionRow = {
  id: number;
  tenant_id: string;
  project_id: string | null;
  phase_id: string | null;
  customer_id: number;
  currency: string | null;
  final_purchase_price: number;
  remaining_balance: number;
  monthly_payment: number;
  start_date: string;
  payment_due_day: number;
  signed_contract_file_path: string | null;
  is_active: boolean;
  status: string;
  customers?: { first_name: string; last_name: string } | null;
  parcels?: { lot_number: string } | null;
};

type PaymentCollectionRow = {
  id: number;
  transaction_id: number;
  customer_id: number;
  amount: number;
  currency: string | null;
  project_id: string | null;
  phase_id: string | null;
  scope_kind: "phase" | "project" | "company" | "unallocated";
  allocation_kind: "applied" | "unallocated" | "reversal";
  fee_charge_id: number | null;
  transaction_type: string;
  collection_method: string | null;
  bank_reference: string | null;
  manual_receipt_number: string | null;
  created_at: string;
  customers?: { first_name: string; last_name: string } | null;
  payment_documents?: Array<{ id: number }> | null;
};

export function CollectionsPage() {
  const { workspace, isLoading: workspaceLoading, error: workspaceError } = useWorkspaceScope();
  const { data: sessionProfile, isLoading: profileLoading } = useQuery({ queryKey: ["session-profile"], queryFn: getSessionAndProfile });
  const role = sessionProfile?.profile?.role ?? null;
  const [requestedFinanceScope, setRequestedFinanceScope] = useState<"phase" | "project" | "company">("phase");
  const financeScope = effectiveFinanceScope(role, requestedFinanceScope);
  const isCompanyAggregate = financeScope === "company";
  const isProjectAggregate = financeScope === "project";
  const canReadFinancials = canReadFinance(role);
  const canSeeContractBalances = role === "Admin" || role === "Super Admin";
  const scopeKey = `${workspaceScopeKey(workspace)}:${financeScope}:${role ?? "unknown"}`;
  const {
    data: contracts,
    isLoading: contractsLoading,
    error: contractsError,
  } = useQuery({
    queryKey: ["collections-contracts", scopeKey],
    queryFn: async () => {
      let query = supabase.from("contracts").select("id,tenant_id,project_id,phase_id,customer_id,currency,final_purchase_price,monthly_payment,start_date,payment_due_day,signed_contract_file_path,is_active,status,customers(first_name,last_name),parcels(lot_number)")
        .eq("tenant_id", workspace!.tenantId).eq("is_active", true).eq("status", "active");
      if (!isCompanyAggregate) {
        query = query.eq("project_id", workspace!.projectId);
        if (!isProjectAggregate) query = query.eq("phase_id", workspace!.phaseId);
      }
      const { data: rows, error: contractError } = await query.order("payment_due_day");
      if (contractError) throw contractError;
      if (!rows?.length) return [];
      const { data: summaries, error: summaryError } = await supabase.from("contract_financial_summary")
        .select("contract_id,remaining_balance,currency").in("contract_id", rows.map((row) => row.id));
      if (summaryError) throw summaryError;
      const byId = new Map((summaries ?? []).map((row) => [row.contract_id, row]));
      return rows.map((row) => ({ ...row, remaining_balance: Number(byId.get(row.id)?.remaining_balance ?? row.final_purchase_price), currency: byId.get(row.id)?.currency ?? row.currency })) as unknown as ContractCollectionRow[];
    },
    enabled: Boolean(workspace && canSeeContractBalances),
  });

  const {
    data: allocations,
    isLoading: allocationsLoading,
    error: allocationsError,
  } = useQuery({
    queryKey: ["collections-allocations", scopeKey],
    queryFn: async () => {
      if (role === "Read Only") {
        const { data, error } = await supabase.rpc("read_phase_payment_allocations_v1", { p_tenant_id: workspace!.tenantId, p_project_id: workspace!.projectId, p_phase_id: workspace!.phaseId });
        if (error) throw error;
        return ((data ?? []) as Array<{ allocation_id: number; transaction_id: number; customer_id: number; fee_charge_id: number | null; allocation_amount: number; currency: string | null; phase_id: string; allocation_kind: "applied" | "unallocated" | "reversal"; transaction_type: string; receipt_date: string | null; created_at: string }>).map((row) => ({
          id: row.allocation_id, transaction_id: row.transaction_id, customer_id: row.customer_id, amount: row.allocation_amount, currency: row.currency,
          fee_charge_id: row.fee_charge_id,
          project_id: workspace!.projectId, phase_id: row.phase_id, scope_kind: "phase" as const, allocation_kind: row.allocation_kind,
          transaction_type: row.transaction_type, collection_method: null, bank_reference: null, manual_receipt_number: null,
          created_at: row.created_at || row.receipt_date || "",
        })) as PaymentCollectionRow[];
      }
      let query = supabase.from("transaction_allocations").select("id,tenant_id,transaction_id,customer_id,amount,currency,scope_kind,project_id,phase_id,fee_charge_id,allocation_kind")
        .eq("tenant_id", workspace!.tenantId);
      if (isProjectAggregate) query = query.in("scope_kind", ["phase", "project"]).eq("project_id", workspace!.projectId);
      else if (!isCompanyAggregate) query = query.eq("scope_kind", "phase").eq("project_id", workspace!.projectId).eq("phase_id", workspace!.phaseId);
      const { data: rows, error: allocationError } = await query.order("created_at", { ascending: false });
      if (allocationError) throw allocationError;
      const allocationRows = rows ?? [];
      const transactionIds = [...new Set(allocationRows.map((row) => row.transaction_id))];
      if (!transactionIds.length) return [];
      const { data: parents, error: parentError } = await supabase.from("transactions")
        .select("id,transaction_type,collection_method,bank_reference,manual_receipt_number,created_at,payment_documents(id)")
        .eq("tenant_id", workspace!.tenantId).in("id", transactionIds);
      if (parentError) throw parentError;
      const parentById = new Map((parents ?? []).map((row) => [row.id, row]));
      const customerIds = [...new Set(allocationRows.map((row) => row.customer_id))];
      const { data: customers, error: customerError } = await supabase.from("customers").select("id,first_name,last_name").eq("tenant_id", workspace!.tenantId).in("id", customerIds);
      if (customerError) throw customerError;
      const customerById = new Map((customers ?? []).map((row) => [row.id, row]));
      return allocationRows.map((row) => {
        const parent = parentById.get(row.transaction_id);
        const customer = customerById.get(row.customer_id);
        return {
          id: row.id, transaction_id: row.transaction_id, customer_id: row.customer_id, amount: Number(row.amount), currency: row.currency,
          fee_charge_id: row.fee_charge_id,
          project_id: row.project_id, phase_id: row.phase_id, scope_kind: row.scope_kind, allocation_kind: row.allocation_kind,
          transaction_type: parent?.transaction_type ?? "Unallocated legacy receipt", collection_method: parent?.collection_method ?? null,
          bank_reference: parent?.bank_reference ?? null, manual_receipt_number: parent?.manual_receipt_number ?? null,
          created_at: parent?.created_at ?? "", customers: customer ? { first_name: customer.first_name ?? "", last_name: customer.last_name ?? "" } : null,
          payment_documents: parent?.payment_documents ?? [],
        } satisfies PaymentCollectionRow & { customers?: { first_name: string; last_name: string } | null };
      }) as Array<PaymentCollectionRow & { customers?: { first_name: string; last_name: string } | null }>;
    },
    enabled: Boolean(workspace && canReadFinancials),
  });

  const feeChargesQuery = useQuery({
    queryKey: ["collections-fee-charges", scopeKey],
    queryFn: async () => {
      let query = supabase.from("fee_charges").select("id,amount,currency,status,scope_kind,project_id,phase_id").eq("tenant_id", workspace!.tenantId);
      if (isProjectAggregate) query = query.in("scope_kind", ["phase", "project"]).eq("project_id", workspace!.projectId);
      else if (!isCompanyAggregate) query = query.eq("scope_kind", "phase").eq("project_id", workspace!.projectId).eq("phase_id", workspace!.phaseId);
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
    enabled: Boolean(workspace && canReadFinancials),
  });

  const today = startOfDay(new Date());
  const weekEnd = addDays(today, 7);
  const contractGroups = useMemo(() => {
    const rows = contracts ?? [];
    const withDue = rows.map((contract) => ({ contract, dueDate: dueDateForCurrentCycle(contract, today) }));
    return {
      dueToday: withDue.filter((row) => isSameDay(row.dueDate, today)),
      dueThisWeek: withDue.filter((row) => row.dueDate > today && row.dueDate <= weekEnd),
      overdue: withDue.filter((row) => row.dueDate < today && outstandingBalance(row.contract) > 0),
      missingSigned: rows.filter((contract) => !contract.signed_contract_file_path),
    };
  }, [contracts, today, weekEnd]);

  const paymentGroups = useMemo(() => {
    const rows = groupAllocationsByReceipt(allocations ?? []);
    if (role === "Read Only") return { missingReceipts: [], missingProof: [] };
    return {
      missingReceipts: rows.filter((payment) => !payment.manual_receipt_number),
      missingProof: rows.filter((payment) => payment.collection_method === "Online Transfer" && !payment.payment_documents?.length),
    };
  }, [allocations, role]);

  const isLoading = workspaceLoading || profileLoading || contractsLoading || allocationsLoading || feeChargesQuery.isLoading;
  const error = contractsError || allocationsError || feeChargesQuery.error;
  const allocationRows = allocations ?? [];
  const paymentSummary = summarizeAllocationRows(allocationRows);
  const feeSummary = summarizeFeeCharges(feeChargesQuery.data ?? [], allocationRows);
  const balanceSummary = summarizeAmountsByCurrency(contracts ?? [], "remaining_balance");
  const operationsInsights = collectionsOperationsInsights({
    overdueCustomers: contractGroups.overdue.length,
    missingSignedContracts: contractGroups.missingSigned.length,
    missingReceipts: paymentGroups.missingReceipts.length,
    missingProofs: paymentGroups.missingProof.length,
  });

  return (
    <section className="v2-page-shell">
      <div className="v2-page-header">
        <p className="v2-page-kicker">Collections Operations</p>
        <h1 className="v2-page-title">Collections</h1>
        <p className="v2-page-description">Account standing, due accounts, missing documents, and follow-up queues.</p>
      </div>
      {workspace && canAggregateCompanyFinance(role) ? <CollectionsScopeControl value={financeScope} onChange={setRequestedFinanceScope} /> : null}
      {isLoading ? <LoadingState /> : null}
      {!workspace && !workspaceLoading ? <ErrorState message={workspaceError ?? "Choose an accessible workspace to view its collections."} /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      {role && !canReadFinancials ? <ErrorState message="Collections amounts and account records are not available to this role." /> : null}
      {canReadFinancials ? <>
        <div className="v2-archive-panel p-4 text-sm text-primary">{financeScope === "company" ? "Company aggregate for the verified tenant. Receipt allocations count once; currencies remain separate and unresolved legacy rows stay unallocated." : financeScope === "project" ? `Project aggregate for ${workspace?.projectName ?? "selected project"}; includes its phase and project-scoped obligations only.` : `Exact phase: ${workspace?.phaseName ?? "selected phase"}. Other phase and unscoped amounts are not included.`}</div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {canSeeContractBalances ? balanceSummary.map((row) => <Metric key={`balance-${row.currency ?? "unknown"}`} title={`Outstanding land · ${row.currency ?? "unverified currency"}`} value={formatCurrencyAmount(row.amount, row.currency)} material="ledger" />) : null}
          {paymentSummary.currencies.map((row) => <Metric key={`cash-${row.currency ?? "unknown"}`} title={`Allocated cash · ${row.currency ?? "unverified currency"}`} value={formatCurrencyAmount(row.phase + row.project + row.company, row.currency)} material="ledger" />)}
          {paymentSummary.currencies.filter((row) => row.unallocated !== 0).map((row) => <Metric key={`unallocated-${row.currency ?? "unknown"}`} title={`Unallocated cash · ${row.currency ?? "unverified currency"}`} value={formatCurrencyAmount(row.unallocated, row.currency)} material="ledger" />)}
          {feeSummary.map((row) => <Metric key={`fees-${row.currency ?? "unknown"}`} title={`Open assessed fees · ${row.currency ?? "unverified currency"}`} value={formatCurrencyAmount(row.outstanding, row.currency)} material="ledger" />)}
        </div>
        {role === "Read Only" ? <Card className="v2-archive-panel"><CardContent className="p-5 text-sm text-muted-foreground">Read Only collections are limited to exact-phase allocation and assessed-fee totals. Contract prices, due queues, receipt metadata and document status are not included.</CardContent></Card> : <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Metric title="Due today" value={contractGroups.dueToday.length} material="workflow" />
            <Metric title="Due this week" value={contractGroups.dueThisWeek.length} material="workflow" />
            <Metric title="Overdue" value={contractGroups.overdue.length} material="workflow" />
          </div>
          <div className="v2-advisor-panel p-4">
            <SmartInsightsPanel title="Operations Insights" description="Display-only collections flags for the selected reporting scope." insights={operationsInsights} />
          </div>
          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            <ContractQueue title="Customers due today" rows={contractGroups.dueToday} tone="blue" />
            <ContractQueue title="Customers due this week" rows={contractGroups.dueThisWeek} tone="green" />
            <ContractQueue title="Overdue customers" rows={contractGroups.overdue} tone="red" />
            <ContractMissingQueue title="Contracts missing signed upload" rows={contractGroups.missingSigned} />
            <PaymentQueue title="Payments missing manual receipt numbers" rows={paymentGroups.missingReceipts} />
            <PaymentQueue title="Online transfers missing uploaded proof" rows={paymentGroups.missingProof} />
          </div>
        </>}
      </> : null}
    </section>
  );
}

function Metric({ title, value, material }: { title: string; value: string | number; material: "ledger" | "workflow" }) {
  return (
    <Card className={material === "ledger" ? "v2-ledger-panel" : "v2-workflow-panel"}>
      <CardHeader><CardTitle className="text-sm text-muted-foreground">{title}</CardTitle></CardHeader>
      <CardContent><p className="text-3xl font-semibold text-primary tabular-nums">{value}</p></CardContent>
    </Card>
  );
}

function CollectionsScopeControl({ value, onChange }: { value: "phase" | "project" | "company"; onChange: (value: "phase" | "project" | "company") => void }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/80 p-3" aria-label="Collections scope">
      <div><p className="text-sm font-medium text-foreground">Collections scope</p><p className="text-xs text-muted-foreground">Company totals are available only to Admin and Super Admin.</p></div>
      <div className="flex gap-2">
        <button type="button" aria-pressed={value === "phase"} className={cn("rounded-lg border px-3 py-2 text-sm", value === "phase" ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground")} onClick={() => onChange("phase")}>Selected phase</button>
        <button type="button" aria-pressed={value === "project"} className={cn("rounded-lg border px-3 py-2 text-sm", value === "project" ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground")} onClick={() => onChange("project")}>Project aggregate</button>
        <button type="button" aria-pressed={value === "company"} className={cn("rounded-lg border px-3 py-2 text-sm", value === "company" ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground")} onClick={() => onChange("company")}>Company aggregate</button>
      </div>
    </div>
  );
}

function ContractQueue({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: Array<{ contract: ContractCollectionRow; dueDate: Date }>;
  tone: "blue" | "green" | "red";
}) {
  return (
    <Card className={tone === "red" ? "border-warning/25 bg-accent-soft/40" : "v2-workflow-panel"}>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No customers in this queue.</p> : null}
        {rows.map(({ contract, dueDate }) => (
          <div key={contract.id} className="v2-record-row">
            <div className="flex justify-between gap-3">
              <Link className="font-medium text-primary hover:text-copper" to={`/customers/${contract.customer_id}`}>
                {customerName(contract.customers)}
              </Link>
              <Badge tone={tone}>{formatDate(dueDate.toISOString())}</Badge>
            </div>
            <p className="text-muted-foreground">Lot {contract.parcels?.lot_number ?? "N/A"} | Balance {formatCurrencyAmount(outstandingBalance(contract), contract.currency)}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ContractMissingQueue({ title, rows }: { title: string; rows: ContractCollectionRow[] }) {
  return (
    <Card className="v2-workflow-panel">
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No missing signed contracts.</p> : null}
        {rows.map((contract) => (
          <div key={contract.id} className="v2-record-row">
            <Link className="font-medium text-primary hover:text-copper" to={`/customers/${contract.customer_id}`}>
              {customerName(contract.customers)}
            </Link>
            <p className="text-muted-foreground">Contract #{contract.id} | Lot {contract.parcels?.lot_number ?? "N/A"}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PaymentQueue({ title, rows }: { title: string; rows: PaymentCollectionRow[] }) {
  return (
    <Card className="v2-ledger-panel">
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No payments in this queue.</p> : null}
        {rows.map((payment) => (
          <div key={payment.id} className="v2-ledger-row">
            <div className="flex justify-between gap-3">
              <Link className="font-medium text-primary hover:text-copper" to={`/customers/${payment.customer_id}`}>
                {customerName(payment.customers)}
              </Link>
              <Badge tone="amber">{formatCurrencyAmount(payment.amount, payment.currency)}</Badge>
            </div>
            <p className="text-muted-foreground">{payment.transaction_type} on {formatDate(payment.created_at)}</p>
            <p className="text-muted-foreground">Reference: {payment.bank_reference ?? "N/A"} | Receipt: {payment.manual_receipt_number ?? "Missing"}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function outstandingBalance(contract: ContractCollectionRow) {
  return Number(contract.remaining_balance ?? 0);
}

function groupAllocationsByReceipt(rows: PaymentCollectionRow[]) {
  const grouped = new Map<string, PaymentCollectionRow>();
  for (const row of rows) {
    const key = `${row.transaction_id}:${row.currency ?? "unknown"}`;
    const existing = grouped.get(key);
    if (existing) existing.amount += Number(row.amount);
    else grouped.set(key, { ...row, amount: Number(row.amount) });
  }
  return [...grouped.values()];
}

function dueDateForCurrentCycle(contract: ContractCollectionRow, today: Date) {
  return accountDueDate(contract, today);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function customerName(customer?: { first_name: string; last_name: string } | null) {
  return `${customer?.first_name ?? ""} ${customer?.last_name ?? ""}`.trim() || "Unknown customer";
}
