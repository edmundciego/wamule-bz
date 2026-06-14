import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Field, Input, Select } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { exportCsv, reportFileName } from "../lib/csv";
import { supabase } from "../lib/supabase";
import { cn, formatDate, money } from "../lib/utils";
import type { CollectionMethod, TransactionType } from "../types/database";

type ReportTab = "Payments" | "Balances" | "Applications" | "Lots" | "Missing Items";
type PaymentReportRow = {
  id: number;
  customer_id: number;
  contract_id: number | null;
  amount: number;
  transaction_type: TransactionType;
  collection_method: CollectionMethod;
  bank_reference: string | null;
  manual_receipt_number: string | null;
  receipt_issued_by: string | null;
  notes: string | null;
  created_at: string;
  customers?: { first_name: string; last_name: string } | null;
  contracts?: { parcels?: { lot_number: string | null } | null } | null;
  payment_documents?: Array<{ id: number }> | null;
};
type ContractReportRow = {
  id: number;
  final_purchase_price: number;
  monthly_payment: number;
  start_date: string;
  payment_due_day: number;
  signed_contract_file_path: string | null;
  is_active: boolean;
  customers?: { id: number; first_name: string; last_name: string } | null;
  parcels?: { lot_number: string | null } | null;
  transactions?: Array<{ amount: number; transaction_type: string; created_at: string }> | null;
};
type ApplicationReportRow = {
  id: number;
  applicant_full_name?: string | null;
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  preferred_parcel_ids?: number[] | null;
  alternate_lot_preference?: string | null;
  intended_use?: string | null;
  payment_option?: string | null;
  status: string;
  created_at: string;
  applicant_address?: string | null;
  legal_notice_acknowledged?: boolean | null;
};
type LotReportRow = {
  id: number;
  lot_number: string;
  dimensions: string;
  base_price: number;
  status: string;
  customer_name: string | null;
  contract_id: number | null;
};
type CustomerReportRow = {
  id: number;
  first_name: string;
  last_name: string;
  contracts?: Array<{ id: number; is_active: boolean }> | null;
};

const tabs: ReportTab[] = ["Payments", "Balances", "Applications", "Lots", "Missing Items"];
const transactionTypes: TransactionType[] = ["Down Payment", "Land Installment", "Garbage Fee", "Road Maintenance"];
const collectionMethods: CollectionMethod[] = ["Cash", "Online Transfer"];

export function ReportsPage() {
  const [activeTab, setActiveTab] = useState<ReportTab>("Payments");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [transactionType, setTransactionType] = useState("");
  const [collectionMethod, setCollectionMethod] = useState("");

  const paymentsQuery = useQuery({
    queryKey: ["reports-payments"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("transactions")
        .select("*, customers(first_name, last_name), contracts(parcels(lot_number)), payment_documents(id)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as PaymentReportRow[];
    },
  });
  const contractsQuery = useQuery({
    queryKey: ["reports-contracts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contracts")
        .select("*, customers(id, first_name, last_name), parcels(lot_number), transactions(amount, transaction_type, created_at)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as ContractReportRow[];
    },
  });
  const applicationsQuery = useQuery({
    queryKey: ["reports-applications"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("applications")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as ApplicationReportRow[];
    },
  });
  const lotsQuery = useQuery({
    queryKey: ["reports-lots"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("parcel_board_view")
        .select("*")
        .order("lot_number", { ascending: true });
      if (error) throw error;
      return data as LotReportRow[];
    },
  });
  const customersQuery = useQuery({
    queryKey: ["reports-customers"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("id, first_name, last_name, contracts(id, is_active)")
        .order("last_name", { ascending: true });
      if (error) throw error;
      return data as CustomerReportRow[];
    },
  });

  const isLoading = paymentsQuery.isLoading || contractsQuery.isLoading || applicationsQuery.isLoading || lotsQuery.isLoading || customersQuery.isLoading;
  const error = paymentsQuery.error || contractsQuery.error || applicationsQuery.error || lotsQuery.error || customersQuery.error;

  const customerOptions = useMemo(() => {
    const map = new Map<number, string>();
    paymentsQuery.data?.forEach((payment) => {
      if (payment.customers) map.set(payment.customer_id, customerName(payment.customers));
    });
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [paymentsQuery.data]);

  const filteredPayments = useMemo(
    () =>
      paymentsQuery.data?.filter((payment) => {
        const created = new Date(payment.created_at);
        const matchesFrom = !dateFrom || created >= startOfDay(dateFrom);
        const matchesTo = !dateTo || created < dayAfter(dateTo);
        const matchesCustomer = !customerId || String(payment.customer_id) === customerId;
        const matchesType = !transactionType || payment.transaction_type === transactionType;
        const matchesMethod = !collectionMethod || payment.collection_method === collectionMethod;
        return matchesFrom && matchesTo && matchesCustomer && matchesType && matchesMethod;
      }) ?? [],
    [collectionMethod, customerId, dateFrom, dateTo, paymentsQuery.data, transactionType],
  );

  const balanceRows = useMemo(
    () =>
      contractsQuery.data?.map((contract) => {
        const landPayments = contract.transactions?.filter((transaction) =>
          ["Down Payment", "Land Installment"].includes(transaction.transaction_type),
        ) ?? [];
        const totalPaid = landPayments.reduce((sum, transaction) => sum + Number(transaction.amount), 0);
        const lastPayment = [...landPayments].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
        return {
          ...contract,
          totalPaid,
          remainingBalance: Math.max(Number(contract.final_purchase_price) - totalPaid, 0),
          lastPaymentDate: lastPayment?.created_at ?? null,
          nextDueDate: nextDueDate(contract),
        };
      }) ?? [],
    [contractsQuery.data],
  );

  const parcelNameById = useMemo(() => {
    const map = new Map<number, string>();
    lotsQuery.data?.forEach((lot) => map.set(lot.id, lot.lot_number));
    return map;
  }, [lotsQuery.data]);

  const missingItems = useMemo(
    () => ({
      missingReceipts: paymentsQuery.data?.filter((payment) => !payment.manual_receipt_number) ?? [],
      missingProofs: paymentsQuery.data?.filter((payment) => payment.collection_method === "Online Transfer" && !payment.payment_documents?.length) ?? [],
      missingSignedContracts: contractsQuery.data?.filter((contract) => !contract.signed_contract_file_path) ?? [],
      customersWithoutActiveContract: customersQuery.data?.filter((customer) => !customer.contracts?.some((contract) => contract.is_active)) ?? [],
      incompleteApplications: applicationsQuery.data?.filter((application) =>
        !application.phone ||
        !application.email ||
        !application.preferred_parcel_ids?.length ||
        !application.intended_use ||
        !application.payment_option ||
        !application.legal_notice_acknowledged,
      ) ?? [],
    }),
    [applicationsQuery.data, contractsQuery.data, customersQuery.data, paymentsQuery.data],
  );

  return (
    <>
      <PageHeader title="Reports" description="Operational reports and CSV exports for payments, balances, applications, lots, and cleanup items." />
      {isLoading ? <LoadingState label="Loading reports" /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}

      <div className="mb-6 overflow-x-auto rounded-md border bg-white">
        <div className="flex min-w-max gap-1 p-1 sm:min-w-0 sm:flex-wrap">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              className={cn(
                "h-10 rounded-md px-4 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-primary",
                activeTab === tab ? "bg-primary text-white shadow-sm hover:bg-primary hover:text-white" : "",
              )}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "Payments" ? (
        <PaymentsReport
          rows={filteredPayments}
          allRows={paymentsQuery.data ?? []}
          customerOptions={customerOptions}
          filters={{ dateFrom, dateTo, customerId, transactionType, collectionMethod }}
          onFiltersChange={{ setDateFrom, setDateTo, setCustomerId, setTransactionType, setCollectionMethod }}
        />
      ) : null}
      {activeTab === "Balances" ? <BalancesReport rows={balanceRows} /> : null}
      {activeTab === "Applications" ? <ApplicationsReport rows={applicationsQuery.data ?? []} parcelNameById={parcelNameById} /> : null}
      {activeTab === "Lots" ? <LotsReport rows={lotsQuery.data ?? []} /> : null}
      {activeTab === "Missing Items" ? <MissingItemsReport items={missingItems} /> : null}
    </>
  );
}

function PaymentsReport({
  rows,
  allRows,
  customerOptions,
  filters,
  onFiltersChange,
}: {
  rows: PaymentReportRow[];
  allRows: PaymentReportRow[];
  customerOptions: Array<[number, string]>;
  filters: {
    dateFrom: string;
    dateTo: string;
    customerId: string;
    transactionType: string;
    collectionMethod: string;
  };
  onFiltersChange: {
    setDateFrom: (value: string) => void;
    setDateTo: (value: string) => void;
    setCustomerId: (value: string) => void;
    setTransactionType: (value: string) => void;
    setCollectionMethod: (value: string) => void;
  };
}) {
  const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);

  function exportPayments() {
    exportCsv({
      filename: reportFileName("payments-report"),
      rows: rows.map((row) => ({
        payment_date: formatDate(row.created_at),
        customer_name: row.customers ? customerName(row.customers) : "",
        lot_number: row.contracts?.parcels?.lot_number ?? "",
        transaction_type: row.transaction_type,
        amount: row.amount,
        collection_method: row.collection_method,
        bank_reference: row.bank_reference,
        manual_receipt_number: row.manual_receipt_number,
        receipt_issued_by: row.receipt_issued_by,
        uploaded_document: row.payment_documents?.length ? "Yes" : "No",
        notes: row.notes,
      })),
      columns: [
        { header: "Payment Date", accessor: (row) => row.payment_date },
        { header: "Customer Name", accessor: (row) => row.customer_name },
        { header: "Lot Number", accessor: (row) => row.lot_number },
        { header: "Transaction Type", accessor: (row) => row.transaction_type },
        { header: "Amount", accessor: (row) => row.amount },
        { header: "Collection Method", accessor: (row) => row.collection_method },
        { header: "Bank Reference", accessor: (row) => row.bank_reference },
        { header: "Manual Receipt Number", accessor: (row) => row.manual_receipt_number },
        { header: "Receipt Issued By", accessor: (row) => row.receipt_issued_by },
        { header: "Uploaded Document", accessor: (row) => row.uploaded_document },
        { header: "Notes", accessor: (row) => row.notes },
      ],
    });
  }

  return (
    <div className="grid gap-5">
      <ReportSummary
        title="Payments Report"
        description={`${rows.length} of ${allRows.length} payments shown. Total: ${money(total)}.`}
        onExport={exportPayments}
      />
      <Card>
        <CardHeader><CardTitle>Filters</CardTitle></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-5">
          <Field label="Date from">
            <Input type="date" value={filters.dateFrom} onChange={(event) => onFiltersChange.setDateFrom(event.target.value)} />
          </Field>
          <Field label="Date to">
            <Input type="date" value={filters.dateTo} onChange={(event) => onFiltersChange.setDateTo(event.target.value)} />
          </Field>
          <Field label="Customer">
            <Select value={filters.customerId} onChange={(event) => onFiltersChange.setCustomerId(event.target.value)}>
              <option value="">All customers</option>
              {customerOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </Select>
          </Field>
          <Field label="Transaction type">
            <Select value={filters.transactionType} onChange={(event) => onFiltersChange.setTransactionType(event.target.value)}>
              <option value="">All types</option>
              {transactionTypes.map((type) => <option key={type}>{type}</option>)}
            </Select>
          </Field>
          <Field label="Collection method">
            <Select value={filters.collectionMethod} onChange={(event) => onFiltersChange.setCollectionMethod(event.target.value)}>
              <option value="">All methods</option>
              {collectionMethods.map((method) => <option key={method}>{method}</option>)}
            </Select>
          </Field>
        </CardContent>
      </Card>
      <ReportTable
        emptyMessage="No payments match these filters."
        headers={["Date", "Customer", "Lot", "Type", "Amount", "Method", "Bank Ref", "Receipt #", "Issued By", "Docs", "Notes"]}
        rows={rows.map((row) => [
          formatDate(row.created_at),
          row.customers ? customerName(row.customers) : "N/A",
          row.contracts?.parcels?.lot_number ?? "N/A",
          row.transaction_type,
          money(row.amount),
          row.collection_method,
          row.bank_reference ?? "N/A",
          row.manual_receipt_number ?? "Missing",
          row.receipt_issued_by ?? "N/A",
          row.payment_documents?.length ? <Badge tone="green">Uploaded</Badge> : <Badge tone="amber">Missing</Badge>,
          row.notes ?? "",
        ])}
      />
    </div>
  );
}

function BalancesReport({ rows }: { rows: Array<ContractReportRow & { totalPaid: number; remainingBalance: number; lastPaymentDate: string | null; nextDueDate: string }> }) {
  function exportBalances() {
    exportCsv({
      filename: reportFileName("outstanding-balances-report"),
      rows: rows.map((row) => ({
        customer_name: row.customers ? customerName(row.customers) : "",
        lot_number: row.parcels?.lot_number ?? "",
        contract_price: row.final_purchase_price,
        total_paid: row.totalPaid,
        remaining_balance: row.remainingBalance,
        monthly_payment: row.monthly_payment,
        start_date: formatDate(row.start_date),
        due_day: row.payment_due_day,
        last_payment_date: row.lastPaymentDate ? formatDate(row.lastPaymentDate) : "",
        next_due_date: formatDate(row.nextDueDate),
      })),
      columns: [
        { header: "Customer Name", accessor: (row) => row.customer_name },
        { header: "Lot Number", accessor: (row) => row.lot_number },
        { header: "Contract Price", accessor: (row) => row.contract_price },
        { header: "Total Paid", accessor: (row) => row.total_paid },
        { header: "Remaining Balance", accessor: (row) => row.remaining_balance },
        { header: "Monthly Payment", accessor: (row) => row.monthly_payment },
        { header: "Start Date", accessor: (row) => row.start_date },
        { header: "Due Day", accessor: (row) => row.due_day },
        { header: "Last Payment Date", accessor: (row) => row.last_payment_date },
        { header: "Next Due Date", accessor: (row) => row.next_due_date },
      ],
    });
  }

  return (
    <div className="grid gap-5">
      <ReportSummary title="Outstanding Balances Report" description={`${rows.length} contracts included.`} onExport={exportBalances} />
      <ReportTable
        emptyMessage="No contracts found."
        headers={["Customer", "Lot", "Contract Price", "Total Paid", "Remaining", "Monthly", "Start", "Due Day", "Last Payment", "Next Due"]}
        rows={rows.map((row) => [
          row.customers ? customerName(row.customers) : "N/A",
          row.parcels?.lot_number ?? "N/A",
          money(row.final_purchase_price),
          money(row.totalPaid),
          money(row.remainingBalance),
          money(row.monthly_payment),
          formatDate(row.start_date),
          String(row.payment_due_day),
          row.lastPaymentDate ? formatDate(row.lastPaymentDate) : "No payments",
          formatDate(row.nextDueDate),
        ])}
      />
    </div>
  );
}

function ApplicationsReport({ rows, parcelNameById }: { rows: ApplicationReportRow[]; parcelNameById: Map<number, string> }) {
  function preferredLots(row: ApplicationReportRow) {
    return row.preferred_parcel_ids?.map((id) => parcelNameById.get(id) ?? `Lot #${id}`).join("; ") || row.alternate_lot_preference || "";
  }

  function exportApplications() {
    exportCsv({
      filename: reportFileName("applications-report"),
      rows: rows.map((row) => ({
        applicant_name: row.applicant_full_name || `${row.first_name} ${row.last_name}`.trim(),
        phone: row.phone,
        email: row.email,
        preferred_lot: preferredLots(row),
        intended_use: row.intended_use,
        payment_option: row.payment_option,
        application_status: row.status,
        submission_date: formatDate(row.created_at),
      })),
      columns: [
        { header: "Applicant Name", accessor: (row) => row.applicant_name },
        { header: "Phone", accessor: (row) => row.phone },
        { header: "Email", accessor: (row) => row.email },
        { header: "Preferred Lot", accessor: (row) => row.preferred_lot },
        { header: "Intended Use", accessor: (row) => row.intended_use },
        { header: "Payment Option", accessor: (row) => row.payment_option },
        { header: "Application Status", accessor: (row) => row.application_status },
        { header: "Submission Date", accessor: (row) => row.submission_date },
      ],
    });
  }

  return (
    <div className="grid gap-5">
      <ReportSummary title="Applications Report" description={`${rows.length} applications included.`} onExport={exportApplications} />
      <ReportTable
        emptyMessage="No applications found."
        headers={["Applicant", "Phone", "Email", "Preferred Lot", "Use", "Payment", "Status", "Submitted"]}
        rows={rows.map((row) => [
          row.applicant_full_name || `${row.first_name} ${row.last_name}`.trim(),
          row.phone,
          row.email ?? "N/A",
          preferredLots(row) || "N/A",
          row.intended_use ?? "N/A",
          row.payment_option ?? "N/A",
          <Badge key={row.id} tone={row.status === "Approved" ? "green" : row.status === "Declined" ? "red" : "amber"}>{row.status}</Badge>,
          formatDate(row.created_at),
        ])}
      />
    </div>
  );
}

function LotsReport({ rows }: { rows: LotReportRow[] }) {
  function exportLots() {
    exportCsv({
      filename: reportFileName("lots-status-report"),
      rows: rows.map((row) => ({
        lot_number: row.lot_number,
        size: row.dimensions,
        price: row.base_price,
        status: row.status,
        assigned_customer: row.customer_name,
        active_contract: row.contract_id ? `Contract #${row.contract_id}` : "",
      })),
      columns: [
        { header: "Lot Number", accessor: (row) => row.lot_number },
        { header: "Size", accessor: (row) => row.size },
        { header: "Price", accessor: (row) => row.price },
        { header: "Status", accessor: (row) => row.status },
        { header: "Assigned Customer", accessor: (row) => row.assigned_customer },
        { header: "Active Contract", accessor: (row) => row.active_contract },
      ],
    });
  }

  return (
    <div className="grid gap-5">
      <ReportSummary title="Lots Status Report" description={`${rows.length} lots included.`} onExport={exportLots} />
      <ReportTable
        emptyMessage="No lots found."
        headers={["Lot", "Size", "Price", "Status", "Assigned Customer", "Active Contract"]}
        rows={rows.map((row) => [
          row.lot_number,
          row.dimensions,
          money(row.base_price),
          <Badge key={row.id} tone={row.status === "Available" ? "green" : row.status === "Sold" ? "blue" : "amber"}>{row.status}</Badge>,
          row.customer_name ?? "N/A",
          row.contract_id ? `Contract #${row.contract_id}` : "N/A",
        ])}
      />
    </div>
  );
}

function MissingItemsReport({
  items,
}: {
  items: {
    missingReceipts: PaymentReportRow[];
    missingProofs: PaymentReportRow[];
    missingSignedContracts: ContractReportRow[];
    customersWithoutActiveContract: CustomerReportRow[];
    incompleteApplications: ApplicationReportRow[];
  };
}) {
  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Missing Items Report</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <CleanupMetric title="Missing receipt #" value={items.missingReceipts.length} />
          <CleanupMetric title="Missing proof" value={items.missingProofs.length} />
          <CleanupMetric title="Unsigned contracts" value={items.missingSignedContracts.length} />
          <CleanupMetric title="No active contract" value={items.customersWithoutActiveContract.length} />
          <CleanupMetric title="Incomplete applications" value={items.incompleteApplications.length} />
        </CardContent>
      </Card>
      <MissingList
        title="Payments missing manual receipt number"
        rows={items.missingReceipts.map((payment) => `${formatDate(payment.created_at)} - ${payment.customers ? customerName(payment.customers) : "Unknown"} - ${money(payment.amount)}`)}
      />
      <MissingList
        title="Online payments missing uploaded proof/document"
        rows={items.missingProofs.map((payment) => `${formatDate(payment.created_at)} - ${payment.customers ? customerName(payment.customers) : "Unknown"} - ${payment.bank_reference ?? "No reference"}`)}
      />
      <MissingList
        title="Contracts missing signed contract upload"
        rows={items.missingSignedContracts.map((contract) => `Contract #${contract.id} - ${contract.customers ? customerName(contract.customers) : "Unknown"} - ${contract.parcels?.lot_number ?? "No lot"}`)}
      />
      <MissingList
        title="Customers without active contract"
        rows={items.customersWithoutActiveContract.map((customer) => `${customer.first_name} ${customer.last_name}`)}
      />
      <MissingList
        title="Applications missing key information"
        rows={items.incompleteApplications.map((application) => `${application.applicant_full_name || `${application.first_name} ${application.last_name}`.trim()} - ${formatDate(application.created_at)}`)}
      />
    </div>
  );
}

function ReportSummary({ title, description, onExport }: { title: string; description: string; onExport: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
        <div>
          <p className="font-display text-2xl font-semibold text-primary">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <Button type="button" onClick={onExport}>
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </CardContent>
    </Card>
  );
}

function ReportTable({ headers, rows, emptyMessage }: { headers: string[]; rows: React.ReactNode[][]; emptyMessage: string }) {
  return (
    <Card>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">{emptyMessage}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead className="bg-primary text-white">
                <tr>
                  {headers.map((header) => (
                    <th key={header} className="whitespace-nowrap px-3 py-3 text-left font-semibold">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="border-b bg-white last:border-b-0 odd:bg-ivory/35">
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className="max-w-[260px] px-3 py-3 align-top text-slate">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CleanupMetric({ title, value }: { title: string; value: number }) {
  return (
    <div className="rounded-md border bg-ivory/35 p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</p>
      <p className="mt-2 text-2xl font-semibold text-primary">{value}</p>
    </div>
  );
}

function MissingList({ title, rows }: { title: string; rows: string[] }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="grid gap-2">
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No items found.</p> : null}
        {rows.map((row) => (
          <div key={row} className="rounded-md border bg-white p-3 text-sm text-slate">{row}</div>
        ))}
      </CardContent>
    </Card>
  );
}

function customerName(customer: { first_name: string; last_name: string }) {
  return `${customer.first_name} ${customer.last_name}`.trim();
}

function startOfDay(value: string) {
  return new Date(`${value}T00:00:00`);
}

function dayAfter(value: string) {
  const date = startOfDay(value);
  date.setDate(date.getDate() + 1);
  return date;
}

function nextDueDate(contract: { payment_due_day: number }) {
  const now = new Date();
  const due = new Date(now.getFullYear(), now.getMonth(), contract.payment_due_day);
  if (due < now) due.setMonth(due.getMonth() + 1);
  return due.toISOString();
}
