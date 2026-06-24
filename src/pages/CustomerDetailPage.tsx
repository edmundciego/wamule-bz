import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Clipboard, RefreshCw } from "lucide-react";
import { ContractForm } from "../components/forms/ContractForm";
import { PaymentForm } from "../components/forms/PaymentForm";
import { PageHeader } from "../components/layout/PageHeader";
import { PaymentDocumentLinks } from "../components/payments/PaymentDocumentLinks";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/Card";
import { Field, Input, Select, Textarea } from "../components/ui/Field";
import { SmartInsightList, SmartInsightsPanel } from "../components/ui/SmartInsightsPanel";
import { ErrorState, LoadingState } from "../components/ui/State";
import { UploadFileSummary } from "../components/uploads/UploadFileSummary";
import { accountDueDate } from "../lib/accountDates";
import { getSessionAndProfile } from "../lib/data";
import { customerOperationsInsights, postSalesRecommendedInsights, reservationReadinessInsights } from "../lib/smartInsights";
import { supabase } from "../lib/supabase";
import { prepareUploadFile, type PreparedUploadFile } from "../lib/uploads";
import { cn, formatDate, money } from "../lib/utils";
import type {
  Contract,
  CustomerAiSummary,
  Lead,
  LotReservation,
  PaymentDocument,
  PaymentDocumentType,
  PaymentRequest,
  PaymentRequestStatus,
  PostSalesActivity,
  PostSalesActivityType,
  PostSalesAiReadinessStatus,
  PostSalesAiSummary,
  PostSalesAgreementStatus,
  PostSalesChecklist,
  PostSalesChecklistStatus,
  PostSalesDocumentStatus,
  PostSalesHandoffStatus,
  PostSalesPaymentSetupStatus,
  PostSalesTask,
  PostSalesTaskPriority,
  PostSalesTaskStatus,
  PostSalesTaskType,
  SiteVisit,
  Transaction,
} from "../types/database";

const customerSections = ["Overview", "Post-Sales", "Contract", "Payments", "Documents", "Requests", "Statement", "Smart Summary"] as const;
const requestStatuses: PaymentRequestStatus[] = ["Draft", "Sent", "Paid", "Cancelled"];
const documentTypes: PaymentDocumentType[] = ["Bank Transfer Proof", "Manual Receipt Photo", "Signed Payment Note", "Other"];
const postSalesTaskTypes: PostSalesTaskType[] = ["document", "agreement", "payment_setup", "customer_contact", "collections_handoff", "internal_review", "general"];
const postSalesTaskPriorities: PostSalesTaskPriority[] = ["low", "normal", "high", "urgent"];
const checklistStatuses: PostSalesChecklistStatus[] = ["not_started", "in_progress", "blocked", "completed", "cancelled"];
const agreementStatuses: PostSalesAgreementStatus[] = ["not_started", "drafting", "ready_for_review", "sent_for_signature", "signed", "blocked"];
const documentStatuses: PostSalesDocumentStatus[] = ["not_started", "missing_documents", "pending_review", "complete", "blocked"];
const handoffStatuses: PostSalesHandoffStatus[] = ["not_started", "ready", "handed_off", "blocked"];
const paymentSetupStatuses: PostSalesPaymentSetupStatus[] = ["not_started", "pending", "ready", "active", "blocked"];

type CustomerSection = (typeof customerSections)[number];
type ActionModalKind = "payment" | "contract" | "request" | "document" | null;
type CustomerContract = Contract & { parcels?: { lot_number: string | null; status?: string | null } | null };
type CustomerTransaction = Transaction & { payment_documents?: PaymentDocument[] | null };
type PaymentDocumentWithTransaction = PaymentDocument & {
  transactions?: Pick<Transaction, "id" | "receipt_number" | "amount" | "transaction_type" | "created_at"> | null;
};
type CustomerDetail = {
  id: number;
  application_id: number;
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  address: string | null;
  created_at: string;
  applications?: { parcels?: { lot_number: string | null; status?: string | null } | null } | null;
  contracts?: CustomerContract[] | null;
  transactions?: CustomerTransaction[] | null;
  payment_documents?: PaymentDocumentWithTransaction[] | null;
  payment_requests?: PaymentRequest[] | null;
  customer_ai_summaries?: CustomerAiSummary[] | null;
};

type PostSalesChecklistFormValues = {
  status: PostSalesChecklistStatus;
  agreement_status: PostSalesAgreementStatus;
  document_status: PostSalesDocumentStatus;
  collections_handoff_status: PostSalesHandoffStatus;
  payment_setup_status: PostSalesPaymentSetupStatus;
  assigned_to: string;
  notes: string;
};

type PostSalesTaskFormValues = {
  title: string;
  description: string;
  task_type: PostSalesTaskType;
  priority: PostSalesTaskPriority;
  due_at: string;
  assigned_to: string;
};

export function CustomerDetailPage() {
  const { id } = useParams();
  const customerId = Number(id);
  const queryClient = useQueryClient();
  const [activeSection, setActiveSection] = useState<CustomerSection>("Overview");
  const [activeAction, setActiveAction] = useState<ActionModalKind>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [voidContractTarget, setVoidContractTarget] = useState<CustomerContract | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidingContractId, setVoidingContractId] = useState<number | null>(null);
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [generatingPostSalesSummaryId, setGeneratingPostSalesSummaryId] = useState<string | null>(null);
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
  const { data: relatedLeads } = useQuery({
    queryKey: ["customer-related-leads", customerId],
    queryFn: async () => {
      const { data: leads, error: queryError } = await supabase
        .from("leads")
        .select("*")
        .eq("customer_id", customerId)
        .order("updated_at", { ascending: false });
      if (queryError) throw queryError;
      return leads as Lead[];
    },
    enabled: Number.isFinite(customerId),
  });
  const { data: relatedReservations } = useQuery({
    queryKey: ["customer-related-reservations", customerId],
    queryFn: async () => {
      const { data: reservations, error: queryError } = await supabase
        .from("lot_reservations")
        .select("*, parcels(id, lot_number, status)")
        .eq("customer_id", customerId)
        .order("updated_at", { ascending: false });
      if (queryError) throw queryError;
      return reservations as Array<LotReservation & { parcels?: { id: number; lot_number: string | null; status: string | null } | null }>;
    },
    enabled: Number.isFinite(customerId),
  });
  const { data: relatedSiteVisits } = useQuery({
    queryKey: ["customer-related-site-visits", customerId],
    queryFn: async () => {
      const { data: visits, error: queryError } = await supabase
        .from("site_visits")
        .select("*")
        .eq("customer_id", customerId)
        .order("scheduled_at", { ascending: true });
      if (queryError) throw queryError;
      return visits as SiteVisit[];
    },
    enabled: Number.isFinite(customerId),
  });
  const { data: postSalesChecklists } = useQuery({
    queryKey: ["customer-post-sales-checklists", customerId],
    queryFn: async () => {
      const { data: checklists, error: queryError } = await supabase
        .from("post_sales_checklists")
        .select("*")
        .eq("customer_id", customerId)
        .order("updated_at", { ascending: false });
      if (queryError) throw queryError;
      return checklists as PostSalesChecklist[];
    },
    enabled: Number.isFinite(customerId),
  });
  const { data: postSalesTasks } = useQuery({
    queryKey: ["customer-post-sales-tasks", customerId],
    queryFn: async () => {
      const { data: tasks, error: queryError } = await supabase
        .from("post_sales_tasks")
        .select("*")
        .eq("customer_id", customerId)
        .order("due_at", { ascending: true, nullsFirst: false });
      if (queryError) throw queryError;
      return tasks as PostSalesTask[];
    },
    enabled: Number.isFinite(customerId),
  });
  const { data: postSalesActivities } = useQuery({
    queryKey: ["customer-post-sales-activities", customerId],
    queryFn: async () => {
      const { data: activities, error: queryError } = await supabase
        .from("post_sales_activities")
        .select("*")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      return activities as PostSalesActivity[];
    },
    enabled: Number.isFinite(customerId),
  });
  const { data: postSalesAiSummaries } = useQuery({
    queryKey: ["customer-post-sales-ai-summaries", customerId],
    queryFn: async () => {
      const { data: summaries, error: queryError } = await supabase
        .from("post_sales_ai_summaries")
        .select("*")
        .eq("customer_id", customerId)
        .order("generated_at", { ascending: false });
      if (queryError) throw queryError;
      return summaries as PostSalesAiSummary[];
    },
    enabled: Number.isFinite(customerId),
  });

  const landPayments =
    data?.transactions?.filter((item) => ["Down Payment", "Land Installment"].includes(item.transaction_type)) ?? [];
  const communityPayments =
    data?.transactions?.filter((item) => ["Garbage Fee", "Road Maintenance"].includes(item.transaction_type)) ?? [];
  const currentRole = sessionProfile?.profile?.role;
  const canWritePostSales = currentRole === "Super Admin" || currentRole === "Admin" || currentRole === "Staff";
  const canGenerateAiSummary = currentRole === "Super Admin" || currentRole === "Admin" || currentRole === "Staff";
  const canVoidContracts = currentRole === "Super Admin" || currentRole === "Admin";
  const collectionsAiEnabled = Boolean(aiSettings?.is_enabled && aiSettings.collections_assistant_enabled);
  const latestAiSummary = latestSummary(data?.customer_ai_summaries ?? []);
  const latestLead = relatedLeads?.[0] ?? null;
  const latestReservation = relatedReservations?.[0] ?? null;
  const activeCustomerContract = data ? activeContract(data.contracts ?? []) : null;
  const latestPostSalesChecklist = postSalesChecklists?.[0] ?? null;
  const latestPostSalesAiSummary = latestPostSalesChecklist
    ? latestPostSalesSummary(postSalesAiSummaries ?? [], latestPostSalesChecklist.id)
    : null;
  const generatedByProfile = latestAiSummary?.generated_by
    ? adminProfiles?.find((profile) => profile.user_id === latestAiSummary.generated_by) ?? null
    : null;

  function refreshCustomer() {
    void queryClient.invalidateQueries({ queryKey: ["customer-detail", customerId] });
  }

  async function refreshPostSales() {
    await queryClient.invalidateQueries({ queryKey: ["customer-post-sales-checklists", customerId] });
    await queryClient.invalidateQueries({ queryKey: ["customer-post-sales-tasks", customerId] });
    await queryClient.invalidateQueries({ queryKey: ["customer-post-sales-activities", customerId] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard-post-sales-checklists"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard-post-sales-tasks"] });
    await queryClient.invalidateQueries({ queryKey: ["application-post-sales-checklists"] });
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

  async function generatePostSalesSummary(checklistId: string) {
    setActionError(null);
    setToast(null);
    setGeneratingPostSalesSummaryId(checklistId);
    const { data: result, error: functionError } = await supabase.functions.invoke("generate-post-sales-summary", {
      body: { checklist_id: checklistId },
    });
    setGeneratingPostSalesSummaryId(null);
    if (functionError) {
      setActionError(functionError.message);
      return;
    }
    if (result?.error) {
      setActionError(String(result.error));
      return;
    }
    setToast(String(result?.message ?? "Post-Sales Smart Summary generated."));
    await queryClient.invalidateQueries({ queryKey: ["customer-post-sales-ai-summaries", customerId] });
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

  async function voidContract() {
    if (!voidContractTarget) return;
    const reason = voidReason.trim();
    if (!reason) {
      setActionError("Void reason is required.");
      return;
    }

    setActionError(null);
    setToast(null);
    setVoidingContractId(voidContractTarget.id);
    const { error } = await supabase.rpc("void_contract", {
      p_contract_id: voidContractTarget.id,
      p_void_reason: reason,
    });
    setVoidingContractId(null);

    if (error) {
      setActionError(error.message);
      return;
    }

    setVoidContractTarget(null);
    setVoidReason("");
    setToast("Contract voided and audit event recorded.");
    await queryClient.invalidateQueries();
  }

  async function addPostSalesActivity(activity: {
    checklist_id?: string | null;
    task_id?: string | null;
    activity_type: PostSalesActivityType;
    title: string;
    description?: string | null;
  }) {
    const { error } = await supabase.from("post_sales_activities").insert({
      checklist_id: activity.checklist_id ?? latestPostSalesChecklist?.id ?? null,
      task_id: activity.task_id ?? null,
      customer_id: customerId,
      application_id: data?.application_id ?? null,
      contract_id: activeCustomerContract?.id ?? null,
      activity_type: activity.activity_type,
      title: activity.title,
      description: activity.description?.trim() || null,
      metadata: null,
    });
    if (error) console.warn("Post-sales activity was not recorded", error);
  }

  async function startPostSalesChecklist() {
    if (!data) return;
    setActionError(null);
    setToast(null);
    const nowIso = new Date().toISOString();
    const { data: checklist, error } = await supabase
      .from("post_sales_checklists")
      .insert({
        customer_id: customerId,
        application_id: data.application_id,
        contract_id: activeCustomerContract?.id ?? null,
        lead_id: latestLead?.id ?? null,
        reservation_id: latestReservation?.id ?? null,
        status: "in_progress",
        started_at: nowIso,
        assigned_to: latestLead?.assigned_to ?? latestReservation?.assigned_to ?? null,
      })
      .select("id")
      .single();
    if (error) {
      setActionError(error.code === "23505" ? "A post-sales checklist is already active for this customer." : error.message);
      return;
    }
    await addPostSalesActivity({
      checklist_id: checklist.id,
      activity_type: "status_change",
      title: "Post-sales checklist started",
      description: "Customer is now being tracked for agreement, document, payment setup, and collections handoff readiness.",
    });
    setToast("Post-sales checklist started.");
    await refreshPostSales();
  }

  async function updatePostSalesChecklist(checklist: PostSalesChecklist, values: PostSalesChecklistFormValues) {
    setActionError(null);
    setToast(null);
    const completed = values.status === "completed";
    const { error } = await supabase.from("post_sales_checklists").update({
      status: values.status,
      agreement_status: values.agreement_status,
      document_status: values.document_status,
      collections_handoff_status: values.collections_handoff_status,
      payment_setup_status: values.payment_setup_status,
      assigned_to: values.assigned_to || null,
      notes: values.notes.trim() || null,
      completed_at: completed ? checklist.completed_at ?? new Date().toISOString() : null,
      started_at: checklist.started_at ?? new Date().toISOString(),
    }).eq("id", checklist.id);
    if (error) {
      setActionError(error.message);
      return;
    }
    const statusChanges = checklistStatusChanges(checklist, values);
    for (const change of statusChanges) {
      await addPostSalesActivity({
        checklist_id: checklist.id,
        activity_type: change.activityType,
        title: change.title,
        description: change.description,
      });
    }
    setToast("Post-sales checklist updated.");
    await refreshPostSales();
  }

  async function createPostSalesTask(values: PostSalesTaskFormValues) {
    if (!data) return;
    setActionError(null);
    setToast(null);
    const title = values.title.trim();
    if (!title) {
      setActionError("Task title is required.");
      return;
    }
    const dueAt = values.due_at ? new Date(values.due_at) : null;
    if (dueAt && Number.isNaN(dueAt.getTime())) {
      setActionError("Choose a valid due date for the post-sales task.");
      return;
    }
    const { data: task, error } = await supabase
      .from("post_sales_tasks")
      .insert({
        customer_id: customerId,
        application_id: data.application_id,
        contract_id: activeCustomerContract?.id ?? null,
        lead_id: latestLead?.id ?? null,
        reservation_id: latestReservation?.id ?? null,
        title,
        description: values.description.trim() || null,
        task_type: values.task_type,
        priority: values.priority,
        due_at: dueAt ? dueAt.toISOString() : null,
        assigned_to: values.assigned_to || latestPostSalesChecklist?.assigned_to || null,
        status: "open",
      })
      .select("id")
      .single();
    if (error) {
      setActionError(error.message);
      return;
    }
    await addPostSalesActivity({
      task_id: task.id,
      activity_type: "task_created",
      title: "Post-sales task created",
      description: title,
    });
    setToast("Post-sales task created.");
    await refreshPostSales();
  }

  async function updatePostSalesTaskStatus(task: PostSalesTask, status: PostSalesTaskStatus) {
    setActionError(null);
    setToast(null);
    const { data: sessionData } = await supabase.auth.getSession();
    const completed = status === "completed";
    const { error } = await supabase.from("post_sales_tasks").update({
      status,
      completed_at: completed ? new Date().toISOString() : null,
      completed_by: completed ? sessionData.session?.user.id ?? null : null,
    }).eq("id", task.id);
    if (error) {
      setActionError(error.message);
      return;
    }
    await addPostSalesActivity({
      task_id: task.id,
      activity_type: completed ? "task_completed" : status === "blocked" ? "blocked" : "status_change",
      title: `Post-sales task marked ${statusLabel(status)}`,
      description: task.title,
    });
    setToast("Post-sales task updated.");
    await refreshPostSales();
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
            <div className="crm-success-panel flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
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
              <div className="crm-tabs">
                <div className="crm-tab-list">
                  {customerSections.map((section) => (
                    <button
                      key={section}
                      type="button"
                      className={cn(
                        "crm-tab",
                        activeSection === section ? "crm-tab-active" : "",
                      )}
                      onClick={() => setActiveSection(section)}
                    >
                      {section}
                    </button>
                  ))}
                </div>
              </div>

              {activeSection === "Overview" ? (
                <OverviewSection
                  customer={data}
                  leads={relatedLeads ?? []}
                  reservations={relatedReservations ?? []}
                  siteVisits={relatedSiteVisits ?? []}
                  postSalesChecklist={latestPostSalesChecklist}
                  postSalesTasks={postSalesTasks ?? []}
                />
              ) : null}
              {activeSection === "Post-Sales" ? (
                <PostSalesSection
                  checklist={latestPostSalesChecklist}
                  tasks={postSalesTasks ?? []}
                  activities={postSalesActivities ?? []}
                  summary={latestPostSalesAiSummary}
                  adminProfiles={adminProfiles ?? []}
                  canWrite={canWritePostSales}
                  canGenerateSummary={canWritePostSales}
                  aiEnabled={Boolean(aiSettings?.is_enabled)}
                  generatingSummary={Boolean(latestPostSalesChecklist && generatingPostSalesSummaryId === latestPostSalesChecklist.id)}
                  onStart={() => void startPostSalesChecklist()}
                  onChecklistUpdate={(values) => latestPostSalesChecklist ? void updatePostSalesChecklist(latestPostSalesChecklist, values) : undefined}
                  onTaskCreate={(values) => void createPostSalesTask(values)}
                  onTaskUpdate={(task, status) => void updatePostSalesTaskStatus(task, status)}
                  onGenerateSummary={(checklistId) => void generatePostSalesSummary(checklistId)}
                />
              ) : null}
              {activeSection === "Contract" ? (
                <ContractSection
                  contracts={data.contracts ?? []}
                  canVoid={canVoidContracts}
                  onVoidRequest={(contract) => {
                    setActionError(null);
                    setVoidReason("");
                    setVoidContractTarget(contract);
                  }}
                />
              ) : null}
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
              {activeSection === "Smart Summary" ? (
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

          <ActionModal
            title="Void Contract"
            description="Void a contract that was created by mistake while keeping it visible in customer history."
            open={Boolean(voidContractTarget)}
            onClose={() => {
              if (voidingContractId) return;
              setVoidContractTarget(null);
              setVoidReason("");
            }}
          >
            {voidContractTarget ? (
              <div className="grid gap-4">
                <div className="crm-warning-panel p-4 text-sm">
                  <p className="font-semibold text-warning">Review before voiding Contract #{voidContractTarget.id}</p>
                  <p className="mt-2 leading-6">
                    Voiding keeps the contract in history and marks it as inactive. It does not delete payments,
                    receipts, documents, or collection records. Review linked payments and lot status separately if
                    needed.
                  </p>
                  {voidContractTarget.parcels?.lot_number ? (
                    <p className="mt-2 leading-6">
                      This contract may have affected Lot {voidContractTarget.parcels.lot_number} status. Review the lot
                      manually if this was created by mistake.
                    </p>
                  ) : null}
                </div>
                <div className="grid gap-2 rounded-md border border-border bg-muted/30 p-4 text-sm">
                  <p className="font-medium text-primary">Contract #{voidContractTarget.id}</p>
                  <p className="text-muted-foreground">
                    Lot {voidContractTarget.parcels?.lot_number ?? "N/A"} | Price {money(voidContractTarget.final_purchase_price)}
                  </p>
                </div>
                <Field label="Void reason" error={!voidReason.trim() && voidReason.length > 0 ? "Void reason is required." : undefined}>
                  <Textarea
                    value={voidReason}
                    onChange={(event) => setVoidReason(event.target.value)}
                    placeholder="Explain why this contract is being voided."
                    disabled={Boolean(voidingContractId)}
                  />
                </Field>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setVoidContractTarget(null);
                      setVoidReason("");
                    }}
                    disabled={Boolean(voidingContractId)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => void voidContract()}
                    disabled={Boolean(voidingContractId) || !voidReason.trim()}
                  >
                    {voidingContractId ? "Voiding..." : "Void Contract"}
                  </Button>
                </div>
              </div>
            ) : null}
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
    <section className="rounded-lg border border-border bg-card p-5 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-secondary">Customer Account</p>
          <h1 className="mt-2 text-2xl font-semibold text-foreground sm:text-3xl">
            {customer.first_name} {customer.last_name}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Account standing, contract activity, payment records, and collection follow-up for this customer.
          </p>
        </div>
        <div className="flex max-w-full flex-wrap gap-2">
          {contract ? <Badge tone={contractStatusTone(contract)}>{contractStatusLabel(contract)} contract</Badge> : <Badge tone="gray">No active contract</Badge>}
          {lotNumber ? <Badge tone="blue">Lot assigned</Badge> : <Badge tone="amber">No lot assigned</Badge>}
          {remainingBalance > 0 ? <Badge tone="amber">Open balance</Badge> : contract ? <Badge tone="green">Paid in full</Badge> : null}
          {missingReceiptCount > 0 ? <Badge tone="red">{missingReceiptCount} missing receipt #</Badge> : null}
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <SummaryCard label="Assigned lot" value={lotNumber ? `Lot ${lotNumber}` : "Not assigned"} />
        <SummaryCard label="Contract status" value={contract ? contractStatusLabel(contract) : "No active contract"} />
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
    <div className="crm-subpanel">
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
          <Button type="button" variant="outline" onClick={onCreateRequest}>Create Payment Request</Button>
          <Button type="button" variant="outline" onClick={onUploadDocument}>Upload Payment Document</Button>
          <Button type="button" variant="ghost" onClick={onStatement}>Print / View Statement</Button>
        </CardContent>
      </Card>
    </aside>
  );
}

function OverviewSection({
  customer,
  leads,
  reservations,
  siteVisits,
  postSalesChecklist,
  postSalesTasks,
}: {
  customer: CustomerDetail;
  leads: Lead[];
  reservations: Array<LotReservation & { parcels?: { id: number; lot_number: string | null; status: string | null } | null }>;
  siteVisits: SiteVisit[];
  postSalesChecklist: PostSalesChecklist | null;
  postSalesTasks: PostSalesTask[];
}) {
  const openRequests = customer.payment_requests?.filter((request) => !["Paid", "Cancelled"].includes(request.status)).length ?? 0;
  const latestLead = leads[0] ?? null;
  const latestReservation = reservations[0] ?? null;
  const contract = activeContract(customer.contracts ?? []);
  const landPayments = customer.transactions?.filter((item) => ["Down Payment", "Land Installment"].includes(item.transaction_type)) ?? [];
  const remainingBalance = contract ? Math.max(Number(contract.final_purchase_price) - totalAmount(landPayments), 0) : 0;
  const operationsInsights = customerOperationsInsights({
    activeContract: contract?.is_active ? contract : null,
    transactions: customer.transactions ?? [],
    paymentRequests: customer.payment_requests ?? [],
    leads,
    reservations,
    siteVisits,
    postSalesChecklist,
    postSalesTasks,
    expectedPaymentOverdue: Boolean(contract && remainingBalance > 0 && new Date(nextDueDate(contract)) < startOfToday()),
    isNewCustomer: daysSince(customer.created_at) <= 30,
  });

  return (
    <div className="grid gap-4">
      <SmartInsightsPanel
        title="Operations Insights"
        description="Live account guidance from customer, contract, payment, reservation, and post-sales records."
        insights={operationsInsights}
      />
      <div className="crm-info-panel p-4 text-sm">
        Post-Sales tracks the operational steps after approval or contract start, including documents, agreement readiness, payment setup, and collections handoff.
      </div>
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
      {latestLead ? (
        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Sales Lead</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">Linked sales pipeline record for this customer.</p>
            </div>
            <Badge tone={leadTone(latestLead.pipeline_stage)}>{leadStageLabel(latestLead.pipeline_stage)}</Badge>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <InfoItem label="Next action" value={latestLead.next_action ?? "No next action recorded"} />
            <InfoItem label="Next action due" value={latestLead.next_action_due_at ? formatDate(latestLead.next_action_due_at) : "No due date"} />
            <InfoItem label="Buyer journey" value={latestLead.buyer_journey_stage ?? "Not recorded"} />
            <Link className="text-sm font-semibold text-primary hover:text-primary-hover" to="/leads">Open Leads workspace</Link>
          </CardContent>
        </Card>
      ) : null}
      {latestReservation ? (
        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Reservation / Deposit Readiness</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Deposit readiness is status tracking only. Payment records and balances are managed separately in Payments and Collections.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone={reservationTone(latestReservation.status)}>{statusLabel(latestReservation.status)}</Badge>
              <Badge tone={depositTone(latestReservation.deposit_status)}>{statusLabel(latestReservation.deposit_status)}</Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm md:grid-cols-2">
            <InfoItem label="Reserved lot" value={latestReservation.parcels?.lot_number ? `Lot ${latestReservation.parcels.lot_number}` : "Not selected"} />
            <InfoItem label="Expected deposit" value={latestReservation.expected_deposit_amount ? money(latestReservation.expected_deposit_amount) : "Not set"} />
            <InfoItem label="Deposit due" value={latestReservation.deposit_due_at ? formatDate(latestReservation.deposit_due_at) : "No due date"} />
            <InfoItem label="Expires" value={latestReservation.expires_at ? formatDate(latestReservation.expires_at) : "No expiry"} />
            {latestReservation.notes ? <div className="md:col-span-2"><InfoItem label="Notes" value={latestReservation.notes} /></div> : null}
            <div className="md:col-span-2">
              <SmartInsightList insights={reservationReadinessInsights(latestReservation)} compact />
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="crm-subpanel text-sm">
      <p className="font-medium text-primary">{label}</p>
      <p className="mt-1 text-muted-foreground">{value}</p>
    </div>
  );
}

function PostSalesSection({
  checklist,
  tasks,
  activities,
  summary,
  adminProfiles,
  canWrite,
  canGenerateSummary,
  aiEnabled,
  generatingSummary,
  onStart,
  onChecklistUpdate,
  onTaskCreate,
  onTaskUpdate,
  onGenerateSummary,
}: {
  checklist: PostSalesChecklist | null;
  tasks: PostSalesTask[];
  activities: PostSalesActivity[];
  summary: PostSalesAiSummary | null;
  adminProfiles: Array<{ user_id: string; full_name: string | null; email: string | null }>;
  canWrite: boolean;
  canGenerateSummary: boolean;
  aiEnabled: boolean;
  generatingSummary: boolean;
  onStart: () => void;
  onChecklistUpdate: (values: PostSalesChecklistFormValues) => void;
  onTaskCreate: (values: PostSalesTaskFormValues) => void;
  onTaskUpdate: (task: PostSalesTask, status: PostSalesTaskStatus) => void;
  onGenerateSummary: (checklistId: string) => void;
}) {
  if (!checklist) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Post-Sales Automation</CardTitle>
          <CardDescription className="mt-1 text-sm">
            Post-Sales tracks the operational steps after approval or contract start, including documents, agreement readiness, payment setup, collections handoff, and staff-owned tasks.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="crm-info-panel p-4 text-sm">
            No post-sales checklist has been started for this customer.
          </div>
          {canWrite ? <Button type="button" onClick={onStart}>Start Post-Sales Checklist</Button> : null}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      <PostSalesSmartSummaryPanel
        summary={summary}
        aiEnabled={aiEnabled}
        canGenerate={canGenerateSummary}
        generating={generatingSummary}
        onGenerate={() => onGenerateSummary(checklist.id)}
      />
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Post-Sales Automation</CardTitle>
            <CardDescription className="mt-1 text-sm">
              Post-Sales tracks operational readiness only. Contract, payment, document, and collections systems remain authoritative.
            </CardDescription>
          </div>
          <Badge tone={postSalesStatusTone(checklist.status)}>{statusLabel(checklist.status)}</Badge>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <StatusMetric label="Agreement" value={statusLabel(checklist.agreement_status)} tone={agreementTone(checklist.agreement_status)} />
            <StatusMetric label="Documents" value={statusLabel(checklist.document_status)} tone={documentTone(checklist.document_status)} />
            <StatusMetric label="Payment setup" value={statusLabel(checklist.payment_setup_status)} tone={paymentSetupTone(checklist.payment_setup_status)} />
            <StatusMetric label="Collections handoff" value={statusLabel(checklist.collections_handoff_status)} tone={handoffTone(checklist.collections_handoff_status)} />
            <StatusMetric label="Assigned" value={adminProfileLabelById(adminProfiles, checklist.assigned_to)} tone="gray" />
          </div>
          <RecommendedActions checklist={checklist} tasks={tasks} />
          {canWrite ? (
            <PostSalesChecklistForm
              checklist={checklist}
              adminProfiles={adminProfiles}
              onSubmit={onChecklistUpdate}
            />
          ) : null}
        </CardContent>
      </Card>

      {canWrite ? <PostSalesTaskForm adminProfiles={adminProfiles} checklist={checklist} onSubmit={onTaskCreate} /> : null}
      <PostSalesTasksCard tasks={tasks} canWrite={canWrite} onUpdate={onTaskUpdate} />
      <PostSalesTimeline activities={activities} />
    </div>
  );
}

function PostSalesSmartSummaryPanel({
  summary,
  aiEnabled,
  canGenerate,
  generating,
  onGenerate,
}: {
  summary: PostSalesAiSummary | null;
  aiEnabled: boolean;
  canGenerate: boolean;
  generating: boolean;
  onGenerate: () => void;
}) {
  const blockers = stringList(summary?.key_blockers);
  const missing = stringList(summary?.missing_information);
  const actions = stringList(summary?.recommended_actions);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Post-Sales Smart Summary</CardTitle>
          <CardDescription className="mt-1 text-xs">
            This summary is generated from Wamule CRM data to support staff review. Staff should verify details before making decisions.
          </CardDescription>
        </div>
        {summary?.readiness_status ? (
          <Badge tone={postSalesAiReadinessTone(summary.readiness_status)}>{statusLabel(summary.readiness_status)}</Badge>
        ) : (
          <Badge tone="gray">Not generated</Badge>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        {summary ? (
          <>
            <div className="crm-info-panel break-words p-3 text-sm leading-6">
              {safeString(summary.summary, "No summary text recorded.")}
            </div>
            <PostSalesSummaryList title="Blockers" items={blockers} empty="No blockers listed." tone="red" />
            <PostSalesSummaryList title="Missing Information" items={missing} empty="No missing information listed." tone="amber" />
            <PostSalesSummaryList title="Recommended Actions" items={actions} empty="No recommended actions listed." tone="blue" />
            {summary.next_best_action ? (
              <div className="crm-subpanel text-sm">
                <p className="font-semibold text-primary">Next Best Action</p>
                <p className="mt-1 break-words text-muted-foreground">{summary.next_best_action}</p>
              </div>
            ) : null}
            {summary.confidence_notes ? (
              <div className="crm-subpanel text-sm">
                <p className="font-semibold text-primary">Confidence Notes</p>
                <p className="mt-1 break-words text-muted-foreground">{summary.confidence_notes}</p>
              </div>
            ) : null}
            <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              <span className="break-words">Generated: {safeFormatDate(summary.generated_at)}</span>
              <span className="break-words">Provider: {safeString(summary.provider, "Not recorded")}</span>
              <span className="break-words">Model: {safeString(summary.model, "Not recorded")}</span>
            </div>
          </>
        ) : (
          <div className="crm-subpanel text-sm text-muted-foreground">
            No Post-Sales Smart Summary has been generated for this checklist yet. Rule-based recommended actions remain available below.
          </div>
        )}
        {!aiEnabled ? (
          <div className="crm-warning-panel p-3 text-sm">
            AI provider access is disabled. Staff can still generate a deterministic fallback summary from current CRM data.
          </div>
        ) : null}
        {canGenerate ? (
          <Button type="button" variant={summary ? "outline" : "primary"} disabled={generating} onClick={onGenerate}>
            <RefreshCw className={cn("h-4 w-4", generating && "animate-spin")} />
            {generating ? "Generating..." : summary ? "Regenerate Summary" : "Generate Summary"}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">You can view summaries but do not have permission to generate them.</p>
        )}
      </CardContent>
    </Card>
  );
}

function PostSalesSummaryList({ title, items, empty, tone }: { title: string; items: string[]; empty: string; tone: BadgeTone }) {
  return (
    <div className="grid gap-2 text-sm">
      <p className="font-semibold text-primary">{title}</p>
      {items.length ? items.map((item) => (
        <div key={item} className="flex items-start gap-2 rounded-md border border-border bg-card p-2 shadow-sm shadow-primary/5">
          <Badge tone={tone}>{title === "Recommended Actions" ? "Action" : "Note"}</Badge>
          <span className="min-w-0 break-words text-muted-foreground">{item}</span>
        </div>
      )) : <p className="text-muted-foreground">{empty}</p>}
    </div>
  );
}

function StatusMetric({ label, value, tone }: { label: string; value: string; tone: BadgeTone }) {
  return (
    <div className="crm-subpanel">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <div className="mt-2"><Badge tone={tone}>{value}</Badge></div>
    </div>
  );
}

function RecommendedActions({ checklist, tasks }: { checklist: PostSalesChecklist; tasks: PostSalesTask[] }) {
  return (
    <SmartInsightsPanel
      title="Recommended Actions"
      description="Rule-based post-sales guidance. No records are changed from this panel."
      insights={postSalesRecommendedInsights(checklist, tasks)}
      compact
    />
  );
}

function PostSalesChecklistForm({
  checklist,
  adminProfiles,
  onSubmit,
}: {
  checklist: PostSalesChecklist;
  adminProfiles: Array<{ user_id: string; full_name: string | null; email: string | null }>;
  onSubmit: (values: PostSalesChecklistFormValues) => void;
}) {
  const [values, setValues] = useState<PostSalesChecklistFormValues>(() => checklistToFormValues(checklist));

  function setField<K extends keyof PostSalesChecklistFormValues>(key: K, value: PostSalesChecklistFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  return (
    <form className="grid gap-4 rounded-md border border-primary/10 bg-primary-soft/40 p-4" onSubmit={(event) => { event.preventDefault(); onSubmit(values); }}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Checklist status">
          <Select value={values.status} onChange={(event) => setField("status", event.target.value as PostSalesChecklistStatus)}>
            {checklistStatuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
          </Select>
        </Field>
        <Field label="Agreement status">
          <Select value={values.agreement_status} onChange={(event) => setField("agreement_status", event.target.value as PostSalesAgreementStatus)}>
            {agreementStatuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
          </Select>
        </Field>
        <Field label="Document status">
          <Select value={values.document_status} onChange={(event) => setField("document_status", event.target.value as PostSalesDocumentStatus)}>
            {documentStatuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
          </Select>
        </Field>
        <Field label="Payment setup">
          <Select value={values.payment_setup_status} onChange={(event) => setField("payment_setup_status", event.target.value as PostSalesPaymentSetupStatus)}>
            {paymentSetupStatuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
          </Select>
        </Field>
        <Field label="Collections handoff">
          <Select value={values.collections_handoff_status} onChange={(event) => setField("collections_handoff_status", event.target.value as PostSalesHandoffStatus)}>
            {handoffStatuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
          </Select>
        </Field>
        <Field label="Assigned">
          <Select value={values.assigned_to} onChange={(event) => setField("assigned_to", event.target.value)}>
            <option value="">Unassigned</option>
            {adminProfiles.map((profile) => <option key={profile.user_id} value={profile.user_id}>{adminProfileLabel(profile)}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Checklist notes">
        <Textarea value={values.notes} onChange={(event) => setField("notes", event.target.value)} />
      </Field>
      <Button type="submit" variant="outline">Save Post-Sales Checklist</Button>
    </form>
  );
}

function PostSalesTaskForm({
  adminProfiles,
  checklist,
  onSubmit,
}: {
  adminProfiles: Array<{ user_id: string; full_name: string | null; email: string | null }>;
  checklist: PostSalesChecklist;
  onSubmit: (values: PostSalesTaskFormValues) => void;
}) {
  const [values, setValues] = useState<PostSalesTaskFormValues>({
    title: "",
    description: "",
    task_type: "general",
    priority: "normal",
    due_at: "",
    assigned_to: checklist.assigned_to ?? "",
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(values);
    setValues({ title: "", description: "", task_type: "general", priority: "normal", due_at: "", assigned_to: checklist.assigned_to ?? "" });
  }

  return (
    <Card>
      <CardHeader><CardTitle>New Post-Sales Task</CardTitle></CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={submit}>
          <Field label="Task title"><Input value={values.title} onChange={(event) => setValues({ ...values, title: event.target.value })} required /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Task type">
              <Select value={values.task_type} onChange={(event) => setValues({ ...values, task_type: event.target.value as PostSalesTaskType })}>
                {postSalesTaskTypes.map((type) => <option key={type} value={type}>{statusLabel(type)}</option>)}
              </Select>
            </Field>
            <Field label="Priority">
              <Select value={values.priority} onChange={(event) => setValues({ ...values, priority: event.target.value as PostSalesTaskPriority })}>
                {postSalesTaskPriorities.map((priority) => <option key={priority} value={priority}>{statusLabel(priority)}</option>)}
              </Select>
            </Field>
            <Field label="Due">
              <Input type="datetime-local" value={values.due_at} onChange={(event) => setValues({ ...values, due_at: event.target.value })} />
            </Field>
            <Field label="Assigned">
              <Select value={values.assigned_to} onChange={(event) => setValues({ ...values, assigned_to: event.target.value })}>
                <option value="">Unassigned</option>
                {adminProfiles.map((profile) => <option key={profile.user_id} value={profile.user_id}>{adminProfileLabel(profile)}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Description"><Textarea value={values.description} onChange={(event) => setValues({ ...values, description: event.target.value })} /></Field>
          <Button type="submit">Create Post-Sales Task</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PostSalesTasksCard({
  tasks,
  canWrite,
  onUpdate,
}: {
  tasks: PostSalesTask[];
  canWrite: boolean;
  onUpdate: (task: PostSalesTask, status: PostSalesTaskStatus) => void;
}) {
  return (
    <Card>
      <CardHeader><CardTitle>Post-Sales Tasks</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        {tasks.length === 0 ? <p className="text-sm text-muted-foreground">No post-sales tasks recorded.</p> : null}
        {tasks.map((task) => (
          <div key={task.id} className="grid gap-3 rounded-md border border-border bg-card p-4 text-sm shadow-sm shadow-primary/5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words font-medium text-primary">{task.title}</p>
                <p className="text-muted-foreground">{statusLabel(task.task_type)} | {task.due_at ? formatDate(task.due_at) : "No due date"}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge tone={taskStatusTone(task.status)}>{statusLabel(task.status)}</Badge>
                <Badge tone={priorityTone(task.priority)}>{statusLabel(task.priority)}</Badge>
              </div>
            </div>
            {task.description ? <p className="break-words text-muted-foreground">{task.description}</p> : null}
            {canWrite && !["completed", "cancelled"].includes(task.status) ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" className="h-9" onClick={() => onUpdate(task, "completed")}>Complete</Button>
                {task.status !== "blocked" ? <Button type="button" variant="outline" className="h-9" onClick={() => onUpdate(task, "blocked")}>Block</Button> : null}
                <Button type="button" variant="ghost" className="h-9" onClick={() => onUpdate(task, "cancelled")}>Cancel</Button>
              </div>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PostSalesTimeline({ activities }: { activities: PostSalesActivity[] }) {
  return (
    <Card>
      <CardHeader><CardTitle>Post-Sales Timeline</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        {activities.length === 0 ? <p className="text-sm text-muted-foreground">No post-sales activity has been recorded yet.</p> : null}
        {activities.map((activity) => (
          <div key={activity.id} className="rounded-md border-l-4 border-primary/30 bg-muted p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="break-words font-medium text-primary">{activity.title}</p>
              <Badge tone="gray">{statusLabel(activity.activity_type)}</Badge>
            </div>
            {activity.description ? <p className="mt-2 break-words text-muted-foreground">{activity.description}</p> : null}
            <p className="mt-2 text-xs text-muted-foreground">{formatDate(activity.created_at)}</p>
          </div>
        ))}
      </CardContent>
    </Card>
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
          <div key={row.id} className="grid gap-3 rounded-md border border-border bg-card p-4 text-sm shadow-sm shadow-primary/5">
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

function ContractSection({
  contracts,
  canVoid,
  onVoidRequest,
}: {
  contracts: CustomerContract[];
  canVoid: boolean;
  onVoidRequest: (contract: CustomerContract) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Contract History</CardTitle>
        <CardDescription>
          Voided contracts remain visible in history. Payments, receipts, documents, collections records, and lot status
          are reviewed separately.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {contracts.length === 0 ? <EmptyState message="No contracts recorded." /> : null}
        {contracts.map((contract) => (
          <div key={contract.id} className="grid gap-3 rounded-md border border-border bg-card p-4 text-sm shadow-sm shadow-primary/5">
            <div className="flex flex-wrap justify-between gap-3">
              <div>
                <strong className="text-primary">Contract #{contract.id}</strong>
                <p className="text-muted-foreground">
                  {contract.parcels?.lot_number ? `Lot ${contract.parcels.lot_number}` : "No lot label available"}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Badge tone={contractStatusTone(contract)}>{contractStatusLabel(contract)}</Badge>
                {canVoid && isVoidableContract(contract) ? (
                  <Button type="button" variant="danger" className="min-h-9 px-3 py-1.5 text-xs" onClick={() => onVoidRequest(contract)}>
                    Void Contract
                  </Button>
                ) : null}
              </div>
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
            {contract.status === "voided" ? (
              <div className="rounded-md border border-danger/20 bg-danger/10 p-3 text-sm text-danger">
                <p className="font-semibold">Voided {safeFormatDate(contract.voided_at)}</p>
                <p className="mt-1 break-words">{contract.void_reason ?? "No reason recorded."}</p>
              </div>
            ) : null}
            {contract.status === "cancelled" ? (
              <div className="rounded-md border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
                <p className="font-semibold text-foreground">Cancelled {safeFormatDate(contract.cancelled_at)}</p>
                {contract.cancel_reason ? <p className="mt-1 break-words">{contract.cancel_reason}</p> : null}
              </div>
            ) : null}
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
          <div key={document.id} className="grid gap-3 rounded-md border border-border bg-card p-4 text-sm shadow-sm shadow-primary/5 lg:grid-cols-[1fr_auto] lg:items-center">
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
        {status ? <p className="crm-warning-panel p-3 text-sm">{status}</p> : null}
        {requests.length === 0 ? <EmptyState message="No payment requests created." /> : null}
        {requests.map((request) => (
          <div key={request.id} className="grid gap-3 rounded-md border border-border bg-card p-4 text-sm shadow-sm shadow-primary/5">
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
                <Button key={option} type="button" variant="outline" className="h-8 px-3" onClick={() => void updateRequestStatus(request.id, option)}>
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
  const [contractId, setContractId] = useState(String(contracts.find((contract) => isVoidableContract(contract))?.id ?? ""));
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
        <div className="crm-subpanel grid gap-2">
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
          <Button type="button" variant="outline" onClick={() => window.print()}>Print Statement</Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatementMetric label="Customer" value={`${customer.first_name} ${customer.last_name}`} />
          <StatementMetric label="Lot" value={assignedLot(customer) ? `Lot ${assignedLot(customer)}` : "N/A"} />
          <StatementMetric label="Contract summary" value={contract ? `Contract #${contract.id} (${contractStatusLabel(contract)})` : "No active contract"} />
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
            <CardTitle>Smart Summary</CardTitle>
            <CardDescription className="mt-1 text-xs">
              Helpful account guidance for buyer details, missing items, risk flags, and recommended next actions.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {canGenerate ? (
              <Button type="button" disabled={generating} onClick={onGenerate}>
                <RefreshCw className={cn("h-4 w-4", generating && "animate-spin")} />
                {generating ? "Generating..." : summary ? "Regenerate Summary" : "Generate Summary"}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
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
          <p className="crm-warning-panel p-3 text-sm">
            Smart collections guidance is not enabled. Enable it in Settings. Deterministic fallback generation is still available for permitted roles.
          </p>
        ) : null}
        {!canGenerate ? (
          <p className="crm-info-panel p-3 text-sm">
            Your role can view smart summaries but cannot generate new summaries.
          </p>
        ) : null}
        {!summary ? (
          <EmptyState message="No smart customer account summary has been generated yet." />
        ) : (
          <>
            <div className="crm-subpanel flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="text-sm font-semibold text-primary">Account status</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Model: {summary.model} | Generated: {formatDate(summary.updated_at || summary.created_at)} | Generated by: {generatedByLabel}
                </p>
              </div>
              <Badge tone={accountStatusTone(summary.account_status)}>{summary.account_status}</Badge>
            </div>

            <SummaryBlock title="Buyer Insights" content={summary.summary} />
            <div className="grid gap-4 lg:grid-cols-2">
              <SummaryBlock title="Balance Summary" content={summary.balance_summary} />
              <SummaryBlock title="Payment Summary" content={summary.payment_summary} />
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <SummaryList title="Risk Flags" items={summary.collections_flags} emptyLabel="No risk flags listed." />
              <SummaryList title="Missing Information" items={summary.missing_items} emptyLabel="No missing information listed." />
              <SummaryList title="Recommended Actions" items={summary.recommended_actions} emptyLabel="No recommended actions listed." />
            </div>

            <div className="rounded-md border border-border bg-card p-4 shadow-sm shadow-primary/5">
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
    <div className="rounded-md border border-border bg-card p-4 shadow-sm shadow-primary/5">
      <p className="text-sm font-semibold text-primary">{title}</p>
      <p className="mt-2 text-sm leading-6 text-foreground">{content || "No summary provided."}</p>
    </div>
  );
}

function SummaryList({ title, items, emptyLabel }: { title: string; items: unknown[]; emptyLabel: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-4 shadow-sm shadow-primary/5">
      <p className="text-sm font-semibold text-primary">{title}</p>
      {items.length ? (
        <div className="mt-3 grid gap-2">
          {items.map((item, index) => (
            <div key={index} className="crm-subpanel text-sm">
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
    <div className="crm-subpanel">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-secondary">{label}</p>
      <p className="mt-1 font-medium text-primary">{value}</p>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-dashed bg-muted p-6 text-center text-sm text-muted-foreground">
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
      <div className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-lg border border-border bg-card shadow-xl">
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

function latestPostSalesSummary(summaries: PostSalesAiSummary[], checklistId: string) {
  return summaries
    .filter((summary) => summary.checklist_id === checklistId)
    .sort((a, b) => safeDateTime(b.generated_at) - safeDateTime(a.generated_at))[0] ?? null;
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

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function safeString(value: unknown, fallback: string) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function safeDateTime(value: unknown) {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function safeFormatDate(value: unknown) {
  const time = safeDateTime(value);
  return time ? formatDate(new Date(time).toISOString()) : "Not recorded";
}

function totalAmount(rows: Array<{ amount: number }>) {
  return rows.reduce((sum, payment) => sum + Number(payment.amount), 0);
}

function contractStatusLabel(contract: Pick<Contract, "status" | "is_active">) {
  if (contract.status === "voided") return "Voided";
  if (contract.status === "cancelled") return "Cancelled";
  if (contract.status === "archived") return "Archived";
  return contract.is_active ? "Active" : "Closed";
}

function contractStatusTone(contract: Pick<Contract, "status" | "is_active">): BadgeTone {
  if (contract.status === "voided") return "red";
  if (contract.status === "cancelled") return "gray";
  if (contract.status === "archived") return "gray";
  return contract.is_active ? "green" : "gray";
}

function isVoidableContract(contract: Pick<Contract, "status" | "is_active">) {
  return contract.is_active && contract.status === "active";
}

function activeContract(contracts: CustomerContract[]) {
  return contracts.find((contract) => isVoidableContract(contract)) ?? null;
}

function nextDueDate(contract: Contract) {
  return accountDueDate(contract).toISOString();
}

function adminProfileLabel(profile: { full_name: string | null; email: string | null } | null | undefined) {
  const label = profile?.full_name || profile?.email || "";
  return label && !isUuid(label) ? label : "System";
}

function leadStageLabel(stage: Lead["pipeline_stage"]) {
  const labels: Record<Lead["pipeline_stage"], string> = {
    new_lead: "New Lead",
    contacted: "Contacted",
    interested: "Interested",
    family_decision: "Family Decision",
    payment_plan_review: "Payment Plan Review",
    site_visit_scheduled: "Site Visit Scheduled",
    deposit_pending: "Deposit Pending",
    deposit_paid: "Deposit Paid",
    application_started: "Application Started",
    contract_started: "Contract Started",
    closed_won: "Closed/Won",
    lost_inactive: "Lost/Inactive",
  };
  return labels[stage] ?? stage;
}

function leadTone(stage: Lead["pipeline_stage"]): BadgeTone {
  if (stage === "closed_won" || stage === "deposit_paid" || stage === "interested") return "green";
  if (stage === "family_decision" || stage === "payment_plan_review" || stage === "deposit_pending") return "amber";
  if (stage === "lost_inactive") return "gray";
  return "blue";
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function checklistToFormValues(checklist: PostSalesChecklist): PostSalesChecklistFormValues {
  return {
    status: checklist.status,
    agreement_status: checklist.agreement_status,
    document_status: checklist.document_status,
    collections_handoff_status: checklist.collections_handoff_status,
    payment_setup_status: checklist.payment_setup_status,
    assigned_to: checklist.assigned_to ?? "",
    notes: checklist.notes ?? "",
  };
}

function checklistStatusChanges(checklist: PostSalesChecklist, values: PostSalesChecklistFormValues) {
  const changes: Array<{ activityType: PostSalesActivityType; title: string; description: string }> = [];
  if (checklist.status !== values.status) {
    changes.push({
      activityType: values.status === "blocked" ? "blocked" : checklist.status === "blocked" ? "unblocked" : "status_change",
      title: "Checklist status updated",
      description: `${statusLabel(checklist.status)} to ${statusLabel(values.status)}`,
    });
  }
  if (checklist.agreement_status !== values.agreement_status) {
    changes.push({
      activityType: "agreement_status_change",
      title: "Agreement readiness updated",
      description: `${statusLabel(checklist.agreement_status)} to ${statusLabel(values.agreement_status)}`,
    });
  }
  if (checklist.document_status !== values.document_status) {
    changes.push({
      activityType: "document_status_change",
      title: "Document readiness updated",
      description: `${statusLabel(checklist.document_status)} to ${statusLabel(values.document_status)}`,
    });
  }
  if (checklist.collections_handoff_status !== values.collections_handoff_status) {
    changes.push({
      activityType: "collections_handoff",
      title: "Collections handoff updated",
      description: `${statusLabel(checklist.collections_handoff_status)} to ${statusLabel(values.collections_handoff_status)}`,
    });
  }
  if (checklist.payment_setup_status !== values.payment_setup_status) {
    changes.push({
      activityType: "payment_setup_status_change",
      title: "Payment setup updated",
      description: `${statusLabel(checklist.payment_setup_status)} to ${statusLabel(values.payment_setup_status)}`,
    });
  }
  if (changes.length === 0 && checklist.notes !== (values.notes.trim() || null)) {
    changes.push({
      activityType: "note",
      title: "Post-sales notes updated",
      description: values.notes.trim() || "Notes cleared.",
    });
  }
  return changes;
}

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function daysSince(value: string) {
  return (Date.now() - new Date(value).getTime()) / 86_400_000;
}

function adminProfileLabelById(profiles: Array<{ user_id: string; full_name: string | null; email: string | null }>, id: string | null) {
  if (!id) return "Unassigned";
  return adminProfileLabel(profiles.find((profile) => profile.user_id === id) ?? { full_name: null, email: id });
}

function postSalesStatusTone(status: PostSalesChecklistStatus): BadgeTone {
  if (status === "completed") return "green";
  if (status === "blocked") return "red";
  if (status === "in_progress") return "blue";
  return "gray";
}

function agreementTone(status: PostSalesAgreementStatus): BadgeTone {
  if (status === "signed") return "green";
  if (status === "blocked") return "red";
  if (status === "ready_for_review") return "amber";
  if (status === "drafting" || status === "sent_for_signature") return "blue";
  return "gray";
}

function documentTone(status: PostSalesDocumentStatus): BadgeTone {
  if (status === "complete") return "green";
  if (status === "blocked") return "red";
  if (status === "missing_documents") return "amber";
  if (status === "pending_review") return "blue";
  return "gray";
}

function handoffTone(status: PostSalesHandoffStatus): BadgeTone {
  if (status === "handed_off") return "green";
  if (status === "blocked") return "red";
  if (status === "ready") return "amber";
  return "gray";
}

function paymentSetupTone(status: PostSalesPaymentSetupStatus): BadgeTone {
  if (status === "active") return "green";
  if (status === "blocked") return "red";
  if (status === "pending") return "amber";
  if (status === "ready") return "blue";
  return "gray";
}

function postSalesAiReadinessTone(status: PostSalesAiReadinessStatus): BadgeTone {
  if (["completed", "ready"].includes(status)) return "green";
  if (status === "blocked") return "red";
  if (["missing_documents", "agreement_review", "signature_pending", "payment_setup_pending", "collections_ready"].includes(status)) return "amber";
  if (status === "not_started" || status === "unknown") return "gray";
  return "blue";
}

function taskStatusTone(status: PostSalesTaskStatus): BadgeTone {
  if (status === "completed") return "green";
  if (status === "blocked") return "red";
  if (status === "in_progress") return "blue";
  if (status === "cancelled") return "gray";
  return "amber";
}

function priorityTone(priority: PostSalesTaskPriority): BadgeTone {
  if (priority === "urgent") return "red";
  if (priority === "high") return "amber";
  if (priority === "low") return "gray";
  return "blue";
}

function reservationTone(status: LotReservation["status"]): BadgeTone {
  if (["deposit_confirmed", "converted_to_application", "converted_to_contract"].includes(status)) return "green";
  if (["deposit_pending", "expired"].includes(status)) return "amber";
  if (["reserved", "deposit_submitted"].includes(status)) return "blue";
  if (status === "cancelled") return "red";
  return "gray";
}

function depositTone(status: LotReservation["deposit_status"]): BadgeTone {
  if (status === "confirmed") return "green";
  if (status === "pending") return "amber";
  if (status === "proof_submitted") return "blue";
  if (status === "overdue") return "red";
  if (status === "waived") return "brown";
  return "gray";
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
