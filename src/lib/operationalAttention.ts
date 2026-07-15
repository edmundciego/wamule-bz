import type { SmartInsight } from "./smartInsights";
import type {
  Application,
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

export const BELIZE_TIME_ZONE = "America/Belize";

export type OperationalAttentionKind =
  | "overdue_follow_up"
  | "follow_up_due_today"
  | "reservation_expiring"
  | "deposit_overdue"
  | "application_review"
  | "collection_alert"
  | "missing_receipt"
  | "missing_transfer_proof"
  | "post_sales_blocker"
  | "post_sales_task_overdue"
  | "site_visit_today"
  | "site_visit_upcoming";

export type OperationalAttentionSeverity = "critical" | "warning" | "info";

export type OperationalAttentionItem = {
  id: string;
  kind: OperationalAttentionKind;
  severity: OperationalAttentionSeverity;
  title: string;
  summary: string;
  entityType: string;
  entityId: string;
  relatedEntityId: string | null;
  route: string;
  dueAt: string | null;
  ownerName: string;
  currentStatus: string;
  sourceUpdatedAt: string;
  metadata: Record<string, string | number | null>;
};

export type OperationalAttentionGroup = {
  kind: OperationalAttentionKind;
  label: string;
  count: number;
  highestSeverity: OperationalAttentionSeverity;
  items: OperationalAttentionItem[];
  viewAllRoute: string;
};

type NameRelation = { first_name?: string | null; last_name?: string | null; full_name?: string | null } | null;
type LeadInput = Pick<Lead, "id" | "full_name" | "pipeline_stage" | "assigned_to" | "updated_at" | "created_at">;
type FollowUpInput = Pick<FollowUpTask, "id" | "lead_id" | "title" | "description" | "due_at" | "status" | "assigned_to" | "updated_at" | "created_at">;
type ReservationInput = Pick<LotReservation, "id" | "lead_id" | "application_id" | "customer_id" | "status" | "deposit_status" | "expires_at" | "deposit_due_at" | "assigned_to" | "updated_at" | "created_at"> & { parcels?: { lot_number?: string | null } | null };
type ApplicationInput = Pick<Application, "id" | "applicant_full_name" | "first_name" | "last_name" | "status" | "updated_at" | "created_at">;
type TransactionInput = Pick<Transaction, "id" | "customer_id" | "amount" | "transaction_type" | "collection_method" | "manual_receipt_number" | "bank_reference" | "status" | "updated_at" | "created_at"> & { customers?: NameRelation; payment_documents?: Array<Pick<PaymentDocument, "id">> | null };
type PaymentRequestInput = Pick<PaymentRequest, "id" | "customer_id" | "amount_due" | "due_date" | "status" | "updated_at" | "created_at"> & { customers?: NameRelation };
type PostSalesChecklistInput = Pick<PostSalesChecklist, "id" | "customer_id" | "status" | "document_status" | "collections_handoff_status" | "updated_at" | "created_at">;
type PostSalesTaskInput = Pick<PostSalesTask, "id" | "customer_id" | "lead_id" | "title" | "due_at" | "status" | "assigned_to" | "updated_at" | "created_at">;
type SiteVisitInput = Pick<SiteVisit, "id" | "lead_id" | "scheduled_at" | "status" | "visit_type" | "assigned_to" | "updated_at" | "created_at">;

export type OperationalAttentionInput = {
  leads?: LeadInput[];
  followUps?: FollowUpInput[];
  reservations?: ReservationInput[];
  applications?: ApplicationInput[];
  transactions?: TransactionInput[];
  paymentRequests?: PaymentRequestInput[];
  postSalesChecklists?: PostSalesChecklistInput[];
  postSalesTasks?: PostSalesTaskInput[];
  siteVisits?: SiteVisitInput[];
  ownerNames?: Map<string, string>;
};

const activeReservationStatuses = new Set(["draft", "reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed"]);
const openFollowUpStatuses = new Set(["open", "in_progress"]);
const openPostSalesStatuses = new Set(["open", "in_progress", "blocked"]);
const attentionLabels: Record<OperationalAttentionKind, string> = {
  overdue_follow_up: "Overdue follow-ups",
  follow_up_due_today: "Follow-ups due today",
  reservation_expiring: "Reservations expiring",
  deposit_overdue: "Deposits overdue",
  application_review: "Applications awaiting review",
  collection_alert: "Collections alerts",
  missing_receipt: "Missing receipt numbers",
  missing_transfer_proof: "Missing transfer proof",
  post_sales_blocker: "Post-sales blockers",
  post_sales_task_overdue: "Post-sales tasks overdue",
  site_visit_today: "Site visits today",
  site_visit_upcoming: "Upcoming site visits",
};

const attentionRoutes: Record<OperationalAttentionKind, string> = {
  overdue_follow_up: "/leads?focus=followups",
  follow_up_due_today: "/leads?focus=followups",
  reservation_expiring: "/leads?focus=reservations",
  deposit_overdue: "/leads?focus=reservations",
  application_review: "/applications?status=Pending%20Review",
  collection_alert: "/collections?focus=alerts",
  missing_receipt: "/payments?focus=missing-receipts",
  missing_transfer_proof: "/payments?focus=missing-proof",
  post_sales_blocker: "/customers?tab=post-sales",
  post_sales_task_overdue: "/customers?tab=post-sales",
  site_visit_today: "/leads?focus=site-visits",
  site_visit_upcoming: "/leads?focus=site-visits",
};

const severityRank: Record<OperationalAttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function buildOperationalAttention(input: OperationalAttentionInput, asOf = new Date()): OperationalAttentionItem[] {
  const items: OperationalAttentionItem[] = [];
  const leads = input.leads ?? [];
  const leadById = new Map(leads.map((lead) => [lead.id, lead]));
  const ownerName = (id: string | null | undefined) => id ? input.ownerNames?.get(id) ?? "Unassigned" : "Unassigned";
  const nameFor = (id: string | number | null | undefined, relation?: NameRelation) => {
    const related = relation ? relation.full_name || `${relation.first_name ?? ""} ${relation.last_name ?? ""}`.trim() : "";
    return related || (id == null ? "Unknown record" : leadById.get(String(id))?.full_name ?? `Record #${id}`);
  };
  const sourceDate = (row: { updated_at?: string | null; created_at?: string | null }) => row.updated_at || row.created_at || asOf.toISOString();

  for (const task of input.followUps ?? []) {
    if (!task.lead_id || !openFollowUpStatuses.has(task.status) || !task.due_at) continue;
    const lead = leadById.get(task.lead_id);
    if (!lead || ["closed_won", "lost_inactive"].includes(lead.pipeline_stage)) continue;
    const overdue = new Date(task.due_at).getTime() < asOf.getTime();
    const dueToday = !overdue && belizeDateKey(task.due_at) === belizeDateKey(asOf);
    if (!overdue && !dueToday) continue;
    const kind = overdue ? "overdue_follow_up" : "follow_up_due_today";
    const route = `/leads?lead=${encodeURIComponent(lead.id)}&focus=followups&followup=${encodeURIComponent(task.id)}`;
    items.push(item({
      id: `${kind}:${task.id}`,
      kind,
      severity: overdue ? "critical" : "warning",
      title: task.title || "Follow-up task",
      summary: `${lead.full_name} · due ${formatBelizeDate(task.due_at)}${task.description ? ` · ${task.description}` : ""}`,
      entityType: "follow_up_task",
      entityId: task.id,
      relatedEntityId: lead.id,
      route,
      dueAt: task.due_at,
      ownerName: ownerName(task.assigned_to ?? lead.assigned_to),
      currentStatus: task.status,
      sourceUpdatedAt: sourceDate(task),
      metadata: { leadName: lead.full_name, followUpId: task.id },
    }));
  }

  for (const reservation of input.reservations ?? []) {
    if (!activeReservationStatuses.has(reservation.status)) continue;
    const lead = reservation.lead_id ? leadById.get(reservation.lead_id) : null;
    const contextName = nameFor(reservation.customer_id ?? reservation.application_id ?? reservation.lead_id, undefined);
    if (reservation.expires_at && new Date(reservation.expires_at).getTime() >= asOf.getTime() && isWithinBelizeDays(reservation.expires_at, asOf, 3)) {
      const label = reservation.parcels?.lot_number ? `Lot ${reservation.parcels.lot_number}` : "reservation";
      items.push(item({
        id: `reservation_expiring:${reservation.id}`,
        kind: "reservation_expiring",
        severity: "warning",
        title: "Reservation expires soon",
        summary: `${lead?.full_name ?? contextName} · ${label} expires ${formatBelizeDate(reservation.expires_at)}`,
        entityType: "reservation",
        entityId: reservation.id,
        relatedEntityId: lead?.id ?? null,
        route: lead ? `/leads?lead=${encodeURIComponent(lead.id)}&focus=reservation&reservation=${encodeURIComponent(reservation.id)}` : attentionRoutes.reservation_expiring,
        dueAt: reservation.expires_at,
        ownerName: ownerName(reservation.assigned_to ?? lead?.assigned_to),
        currentStatus: reservation.status,
        sourceUpdatedAt: sourceDate(reservation),
        metadata: { reservationId: reservation.id, leadName: lead?.full_name ?? contextName },
      }));
    }
    const depositDue = reservation.deposit_due_at ? new Date(reservation.deposit_due_at) : null;
    const depositOverdue = reservation.deposit_status === "overdue" || (reservation.deposit_status === "pending" && depositDue !== null && depositDue.getTime() < asOf.getTime());
    if (depositOverdue) {
      items.push(item({
        id: `deposit_overdue:${reservation.id}`,
        kind: "deposit_overdue",
        severity: "critical",
        title: "Deposit readiness is overdue",
        summary: `${lead?.full_name ?? contextName} · expected deposit was due ${formatBelizeDate(reservation.deposit_due_at)}`,
        entityType: "reservation",
        entityId: reservation.id,
        relatedEntityId: lead?.id ?? null,
        route: lead ? `/leads?lead=${encodeURIComponent(lead.id)}&focus=reservation&reservation=${encodeURIComponent(reservation.id)}` : attentionRoutes.deposit_overdue,
        dueAt: reservation.deposit_due_at,
        ownerName: ownerName(reservation.assigned_to ?? lead?.assigned_to),
        currentStatus: reservation.deposit_status,
        sourceUpdatedAt: sourceDate(reservation),
        metadata: { reservationId: reservation.id, leadName: lead?.full_name ?? contextName },
      }));
    }
  }

  for (const application of input.applications ?? []) {
    if (application.status !== "Pending Review") continue;
    const name = application.applicant_full_name || `${application.first_name} ${application.last_name}`.trim() || `Application #${application.id}`;
    items.push(item({
      id: `application_review:${application.id}`,
      kind: "application_review",
      severity: "warning",
      title: "Application awaiting review",
      summary: `${name} · Application #${application.id}`,
      entityType: "application",
      entityId: String(application.id),
      relatedEntityId: null,
      route: `/applications?application=${encodeURIComponent(application.id)}`,
      dueAt: null,
      ownerName: "Unassigned",
      currentStatus: application.status,
      sourceUpdatedAt: sourceDate(application),
      metadata: { applicantName: name },
    }));
  }

  for (const payment of input.transactions ?? []) {
    if (payment.status !== "posted") continue;
    const customer = nameFor(payment.customer_id, payment.customers);
    if (!String(payment.manual_receipt_number ?? "").trim()) {
      items.push(item({
        id: `missing_receipt:${payment.id}`,
        kind: "missing_receipt",
        severity: "warning",
        title: "Enter manual receipt number",
        summary: `${customer} · payment #${payment.id} · ${formatBelizeDate(payment.created_at)}`,
        entityType: "payment",
        entityId: String(payment.id),
        relatedEntityId: String(payment.customer_id),
        route: `/payments?payment=${encodeURIComponent(payment.id)}&focus=missing-receipt`,
        dueAt: null,
        ownerName: "Finance",
        currentStatus: payment.status,
        sourceUpdatedAt: sourceDate(payment),
        metadata: { customerName: customer, amount: payment.amount },
      }));
    }
    const transfer = ["Online Transfer", "Bank Transfer"].includes(String(payment.collection_method));
    if (transfer && !(payment.payment_documents?.length ?? 0)) {
      items.push(item({
        id: `missing_transfer_proof:${payment.id}`,
        kind: "missing_transfer_proof",
        severity: "warning",
        title: "Upload or confirm transfer proof",
        summary: `${customer} · payment #${payment.id}`,
        entityType: "payment",
        entityId: String(payment.id),
        relatedEntityId: String(payment.customer_id),
        route: `/payments?payment=${encodeURIComponent(payment.id)}&focus=missing-proof`,
        dueAt: null,
        ownerName: "Finance",
        currentStatus: payment.status,
        sourceUpdatedAt: sourceDate(payment),
        metadata: { customerName: customer, amount: payment.amount },
      }));
    }
  }

  for (const request of input.paymentRequests ?? []) {
    if (!["Draft", "Sent"].includes(request.status) || !request.due_date || new Date(request.due_date).getTime() >= asOf.getTime()) continue;
    const customer = nameFor(request.customer_id, request.customers);
    items.push(item({
      id: `collection_alert:${request.id}`,
      kind: "collection_alert",
      severity: "critical",
      title: "Payment request is overdue",
      summary: `${customer} · request #${request.id} was due ${formatBelizeDate(request.due_date)}`,
      entityType: "payment_request",
      entityId: String(request.id),
      relatedEntityId: String(request.customer_id),
      route: `/customers/${encodeURIComponent(request.customer_id)}?tab=requests&request=${encodeURIComponent(request.id)}`,
      dueAt: request.due_date,
      ownerName: "Collections",
      currentStatus: request.status,
      sourceUpdatedAt: sourceDate(request),
      metadata: { customerName: customer, amountDue: request.amount_due },
    }));
  }

  for (const checklist of input.postSalesChecklists ?? []) {
    const blocked = checklist.status === "blocked" || checklist.document_status === "blocked" || checklist.collections_handoff_status === "blocked";
    if (!blocked) continue;
    items.push(item({
      id: `post_sales_blocker:${checklist.id}`,
      kind: "post_sales_blocker",
      severity: "critical",
      title: "Post-sales checklist is blocked",
      summary: `Customer #${checklist.customer_id ?? "unassigned"} · review post-sales blockers`,
      entityType: "post_sales_checklist",
      entityId: checklist.id,
      relatedEntityId: checklist.customer_id == null ? null : String(checklist.customer_id),
      route: `/customers/${encodeURIComponent(checklist.customer_id ?? "")}?tab=post-sales&checklist=${encodeURIComponent(checklist.id)}`,
      dueAt: null,
      ownerName: "Unassigned",
      currentStatus: checklist.status,
      sourceUpdatedAt: sourceDate(checklist),
      metadata: { checklistId: checklist.id },
    }));
  }

  for (const task of input.postSalesTasks ?? []) {
    if (!openPostSalesStatuses.has(task.status) || !task.due_at || new Date(task.due_at).getTime() >= asOf.getTime()) continue;
    items.push(item({
      id: `post_sales_task_overdue:${task.id}`,
      kind: "post_sales_task_overdue",
      severity: "critical",
      title: task.title || "Post-sales task overdue",
      summary: `Customer #${task.customer_id ?? "unassigned"} · due ${formatBelizeDate(task.due_at)}`,
      entityType: "post_sales_task",
      entityId: task.id,
      relatedEntityId: task.customer_id == null ? null : String(task.customer_id),
      route: `/customers/${encodeURIComponent(task.customer_id ?? "")}?tab=post-sales&task=${encodeURIComponent(task.id)}`,
      dueAt: task.due_at,
      ownerName: ownerName(task.assigned_to),
      currentStatus: task.status,
      sourceUpdatedAt: sourceDate(task),
      metadata: { taskId: task.id },
    }));
  }

  for (const visit of input.siteVisits ?? []) {
    if (!["scheduled", "rescheduled"].includes(visit.status) || !visit.scheduled_at) continue;
    const timestamp = new Date(visit.scheduled_at).getTime();
    const days = belizeDayDifference(asOf, visit.scheduled_at);
    if (timestamp < asOf.getTime() || days < 0 || days > 7) continue;
    const lead = visit.lead_id ? leadById.get(visit.lead_id) : null;
    const kind = days === 0 ? "site_visit_today" : "site_visit_upcoming";
    items.push(item({
      id: `${kind}:${visit.id}`,
      kind,
      severity: days === 0 ? "warning" : "info",
      title: visit.visit_type || "Site visit",
      summary: `${lead?.full_name ?? "Buyer record"} · ${formatBelizeDate(visit.scheduled_at)}`,
      entityType: "site_visit",
      entityId: visit.id,
      relatedEntityId: lead?.id ?? visit.lead_id ?? null,
      route: lead ? `/leads?lead=${encodeURIComponent(lead.id)}&focus=site-visits&visit=${encodeURIComponent(visit.id)}` : attentionRoutes[kind],
      dueAt: visit.scheduled_at,
      ownerName: ownerName(visit.assigned_to ?? lead?.assigned_to),
      currentStatus: visit.status,
      sourceUpdatedAt: sourceDate(visit),
      metadata: { leadName: lead?.full_name ?? "Buyer record", visitId: visit.id },
    }));
  }

  return items.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || compareDue(a.dueAt, b.dueAt) || a.id.localeCompare(b.id));
}

export function groupOperationalAttention(items: OperationalAttentionItem[]): OperationalAttentionGroup[] {
  const groups = new Map<OperationalAttentionKind, OperationalAttentionItem[]>();
  items.forEach((item) => groups.set(item.kind, [...(groups.get(item.kind) ?? []), item]));
  return [...groups.entries()]
    .map(([kind, groupItems]) => ({
      kind,
      label: attentionLabels[kind],
      count: groupItems.length,
      highestSeverity: groupItems.reduce<OperationalAttentionSeverity>((highest, current) => severityRank[current.severity] < severityRank[highest] ? current.severity : highest, "info"),
      items: groupItems.slice(0, 25),
      viewAllRoute: attentionRoutes[kind],
    }))
    .sort((a, b) => severityRank[a.highestSeverity] - severityRank[b.highestSeverity] || b.count - a.count);
}

export function operationalAttentionInsights(items: OperationalAttentionItem[]): SmartInsight[] {
  const groups = groupOperationalAttention(items);
  if (!groups.length) return [{ title: "No urgent operations flags.", description: "Current operational records do not require immediate attention.", tone: "success" }];
  return groups.slice(0, 6).map((group) => {
    const first = group.items[0];
    return {
      title: `${group.label} (${group.count})`,
      description: first.summary,
      tone: group.highestSeverity === "critical" ? "danger" : group.highestSeverity === "warning" ? "warning" : "info",
      actionLabel: "Open records",
      metadata: first.currentStatus,
      actionHref: first.route || group.viewAllRoute,
      sourceItemId: first.id,
    };
  });
}

export function belizeDateKey(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BELIZE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function formatBelizeDate(value: string | null | undefined) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-BZ", { dateStyle: "medium", timeZone: BELIZE_TIME_ZONE }).format(new Date(value));
}

export function isOperationalAttentionCurrent(item: Pick<OperationalAttentionItem, "kind" | "dueAt" | "currentStatus">, source: Record<string, unknown> | null, asOf = new Date()) {
  if (!source) return false;
  const status = String(source.status ?? "");
  if (["completed", "cancelled", "Done", "Dismissed", "Paid", "Cancelled", "Declined", "voided", "reversed"].includes(status)) return false;
  if (item.kind === "overdue_follow_up" || item.kind === "post_sales_task_overdue" || item.kind === "collection_alert") {
    if (item.kind === "overdue_follow_up") {
      const linkedLead = source.leads as { pipeline_stage?: string | null } | null | undefined;
      if (!linkedLead || ["closed_won", "lost_inactive"].includes(String(linkedLead.pipeline_stage))) return false;
    }
    return Boolean(source.due_at || source.due_date) && new Date(String(source.due_at ?? source.due_date)).getTime() < asOf.getTime();
  }
  if (item.kind === "follow_up_due_today") {
    const linkedLead = source.leads as { pipeline_stage?: string | null } | null | undefined;
    return Boolean(linkedLead) && !["closed_won", "lost_inactive"].includes(String(linkedLead?.pipeline_stage)) && belizeDateKey(String(source.due_at ?? "")) === belizeDateKey(asOf);
  }
  if (item.kind === "site_visit_today") return belizeDateKey(String(source.scheduled_at ?? "")) === belizeDateKey(asOf);
  if (item.kind === "reservation_expiring") return activeReservationStatuses.has(status) && new Date(String(source.expires_at ?? "")).getTime() >= asOf.getTime() && isWithinBelizeDays(String(source.expires_at ?? ""), asOf, 3);
  if (item.kind === "deposit_overdue") return activeReservationStatuses.has(status) && (String(source.deposit_status) === "overdue" || (String(source.deposit_status) === "pending" && new Date(String(source.deposit_due_at ?? "")).getTime() < asOf.getTime()));
  if (item.kind === "application_review") return status === "Pending Review";
  if (item.kind === "missing_receipt") return status === "posted" && !String(source.manual_receipt_number ?? "").trim();
  if (item.kind === "missing_transfer_proof") return status === "posted" && ["Online Transfer", "Bank Transfer"].includes(String(source.collection_method)) && !(Array.isArray(source.payment_documents) && source.payment_documents.length > 0);
  if (item.kind === "post_sales_blocker") return status === "blocked" || String(source.document_status) === "blocked" || String(source.collections_handoff_status) === "blocked";
  if (item.kind === "site_visit_upcoming") return ["scheduled", "rescheduled"].includes(status) && new Date(String(source.scheduled_at ?? "")).getTime() >= asOf.getTime() && belizeDayDifference(asOf, String(source.scheduled_at ?? "")) <= 7;
  return true;
}

function item(value: OperationalAttentionItem): OperationalAttentionItem {
  return value;
}

function compareDue(a: string | null, b: string | null) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return new Date(a).getTime() - new Date(b).getTime();
}

function belizeDayDifference(start: Date, target: string) {
  const first = Date.parse(`${belizeDateKey(start)}T00:00:00Z`);
  const second = Date.parse(`${belizeDateKey(target)}T00:00:00Z`);
  return Math.round((second - first) / 86_400_000);
}

function isWithinBelizeDays(value: string, asOf: Date, maxDays: number) {
  if (!value) return false;
  const days = belizeDayDifference(asOf, value);
  return days >= 0 && days <= maxDays;
}
