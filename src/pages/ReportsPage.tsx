import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge, statusBadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Field, Input, Select } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { exportCsv, reportFileName } from "../lib/csv";
import { supabase } from "../lib/supabase";
import { cn, formatDate, money } from "../lib/utils";
import type {
  AdminProfile,
  CollectionMethod,
  FollowUpTask,
  FollowUpTaskPriority,
  FollowUpTaskStatus,
  Lead,
  LeadPipelineStage,
  LotReservation,
  PaymentRequest,
  PostSalesChecklist,
  PostSalesChecklistStatus,
  PostSalesTask,
  ReservationStatus,
  SiteVisit,
  SiteVisitStatus,
  TransactionType,
} from "../types/database";

type ReportTab =
  | "Payments"
  | "Balances"
  | "Sales"
  | "Follow-ups"
  | "Site Visits"
  | "Reservations"
  | "Applications"
  | "Post-Sales"
  | "Workload"
  | "Demand"
  | "Lots"
  | "Missing Items";
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
type LeadReportRow = Lead & { parcels?: { id: number; lot_number: string | null; status: string | null } | null };
type SiteVisitReportRow = SiteVisit & { parcels?: { id: number; lot_number: string | null; status: string | null } | null };
type ReservationReportRow = LotReservation & { parcels?: { id: number; lot_number: string | null; status: string | null } | null };

const tabs: ReportTab[] = ["Payments", "Balances", "Sales", "Follow-ups", "Site Visits", "Reservations", "Applications", "Post-Sales", "Workload", "Demand", "Lots", "Missing Items"];
const transactionTypes: TransactionType[] = ["Down Payment", "Land Installment", "Garbage Fee", "Road Maintenance"];
const collectionMethods: CollectionMethod[] = ["Cash", "Online Transfer"];
const pipelineStages: LeadPipelineStage[] = ["new_lead", "contacted", "interested", "family_decision", "payment_plan_review", "site_visit_scheduled", "deposit_pending", "deposit_paid", "application_started", "contract_started", "closed_won", "lost_inactive"];
const followUpStatuses: FollowUpTaskStatus[] = ["open", "in_progress", "completed", "cancelled"];
const followUpPriorities: FollowUpTaskPriority[] = ["low", "normal", "high", "urgent"];
const siteVisitStatuses: SiteVisitStatus[] = ["scheduled", "completed", "no_show", "cancelled", "rescheduled"];
const reservationStatuses: ReservationStatus[] = ["draft", "reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed", "converted_to_application", "converted_to_contract", "expired", "cancelled", "released"];
const postSalesStatuses: PostSalesChecklistStatus[] = ["not_started", "in_progress", "blocked", "completed", "cancelled"];

export function ReportsPage() {
  const [activeTab, setActiveTab] = useState<ReportTab>("Payments");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [transactionType, setTransactionType] = useState("");
  const [collectionMethod, setCollectionMethod] = useState("");
  const [pipelineStage, setPipelineStage] = useState("");
  const [leadSource, setLeadSource] = useState("");
  const [assignedStaff, setAssignedStaff] = useState("");
  const [taskStatus, setTaskStatus] = useState("");
  const [taskPriority, setTaskPriority] = useState("");
  const [visitStatus, setVisitStatus] = useState("");
  const [reservationStatus, setReservationStatus] = useState("");
  const [postSalesStatus, setPostSalesStatus] = useState("");

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
  const leadsQuery = useQuery({
    queryKey: ["reports-leads"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leads")
        .select("*, parcels(id, lot_number, status)")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data as LeadReportRow[];
    },
  });
  const followUpsQuery = useQuery({
    queryKey: ["reports-follow-ups"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("follow_up_tasks")
        .select("*")
        .order("due_at", { ascending: true, nullsFirst: false });
      if (error) throw error;
      return data as FollowUpTask[];
    },
  });
  const siteVisitsQuery = useQuery({
    queryKey: ["reports-site-visits"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("site_visits")
        .select("*, parcels(id, lot_number, status)")
        .order("scheduled_at", { ascending: true });
      if (error) throw error;
      return data as SiteVisitReportRow[];
    },
  });
  const reservationsQuery = useQuery({
    queryKey: ["reports-reservations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("lot_reservations")
        .select("*, parcels(id, lot_number, status)")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data as ReservationReportRow[];
    },
  });
  const postSalesChecklistsQuery = useQuery({
    queryKey: ["reports-post-sales-checklists"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("post_sales_checklists")
        .select("*")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data as PostSalesChecklist[];
    },
  });
  const postSalesTasksQuery = useQuery({
    queryKey: ["reports-post-sales-tasks"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("post_sales_tasks")
        .select("*")
        .order("due_at", { ascending: true, nullsFirst: false });
      if (error) throw error;
      return data as PostSalesTask[];
    },
  });
  const paymentRequestsQuery = useQuery({
    queryKey: ["reports-payment-requests"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_requests")
        .select("*")
        .order("due_date", { ascending: true });
      if (error) throw error;
      return data as PaymentRequest[];
    },
  });
  const adminProfilesQuery = useQuery({
    queryKey: ["reports-admin-profiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("admin_profiles")
        .select("user_id, email, full_name, role, created_at, updated_at")
        .order("full_name", { ascending: true });
      if (error) throw error;
      return data as AdminProfile[];
    },
  });

  const isLoading = paymentsQuery.isLoading || contractsQuery.isLoading || applicationsQuery.isLoading || lotsQuery.isLoading || customersQuery.isLoading || leadsQuery.isLoading || followUpsQuery.isLoading || siteVisitsQuery.isLoading || reservationsQuery.isLoading || postSalesChecklistsQuery.isLoading || postSalesTasksQuery.isLoading || paymentRequestsQuery.isLoading || adminProfilesQuery.isLoading;
  const error = paymentsQuery.error || contractsQuery.error || applicationsQuery.error || lotsQuery.error || customersQuery.error || leadsQuery.error || followUpsQuery.error || siteVisitsQuery.error || reservationsQuery.error || postSalesChecklistsQuery.error || postSalesTasksQuery.error || paymentRequestsQuery.error || adminProfilesQuery.error;

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
        const matchesCustomer = !customerId || String(payment.customer_id) === customerId;
        const matchesType = !transactionType || payment.transaction_type === transactionType;
        const matchesMethod = !collectionMethod || payment.collection_method === collectionMethod;
        return inDateRange(payment.created_at, dateFrom, dateTo) && matchesCustomer && matchesType && matchesMethod;
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
  const profileById = useMemo(() => new Map((adminProfilesQuery.data ?? []).map((profile) => [profile.user_id, profile])), [adminProfilesQuery.data]);
  const lotById = useMemo(() => {
    const map = new Map<number, { lot_number: string; status: string }>();
    lotsQuery.data?.forEach((lot) => map.set(lot.id, { lot_number: lot.lot_number, status: lot.status }));
    return map;
  }, [lotsQuery.data]);
  const sourceOptions = useMemo(() => [...new Set((leadsQuery.data ?? []).map((lead) => lead.source).filter(Boolean) as string[])].sort(), [leadsQuery.data]);
  const staffOptions = useMemo(() => {
    const ids = new Set<string>();
    leadsQuery.data?.forEach((row) => row.assigned_to && ids.add(row.assigned_to));
    followUpsQuery.data?.forEach((row) => row.assigned_to && ids.add(row.assigned_to));
    siteVisitsQuery.data?.forEach((row) => row.assigned_to && ids.add(row.assigned_to));
    reservationsQuery.data?.forEach((row) => row.assigned_to && ids.add(row.assigned_to));
    postSalesTasksQuery.data?.forEach((row) => row.assigned_to && ids.add(row.assigned_to));
    postSalesChecklistsQuery.data?.forEach((row) => row.assigned_to && ids.add(row.assigned_to));
    return [...ids].map((id) => [id, staffName(id, profileById)] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]));
  }, [followUpsQuery.data, leadsQuery.data, postSalesChecklistsQuery.data, postSalesTasksQuery.data, profileById, reservationsQuery.data, siteVisitsQuery.data]);
  const reportFilters = {
    dateFrom,
    dateTo,
    pipelineStage,
    leadSource,
    assignedStaff,
    taskStatus,
    taskPriority,
    visitStatus,
    reservationStatus,
    postSalesStatus,
  };
  const filterSetters = {
    setDateFrom,
    setDateTo,
    setPipelineStage,
    setLeadSource,
    setAssignedStaff,
    setTaskStatus,
    setTaskPriority,
    setVisitStatus,
    setReservationStatus,
    setPostSalesStatus,
  };
  const filteredLeads = useMemo(
    () => (leadsQuery.data ?? []).filter((lead) =>
      inDateRange(lead.created_at, dateFrom, dateTo) &&
      (!pipelineStage || lead.pipeline_stage === pipelineStage) &&
      (!leadSource || lead.source === leadSource) &&
      (!assignedStaff || lead.assigned_to === assignedStaff)
    ),
    [assignedStaff, dateFrom, dateTo, leadSource, leadsQuery.data, pipelineStage],
  );
  const filteredFollowUps = useMemo(
    () => (followUpsQuery.data ?? []).filter((task) =>
      inDateRange(task.due_at ?? task.created_at, dateFrom, dateTo) &&
      (!taskStatus || task.status === taskStatus) &&
      (!taskPriority || task.priority === taskPriority) &&
      (!assignedStaff || task.assigned_to === assignedStaff)
    ),
    [assignedStaff, dateFrom, dateTo, followUpsQuery.data, taskPriority, taskStatus],
  );
  const filteredSiteVisits = useMemo(
    () => (siteVisitsQuery.data ?? []).filter((visit) =>
      inDateRange(visit.scheduled_at, dateFrom, dateTo) &&
      (!visitStatus || visit.status === visitStatus) &&
      (!assignedStaff || visit.assigned_to === assignedStaff)
    ),
    [assignedStaff, dateFrom, dateTo, siteVisitsQuery.data, visitStatus],
  );
  const filteredReservations = useMemo(
    () => (reservationsQuery.data ?? []).filter((reservation) =>
      inDateRange(reservation.created_at, dateFrom, dateTo) &&
      (!reservationStatus || reservation.status === reservationStatus) &&
      (!assignedStaff || reservation.assigned_to === assignedStaff)
    ),
    [assignedStaff, dateFrom, dateTo, reservationStatus, reservationsQuery.data],
  );
  const filteredPostSalesTasks = useMemo(
    () => (postSalesTasksQuery.data ?? []).filter((task) =>
      inDateRange(task.due_at ?? task.created_at, dateFrom, dateTo) &&
      (!taskStatus || task.status === taskStatus) &&
      (!taskPriority || task.priority === taskPriority) &&
      (!assignedStaff || task.assigned_to === assignedStaff)
    ),
    [assignedStaff, dateFrom, dateTo, postSalesTasksQuery.data, taskPriority, taskStatus],
  );
  const filteredPostSalesChecklists = useMemo(
    () => (postSalesChecklistsQuery.data ?? []).filter((checklist) =>
      inDateRange(checklist.created_at, dateFrom, dateTo) &&
      (!postSalesStatus || checklist.status === postSalesStatus) &&
      (!assignedStaff || checklist.assigned_to === assignedStaff)
    ),
    [assignedStaff, dateFrom, dateTo, postSalesChecklistsQuery.data, postSalesStatus],
  );

  return (
    <>
      <PageHeader title="Reports" description="Operational reports and CSV exports for payments, balances, applications, lots, and cleanup items." />
      {isLoading ? <LoadingState label="Loading reports" /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}

      <div className="crm-tabs mb-6 overflow-x-auto">
        <div className="crm-tab-list">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              className={cn(
                "crm-tab",
                activeTab === tab ? "crm-tab-active" : "",
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
      {activeTab === "Sales" ? <SalesPipelineReport rows={filteredLeads} allRows={leadsQuery.data ?? []} filters={reportFilters} onFiltersChange={filterSetters} sourceOptions={sourceOptions} staffOptions={staffOptions} profileById={profileById} /> : null}
      {activeTab === "Follow-ups" ? <FollowUpsReport rows={filteredFollowUps} allRows={followUpsQuery.data ?? []} filters={reportFilters} onFiltersChange={filterSetters} staffOptions={staffOptions} profileById={profileById} /> : null}
      {activeTab === "Site Visits" ? <SiteVisitsReport rows={filteredSiteVisits} allRows={siteVisitsQuery.data ?? []} filters={reportFilters} onFiltersChange={filterSetters} staffOptions={staffOptions} profileById={profileById} /> : null}
      {activeTab === "Reservations" ? <ReservationsReport rows={filteredReservations} allRows={reservationsQuery.data ?? []} filters={reportFilters} onFiltersChange={filterSetters} staffOptions={staffOptions} profileById={profileById} /> : null}
      {activeTab === "Applications" ? <ApplicationsReport rows={applicationsQuery.data ?? []} allRows={applicationsQuery.data ?? []} parcelNameById={parcelNameById} lotById={lotById} postSalesChecklists={postSalesChecklistsQuery.data ?? []} leads={leadsQuery.data ?? []} dateFrom={dateFrom} dateTo={dateTo} setDateFrom={setDateFrom} setDateTo={setDateTo} /> : null}
      {activeTab === "Post-Sales" ? <PostSalesReport tasks={filteredPostSalesTasks} checklists={filteredPostSalesChecklists} allTasks={postSalesTasksQuery.data ?? []} allChecklists={postSalesChecklistsQuery.data ?? []} filters={reportFilters} onFiltersChange={filterSetters} staffOptions={staffOptions} profileById={profileById} /> : null}
      {activeTab === "Workload" ? <StaffWorkloadReport leads={leadsQuery.data ?? []} followUps={followUpsQuery.data ?? []} visits={siteVisitsQuery.data ?? []} postSalesTasks={postSalesTasksQuery.data ?? []} profileById={profileById} staffOptions={staffOptions} /> : null}
      {activeTab === "Demand" ? <DemandReport leads={leadsQuery.data ?? []} applications={applicationsQuery.data ?? []} reservations={reservationsQuery.data ?? []} visits={siteVisitsQuery.data ?? []} lotById={lotById} /> : null}
      {activeTab === "Lots" ? <LotsReport rows={lotsQuery.data ?? []} /> : null}
      {activeTab === "Missing Items" ? <MissingItemsReport items={missingItems} paymentRequests={paymentRequestsQuery.data ?? []} postSalesChecklists={postSalesChecklistsQuery.data ?? []} /> : null}
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
        payment_date: safeFormatDate(row.created_at),
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
          safeFormatDate(row.created_at),
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
        start_date: safeFormatDate(row.start_date),
        due_day: row.payment_due_day,
        last_payment_date: row.lastPaymentDate ? safeFormatDate(row.lastPaymentDate) : "",
        next_due_date: safeFormatDate(row.nextDueDate),
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
          safeFormatDate(row.start_date),
          String(row.payment_due_day),
          row.lastPaymentDate ? safeFormatDate(row.lastPaymentDate) : "No payments",
          safeFormatDate(row.nextDueDate),
        ])}
      />
    </div>
  );
}

function SalesPipelineReport({
  rows,
  allRows,
  filters,
  onFiltersChange,
  sourceOptions,
  staffOptions,
  profileById,
}: {
  rows: LeadReportRow[];
  allRows: LeadReportRow[];
  filters: ReportFilters;
  onFiltersChange: ReportFilterSetters;
  sourceOptions: string[];
  staffOptions: Array<[string, string]>;
  profileById: Map<string, AdminProfile>;
}) {
  const stageCounts = countBy(rows, (row) => leadStageLabel(row.pipeline_stage));
  const overdue = rows.filter((row) => isBeforeToday(row.next_action_due_at));
  const unassigned = rows.filter((row) => !row.assigned_to && !["closed_won", "lost_inactive"].includes(row.pipeline_stage));

  function exportSales() {
    exportCsv({
      filename: reportFileName("sales-pipeline-report"),
      rows: rows.map((row) => ({
        lead_name: row.full_name,
        source: row.source,
        stage: leadStageLabel(row.pipeline_stage),
        assigned_to: staffName(row.assigned_to, profileById),
        preferred_lot: row.parcels?.lot_number,
        next_action: row.next_action,
        next_action_due: row.next_action_due_at ? safeFormatDate(row.next_action_due_at) : "",
        created_at: safeFormatDate(row.created_at),
      })),
      columns: basicColumns(["lead_name", "source", "stage", "assigned_to", "preferred_lot", "next_action", "next_action_due", "created_at"]),
    });
  }

  return (
    <div className="grid gap-5">
      <ReportSummary title="Sales Pipeline Report" description={`${rows.length} of ${allRows.length} leads shown. ${overdue.length} overdue next actions, ${unassigned.length} unassigned active leads.`} onExport={exportSales} />
      <SalesFilters filters={filters} onFiltersChange={onFiltersChange} sourceOptions={sourceOptions} staffOptions={staffOptions} />
      <MetricGrid metrics={[
        ["New leads", rows.length],
        ["Unassigned active", unassigned.length],
        ["Overdue next actions", overdue.length],
        ["Family decision", rows.filter((row) => row.pipeline_stage === "family_decision").length],
        ["Payment plan review", rows.filter((row) => row.pipeline_stage === "payment_plan_review").length],
        ["Deposit pending", rows.filter((row) => row.pipeline_stage === "deposit_pending").length],
      ]} />
      <CountPanel title="Leads by Pipeline Stage" counts={stageCounts} />
      <CountPanel title="Leads by Source" counts={countBy(rows, (row) => row.source || "Unknown")} />
      <ReportTable
        emptyMessage="No leads match these filters."
        headers={["Lead", "Source", "Stage", "Assigned", "Lot", "Next Action", "Due", "Created"]}
        rows={rows.slice(0, 80).map((row) => [
          row.full_name,
          row.source ?? "Unknown",
          <Badge key={row.id} tone={leadStageTone(row.pipeline_stage)}>{leadStageLabel(row.pipeline_stage)}</Badge>,
          staffName(row.assigned_to, profileById),
          row.parcels?.lot_number ?? "N/A",
          row.next_action ?? "No next action",
          row.next_action_due_at ? safeFormatDate(row.next_action_due_at) : "Not set",
          safeFormatDate(row.created_at),
        ])}
      />
    </div>
  );
}

function FollowUpsReport({
  rows,
  allRows,
  filters,
  onFiltersChange,
  staffOptions,
  profileById,
}: {
  rows: FollowUpTask[];
  allRows: FollowUpTask[];
  filters: ReportFilters;
  onFiltersChange: ReportFilterSetters;
  staffOptions: Array<[string, string]>;
  profileById: Map<string, AdminProfile>;
}) {
  const open = rows.filter((row) => ["open", "in_progress"].includes(row.status));
  const overdue = open.filter((row) => isBeforeToday(row.due_at));
  const dueSoon = open.filter((row) => isTodayOrUpcoming(row.due_at, 7));

  function exportFollowUps() {
    exportCsv({
      filename: reportFileName("follow-ups-report"),
      rows: rows.map((row) => ({
        title: row.title,
        status: row.status,
        priority: row.priority,
        assigned_to: staffName(row.assigned_to, profileById),
        due_at: row.due_at ? safeFormatDate(row.due_at) : "",
        completed_at: row.completed_at ? safeFormatDate(row.completed_at) : "",
        related_lead: row.lead_id,
      })),
      columns: basicColumns(["title", "status", "priority", "assigned_to", "due_at", "completed_at", "related_lead"]),
    });
  }

  return (
    <div className="grid gap-5">
      <ReportSummary title="Follow-Up Report" description={`${rows.length} of ${allRows.length} follow-ups shown. ${overdue.length} overdue and ${dueSoon.length} due within 7 days.`} onExport={exportFollowUps} />
      <TaskFilters filters={filters} onFiltersChange={onFiltersChange} staffOptions={staffOptions} statusOptions={followUpStatuses} />
      <MetricGrid metrics={[
        ["Open", open.length],
        ["Overdue", overdue.length],
        ["Due today/upcoming", dueSoon.length],
        ["Completed in range", rows.filter((row) => row.status === "completed").length],
        ["High/Urgent", rows.filter((row) => ["high", "urgent"].includes(row.priority)).length],
      ]} />
      <CountPanel title="Follow-ups by Assigned Staff" counts={countBy(rows, (row) => staffName(row.assigned_to, profileById))} />
      <ReportTable
        emptyMessage="No follow-ups match these filters."
        headers={["Title", "Status", "Priority", "Assigned", "Due", "Completed", "Related"]}
        rows={rows.slice(0, 100).map((row) => [
          row.title,
          <Badge key={`${row.id}-status`} tone={statusBadgeTone(row.status)}>{labelize(row.status)}</Badge>,
          <Badge key={`${row.id}-priority`} tone={priorityTone(row.priority)}>{labelize(row.priority)}</Badge>,
          staffName(row.assigned_to, profileById),
          row.due_at ? safeFormatDate(row.due_at) : "Not set",
          row.completed_at ? safeFormatDate(row.completed_at) : "N/A",
          row.lead_id ? `Lead ${row.lead_id}` : row.customer_id ? `Customer #${row.customer_id}` : "N/A",
        ])}
      />
    </div>
  );
}

function SiteVisitsReport({
  rows,
  allRows,
  filters,
  onFiltersChange,
  staffOptions,
  profileById,
}: {
  rows: SiteVisitReportRow[];
  allRows: SiteVisitReportRow[];
  filters: ReportFilters;
  onFiltersChange: ReportFilterSetters;
  staffOptions: Array<[string, string]>;
  profileById: Map<string, AdminProfile>;
}) {
  function exportVisits() {
    exportCsv({
      filename: reportFileName("site-visits-report"),
      rows: rows.map((row) => ({
        scheduled_at: safeFormatDate(row.scheduled_at),
        status: row.status,
        assigned_to: staffName(row.assigned_to, profileById),
        lot: row.parcels?.lot_number,
        location: row.location,
        visit_type: row.visit_type,
      })),
      columns: basicColumns(["scheduled_at", "status", "assigned_to", "lot", "location", "visit_type"]),
    });
  }

  return (
    <div className="grid gap-5">
      <ReportSummary title="Site Visit Report" description={`${rows.length} of ${allRows.length} visits shown.`} onExport={exportVisits} />
      <VisitFilters filters={filters} onFiltersChange={onFiltersChange} staffOptions={staffOptions} />
      <MetricGrid metrics={[
        ["Scheduled", rows.filter((row) => ["scheduled", "rescheduled"].includes(row.status)).length],
        ["Upcoming", rows.filter((row) => isTodayOrUpcoming(row.scheduled_at, 7)).length],
        ["Completed", rows.filter((row) => row.status === "completed").length],
        ["Cancelled / No-show", rows.filter((row) => ["cancelled", "no_show"].includes(row.status)).length],
      ]} />
      <CountPanel title="Visits by Project/Lot" counts={countBy(rows, (row) => row.parcels?.lot_number || "No lot")} />
      <ReportTable
        emptyMessage="No site visits match these filters."
        headers={["Scheduled", "Status", "Assigned", "Lot", "Location", "Type", "Notes"]}
        rows={rows.slice(0, 100).map((row) => [
          safeFormatDate(row.scheduled_at),
          <Badge key={row.id} tone={statusBadgeTone(row.status)}>{labelize(row.status)}</Badge>,
          staffName(row.assigned_to, profileById),
          row.parcels?.lot_number ?? "N/A",
          row.location ?? "N/A",
          row.visit_type ?? "N/A",
          row.notes ?? "",
        ])}
      />
    </div>
  );
}

function ReservationsReport({
  rows,
  allRows,
  filters,
  onFiltersChange,
  staffOptions,
  profileById,
}: {
  rows: ReservationReportRow[];
  allRows: ReservationReportRow[];
  filters: ReportFilters;
  onFiltersChange: ReportFilterSetters;
  staffOptions: Array<[string, string]>;
  profileById: Map<string, AdminProfile>;
}) {
  const active = rows.filter((row) => activeReservationStatuses.has(row.status));
  const expiring = active.filter((row) => isTodayOrUpcoming(row.expires_at, 3));
  const expired = active.filter((row) => isBeforeToday(row.expires_at));
  const depositOverdue = active.filter((row) => row.deposit_status === "overdue" || (row.deposit_status === "pending" && isBeforeToday(row.deposit_due_at)));
  const expectedTotal = rows.reduce((sum, row) => sum + Number(row.expected_deposit_amount ?? 0), 0);

  function exportReservations() {
    exportCsv({
      filename: reportFileName("reservations-deposit-readiness-report"),
      rows: rows.map((row) => ({
        reservation_code: row.reservation_code,
        lot: row.parcels?.lot_number,
        status: row.status,
        deposit_status: row.deposit_status,
        expected_deposit: row.expected_deposit_amount,
        deposit_due: row.deposit_due_at ? safeFormatDate(row.deposit_due_at) : "",
        expires_at: row.expires_at ? safeFormatDate(row.expires_at) : "",
        assigned_to: staffName(row.assigned_to, profileById),
      })),
      columns: basicColumns(["reservation_code", "lot", "status", "deposit_status", "expected_deposit", "deposit_due", "expires_at", "assigned_to"]),
    });
  }

  return (
    <div className="grid gap-5">
      <ReportSummary title="Reservation & Deposit Readiness Report" description={`${rows.length} of ${allRows.length} reservations shown. Expected deposit total shown as readiness context only: ${money(expectedTotal)}.`} onExport={exportReservations} />
      <ReservationFilters filters={filters} onFiltersChange={onFiltersChange} staffOptions={staffOptions} />
      <MetricGrid metrics={[
        ["Active reservations", active.length],
        ["Expiring soon", expiring.length],
        ["Expired active", expired.length],
        ["Deposit pending", active.filter((row) => row.deposit_status === "pending").length],
        ["Deposit overdue", depositOverdue.length],
        ["Proof submitted", active.filter((row) => row.deposit_status === "proof_submitted").length],
        ["Deposit confirmed", active.filter((row) => row.deposit_status === "confirmed").length],
        ["Ready next step", active.filter((row) => row.deposit_status === "confirmed" && !row.converted_application_id && !row.converted_contract_id).length],
      ]} />
      <CountPanel title="Reservations by Lot" counts={countBy(rows, (row) => row.parcels?.lot_number || "No lot")} />
      <ReportTable
        emptyMessage="No reservations match these filters."
        headers={["Code", "Lot", "Status", "Deposit", "Expected", "Deposit Due", "Expires", "Assigned"]}
        rows={rows.slice(0, 100).map((row) => [
          row.reservation_code ?? row.id,
          row.parcels?.lot_number ?? "N/A",
          <Badge key={`${row.id}-status`} tone={statusBadgeTone(row.status)}>{labelize(row.status)}</Badge>,
          <Badge key={`${row.id}-deposit`} tone={row.deposit_status === "overdue" ? "red" : row.deposit_status === "confirmed" ? "green" : "amber"}>{labelize(row.deposit_status)}</Badge>,
          row.expected_deposit_amount ? money(row.expected_deposit_amount) : "Not set",
          row.deposit_due_at ? safeFormatDate(row.deposit_due_at) : "Not set",
          row.expires_at ? safeFormatDate(row.expires_at) : "Not set",
          staffName(row.assigned_to, profileById),
        ])}
      />
    </div>
  );
}

function ApplicationsReport({
  rows,
  allRows,
  parcelNameById,
  lotById,
  postSalesChecklists,
  leads,
  dateFrom,
  dateTo,
  setDateFrom,
  setDateTo,
}: {
  rows: ApplicationReportRow[];
  allRows: ApplicationReportRow[];
  parcelNameById: Map<number, string>;
  lotById: Map<number, { lot_number: string; status: string }>;
  postSalesChecklists: PostSalesChecklist[];
  leads: LeadReportRow[];
  dateFrom: string;
  dateTo: string;
  setDateFrom: (value: string) => void;
  setDateTo: (value: string) => void;
}) {
  rows = rows.filter((row) => inDateRange(row.created_at, dateFrom, dateTo));
  function preferredLots(row: ApplicationReportRow) {
    return row.preferred_parcel_ids?.map((id) => parcelNameById.get(id) ?? `Lot #${id}`).join("; ") || row.alternate_lot_preference || "";
  }
  const unavailable = rows.filter((row) => row.preferred_parcel_ids?.some((id) => {
    const lot = lotById.get(id);
    return lot && lot.status !== "Available";
  }));
  const withoutLead = rows.filter((row) => !leads.some((lead) => Number(lead.application_id) === row.id));
  const approvedWithoutPostSales = rows.filter((row) => row.status === "Approved" && !postSalesChecklists.some((checklist) => Number(checklist.application_id) === row.id));

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
        submission_date: safeFormatDate(row.created_at),
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
      <ReportSummary title="Applications Report" description={`${rows.length} of ${allRows.length} applications included.`} onExport={exportApplications} />
      <DateFilters dateFrom={dateFrom} dateTo={dateTo} setDateFrom={setDateFrom} setDateTo={setDateTo} />
      <MetricGrid metrics={[
        ["Pending review", rows.filter((row) => row.status === "Pending Review").length],
        ["Approved", rows.filter((row) => row.status === "Approved").length],
        ["Declined", rows.filter((row) => row.status === "Declined").length],
        ["Unavailable selected lots", unavailable.length],
        ["Approved without post-sales", approvedWithoutPostSales.length],
        ["No linked lead", withoutLead.length],
      ]} />
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
          <Badge key={row.id} tone={statusBadgeTone(row.status)}>{row.status}</Badge>,
          safeFormatDate(row.created_at),
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
          <Badge key={row.id} tone={statusBadgeTone(row.status)}>{row.status}</Badge>,
          row.customer_name ?? "N/A",
          row.contract_id ? `Contract #${row.contract_id}` : "N/A",
        ])}
      />
    </div>
  );
}

function PostSalesReport({
  tasks,
  checklists,
  allTasks,
  allChecklists,
  filters,
  onFiltersChange,
  staffOptions,
  profileById,
}: {
  tasks: PostSalesTask[];
  checklists: PostSalesChecklist[];
  allTasks: PostSalesTask[];
  allChecklists: PostSalesChecklist[];
  filters: ReportFilters;
  onFiltersChange: ReportFilterSetters;
  staffOptions: Array<[string, string]>;
  profileById: Map<string, AdminProfile>;
}) {
  const openTasks = tasks.filter((row) => ["open", "in_progress", "blocked"].includes(row.status));
  const overdueTasks = openTasks.filter((row) => isBeforeToday(row.due_at));

  function exportPostSales() {
    exportCsv({
      filename: reportFileName("post-sales-report"),
      rows: [
        ...tasks.map((row) => ({
          record_type: "task",
          title: row.title,
          status: row.status,
          priority: row.priority,
          assigned_to: staffName(row.assigned_to, profileById),
          due_at: row.due_at ? safeFormatDate(row.due_at) : "",
          customer_id: row.customer_id,
        })),
        ...checklists.map((row) => ({
          record_type: "checklist",
          title: `Checklist ${row.id}`,
          status: row.status,
          priority: "",
          assigned_to: staffName(row.assigned_to, profileById),
          due_at: "",
          customer_id: row.customer_id,
        })),
      ],
      columns: basicColumns(["record_type", "title", "status", "priority", "assigned_to", "due_at", "customer_id"]),
    });
  }

  return (
    <div className="grid gap-5">
      <ReportSummary title="Post-Sales Report" description={`${tasks.length} of ${allTasks.length} tasks and ${checklists.length} of ${allChecklists.length} checklists shown.`} onExport={exportPostSales} />
      <PostSalesFilters filters={filters} onFiltersChange={onFiltersChange} staffOptions={staffOptions} />
      <MetricGrid metrics={[
        ["Open tasks", openTasks.length],
        ["Overdue tasks", overdueTasks.length],
        ["Blocked checklists", checklists.filter((row) => row.status === "blocked").length],
        ["Agreements ready/signature", checklists.filter((row) => ["ready_for_review", "sent_for_signature"].includes(row.agreement_status)).length],
        ["Documents missing/review", checklists.filter((row) => ["missing_documents", "pending_review"].includes(row.document_status)).length],
        ["Payment setup pending", checklists.filter((row) => row.payment_setup_status === "pending").length],
        ["Collections handoff ready", checklists.filter((row) => row.collections_handoff_status === "ready").length],
      ]} />
      <div className="grid gap-5 xl:grid-cols-2">
        <CountPanel title="Agreement Statuses" counts={countBy(checklists, (row) => labelize(row.agreement_status))} />
        <CountPanel title="Document Statuses" counts={countBy(checklists, (row) => labelize(row.document_status))} />
        <CountPanel title="Payment Setup Statuses" counts={countBy(checklists, (row) => labelize(row.payment_setup_status))} />
        <CountPanel title="Collections Handoff Statuses" counts={countBy(checklists, (row) => labelize(row.collections_handoff_status))} />
      </div>
      <ReportTable
        emptyMessage="No post-sales tasks match these filters."
        headers={["Task", "Type", "Status", "Priority", "Assigned", "Due", "Customer"]}
        rows={tasks.slice(0, 100).map((row) => [
          row.title,
          labelize(row.task_type),
          <Badge key={`${row.id}-status`} tone={statusBadgeTone(row.status)}>{labelize(row.status)}</Badge>,
          <Badge key={`${row.id}-priority`} tone={priorityTone(row.priority)}>{labelize(row.priority)}</Badge>,
          staffName(row.assigned_to, profileById),
          row.due_at ? safeFormatDate(row.due_at) : "Not set",
          row.customer_id ? `Customer #${row.customer_id}` : "N/A",
        ])}
      />
    </div>
  );
}

function StaffWorkloadReport({
  leads,
  followUps,
  visits,
  postSalesTasks,
  profileById,
  staffOptions,
}: {
  leads: LeadReportRow[];
  followUps: FollowUpTask[];
  visits: SiteVisitReportRow[];
  postSalesTasks: PostSalesTask[];
  profileById: Map<string, AdminProfile>;
  staffOptions: Array<[string, string]>;
}) {
  const rows = staffOptions.map(([id, name]) => {
    const staffLeads = leads.filter((row) => row.assigned_to === id);
    const staffFollowUps = followUps.filter((row) => row.assigned_to === id && ["open", "in_progress"].includes(row.status));
    const staffVisits = visits.filter((row) => row.assigned_to === id && ["scheduled", "rescheduled"].includes(row.status));
    const staffPostSales = postSalesTasks.filter((row) => row.assigned_to === id && ["open", "in_progress", "blocked"].includes(row.status));
    const overdue = staffFollowUps.filter((row) => isBeforeToday(row.due_at)).length + staffPostSales.filter((row) => isBeforeToday(row.due_at)).length;
    return { id, name, leads: staffLeads.length, followUps: staffFollowUps.length, visits: staffVisits.length, postSales: staffPostSales.length, overdue };
  });

  function exportWorkload() {
    exportCsv({
      filename: reportFileName("staff-workload-report"),
      rows,
      columns: basicColumns(["name", "leads", "followUps", "visits", "postSales", "overdue"]),
    });
  }

  return (
    <div className="grid gap-5">
      <ReportSummary title="Staff Workload Report" description={`${rows.length} staff members with assigned CRM work.`} onExport={exportWorkload} />
      <ReportTable
        emptyMessage="No assigned staff workload found."
        headers={["Staff", "Assigned Leads", "Open Follow-ups", "Scheduled Visits", "Open Post-Sales", "Overdue Items"]}
        rows={rows.map((row) => [
          row.name || staffName(row.id, profileById),
          String(row.leads),
          String(row.followUps),
          String(row.visits),
          String(row.postSales),
          row.overdue ? <Badge key={row.id} tone="red">{row.overdue}</Badge> : <Badge key={row.id} tone="green">0</Badge>,
        ])}
      />
    </div>
  );
}

function DemandReport({
  leads,
  applications,
  reservations,
  visits,
  lotById,
}: {
  leads: LeadReportRow[];
  applications: ApplicationReportRow[];
  reservations: ReservationReportRow[];
  visits: SiteVisitReportRow[];
  lotById: Map<number, { lot_number: string; status: string }>;
}) {
  const demand = new Map<string, { lot: string; leads: number; applications: number; reservations: number; visits: number; activeReservation: boolean }>();
  function ensure(lot: string) {
    const current = demand.get(lot) ?? { lot, leads: 0, applications: 0, reservations: 0, visits: 0, activeReservation: false };
    demand.set(lot, current);
    return current;
  }
  leads.forEach((lead) => {
    const lot = lead.parcels?.lot_number ?? (lead.parcel_id ? lotById.get(lead.parcel_id)?.lot_number : null);
    if (lot) ensure(lot).leads += 1;
  });
  applications.forEach((application) => application.preferred_parcel_ids?.forEach((id) => {
    const lot = lotById.get(id)?.lot_number ?? `Lot #${id}`;
    ensure(lot).applications += 1;
  }));
  reservations.forEach((reservation) => {
    const lot = reservation.parcels?.lot_number ?? (reservation.parcel_id ? lotById.get(reservation.parcel_id)?.lot_number : null);
    if (!lot) return;
    const row = ensure(lot);
    row.reservations += 1;
    row.activeReservation ||= activeReservationStatuses.has(reservation.status);
  });
  visits.forEach((visit) => {
    const lot = visit.parcels?.lot_number ?? (visit.parcel_id ? lotById.get(visit.parcel_id)?.lot_number : null);
    if (lot) ensure(lot).visits += 1;
  });
  const rows = [...demand.values()].sort((a, b) => (b.leads + b.applications + b.reservations + b.visits) - (a.leads + a.applications + a.reservations + a.visits));

  function exportDemand() {
    exportCsv({
      filename: reportFileName("project-lot-demand-report"),
      rows,
      columns: basicColumns(["lot", "leads", "applications", "reservations", "visits", "activeReservation"]),
    });
  }

  return (
    <div className="grid gap-5">
      <ReportSummary title="Project / Lot Demand Report" description={`${rows.length} lots have recorded lead, application, reservation, or visit interest.`} onExport={exportDemand} />
      <ReportTable
        emptyMessage="No lot demand records found."
        headers={["Lot", "Leads", "Applications", "Reservations", "Site Visits", "Active Reservation", "Repeated Interest"]}
        rows={rows.map((row) => {
          const totalInterest = row.leads + row.applications + row.reservations + row.visits;
          return [
            row.lot,
            String(row.leads),
            String(row.applications),
            String(row.reservations),
            String(row.visits),
            row.activeReservation ? <Badge key={`${row.lot}-active`} tone="amber">Yes</Badge> : "No",
            totalInterest > 1 ? <Badge key={`${row.lot}-interest`} tone="blue">{totalInterest} records</Badge> : "No",
          ];
        })}
      />
    </div>
  );
}

function MissingItemsReport({
  items,
  paymentRequests,
  postSalesChecklists,
}: {
  items: {
    missingReceipts: PaymentReportRow[];
    missingProofs: PaymentReportRow[];
    missingSignedContracts: ContractReportRow[];
    customersWithoutActiveContract: CustomerReportRow[];
    incompleteApplications: ApplicationReportRow[];
  };
  paymentRequests: PaymentRequest[];
  postSalesChecklists: PostSalesChecklist[];
}) {
  const overduePaymentRequests = paymentRequests.filter((row) => ["Draft", "Sent"].includes(row.status) && isBeforeToday(row.due_date));
  const handoffReady = postSalesChecklists.filter((row) => row.collections_handoff_status === "ready");
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
          <CleanupMetric title="Overdue requests" value={overduePaymentRequests.length} />
          <CleanupMetric title="Handoff ready" value={handoffReady.length} />
        </CardContent>
      </Card>
      <MissingList
        title="Payments missing manual receipt number"
        rows={items.missingReceipts.map((payment) => `${safeFormatDate(payment.created_at)} - ${payment.customers ? customerName(payment.customers) : "Unknown"} - ${money(payment.amount)}`)}
      />
      <MissingList
        title="Online payments missing uploaded proof/document"
        rows={items.missingProofs.map((payment) => `${safeFormatDate(payment.created_at)} - ${payment.customers ? customerName(payment.customers) : "Unknown"} - ${payment.bank_reference ?? "No reference"}`)}
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
        rows={items.incompleteApplications.map((application) => `${application.applicant_full_name || `${application.first_name} ${application.last_name}`.trim()} - ${safeFormatDate(application.created_at)}`)}
      />
      <MissingList
        title="Overdue payment requests"
        rows={overduePaymentRequests.map((request) => `Payment request #${request.id} - ${money(request.amount_due)} due ${safeFormatDate(request.due_date)}`)}
      />
      <MissingList
        title="Collections handoff ready"
        rows={handoffReady.map((checklist) => `Checklist #${checklist.id} - Customer ${checklist.customer_id ?? "N/A"}`)}
      />
    </div>
  );
}

type ReportFilters = {
  dateFrom: string;
  dateTo: string;
  pipelineStage: string;
  leadSource: string;
  assignedStaff: string;
  taskStatus: string;
  taskPriority: string;
  visitStatus: string;
  reservationStatus: string;
  postSalesStatus: string;
};

type ReportFilterSetters = {
  setDateFrom: (value: string) => void;
  setDateTo: (value: string) => void;
  setPipelineStage: (value: string) => void;
  setLeadSource: (value: string) => void;
  setAssignedStaff: (value: string) => void;
  setTaskStatus: (value: string) => void;
  setTaskPriority: (value: string) => void;
  setVisitStatus: (value: string) => void;
  setReservationStatus: (value: string) => void;
  setPostSalesStatus: (value: string) => void;
};

function DateFilters({ dateFrom, dateTo, setDateFrom, setDateTo }: { dateFrom: string; dateTo: string; setDateFrom: (value: string) => void; setDateTo: (value: string) => void }) {
  return (
    <Card>
      <CardHeader><CardTitle>Filters</CardTitle></CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <Field label="Date from">
          <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        </Field>
        <Field label="Date to">
          <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        </Field>
      </CardContent>
    </Card>
  );
}

function SalesFilters({ filters, onFiltersChange, sourceOptions, staffOptions }: { filters: ReportFilters; onFiltersChange: ReportFilterSetters; sourceOptions: string[]; staffOptions: Array<[string, string]> }) {
  return (
    <Card>
      <CardHeader><CardTitle>Filters</CardTitle></CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-5">
        <Field label="Date from"><Input type="date" value={filters.dateFrom} onChange={(event) => onFiltersChange.setDateFrom(event.target.value)} /></Field>
        <Field label="Date to"><Input type="date" value={filters.dateTo} onChange={(event) => onFiltersChange.setDateTo(event.target.value)} /></Field>
        <Field label="Pipeline stage">
          <Select value={filters.pipelineStage} onChange={(event) => onFiltersChange.setPipelineStage(event.target.value)}>
            <option value="">All stages</option>
            {pipelineStages.map((stage) => <option key={stage} value={stage}>{leadStageLabel(stage)}</option>)}
          </Select>
        </Field>
        <Field label="Source">
          <Select value={filters.leadSource} onChange={(event) => onFiltersChange.setLeadSource(event.target.value)}>
            <option value="">All sources</option>
            {sourceOptions.map((source) => <option key={source}>{source}</option>)}
          </Select>
        </Field>
        <Field label="Assigned staff">
          <Select value={filters.assignedStaff} onChange={(event) => onFiltersChange.setAssignedStaff(event.target.value)}>
            <option value="">All staff</option>
            {staffOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
        </Field>
      </CardContent>
    </Card>
  );
}

function TaskFilters({ filters, onFiltersChange, staffOptions, statusOptions }: { filters: ReportFilters; onFiltersChange: ReportFilterSetters; staffOptions: Array<[string, string]>; statusOptions: string[] }) {
  return (
    <Card>
      <CardHeader><CardTitle>Filters</CardTitle></CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-5">
        <Field label="Date from"><Input type="date" value={filters.dateFrom} onChange={(event) => onFiltersChange.setDateFrom(event.target.value)} /></Field>
        <Field label="Date to"><Input type="date" value={filters.dateTo} onChange={(event) => onFiltersChange.setDateTo(event.target.value)} /></Field>
        <Field label="Status">
          <Select value={filters.taskStatus} onChange={(event) => onFiltersChange.setTaskStatus(event.target.value)}>
            <option value="">All statuses</option>
            {statusOptions.map((status) => <option key={status} value={status}>{labelize(status)}</option>)}
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={filters.taskPriority} onChange={(event) => onFiltersChange.setTaskPriority(event.target.value)}>
            <option value="">All priorities</option>
            {followUpPriorities.map((priority) => <option key={priority} value={priority}>{labelize(priority)}</option>)}
          </Select>
        </Field>
        <Field label="Assigned staff">
          <Select value={filters.assignedStaff} onChange={(event) => onFiltersChange.setAssignedStaff(event.target.value)}>
            <option value="">All staff</option>
            {staffOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
        </Field>
      </CardContent>
    </Card>
  );
}

function VisitFilters({ filters, onFiltersChange, staffOptions }: { filters: ReportFilters; onFiltersChange: ReportFilterSetters; staffOptions: Array<[string, string]> }) {
  return (
    <Card>
      <CardHeader><CardTitle>Filters</CardTitle></CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-4">
        <Field label="Date from"><Input type="date" value={filters.dateFrom} onChange={(event) => onFiltersChange.setDateFrom(event.target.value)} /></Field>
        <Field label="Date to"><Input type="date" value={filters.dateTo} onChange={(event) => onFiltersChange.setDateTo(event.target.value)} /></Field>
        <Field label="Status">
          <Select value={filters.visitStatus} onChange={(event) => onFiltersChange.setVisitStatus(event.target.value)}>
            <option value="">All statuses</option>
            {siteVisitStatuses.map((status) => <option key={status} value={status}>{labelize(status)}</option>)}
          </Select>
        </Field>
        <Field label="Assigned staff">
          <Select value={filters.assignedStaff} onChange={(event) => onFiltersChange.setAssignedStaff(event.target.value)}>
            <option value="">All staff</option>
            {staffOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
        </Field>
      </CardContent>
    </Card>
  );
}

function ReservationFilters({ filters, onFiltersChange, staffOptions }: { filters: ReportFilters; onFiltersChange: ReportFilterSetters; staffOptions: Array<[string, string]> }) {
  return (
    <Card>
      <CardHeader><CardTitle>Filters</CardTitle></CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-4">
        <Field label="Date from"><Input type="date" value={filters.dateFrom} onChange={(event) => onFiltersChange.setDateFrom(event.target.value)} /></Field>
        <Field label="Date to"><Input type="date" value={filters.dateTo} onChange={(event) => onFiltersChange.setDateTo(event.target.value)} /></Field>
        <Field label="Status">
          <Select value={filters.reservationStatus} onChange={(event) => onFiltersChange.setReservationStatus(event.target.value)}>
            <option value="">All statuses</option>
            {reservationStatuses.map((status) => <option key={status} value={status}>{labelize(status)}</option>)}
          </Select>
        </Field>
        <Field label="Assigned staff">
          <Select value={filters.assignedStaff} onChange={(event) => onFiltersChange.setAssignedStaff(event.target.value)}>
            <option value="">All staff</option>
            {staffOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
        </Field>
      </CardContent>
    </Card>
  );
}

function PostSalesFilters({ filters, onFiltersChange, staffOptions }: { filters: ReportFilters; onFiltersChange: ReportFilterSetters; staffOptions: Array<[string, string]> }) {
  return (
    <Card>
      <CardHeader><CardTitle>Filters</CardTitle></CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-5">
        <Field label="Date from"><Input type="date" value={filters.dateFrom} onChange={(event) => onFiltersChange.setDateFrom(event.target.value)} /></Field>
        <Field label="Date to"><Input type="date" value={filters.dateTo} onChange={(event) => onFiltersChange.setDateTo(event.target.value)} /></Field>
        <Field label="Checklist status">
          <Select value={filters.postSalesStatus} onChange={(event) => onFiltersChange.setPostSalesStatus(event.target.value)}>
            <option value="">All statuses</option>
            {postSalesStatuses.map((status) => <option key={status} value={status}>{labelize(status)}</option>)}
          </Select>
        </Field>
        <Field label="Task priority">
          <Select value={filters.taskPriority} onChange={(event) => onFiltersChange.setTaskPriority(event.target.value)}>
            <option value="">All priorities</option>
            {followUpPriorities.map((priority) => <option key={priority} value={priority}>{labelize(priority)}</option>)}
          </Select>
        </Field>
        <Field label="Assigned staff">
          <Select value={filters.assignedStaff} onChange={(event) => onFiltersChange.setAssignedStaff(event.target.value)}>
            <option value="">All staff</option>
            {staffOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
        </Field>
      </CardContent>
    </Card>
  );
}

function MetricGrid({ metrics }: { metrics: Array<[string, number]> }) {
  return (
    <Card>
      <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map(([title, value]) => <CleanupMetric key={title} title={title} value={value} />)}
      </CardContent>
    </Card>
  );
}

function CountPanel({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="grid gap-2">
        {entries.length ? entries.map(([label, count]) => (
          <div key={label} className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm">
            <span className="font-medium text-primary">{label}</span>
            <Badge tone="blue">{count}</Badge>
          </div>
        )) : <p className="text-sm text-muted-foreground">No records found.</p>}
      </CardContent>
    </Card>
  );
}

function ReportSummary({ title, description, onExport }: { title: string; description: string; onExport: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
        <div>
          <p className="font-display text-2xl font-semibold text-foreground">{title}</p>
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
            <table className="crm-table min-w-[900px]">
              <thead>
                <tr>
                  {headers.map((header) => (
                    <th key={header}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className="max-w-[260px] align-top break-words">
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
    <div className="crm-subpanel">
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
          <div key={row} className="break-words rounded-md border border-border bg-card p-3 text-sm text-slate shadow-sm shadow-primary/5">{row}</div>
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
  const dueDay = Number.isFinite(Number(contract.payment_due_day))
    ? Math.max(1, Math.min(31, Number(contract.payment_due_day)))
    : 1;
  const due = new Date(now.getFullYear(), now.getMonth(), dueDay);
  if (due < now) due.setMonth(due.getMonth() + 1);
  return due.toISOString();
}

const activeReservationStatuses = new Set<ReservationStatus>(["draft", "reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed"]);

function inDateRange(value: string | null | undefined, dateFrom: string, dateTo: string) {
  const date = parseDate(value);
  if (!date) return !dateFrom && !dateTo;
  const matchesFrom = !dateFrom || date >= startOfDay(dateFrom);
  const matchesTo = !dateTo || date < dayAfter(dateTo);
  return matchesFrom && matchesTo;
}

function isBeforeToday(value: string | null | undefined) {
  const date = parseDate(value);
  return Boolean(date && date < startOfLocalToday());
}

function isTodayOrUpcoming(value: string | null | undefined, days: number) {
  const date = parseDate(value);
  if (!date) return false;
  const start = startOfLocalToday();
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  return date >= start && date < end;
}

function parseDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfLocalToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function countBy<T>(rows: T[], keyFn: (row: T) => string) {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const key = keyFn(row) || "Unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function leadStageLabel(stage: string) {
  return labelize(stage);
}

function leadStageTone(stage: string) {
  if (["closed_won", "deposit_paid", "contract_started"].includes(stage)) return "green";
  if (["lost_inactive"].includes(stage)) return "gray";
  if (["family_decision", "payment_plan_review", "deposit_pending"].includes(stage)) return "amber";
  return "blue";
}

function priorityTone(priority: string) {
  if (priority === "urgent") return "red";
  if (priority === "high") return "amber";
  if (priority === "low") return "gray";
  return "blue";
}

function staffName(userId: string | null | undefined, profileById: Map<string, AdminProfile>) {
  if (!userId) return "Unassigned";
  const profile = profileById.get(userId);
  return profile?.full_name || profile?.email || userId;
}

function safeFormatDate(value: string | null | undefined) {
  if (!parseDate(value)) return "Date not recorded";
  try {
    return formatDate(value);
  } catch {
    return "Date not recorded";
  }
}

function basicColumns(keys: string[]) {
  return keys.map((key) => ({
    header: labelize(key),
    accessor: (row: Record<string, string | number | boolean | null | undefined>) => row[key],
  }));
}
