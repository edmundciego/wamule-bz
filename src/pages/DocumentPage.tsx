import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { ErrorState, LoadingState } from "../components/ui/State";
import { useCompanyProfile } from "../lib/brand";
import { activeContract as canonicalActiveContract, remainingLandBalance, totalPostedLandPayments } from "../lib/financial";
import { supabase } from "../lib/supabase";
import { formatDate, money } from "../lib/utils";

type DocumentKind = "receipt" | "balance" | "ledger";

const communityTypes = ["Garbage Fee", "Road Maintenance"];

export function DocumentPage() {
  const { kind, id } = useParams();
  const documentKind = kind as DocumentKind;
  const numericId = Number(id);

  const { data, isLoading, error } = useQuery({
    queryKey: ["document", documentKind, numericId],
    queryFn: async () => {
      if (documentKind === "receipt") return getReceiptDocument(numericId);
      if (documentKind === "balance") return getCustomerDocument(numericId);
      if (documentKind === "ledger") return getCustomerDocument(numericId);
      throw new Error("Unknown document type.");
    },
    enabled: ["receipt", "balance", "ledger"].includes(documentKind) && Number.isFinite(numericId),
  });

  return (
    <main className="min-h-screen bg-background p-4 print:bg-white print:p-0">
      <div className="print-hidden mx-auto mb-4 flex max-w-4xl items-center justify-between gap-3">
        <Link className="text-sm font-medium text-primary hover:text-copper" to="/customers">
          Back to admin
        </Link>
        <Button type="button" onClick={() => window.print()}>
          Print / Save PDF
        </Button>
      </div>
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      {data && documentKind === "receipt" ? <ReceiptDocument data={data as ReceiptDocumentData} /> : null}
      {data && documentKind === "balance" ? <BalanceStatement data={data as CustomerDocumentData} /> : null}
      {data && documentKind === "ledger" ? <LedgerStatement data={data as CustomerDocumentData} /> : null}
    </main>
  );
}

async function getReceiptDocument(transactionId: number) {
  const { data: transaction, error } = await supabase
    .from("transactions")
    .select("*, customers(*), contracts(*, parcels(*))")
    .eq("id", transactionId)
    .single();
  if (error) throw error;

  const { data: profile } = await supabase
    .from("admin_profiles")
    .select("full_name")
    .eq("user_id", transaction.authorized_by)
    .maybeSingle();

  const { data: allTransactions, error: transactionError } = await supabase
    .from("transactions")
    .select("*")
    .eq("customer_id", transaction.customer_id)
    .order("created_at", { ascending: true });
  if (transactionError) throw transactionError;

  const { data: customerContracts } = await supabase
    .from("contracts")
    .select("*, parcels(*)")
    .eq("customer_id", transaction.customer_id)
    .order("is_active", { ascending: false });

  return {
    transaction,
    customerContracts: customerContracts ?? [],
    authorizedAdmin: profile?.full_name ?? transaction.authorized_by,
    remainingBalance: remainingLandBalance(transaction.contracts ?? activeContract(customerContracts ?? []), allTransactions ?? []),
  };
}

async function getCustomerDocument(customerId: number) {
  const { data: customer, error } = await supabase
    .from("customers")
    .select("*, applications(*, parcels(*)), contracts(*, parcels(*)), transactions(*)")
    .eq("id", customerId)
    .single();
  if (error) throw error;

  const { data: communityStatus } = await supabase
    .from("community_fee_account_status")
    .select("*")
    .eq("customer_id", customerId)
    .maybeSingle();

  return { customer, communityStatus };
}

type ReceiptDocumentData = Awaited<ReturnType<typeof getReceiptDocument>>;
type CustomerDocumentData = Awaited<ReturnType<typeof getCustomerDocument>>;

function ReceiptDocument({ data }: { data: ReceiptDocumentData }) {
  const { transaction } = data;
  const customer = transaction.customers;
  const contract = transaction.contracts;
  const fallbackContract = activeContract(data.customerContracts);
  const lotNumber = contract?.parcels?.lot_number ?? fallbackContract?.parcels?.lot_number ?? "N/A";

  return (
    <DocumentShell title="Payment Receipt" documentNumber={transaction.receipt_number}>
      <InfoGrid
        rows={[
          ["Receipt number", transaction.receipt_number],
          ["Customer", fullName(customer)],
          ["Lot number", `Lot ${lotNumber}`],
          ["Payment amount", money(transaction.amount)],
          ["Payment method", transaction.collection_method],
          ["Payment date", formatDate(transaction.created_at)],
          ["Bank reference", transaction.bank_reference ?? "N/A"],
          ["Authorized admin", data.authorizedAdmin],
          ["Remaining balance", data.remainingBalance === null ? "N/A" : money(data.remainingBalance)],
        ]}
      />
      {transaction.notes ? <NoteBlock title="Payment notes" body={transaction.notes} /> : null}
    </DocumentShell>
  );
}

function BalanceStatement({ data }: { data: CustomerDocumentData }) {
  const { customer, communityStatus } = data;
  const contract = activeContract(customer.contracts);
  const transactions = sortedTransactions(customer.transactions ?? []);
  const landPaid = contract ? totalPostedLandPayments(transactions, contract.id) : 0;
  const communityPaid = sumTransactions(transactions, communityTypes);
  const balance = remainingLandBalance(contract, transactions);

  return (
    <DocumentShell title="Balance Statement" documentNumber={`BS-${customer.id}-${dateStamp()}`}>
      <InfoGrid
        rows={[
          ["Customer", fullName(customer)],
          ["Lot number", contract?.parcels?.lot_number ? `Lot ${contract.parcels.lot_number}` : "N/A"],
          ["Original purchase price", contract ? money(contract.final_purchase_price) : "N/A"],
          ["Initial deposit", contract ? money(contract.initial_deposit) : "N/A"],
          ["Total land paid", money(landPaid)],
          ["Remaining land balance", balance === null ? "N/A" : money(balance)],
          ["Monthly payment", contract ? money(contract.monthly_payment) : "N/A"],
          ["Next due date", contract ? formatDate(nextDueDate(contract)) : "N/A"],
          ["Community fees paid", money(communityPaid)],
          ["Community fee standing", communityStanding(communityStatus)],
        ]}
      />
      <TransactionSummary title="Payment history summary" rows={transactions.slice(0, 8)} />
    </DocumentShell>
  );
}

function LedgerStatement({ data }: { data: CustomerDocumentData }) {
  const { customer, communityStatus } = data;
  const contract = activeContract(customer.contracts);
  const transactions = sortedTransactions(customer.transactions ?? []);
  const landPaid = contract ? totalPostedLandPayments(transactions, contract.id) : 0;
  const expectedLandPaid = contract ? expectedLandDue(contract) : 0;
  const missedAmount = contract ? Math.max(expectedLandPaid - landPaid, 0) : 0;

  return (
    <DocumentShell title="Customer Ledger Statement" documentNumber={`LS-${customer.id}-${dateStamp()}`}>
      <InfoGrid
        rows={[
          ["Customer", fullName(customer)],
          ["Contract", contract ? `Contract #${contract.id}` : "N/A"],
          ["Lot number", contract?.parcels?.lot_number ? `Lot ${contract.parcels.lot_number}` : "N/A"],
          ["Contract terms", contract ? `${money(contract.final_purchase_price)} over ${contract.term_months} months` : "N/A"],
          ["Initial deposit", contract ? money(contract.initial_deposit) : "N/A"],
          ["Monthly payment", contract ? money(contract.monthly_payment) : "N/A"],
          ["Payment due day", contract ? String(contract.payment_due_day) : "N/A"],
          ["Expected land paid to date", contract ? money(expectedLandPaid) : "N/A"],
          ["Missed/short payment amount", contract ? money(missedAmount) : "N/A"],
          ["Community fee standing", communityStanding(communityStatus)],
        ]}
      />
      <TransactionTable title="Full transaction history" rows={transactions} />
    </DocumentShell>
  );
}

function DocumentShell({
  title,
  documentNumber,
  children,
}: {
  title: string;
  documentNumber: string;
  children: React.ReactNode;
}) {
  const { company, companyName, shortName, isLoading: companyLoading, isUnavailable: companyUnavailable } = useCompanyProfile();

  if (companyLoading) {
    return (
      <article className="mx-auto max-w-4xl rounded-lg border bg-white p-8 shadow-sm print:max-w-none print:rounded-none print:border-0 print:shadow-none">
        <LoadingState label="Loading document branding…" />
      </article>
    );
  }

  return (
    <article className="mx-auto max-w-4xl rounded-lg border bg-white p-8 shadow-sm print:max-w-none print:rounded-none print:border-0 print:shadow-none">
      <header className="mb-8 flex items-start justify-between gap-6 border-b border-copper/30 pb-5">
        <div className="flex items-center gap-4">
          <img src={companyUnavailable ? "/favicon/android-chrome-192x192.png" : company.logo_url} alt={companyUnavailable ? "Company logo" : companyName} className="h-16 w-16 rounded-md border bg-ivory object-cover" />
          <div>
            <p className="font-display text-3xl font-semibold text-primary">{companyUnavailable ? "Company" : shortName}</p>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-copper">{companyUnavailable ? "Administrative record" : "Development"}</p>
          </div>
        </div>
        <div className="text-right text-sm">
          <h1 className="font-display text-3xl font-semibold text-primary">{title}</h1>
          <p className="mt-1 text-muted-foreground">Document #: {documentNumber}</p>
          <p className="text-muted-foreground">Generated: {formatDate(new Date().toISOString())}</p>
        </div>
      </header>
      {children}
      <footer className="mt-8 border-t pt-4 text-xs text-muted-foreground">
        This document was generated from {companyUnavailable ? "company" : companyName} administrative records.
      </footer>
    </article>
  );
}

function InfoGrid({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="rounded-md border bg-ivory/40 p-3">
          <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-copper">{label}</dt>
          <dd className="mt-1 text-sm font-medium text-primary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function NoteBlock({ title, body }: { title: string; body: string }) {
  return (
    <section className="mt-6 rounded-md border p-4">
      <h2 className="font-display text-xl font-semibold text-primary">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
    </section>
  );
}

function TransactionSummary({ title, rows }: { title: string; rows: TransactionRow[] }) {
  return (
    <section className="mt-6">
      <h2 className="font-display text-xl font-semibold text-primary">{title}</h2>
      <div className="mt-3 grid gap-2">
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No transactions recorded.</p> : null}
        {rows.map((row) => (
          <div key={row.id} className="flex justify-between gap-4 rounded-md border p-3 text-sm">
            <span>{formatDate(row.created_at)} - {row.transaction_type}</span>
            <span className="font-medium">{money(row.amount)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TransactionTable({ title, rows }: { title: string; rows: TransactionRow[] }) {
  return (
    <section className="mt-6">
      <h2 className="font-display text-xl font-semibold text-primary">{title}</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b bg-ivory">
              <th className="p-2">Date</th>
              <th className="p-2">Receipt</th>
              <th className="p-2">Type</th>
              <th className="p-2">Method</th>
              <th className="p-2">Reference</th>
              <th className="p-2 text-right">Amount</th>
              <th className="p-2">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b">
                <td className="p-2">{formatDate(row.created_at)}</td>
                <td className="p-2">{row.receipt_number}</td>
                <td className="p-2">{row.transaction_type}</td>
                <td className="p-2">{row.collection_method}</td>
                <td className="p-2">{row.bank_reference ?? "N/A"}</td>
                <td className="p-2 text-right font-medium">{money(row.amount)}</td>
                <td className="p-2">{row.notes ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type TransactionRow = {
  id: number;
  receipt_number: string;
  transaction_type: string;
  collection_method: string;
  bank_reference: string | null;
  amount: number;
  contract_id: number | null;
  status: string;
  notes: string | null;
  created_at: string;
};

function fullName(customer?: { first_name?: string | null; last_name?: string | null } | null) {
  return `${customer?.first_name ?? ""} ${customer?.last_name ?? ""}`.trim() || "N/A";
}

function sortedTransactions(rows: TransactionRow[]) {
  return [...rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

function sumTransactions(rows: TransactionRow[], types: string[]) {
  return rows
    .filter((row) => types.includes(row.transaction_type))
    .reduce((sum, row) => sum + Number(row.amount), 0);
}

function activeContract(contracts?: ContractRow[] | null) {
  return canonicalActiveContract(contracts);
}

type ContractRow = {
  id: number;
  is_active: boolean;
  status: string;
  final_purchase_price: number;
  initial_deposit: number;
  term_months: number;
  monthly_payment: number;
  start_date: string;
  payment_due_day: number;
  parcels?: { lot_number?: string | null } | null;
};

function nextDueDate(contract: ContractRow) {
  const now = new Date();
  const due = new Date(now.getFullYear(), now.getMonth(), contract.payment_due_day);
  if (due < now) due.setMonth(due.getMonth() + 1);
  return due.toISOString();
}

function expectedLandDue(contract: ContractRow) {
  const start = new Date(contract.start_date);
  const now = new Date();
  const months =
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth()) +
    (now.getDate() >= contract.payment_due_day ? 1 : 0);
  return Math.min(
    Number(contract.initial_deposit) + Math.max(months, 0) * Number(contract.monthly_payment),
    Number(contract.final_purchase_price),
  );
}

function communityStanding(status: { community_fee_balance?: number | null } | null) {
  if (!status) return "No community fee status available";
  const balance = Number(status.community_fee_balance ?? 0);
  return balance > 0 ? `${money(balance)} outstanding` : "Current";
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10).replaceAll("-", "");
}
