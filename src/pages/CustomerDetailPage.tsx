import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Clipboard, RefreshCw } from "lucide-react";
import { ContractForm } from "../components/forms/ContractForm";
import { PaymentForm } from "../components/forms/PaymentForm";
import { PageHeader } from "../components/layout/PageHeader";
import { PaymentDocumentLinks } from "../components/payments/PaymentDocumentLinks";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Field, Input, Select, Textarea } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { UploadFileSummary } from "../components/uploads/UploadFileSummary";
import { accountDueDate } from "../lib/accountDates";
import { getSessionAndProfile } from "../lib/data";
import { supabase } from "../lib/supabase";
import { prepareUploadFile, type PreparedUploadFile } from "../lib/uploads";
import { cn, formatDate, money } from "../lib/utils";
import type {
  Contract,
  CustomerAiSummary,
  PaymentDocument,
  PaymentDocumentType,
  PaymentRequest,
  PaymentRequestStatus,
  Transaction,
} from "../types/database";

const customerSections = ["Overview", "Contract", "Payments", "Documents", "Requests", "Statement", "AI Summary"] as const;
const requestStatuses: PaymentRequestStatus[] = ["Draft", "Sent", "Paid", "Cancelled"];
const documentTypes: PaymentDocumentType[] = ["Bank Transfer Proof", "Manual Receipt Photo", "Signed Payment Note", "Other"];

type CustomerSection = (typeof customerSections)[number];
type ActionModalKind = "payment" | "contract" | "request" | "document" | null;
type CustomerContract = Contract & { parcels?: { lot_number: string | null; status?: string | null } | null };
type CustomerTransaction = Transaction & { payment_documents?: PaymentDocument[] | null };
type PaymentDocumentWithTransaction = PaymentDocument & {
  transactions?: Pick<Transaction, "id" | "receipt_number" | "amount" | "transaction_type" | "created_at"> | null;
};
type CustomerDetail = {
  id: number;
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  address: string | null;
  applications?: { parcels?: { lot_number: string | null; status?: string | null } | null } | null;
  contracts?: CustomerContract[] | null;
  transactions?: CustomerTransaction[] | null;
  payment_documents?: PaymentDocumentWithTransaction[] | null;
  payment_requests?: PaymentRequest[] | null;
  customer_ai_summaries?: CustomerAiSummary[] | null;
};

export function CustomerDetailPage() {
  const { id } = useParams();
  const customerId = Number(id);
  const queryClient = useQueryClient();
  const [activeSection, setActiveSection] = useState<CustomerSection>("Overview");
  const [activeAction, setActiveAction] = useState<ActionModalKind>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const { data: sessionProfile } = useQuery({
    queryKey: ["session-profile"],
    queryFn: getSessionAndProfile,
  });
  const { data: aiSettings } = useQuery({
    queryKey: ["customer-ai-settings"],
    queryFn: async () => {
      const { data: settings, error: queryError } = await supabase
        .from("ai_settings")
        .select("is_enabled, collections_assistant_enabled")
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (queryError) throw queryError;
      return settings;
    },
  });
  const { data: adminProfiles } = useQuery({
    queryKey: ["customer-ai-admin-profiles"],
    queryFn: async () => {
      const { data: profiles, error: queryError } = await supabase
        .from("admin_profiles")
        .select("user_id, full_name, email");
      if (queryError) throw queryError;
      return profiles as Array<{ user_id: string; full_name: string | null; email: string | null }>;
    },
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ["customer-detail", customerId],
    queryFn: async () => {
      const { data: customer, error: queryError } = await supabase
        .from("customers")
        .select(
          "*, applications(*, parcels(*)), contracts(*, parcels(*)), transactions(*, payment_documents(*)), payment_documents(*, transactions(id, receipt_number, amount, transaction_type, created_at)), payment_requests(*), customer_ai_summaries(*)",
        )
        .eq("id", customerId)
        .single();
      if (queryError) throw queryError;
      return customer as CustomerDetail;
    },
    enabled: Number.isFinite(customerId),
  });

  const landPayments =
    data?.transactions?.filter((item) => ["Down Payment", "Land Installment"].includes(item.transaction_type)) ?? [];
  const communityPayments =
    data?.transactions?.filter((item) => ["Garbage Fee", "Road Maintenance"].includes(item.transaction_type)) ?? [];
  const currentRole = sessionProfile?.profile?.role;
  const canGenerateAiSummary = currentRole === "Super Admin" || currentRole === "Admin" || currentRole === "Staff";
  const collectionsAiEnabled = Boolean(aiSettings?.is_enabled && aiSettings.collections_assistant_enabled);
  const latestAiSummary = latestSummary(data?.customer_ai_summaries ?? []);
  const generatedByProfile = latestAiSummary?.generated_by
    ? adminProfiles?.find((profile) => profile.user_id === latestAiSummary.generated_by) ?? null
    : null;

  function refreshCustomer() {
    void queryClient.invalidateQueries({ queryKey: ["customer-detail", customerId] });
  }

  function handleActionSuccess(message: string) {
    setActiveAction(null);
    setToast(message);
    refreshCustomer();
  }

  async function generateAiSummary() {
    setActionError(null);
    setToast(null);
    setGeneratingSummary(true);
    const { data: result, error: functionError } = await supabase.functions.invoke("generate-customer-summary", {
      body: { customer_id: customerId },
    });
    setGeneratingSummary(false);
    if (functionError) {
      setActionError(functionError.message);
      return;
    }
    if (result?.error) {
      setActionError(String(result.error));
      return;
    }
    setToast(String(result?.message ?? "Customer AI summary generated."));
    await queryClient.invalidateQueries({ queryKey: ["customer-detail", customerId] });
  }

  async function copyFollowUpMessage(message: string) {
    setActionError(null);
    setToast(null);
    try {
      await navigator.clipboard.writeText(message);
      setToast("Follow-up message copied.");
    } catch {
      setActionError("Clipboard copy failed in this browser.");
    }
  }

  function showStatement() {
    setActiveSection("Statement");
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  }

  return (
    <>
      <PageHeader
        title={data ? `${data.first_name} ${data.last_name}` : "Customer"}
        description="Customer account profile, balance standing, documents, requests, and collections history."
      />
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      {data ? (
        <div className="mx-auto grid max-w-7xl gap-6">
          {toast ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-sage/35 bg-sage/15 px-4 py-3 text-sm text-primary">
              <span>{toast}</span>
              <button type="button" className="font-medium text-primary" onClick={() => setToast(null)}>
                Dismiss
              </button>
            </div>
          ) : null}
          {actionError ? <ErrorState message={actionError} /> : null}

          <CustomerAccountHeader customer={data} landPayments={landPayments} />

          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="grid min-w-0 gap-6">
              <div className="overflow-x-auto rounded-md border bg-white">
                <div className="flex min-w-max gap-1 p-1 sm:min-w-0 sm:flex-wrap">
                  {customerSections.map((section) => (
                    <button
                      key={section}
                      type="button"
                      className={cn(
                        "h-10 rounded-md px-4 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-primary",
                        activeSection === section ? "bg-primary text-white shadow-sm hover:bg-primary hover:text-white" : "",
                      )}
                      onClick={() => setActiveSection(section)}
                    >
                      {section}
                    </button>
                  ))}
                </div>
              </div>

              {activeSection === "Overview" ? <OverviewSection customer={data} /> : null}
              {activeSection === "Contract" ? <ContractSection contracts={data.contracts ?? []} /> : null}
              {activeSection === "Payments" ? (
                <>
                  <Ledger title="Land Payment History" rows={landPayments} />
                  <Ledger title="Community Fee History" rows={communityPayments} />
                </>
              ) : null}
              {activeSection === "Documents" ? <DocumentsSection documents={data.payment_documents ?? []} /> : null}
              {activeSection === "Requests" ? (
                <PaymentRequestsSection
                  requests={data.payment_requests ?? []}
                  onNewRequest={() => setActiveAction("request")}
                  onChanged={() => {
                    setToast("Payment request updated.");
                    refreshCustomer();
                  }}
                />
              ) : null}
              {activeSection === "Statement" ? (
                <BalanceStatementSection customer={data} landPayments={landPayments} />
              ) : null}
              {activeSection === "AI Summary" ? (
                <AiSummarySection
                  summary={latestAiSummary}
                  canGenerate={canGenerateAiSummary}
                  aiEnabled={collectionsAiEnabled}
                  generating={generatingSummary}
                  generatedByLabel={adminProfileLabel(generatedByProfile)}
                  onGenerate={() => void generateAiSummary()}
                  onCopy={(message) => void copyFollowUpMessage(message)}
                />
              ) : null}
            </div>

            <QuickActions
              onRecordPayment={() => setActiveAction("payment")}
              onCreateContract={() => setActiveAction("contract")}
              onCreateRequest={() => setActiveAction("request")}
              onUploadDocument={() => setActiveAction("document")}
              onStatement={showStatement}
            />
          </div>

          <ActionModal
            title="Record Payment"
            description="Log a payment, receipt book number, bank reference, and optional supporting document."
            open={activeAction === "payment"}
            onClose={() => setActiveAction(null)}
          >
            <PaymentForm
              customerId={customerId}
              embedded
              onSuccess={() => handleActionSuccess("Payment recorded.")}
            />
          </ActionModal>

          <ActionModal
            title="Create Contract"
            description="Create a customer contract using the standard installment plans or a custom agreement."
            open={activeAction === "contract"}
            onClose={() => setActiveAction(null)}
          >
            <ContractForm
              customerId={customerId}
              embedded
              onSuccess={() => handleActionSuccess("Contract created.")}
            />
          </ActionModal>

          <ActionModal
            title="New Payment Request"
            description="Create a request for an upcoming or overdue customer payment."
            open={activeAction === "request"}
            onClose={() => setActiveAction(null)}
          >
            <PaymentRequestForm
              customerId={customerId}
              contracts={data.contracts ?? []}
              onSuccess={() => handleActionSuccess("Payment request created.")}
            />
          </ActionModal>

          <ActionModal
            title="Upload Payment Document"
            description="Attach bank proof, a manual receipt photo, signed payment note, or supporting document."
            open={activeAction === "document"}
            onClose={() => setActiveAction(null)}
          >
            <CustomerDocumentUploadForm
              customerId={customerId}
              transactions={data.transactions ?? []}
              onSuccess={() => handleActionSuccess("Payment document uploaded.")}
            />
          </ActionModal>
        </div>
      ) : null}
    </>
  );
}

function CustomerAccountHeader({
  customer,
  landPayments,
}: {
  customer: CustomerDetail;
  landPayments: CustomerTransaction[];
}) {
  const contract = activeContract(customer.contracts ?? []);
  const lotNumber = assignedLot(customer);
  const totalPaid = totalAmount(landPayments);
  const remainingBalance = contract ? Math.max(Number(contract.final_purchase_price) - totalPaid, 0) : 0;
  const missingReceiptCount = customer.transactions?.filter((transaction) => !transaction.manual_receipt_number).length ?? 0;

  return (
    <section className="rounded-lg border bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-copper">Customer Account</p>
          <h1 className="mt-2 text-2xl font-semibold text-primary sm:text-3xl">
            {customer.first_name} {customer.last_name}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Account standing, contract activity, payment records, and collection follow-up for this customer.
          </p>
        </div>
        <div className="flex max-w-full flex-wrap gap-2">
          {contract?.is_active ? <Badge tone="green">Active contract</Badge> : <Badge tone="gray">No active contract</Badge>}
          {lotNumber ? <Badge tone="blue">Lot assigned</Badge> : <Badge tone="amber">No lot assigned</Badge>}
          {remainingBalance > 0 ? <Badge tone="amber">Open balance</Badge> : contract ? <Badge tone="green">Paid in full</Badge> : null}
          {missingReceiptCount > 0 ? <Badge tone="red">{missingReceiptCount} missing receipt #</Badge> : null}
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <SummaryCard label="Assigned lot" value={lotNumber ? `Lot ${lotNumber}` : "Not assigned"} />
        <SummaryCard label="Contract status" value={contract ? (contract.is_active ? "Active" : "Closed") : "No contract"} />
        <SummaryCard label="Total paid" value={money(totalPaid)} />
        <SummaryCard label="Remaining balance" value={contract ? money(remainingBalance) : "N/A"} />
        <SummaryCard label="Monthly payment" value={contract ? money(contract.monthly_payment) : "N/A"} />
        <SummaryCard label="Next due date" value={contract ? formatDate(nextDueDate(contract)) : "N/A"} />
      </div>
    </section>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-ivory/35 p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-base font-semibold text-primary">{value}</p>
    </div>
  );
}

function QuickActions({
  onRecordPayment,
  onCreateContract,
  onCreateRequest,
  onUploadDocument,
  onStatement,
}: {
  onRecordPayment: () => void;
  onCreateContract: () => void;
  onCreateRequest: () => void;
  onUploadDocument: () => void;
  onStatement: () => void;
}) {
  return (
    <aside className="grid gap-4 xl:sticky xl:top-6">
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          <Button type="button" onClick={onRecordPayment}>Record Payment</Button>
          <Button type="button" variant="secondary" onClick={onCreateContract}>Create Contract</Button>
          <Button type="button" variant="secondary" onClick={onCreateRequest}>Create Payment Request</Button>
          <Button type="button" variant="secondary" onClick={onUploadDocument}>Upload Payment Document</Button>
          <Button type="button" variant="ghost" onClick={onStatement}>Print / View Statement</Button>
        </CardContent>
      </Card>
    </aside>
  );
}

function OverviewSection({ customer }: { customer: CustomerDetail }) {
  const openRequests = customer.payment_requests?.filter((request) => !["Paid", "Cancelled"].includes(request.status)).length ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Overview</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <InfoItem label="Phone" value={customer.phone} />
        <InfoItem label="Email" value={customer.email ?? "Not provided"} />
        <InfoItem label="Address" value={customer.address ?? "Not provided"} />
        <InfoItem label="Assigned lot" value={assignedLot(customer) ? `Lot ${assignedLot(customer)}` : "Not assigned"} />
        <InfoItem label="Open payment requests" value={String(openRequests)} />
      </CardContent>
    </Card>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-ivory/35 p-3 text-sm">
      <p className="font-medium text-primary">{label}</p>
      <p className="mt-1 text-muted-foreground">{value}</p>
    </div>
  );
}

function Ledger({
  title,
  rows,
}: {
  title: string;
  rows: CustomerTransaction[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {rows.length === 0 ? <EmptyState message="No transactions recorded." /> : null}
        {rows.map((row) => (
          <div key={row.id} className="grid gap-3 rounded-md border bg-white p-4 text-sm">
            <div className="flex flex-wrap justify-between gap-3">
              <div>
                <p className="font-medium text-primary">{row.transaction_type}</p>
                <p className="text-muted-foreground">{formatDate(row.created_at)}</p>
              </div>
              <span className="font-semibold text-primary">{money(row.amount)}</span>
            </div>
            <div className="grid gap-2 text-muted-foreground sm:grid-cols-2">
              <span>Bank reference: {row.bank_reference ?? "N/A"}</span>
              <span>Receipt date: {row.receipt_date ? formatDate(row.receipt_date) : "Not recorded"}</span>
              <span>Manual receipt: {row.manual_receipt_number ?? "Missing"}</span>
              <span>
                {row.manual_receipt_number ? <Badge tone="green">Receipt recorded</Badge> : <Badge tone="amber">Missing receipt #</Badge>}
              </span>
            </div>
            <PaymentDocumentLinks documents={row.payment_documents} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ContractSection({ contracts }: { contracts: CustomerContract[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Contract</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {contracts.length === 0 ? <EmptyState message="No contracts recorded." /> : null}
        {contracts.map((contract) => (
          <div key={contract.id} className="grid gap-3 rounded-md border bg-white p-4 text-sm">
            <div className="flex flex-wrap justify-between gap-3">
              <div>
                <strong className="text-primary">Contract #{contract.id}</strong>
                <p className="text-muted-foreground">
                  {contract.parcels?.lot_number ? `Lot ${contract.parcels.lot_number}` : "No lot label available"}
                </p>
              </div>
              <Badge tone={contract.is_active ? "green" : "gray"}>{contract.is_active ? "Active" : "Closed"}</Badge>
            </div>
            <div className="grid gap-2 text-muted-foreground md:grid-cols-2">
              <span>Price: {money(contract.final_purchase_price)}</span>
              <span>Initial deposit: {money(contract.initial_deposit)}</span>
              <span>Monthly: {money(contract.monthly_payment)}</span>
              <span>Term: {contract.term_months} months</span>
              <span>Due day: {contract.payment_due_day}</span>
              <span>Start: {formatDate(contract.start_date)}</span>
            </div>
            <p className="text-muted-foreground">Signed file: {contract.signed_contract_file_path ?? "Not uploaded"}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function DocumentsSection({ documents }: { documents: PaymentDocumentWithTransaction[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Documents</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {documents.length === 0 ? <EmptyState message="No payment documents uploaded." /> : null}
        {documents.map((document) => (
          <div key={document.id} className="grid gap-3 rounded-md border bg-white p-4 text-sm lg:grid-cols-[1fr_auto] lg:items-center">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="blue">{document.document_type}</Badge>
                <span className="font-medium text-primary">{document.original_file_name}</span>
              </div>
              <p className="mt-2 text-muted-foreground">
                Related transaction: {document.transactions ? `${document.transactions.transaction_type} - ${money(document.transactions.amount)}` : "Not linked"}
              </p>
              <p className="text-muted-foreground">Uploaded: {formatDate(document.created_at)}</p>
            </div>
            <PaymentDocumentLinks documents={[document]} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PaymentRequestsSection({
  requests,
  onNewRequest,
  onChanged,
}: {
  requests: PaymentRequest[];
  onNewRequest: () => void;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<string | null>(null);

  async function updateRequestStatus(id: number, nextStatus: PaymentRequestStatus) {
    setStatus(null);
    const { error } = await supabase
      .from("payment_requests")
      .update({ status: nextStatus })
      .eq("id", id);
    if (error) {
      setStatus(error.message);
      return;
    }
    onChanged();
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle>Requests</CardTitle>
          <Button type="button" onClick={onNewRequest}>New Payment Request</Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {status ? <p className="rounded-md border border-copper/30 bg-copper/10 p-3 text-sm text-copper">{status}</p> : null}
        {requests.length === 0 ? <EmptyState message="No payment requests created." /> : null}
        {requests.map((request) => (
          <div key={request.id} className="grid gap-3 rounded-md border bg-white p-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium text-primary">{request.reason}</p>
                <p className="text-muted-foreground">{money(request.amount_due)} due {formatDate(request.due_date)}</p>
              </div>
              <Badge tone={request.status === "Paid" ? "green" : request.status === "Cancelled" ? "gray" : request.status === "Sent" ? "blue" : "amber"}>
                {request.status}
              </Badge>
            </div>
            {request.notes ? <p className="text-muted-foreground">{request.notes}</p> : null}
            <div className="flex flex-wrap gap-2">
              {requestStatuses.filter((option) => option !== request.status).map((option) => (
                <Button key={option} type="button" variant="secondary" className="h-8 px-3" onClick={() => void updateRequestStatus(request.id, option)}>
                  Mark {option}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PaymentRequestForm({
  customerId,
  contracts,
  onSuccess,
}: {
  customerId: number;
  contracts: CustomerContract[];
  onSuccess: () => void;
}) {
  const [contractId, setContractId] = useState(String(contracts.find((contract) => contract.is_active)?.id ?? ""));
  const [amountDue, setAmountDue] = useState("");
  const [dueDate, setDueDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("Monthly installment");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function createRequest(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user.id;
    if (!userId) {
      setSaving(false);
      setError("Your session has expired. Sign in again.");
      return;
    }

    const { error: insertError } = await supabase.from("payment_requests").insert({
      customer_id: customerId,
      contract_id: contractId ? Number(contractId) : null,
      amount_due: Number(amountDue),
      due_date: dueDate,
      reason,
      notes: notes.trim() || null,
      status: "Draft",
      created_by: userId,
    });
    setSaving(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    onSuccess();
  }

  return (
    <form className="grid gap-4" onSubmit={createRequest}>
      {error ? <ErrorState message={error} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Contract">
          <Select value={contractId} onChange={(event) => setContractId(event.target.value)}>
            <option value="">No contract</option>
            {contracts.map((contract) => (
              <option key={contract.id} value={contract.id}>Contract #{contract.id}</option>
            ))}
          </Select>
        </Field>
        <Field label="Amount due">
          <Input type="number" min="0" step="0.01" value={amountDue} onChange={(event) => setAmountDue(event.target.value)} required />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Due date">
          <Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} required />
        </Field>
        <Field label="Reason">
          <Input value={reason} onChange={(event) => setReason(event.target.value)} required />
        </Field>
      </div>
      <Field label="Notes">
        <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
      </Field>
      <Button disabled={saving}>{saving ? "Creating..." : "Create payment request"}</Button>
    </form>
  );
}

function CustomerDocumentUploadForm({
  customerId,
  transactions,
  onSuccess,
}: {
  customerId: number;
  transactions: CustomerTransaction[];
  onSuccess: () => void;
}) {
  const [transactionId, setTransactionId] = useState("");
  const [documentType, setDocumentType] = useState<PaymentDocumentType>("Manual Receipt Photo");
  const [file, setFile] = useState<PreparedUploadFile | null>(null);
  const [fileStatus, setFileStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function uploadDocument(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!file) {
      setError("Choose a document to upload.");
      return;
    }
    setSaving(true);
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user.id;
    if (!userId) {
      setSaving(false);
      setError("Your session has expired. Sign in again.");
      return;
    }

    setFileStatus("Uploading document...");
    const safeName = file.uploadFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const linkedTransactionId = transactionId ? Number(transactionId) : null;
    const filePath = `${customerId}/${linkedTransactionId ?? "unlinked"}/${Date.now()}-${safeName}`;
    const { error: uploadError } = await supabase.storage
      .from("payment-documents")
      .upload(filePath, file.uploadFile, { upsert: false });
    if (uploadError) {
      setSaving(false);
      setError(uploadError.message);
      return;
    }

    const { error: insertError } = await supabase.from("payment_documents").insert({
      transaction_id: linkedTransactionId,
      customer_id: customerId,
      document_type: documentType,
      file_path: filePath,
      original_file_name: file.originalFile.name,
      uploaded_by: userId,
    });
    setSaving(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    onSuccess();
  }

  async function handleFileChange(selectedFile: File | undefined) {
    setFile(null);
    setFileStatus(null);
    if (!selectedFile) return;
    setFileStatus("Preparing file...");
    try {
      const prepared = await prepareUploadFile(selectedFile, "payment-document");
      setFile(prepared);
      setFileStatus(prepared.wasCompressed ? "Image compressed and ready to upload." : "File ready to upload.");
    } catch (fileError) {
      setFileStatus((fileError as Error).message);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={uploadDocument}>
      {error ? <ErrorState message={error} /> : null}
      <Field label="Related transaction">
        <Select value={transactionId} onChange={(event) => setTransactionId(event.target.value)}>
          <option value="">Not linked yet</option>
          {transactions.map((transaction) => (
            <option key={transaction.id} value={transaction.id}>
              {transaction.transaction_type} - {money(transaction.amount)} - {formatDate(transaction.created_at)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Document type">
        <Select value={documentType} onChange={(event) => setDocumentType(event.target.value as PaymentDocumentType)}>
          {documentTypes.map((type) => (
            <option key={type}>{type}</option>
          ))}
        </Select>
      </Field>
      <Field label="Document file">
        <div className="grid gap-2 rounded-md border bg-ivory/40 p-3">
          <Input
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            onChange={(event) => void handleFileChange(event.target.files?.[0])}
            required
          />
          <p className="text-xs font-normal text-muted-foreground">
            Files are stored in the private payment-documents bucket.
          </p>
          <UploadFileSummary file={file} status={fileStatus} />
        </div>
      </Field>
      <Button disabled={saving}>{saving ? "Uploading..." : "Upload document"}</Button>
    </form>
  );
}

function BalanceStatementSection({
  customer,
  landPayments,
}: {
  customer: CustomerDetail;
  landPayments: CustomerTransaction[];
}) {
  const contract = activeContract(customer.contracts ?? []);
  const totalPaid = totalAmount(landPayments);
  const remainingBalance = contract ? Math.max(Number(contract.final_purchase_price) - totalPaid, 0) : 0;
  const lastPayment = [...landPayments].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle>Statement</CardTitle>
          <Button type="button" variant="secondary" onClick={() => window.print()}>Print Statement</Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatementMetric label="Customer" value={`${customer.first_name} ${customer.last_name}`} />
          <StatementMetric label="Lot" value={assignedLot(customer) ? `Lot ${assignedLot(customer)}` : "N/A"} />
          <StatementMetric label="Contract summary" value={contract ? `Contract #${contract.id} (${contract.is_active ? "Active" : "Closed"})` : "No contract"} />
          <StatementMetric label="Original purchase price" value={contract ? money(contract.final_purchase_price) : "N/A"} />
          <StatementMetric label="Total paid" value={money(totalPaid)} />
          <StatementMetric label="Remaining balance" value={contract ? money(remainingBalance) : "N/A"} />
          <StatementMetric label="Monthly installment" value={contract ? money(contract.monthly_payment) : "N/A"} />
          <StatementMetric label="Last payment date" value={lastPayment ? formatDate(lastPayment.created_at) : "No payments"} />
          <StatementMetric label="Next due date" value={contract ? formatDate(nextDueDate(contract)) : "N/A"} />
        </div>
        <Ledger title="Payment History" rows={landPayments} />
      </CardContent>
    </Card>
  );
}

function AiSummarySection({
  summary,
  canGenerate,
  aiEnabled,
  generating,
  generatedByLabel,
  onGenerate,
  onCopy,
}: {
  summary: CustomerAiSummary | null;
  canGenerate: boolean;
  aiEnabled: boolean;
  generating: boolean;
  generatedByLabel: string;
  onGenerate: () => void;
  onCopy: (message: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>AI Summary</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Assistant-generated guidance only. Review the account records before contacting the customer.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canGenerate ? (
              <Button type="button" disabled={generating} onClick={onGenerate}>
                <RefreshCw className={cn("h-4 w-4", generating && "animate-spin")} />
                {generating ? "Generating..." : summary ? "Regenerate Summary" : "Generate AI Summary"}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              disabled={!summary?.draft_follow_up_message}
              onClick={() => summary?.draft_follow_up_message ? onCopy(summary.draft_follow_up_message) : undefined}
            >
              <Clipboard className="h-4 w-4" />
              Copy Follow-Up Message
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        {!aiEnabled ? (
          <p className="rounded-md border border-copper/25 bg-copper/10 p-3 text-sm text-copper">
            AI Collections Assistant is not enabled. Enable it in Settings. Deterministic fallback generation is still available for permitted roles.
          </p>
        ) : null}
        {!canGenerate ? (
          <p className="rounded-md border border-primary/15 bg-primary/10 p-3 text-sm text-primary">
            Your role can view AI summaries but cannot generate new summaries.
          </p>
        ) : null}
        {!summary ? (
          <EmptyState message="No AI customer account summary has been generated yet." />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-ivory/40 p-4">
              <div>
                <p className="text-sm font-semibold text-primary">Account status</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Model: {summary.model} | Generated: {formatDate(summary.updated_at || summary.created_at)} | Generated by: {generatedByLabel}
                </p>
              </div>
              <Badge tone={accountStatusTone(summary.account_status)}>{summary.account_status}</Badge>
            </div>

            <SummaryBlock title="Account Summary" content={summary.summary} />
            <div className="grid gap-4 lg:grid-cols-2">
              <SummaryBlock title="Balance Summary" content={summary.balance_summary} />
              <SummaryBlock title="Payment Summary" content={summary.payment_summary} />
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <SummaryList title="Collections Flags" items={summary.collections_flags} emptyLabel="No collections flags listed." />
              <SummaryList title="Missing Items" items={summary.missing_items} emptyLabel="No missing items listed." />
              <SummaryList title="Recommended Actions" items={summary.recommended_actions} emptyLabel="No recommended actions listed." />
            </div>

            <div className="rounded-md border bg-white p-4">
              <p className="text-sm font-semibold text-primary">Draft Follow-Up Message</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">{summary.draft_follow_up_message || "No draft message generated."}</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryBlock({ title, content }: { title: string; content: string }) {
  return (
    <div className="rounded-md border bg-white p-4">
      <p className="text-sm font-semibold text-primary">{title}</p>
      <p className="mt-2 text-sm leading-6 text-foreground">{content || "No summary provided."}</p>
    </div>
  );
}

function SummaryList({ title, items, emptyLabel }: { title: string; items: unknown[]; emptyLabel: string }) {
  return (
    <div className="rounded-md border bg-white p-4">
      <p className="text-sm font-semibold text-primary">{title}</p>
      {items.length ? (
        <div className="mt-3 grid gap-2">
          {items.map((item, index) => (
            <div key={index} className="rounded-md border border-primary/10 bg-ivory/35 p-3 text-sm">
              <p className="font-medium text-primary">{summaryItemTitle(item)}</p>
              {summaryItemDetail(item) ? <p className="mt-1 text-muted-foreground">{summaryItemDetail(item)}</p> : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">{emptyLabel}</p>
      )}
    </div>
  );
}

function StatementMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-ivory/40 p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-copper">{label}</p>
      <p className="mt-1 font-medium text-primary">{value}</p>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-dashed bg-ivory/35 p-6 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function ActionModal({
  title,
  description,
  open,
  onClose,
  children,
}: {
  title: string;
  description: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-primary/70 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-lg bg-white shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-primary">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
          <Button type="button" variant="ghost" className="h-9 px-3" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="max-h-[calc(90vh-96px)] overflow-y-auto p-5">
          {children}
        </div>
      </div>
    </div>
  );
}

function assignedLot(customer: CustomerDetail) {
  const contract = activeContract(customer.contracts ?? []);
  return contract?.parcels?.lot_number ?? customer.applications?.parcels?.lot_number ?? null;
}

function latestSummary(summaries: CustomerAiSummary[]) {
  return [...summaries].sort((a, b) => new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime())[0] ?? null;
}

function accountStatusTone(status: CustomerAiSummary["account_status"]) {
  if (status === "Good Standing") return "green";
  if (status === "Due Soon") return "amber";
  if (status === "Overdue") return "red";
  if (status === "Missing Documents") return "amber";
  if (status === "No Active Contract") return "gray";
  return "blue";
}

function summaryItemRecord(item: unknown) {
  return item && typeof item === "object" ? item as Record<string, unknown> : null;
}

function summaryItemTitle(item: unknown) {
  const record = summaryItemRecord(item);
  return String(record?.title ?? record?.label ?? (typeof item === "string" ? item : "Item"));
}

function summaryItemDetail(item: unknown) {
  const record = summaryItemRecord(item);
  return String(record?.detail ?? record?.description ?? "");
}

function totalAmount(rows: Array<{ amount: number }>) {
  return rows.reduce((sum, payment) => sum + Number(payment.amount), 0);
}

function activeContract(contracts: CustomerContract[]) {
  return contracts.find((contract) => contract.is_active) ?? contracts[0] ?? null;
}

function nextDueDate(contract: Contract) {
  return accountDueDate(contract).toISOString();
}

function adminProfileLabel(profile: { full_name: string | null; email: string | null } | null | undefined) {
  const label = profile?.full_name || profile?.email || "";
  return label && !isUuid(label) ? label : "System";
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
