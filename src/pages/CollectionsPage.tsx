import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { ErrorState, LoadingState } from "../components/ui/State";
import { supabase } from "../lib/supabase";
import { formatDate, money } from "../lib/utils";

type ContractCollectionRow = {
  id: number;
  customer_id: number;
  final_purchase_price: number;
  monthly_payment: number;
  start_date: string;
  payment_due_day: number;
  signed_contract_file_path: string | null;
  is_active: boolean;
  customers?: { first_name: string; last_name: string } | null;
  parcels?: { lot_number: string } | null;
  transactions?: Array<{ amount: number; transaction_type: string }> | null;
};

type PaymentCollectionRow = {
  id: number;
  customer_id: number;
  amount: number;
  transaction_type: string;
  collection_method: string;
  bank_reference: string | null;
  manual_receipt_number: string | null;
  created_at: string;
  customers?: { first_name: string; last_name: string } | null;
  payment_documents?: Array<{ id: number }> | null;
};

export function CollectionsPage() {
  const {
    data: contracts,
    isLoading: contractsLoading,
    error: contractsError,
  } = useQuery({
    queryKey: ["collections-contracts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contracts")
        .select("*, customers(first_name, last_name), parcels(lot_number), transactions(amount, transaction_type)")
        .eq("is_active", true)
        .order("payment_due_day");
      if (error) throw error;
      return data as ContractCollectionRow[];
    },
  });

  const {
    data: payments,
    isLoading: paymentsLoading,
    error: paymentsError,
  } = useQuery({
    queryKey: ["collections-payments"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("transactions")
        .select("*, customers(first_name, last_name), payment_documents(id)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as PaymentCollectionRow[];
    },
  });

  const today = startOfDay(new Date());
  const weekEnd = addDays(today, 7);
  const contractGroups = useMemo(() => {
    const rows = contracts ?? [];
    const withDue = rows.map((contract) => ({ contract, dueDate: dueDateForCurrentCycle(contract, today) }));
    return {
      dueToday: withDue.filter((row) => isSameDay(row.dueDate, today)),
      dueThisWeek: withDue.filter((row) => row.dueDate > today && row.dueDate <= weekEnd),
      overdue: withDue.filter((row) => row.dueDate < today),
      missingSigned: rows.filter((contract) => !contract.signed_contract_file_path),
      outstanding: rows.reduce((sum, contract) => sum + outstandingBalance(contract), 0),
    };
  }, [contracts, today, weekEnd]);

  const paymentGroups = useMemo(() => {
    const rows = payments ?? [];
    return {
      missingReceipts: rows.filter((payment) => !payment.manual_receipt_number),
      missingProof: rows.filter((payment) => payment.collection_method === "Online Transfer" && !payment.payment_documents?.length),
    };
  }, [payments]);

  const isLoading = contractsLoading || paymentsLoading;
  const error = contractsError || paymentsError;

  return (
    <>
      <PageHeader title="Collections" description="Account standing, due accounts, missing documents, and follow-up queues." />
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric title="Outstanding land balance" value={money(contractGroups.outstanding)} />
        <Metric title="Due today" value={contractGroups.dueToday.length} />
        <Metric title="Due this week" value={contractGroups.dueThisWeek.length} />
        <Metric title="Overdue" value={contractGroups.overdue.length} />
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <ContractQueue title="Customers due today" rows={contractGroups.dueToday} tone="blue" />
        <ContractQueue title="Customers due this week" rows={contractGroups.dueThisWeek} tone="green" />
        <ContractQueue title="Overdue customers" rows={contractGroups.overdue} tone="red" />
        <ContractMissingQueue title="Contracts missing signed upload" rows={contractGroups.missingSigned} />
        <PaymentQueue title="Payments missing manual receipt numbers" rows={paymentGroups.missingReceipts} />
        <PaymentQueue title="Online transfers missing uploaded proof" rows={paymentGroups.missingProof} />
      </div>
    </>
  );
}

function Metric({ title, value }: { title: string; value: string | number }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm text-muted-foreground">{title}</CardTitle></CardHeader>
      <CardContent><p className="font-display text-3xl font-semibold text-primary">{value}</p></CardContent>
    </Card>
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
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No customers in this queue.</p> : null}
        {rows.map(({ contract, dueDate }) => (
          <div key={contract.id} className="rounded-md border p-3 text-sm">
            <div className="flex justify-between gap-3">
              <Link className="font-medium text-primary hover:text-copper" to={`/customers/${contract.customer_id}`}>
                {customerName(contract.customers)}
              </Link>
              <Badge tone={tone}>{formatDate(dueDate.toISOString())}</Badge>
            </div>
            <p className="text-muted-foreground">Lot {contract.parcels?.lot_number ?? "N/A"} | Balance {money(outstandingBalance(contract))}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ContractMissingQueue({ title, rows }: { title: string; rows: ContractCollectionRow[] }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No missing signed contracts.</p> : null}
        {rows.map((contract) => (
          <div key={contract.id} className="rounded-md border p-3 text-sm">
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
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No payments in this queue.</p> : null}
        {rows.map((payment) => (
          <div key={payment.id} className="rounded-md border p-3 text-sm">
            <div className="flex justify-between gap-3">
              <Link className="font-medium text-primary hover:text-copper" to={`/customers/${payment.customer_id}`}>
                {customerName(payment.customers)}
              </Link>
              <Badge tone="amber">{money(payment.amount)}</Badge>
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
  const paid = contract.transactions
    ?.filter((transaction) => ["Down Payment", "Land Installment"].includes(transaction.transaction_type))
    .reduce((sum, transaction) => sum + Number(transaction.amount), 0) ?? 0;
  return Math.max(Number(contract.final_purchase_price) - paid, 0);
}

function dueDateForCurrentCycle(contract: ContractCollectionRow, today: Date) {
  const due = new Date(today.getFullYear(), today.getMonth(), contract.payment_due_day);
  if (due < today && outstandingBalance(contract) <= 0) {
    due.setMonth(due.getMonth() + 1);
  }
  return due;
}

function customerName(customer?: { first_name: string; last_name: string } | null) {
  return `${customer?.first_name ?? ""} ${customer?.last_name ?? ""}`.trim() || "Unknown customer";
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
