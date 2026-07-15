import { formatDate } from "./utils";
import { buildOperationalAttention, operationalAttentionInsights, type OperationalAttentionItem } from "./operationalAttention";
import type {
  Application,
  Contract,
  FollowUpTask,
  Lead,
  LotReservation,
  PaymentDocument,
  PaymentRequest,
  PostSalesChecklist,
  PostSalesTask,
  SiteVisit,
  Transaction,
} from "../types/database";

export type SmartInsightTone = "info" | "warning" | "danger" | "success" | "action";

export type SmartInsight = {
  title: string;
  description: string;
  tone: SmartInsightTone;
  actionLabel?: string;
  metadata?: string;
  actionHref?: string;
  sourceItemId?: string;
};

export const activeReservationStatuses = new Set<LotReservation["status"]>([
  "draft",
  "reserved",
  "deposit_pending",
  "deposit_submitted",
  "deposit_confirmed",
]);

const openFollowUpStatuses = new Set<FollowUpTask["status"]>(["open", "in_progress"]);
const openPostSalesTaskStatuses = new Set<PostSalesTask["status"]>(["open", "in_progress", "blocked"]);

export function leadSmartInsights(
  lead: Pick<Lead, "assigned_to" | "next_action" | "next_action_due_at" | "pipeline_stage" | "phone" | "email" | "whatsapp">,
  tasks: Pick<FollowUpTask, "status">[] = [],
  visits: Pick<SiteVisit, "status" | "scheduled_at">[] = [],
  reservations: Pick<LotReservation, "status">[] = [],
): SmartInsight[] {
  const insights: SmartInsight[] = [];
  const now = new Date();
  const activeReservation = reservations.find((reservation) => activeReservationStatuses.has(reservation.status));
  const upcomingVisit = visits.find((visit) => isUpcomingSiteVisit(visit, now));

  if (lead.pipeline_stage === "closed_won") {
    return [{
      title: "Lead is closed/won.",
      description: "No active sales follow-up guidance is shown for this closed lead.",
      tone: "success",
    }];
  }

  if (lead.pipeline_stage === "lost_inactive") {
    return [{
      title: "Lead is lost/inactive.",
      description: "No active sales follow-up guidance is shown unless staff reactivates the lead.",
      tone: "info",
    }];
  }

  if (!lead.assigned_to) {
    insights.push({
      title: "Assign a team member.",
      description: "This buyer does not have a clear internal owner yet.",
      tone: "action",
    });
  }

  if (!lead.next_action?.trim()) {
    insights.push({
      title: "Add a next action.",
      description: "A short next step helps staff keep the buyer journey moving.",
      tone: "action",
    });
  }

  const attentionItems = buildOperationalAttention({
    leads: [lead as Lead],
    followUps: tasks as FollowUpTask[],
  }, now);
  const overdueFollowUp = attentionItems.find((item) => item.kind === "overdue_follow_up");
  if (overdueFollowUp) {
    insights.push({
      title: "Follow-up overdue.",
      description: overdueFollowUp.summary,
      tone: "danger",
      metadata: safeFormatDate(overdueFollowUp.dueAt ?? null),
      actionLabel: "Open follow-up",
      actionHref: overdueFollowUp.route,
    });
  }

  if (lead.pipeline_stage === "family_decision") {
    insights.push({
      title: "Buyer may need decision support.",
      description: "This stage often needs clear answers for family or stakeholder questions.",
      tone: "info",
    });
  }

  if (lead.pipeline_stage === "payment_plan_review") {
    insights.push({
      title: "Clarify payment plan details.",
      description: "Confirm the buyer understands deposit, installment, and timing expectations.",
      tone: "warning",
    });
  }

  if (lead.pipeline_stage === "site_visit_scheduled" && !upcomingVisit) {
    insights.push({
      title: "Confirm site visit details.",
      description: "The stage says a site visit is scheduled, but no upcoming visit is recorded.",
      tone: "warning",
    });
  }

  if (lead.pipeline_stage === "deposit_pending" && !activeReservation) {
    insights.push({
      title: "Review reservation/deposit readiness.",
      description: "The buyer is deposit pending without an active reservation hold.",
      tone: "warning",
    });
  }

  if (!lead.phone && !lead.email && !lead.whatsapp) {
    insights.push({
      title: "Add a phone, WhatsApp, or email contact.",
      description: "The lead has no recorded contact method.",
      tone: "action",
    });
  }

  if (!tasks.some((task) => openFollowUpStatuses.has(task.status))) {
    insights.push({
      title: "Add a follow-up task.",
      description: activeReservation
        ? "There is no open follow-up for this active reservation."
        : "There is no open follow-up task for this lead.",
      tone: "action",
    });
  }

  if (upcomingVisit) {
    insights.push({
      title: "Site visit scheduled.",
      description: `The next site visit is scheduled for ${safeFormatDate(upcomingVisit.scheduled_at) ?? "the recorded date"}.`,
      tone: "success",
    });
  }

  if (activeReservation) {
    insights.push({
      title: "Active reservation exists.",
      description: "Track expiry and deposit readiness before application or contract next steps.",
      tone: "info",
    });
  }

  return withFallback(insights, {
    title: "Buyer record is current.",
    description: "Keep notes, follow-ups, and site visits updated as the conversation progresses.",
    tone: "info",
  });
}

export function reservationReadinessInsights(
  reservation: Pick<LotReservation, "status" | "deposit_status" | "expires_at" | "deposit_due_at" | "expected_deposit_amount">,
  hasOpenFollowUp = true,
): SmartInsight[] {
  const insights: SmartInsight[] = [];
  const now = new Date();
  const active = activeReservationStatuses.has(reservation.status);

  if (active && reservation.expires_at) {
    const days = daysUntil(reservation.expires_at, now);
    if (days !== null && days < 0) {
      insights.push({
        title: "Reservation needs review.",
        description: "The active reservation is past its expiry date.",
        tone: "danger",
        metadata: safeFormatDate(reservation.expires_at),
      });
    } else if (days !== null && days <= 3) {
      insights.push({
        title: "Reservation expires soon.",
        description: "Review the buyer status before the hold expires.",
        tone: "warning",
        metadata: safeFormatDate(reservation.expires_at),
      });
    }
  }

  if (active && reservation.deposit_status === "pending" && isBeforeToday(reservation.deposit_due_at, now)) {
    insights.push({
      title: "Deposit is overdue.",
      description: "The expected deposit due date has passed. Payment records remain unchanged.",
      tone: "danger",
      metadata: safeFormatDate(reservation.deposit_due_at),
    });
  }

  if (active && reservation.deposit_status === "proof_submitted") {
    insights.push({
      title: "Review proof before confirming.",
      description: "Deposit proof is marked submitted and needs staff review.",
      tone: "action",
    });
  }

  if (active && reservation.deposit_status === "confirmed") {
    insights.push({
      title: "Ready for next step.",
      description: "Deposit readiness is confirmed for staff review of application, contract, or post-sales next steps.",
      tone: "success",
    });
  }

  if (active && !hasOpenFollowUp) {
    insights.push({
      title: "Consider adding a follow-up.",
      description: "This active reservation does not have an open follow-up task.",
      tone: "action",
    });
  }

  if (active && reservation.deposit_status !== "not_requested" && !reservation.expected_deposit_amount) {
    insights.push({
      title: "Add expected deposit amount if required.",
      description: "Deposit tracking is active but no expected amount is recorded.",
      tone: "warning",
    });
  }

  return withFallback(insights, {
    title: "Reservation tracking is current.",
    description: "No immediate reservation or deposit readiness flags were found.",
    tone: "info",
  });
}

export function postSalesRecommendedInsights(
  checklist: Pick<PostSalesChecklist, "status" | "agreement_status" | "document_status" | "collections_handoff_status" | "payment_setup_status">,
  tasks: Pick<PostSalesTask, "status" | "due_at">[] = [],
): SmartInsight[] {
  const insights: SmartInsight[] = [];

  if (checklist.document_status === "missing_documents") {
    insights.push({ title: "Request missing documents.", description: "Document readiness is marked missing documents.", tone: "action" });
  }
  if (checklist.document_status === "pending_review") {
    insights.push({ title: "Review submitted documents.", description: "Documents are waiting for staff review.", tone: "action" });
  }
  if (checklist.agreement_status === "ready_for_review") {
    insights.push({ title: "Review agreement before sending.", description: "Agreement readiness is marked ready for review.", tone: "action" });
  }
  if (checklist.agreement_status === "sent_for_signature") {
    insights.push({ title: "Follow up on signed agreement.", description: "Agreement has been sent and may need follow-up.", tone: "warning" });
  }
  if (checklist.collections_handoff_status === "ready") {
    insights.push({ title: "Hand off to collections.", description: "Collections handoff is marked ready.", tone: "action" });
  }
  if (checklist.payment_setup_status === "pending") {
    insights.push({ title: "Confirm payment setup details.", description: "Payment setup is still pending.", tone: "warning" });
  }
  if (checklist.status === "blocked") {
    insights.push({ title: "Review blocker before proceeding.", description: "The checklist is blocked and needs staff review.", tone: "danger" });
  }
  if (tasks.some((task) => openPostSalesTaskStatuses.has(task.status) && isBeforeToday(task.due_at))) {
    insights.push({ title: "Post-sales task overdue.", description: "At least one open post-sales task is past due.", tone: "danger" });
  }

  return withFallback(insights, {
    title: "Post-sales checklist is current.",
    description: "Keep agreement, documents, payment setup, and handoff statuses updated.",
    tone: "info",
  });
}

export function applicationSmartInsights({
  application,
  selectedLotStatus,
  linkedLead,
  postSalesChecklist,
}: {
  application: Pick<Application, "status" | "phone" | "email" | "applicant_full_name" | "first_name" | "last_name" | "parcel_id" | "intended_use" | "payment_option" | "legal_notice_acknowledged"> & {
    preferred_parcel_ids?: number[] | null;
  };
  selectedLotStatus?: string | null;
  linkedLead?: Pick<Lead, "id" | "next_action"> | null;
  postSalesChecklist?: Pick<PostSalesChecklist, "id"> | null;
}): SmartInsight[] {
  const insights: SmartInsight[] = [];
  const hasName = Boolean(application.applicant_full_name?.trim() || application.first_name?.trim() || application.last_name?.trim());

  if (application.status === "Declined") {
    return [{
      title: "Application is declined.",
      description: "No rule-based next-step guidance is shown for declined applications.",
      tone: "info",
    }];
  }

  if (selectedLotStatus && selectedLotStatus !== "Available" && application.status !== "Approved") {
    insights.push({
      title: "Selected lot may no longer be available.",
      description: `The current lot status is ${selectedLotStatus}. Review availability before approval.`,
      tone: "danger",
    });
  }

  if (!hasName || !application.phone || !application.email || !application.intended_use || !application.payment_option || !application.legal_notice_acknowledged) {
    insights.push({
      title: "Review missing application details.",
      description: "Required buyer or application fields appear incomplete.",
      tone: "warning",
    });
  }

  if (linkedLead && !linkedLead.next_action?.trim()) {
    insights.push({
      title: "Add a sales follow-up.",
      description: "A linked lead exists but does not have a next action.",
      tone: "action",
    });
  }

  if (application.status === "Approved" && !postSalesChecklist) {
    insights.push({
      title: "Start post-sales checklist when ready.",
      description: "This approved application does not have a linked post-sales checklist yet.",
      tone: "action",
    });
  }

  if (!linkedLead) {
    insights.push({
      title: "Create or link a lead if sales tracking is needed.",
      description: "This application is not linked to a sales lead.",
      tone: "info",
    });
  }

  return withFallback(insights, {
    title: "Application review is current.",
    description: "No immediate rule-based application flags were found.",
    tone: "info",
  });
}

export function customerOperationsInsights({
  activeContract,
  transactions,
  paymentRequests,
  leads,
  reservations,
  siteVisits,
  postSalesChecklist,
  postSalesTasks,
  expectedPaymentOverdue,
  isNewCustomer,
}: {
  activeContract?: Pick<Contract, "signed_contract_file_path"> | null;
  transactions: Array<Pick<Transaction, "collection_method" | "manual_receipt_number"> & { payment_documents?: Pick<PaymentDocument, "id">[] | null }>;
  paymentRequests: Pick<PaymentRequest, "status" | "due_date">[];
  leads: Pick<Lead, "id">[];
  reservations: Pick<LotReservation, "status" | "deposit_status">[];
  siteVisits: Pick<SiteVisit, "status" | "scheduled_at">[];
  postSalesChecklist?: Pick<PostSalesChecklist, "id"> | null;
  postSalesTasks: Pick<PostSalesTask, "status" | "due_at">[];
  expectedPaymentOverdue: boolean;
  isNewCustomer: boolean;
}): SmartInsight[] {
  const insights: SmartInsight[] = [];
  const safeTransactions = transactions ?? [];
  const safePaymentRequests = paymentRequests ?? [];
  const safeLeads = leads ?? [];
  const safeReservations = reservations ?? [];
  const safeSiteVisits = siteVisits ?? [];
  const safePostSalesTasks = postSalesTasks ?? [];
  const activeDepositConfirmedReservation = safeReservations.find((reservation) =>
    activeReservationStatuses.has(reservation.status) && reservation.deposit_status === "confirmed"
  );

  if (activeContract && !activeContract.signed_contract_file_path) {
    insights.push({ title: "Signed contract still needed.", description: "The active contract does not have a signed upload.", tone: "warning" });
  }

  if (safeTransactions.some((transaction) => transaction.collection_method === "Online Transfer" && !transaction.payment_documents?.length)) {
    insights.push({ title: "Payment proof needs review.", description: "An online transfer has no linked proof document.", tone: "warning" });
  }

  if (expectedPaymentOverdue || safePaymentRequests.some((request) => !["Paid", "Cancelled"].includes(request.status) && isBeforeToday(request.due_date))) {
    insights.push({ title: "Payment follow-up needed.", description: "An expected or requested payment appears overdue.", tone: "danger" });
  }

  if (!safeLeads.length && isNewCustomer) {
    insights.push({ title: "Sales source may be missing.", description: "This newer customer has no linked lead record.", tone: "info" });
  }

  if (safePostSalesTasks.some((task) => openPostSalesTaskStatuses.has(task.status))) {
    insights.push({ title: "Follow-up tasks pending.", description: "Open post-sales tasks are linked to this customer.", tone: "action" });
  }

  const upcomingVisit = safeSiteVisits.find((visit) => isUpcomingSiteVisit(visit, new Date()));
  if (upcomingVisit) {
    insights.push({
      title: "Site visit scheduled.",
      description: `An upcoming site visit is scheduled for ${safeFormatDate(upcomingVisit.scheduled_at) ?? "the recorded date"}.`,
      tone: "success",
    });
  }

  if (activeDepositConfirmedReservation && !postSalesChecklist) {
    insights.push({
      title: "Ready for next step.",
      description: "Deposit readiness is confirmed, but no linked post-sales checklist is active.",
      tone: "success",
    });
  }

  return withFallback(insights, {
    title: "Customer account is current.",
    description: "No immediate rule-based customer operations flags were found.",
    tone: "info",
  });
}

export function dashboardOperationsInsights(items: OperationalAttentionItem[]): SmartInsight[] {
  return operationalAttentionInsights(items);
}

export function collectionsOperationsInsights({
  overdueCustomers,
  missingSignedContracts,
  missingReceipts,
  missingProofs,
}: {
  overdueCustomers: number;
  missingSignedContracts: number;
  missingReceipts: number;
  missingProofs: number;
}): SmartInsight[] {
  const insights: SmartInsight[] = [];
  const overdueCount = safeCount(overdueCustomers);
  const signedCount = safeCount(missingSignedContracts);
  const receiptCount = safeCount(missingReceipts);
  const proofCount = safeCount(missingProofs);
  if (overdueCount > 0) insights.push(countInsight("Payment follow-up needed", overdueCount, "Customers have overdue expected payments.", "danger"));
  if (signedCount > 0) insights.push(countInsight("Signed contract still needed", signedCount, "Active contracts are missing signed uploads.", "warning"));
  if (receiptCount > 0) insights.push(countInsight("Receipt details missing", receiptCount, "Payments are missing manual receipt numbers.", "warning"));
  if (proofCount > 0) insights.push(countInsight("Payment proof needs review", proofCount, "Online transfers are missing uploaded proof.", "action"));

  return withFallback(insights, {
    title: "Collections queues are current.",
    description: "No overdue customers or missing collection documents were found in the current queues.",
    tone: "success",
  });
}

function countInsight(title: string, count: number, description: string, tone: SmartInsightTone): SmartInsight {
  return { title, description, tone, metadata: String(count) };
}

function withFallback(insights: SmartInsight[], fallback: SmartInsight) {
  return insights.length ? insights : [fallback];
}

function isUpcomingSiteVisit(visit: Pick<SiteVisit, "status" | "scheduled_at">, now: Date) {
  const scheduledAt = parseDate(visit.scheduled_at);
  return Boolean((visit.status === "scheduled" || visit.status === "rescheduled") && scheduledAt && scheduledAt >= now);
}

function isBeforeToday(value: string | null | undefined, now = new Date()) {
  const date = parseDate(value);
  if (!date) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return date < today;
}

function daysUntil(value: string, now = new Date()) {
  const date = parseDate(value);
  if (!date) return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return (target.getTime() - start.getTime()) / 86_400_000;
}

function parseDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeFormatDate(value: string | null | undefined) {
  return parseDate(value) ? formatDate(value) : undefined;
}

function safeCount(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
