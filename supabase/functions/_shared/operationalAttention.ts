/**
 * Deterministic operational attention rules used by generated Daily Briefs.
 * This deliberately contains no AI calls and only returns source-backed records.
 */
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

export type OperationalAttentionItem = {
  id: string;
  kind: OperationalAttentionKind;
  severity: "critical" | "warning" | "info";
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
};

type Row = Record<string, unknown>;
type Input = {
  leads?: Row[];
  followUps?: Row[];
  reservations?: Row[];
  applications?: Row[];
  payments?: Row[];
  paymentRequests?: Row[];
  postSalesChecklists?: Row[];
  postSalesTasks?: Row[];
  siteVisits?: Row[];
};

const activeReservations = new Set(["draft", "reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed"]);
const openFollowUps = new Set(["open", "in_progress"]);
const openPostSales = new Set(["open", "in_progress", "blocked"]);
const severityRank = { critical: 0, warning: 1, info: 2 } as const;

export function buildOperationalAttention(input: Input, asOf = new Date()): OperationalAttentionItem[] {
  const items: OperationalAttentionItem[] = [];
  const leads = input.leads ?? [];
  const leadById = new Map(leads.map((lead) => [String(lead.id), lead]));
  const customerName = (row: Row | null | undefined) => {
    const customer = row?.customers as Row | null | undefined;
    return String(`${customer?.first_name ?? ""} ${customer?.last_name ?? ""}`).trim() || `Record #${row?.customer_id ?? row?.id ?? "?"}`;
  };
  const sourceUpdated = (row: Row) => String(row.updated_at ?? row.created_at ?? asOf.toISOString());
  const followUpRoute = (leadId: unknown, taskId: unknown) => `/leads?lead=${encodeURIComponent(String(leadId))}&focus=followups&followup=${encodeURIComponent(String(taskId))}`;
  const reservationRoute = (leadId: unknown, reservationId: unknown) => `/leads?lead=${encodeURIComponent(String(leadId))}&focus=reservation&reservation=${encodeURIComponent(String(reservationId))}`;

  for (const task of input.followUps ?? []) {
    if (!task.lead_id || !openFollowUps.has(String(task.status)) || !task.due_at) continue;
    const lead = leadById.get(String(task.lead_id));
    if (!lead || ["closed_won", "lost_inactive"].includes(String(lead.pipeline_stage))) continue;
    const due = new Date(String(task.due_at));
    if (Number.isNaN(due.getTime())) continue;
    const overdue = due.getTime() < asOf.getTime();
    const dueToday = !overdue && belizeDateKey(due) === belizeDateKey(asOf);
    if (!overdue && !dueToday) continue;
    const kind = overdue ? "overdue_follow_up" : "follow_up_due_today";
    items.push({
      id: `${kind}:${task.id}`,
      kind,
      severity: overdue ? "critical" : "warning",
      title: String(task.title ?? "Follow-up task"),
      summary: `${String(lead.full_name ?? "Buyer")} · due ${formatBelizeDate(String(task.due_at))}`,
      entityType: "follow_up_task",
      entityId: String(task.id),
      relatedEntityId: String(lead.id),
      route: followUpRoute(lead.id, task.id),
      dueAt: String(task.due_at),
      ownerName: "Unassigned",
      currentStatus: String(task.status ?? "open"),
      sourceUpdatedAt: sourceUpdated(task),
    });
  }

  for (const reservation of input.reservations ?? []) {
    if (!activeReservations.has(String(reservation.status))) continue;
    const lead = reservation.lead_id ? leadById.get(String(reservation.lead_id)) : null;
    const name = lead ? String(lead.full_name ?? "Buyer") : customerName(reservation);
    if (reservation.expires_at && new Date(String(reservation.expires_at)).getTime() >= asOf.getTime() && isWithinBelizeDays(String(reservation.expires_at), asOf, 3)) {
      const lot = (reservation.parcels as Row | null | undefined)?.lot_number;
      items.push({
        id: `reservation_expiring:${reservation.id}`,
        kind: "reservation_expiring",
        severity: "warning",
        title: "Reservation expires soon",
        summary: `${name}${lot ? ` · Lot ${lot}` : ""} · expires ${formatBelizeDate(String(reservation.expires_at))}`,
        entityType: "reservation",
        entityId: String(reservation.id),
        relatedEntityId: lead?.id ? String(lead.id) : null,
        route: lead ? reservationRoute(lead.id, reservation.id) : "/leads?focus=reservations",
        dueAt: String(reservation.expires_at),
        ownerName: "Unassigned",
        currentStatus: String(reservation.status),
        sourceUpdatedAt: sourceUpdated(reservation),
      });
    }
    const depositDue = reservation.deposit_due_at ? new Date(String(reservation.deposit_due_at)) : null;
    if (String(reservation.deposit_status) === "overdue" || (String(reservation.deposit_status) === "pending" && depositDue && depositDue.getTime() < asOf.getTime())) {
      items.push({
        id: `deposit_overdue:${reservation.id}`,
        kind: "deposit_overdue",
        severity: "critical",
        title: "Deposit readiness is overdue",
        summary: `${name} · expected deposit was due ${reservation.deposit_due_at ? formatBelizeDate(String(reservation.deposit_due_at)) : "not set"}`,
        entityType: "reservation",
        entityId: String(reservation.id),
        relatedEntityId: lead?.id ? String(lead.id) : null,
        route: lead ? reservationRoute(lead.id, reservation.id) : "/leads?focus=reservations",
        dueAt: reservation.deposit_due_at ? String(reservation.deposit_due_at) : null,
        ownerName: "Unassigned",
        currentStatus: String(reservation.deposit_status ?? reservation.status),
        sourceUpdatedAt: sourceUpdated(reservation),
      });
    }
  }

  for (const application of input.applications ?? []) {
    if (String(application.status) !== "Pending Review") continue;
    const name = String(application.applicant_full_name ?? `${application.first_name ?? ""} ${application.last_name ?? ""}`).trim() || `Application #${application.id}`;
    items.push({
      id: `application_review:${application.id}`,
      kind: "application_review",
      severity: "warning",
      title: "Application awaiting review",
      summary: `${name} · Application #${application.id}`,
      entityType: "application",
      entityId: String(application.id),
      relatedEntityId: null,
      route: `/applications?application=${encodeURIComponent(String(application.id))}`,
      dueAt: null,
      ownerName: "Unassigned",
      currentStatus: String(application.status),
      sourceUpdatedAt: sourceUpdated(application),
    });
  }

  for (const payment of input.payments ?? []) {
    if (String(payment.status) !== "posted") continue;
    const name = customerName(payment);
    if (!String(payment.manual_receipt_number ?? "").trim()) {
      items.push({ id: `missing_receipt:${payment.id}`, kind: "missing_receipt", severity: "warning", title: "Enter manual receipt number", summary: `${name} · payment #${payment.id}`, entityType: "payment", entityId: String(payment.id), relatedEntityId: String(payment.customer_id ?? ""), route: `/payments?payment=${encodeURIComponent(String(payment.id))}&focus=missing-receipt`, dueAt: null, ownerName: "Finance", currentStatus: "posted", sourceUpdatedAt: sourceUpdated(payment) });
    }
    if (["Online Transfer", "Bank Transfer"].includes(String(payment.collection_method)) && (!Array.isArray(payment.payment_documents) || payment.payment_documents.length === 0)) {
      items.push({ id: `missing_transfer_proof:${payment.id}`, kind: "missing_transfer_proof", severity: "warning", title: "Upload or confirm transfer proof", summary: `${name} · payment #${payment.id}`, entityType: "payment", entityId: String(payment.id), relatedEntityId: String(payment.customer_id ?? ""), route: `/payments?payment=${encodeURIComponent(String(payment.id))}&focus=missing-proof`, dueAt: null, ownerName: "Finance", currentStatus: "posted", sourceUpdatedAt: sourceUpdated(payment) });
    }
  }

  for (const request of input.paymentRequests ?? []) {
    const due = request.due_date ? new Date(String(request.due_date)) : null;
    if (!["Draft", "Sent"].includes(String(request.status)) || !due || Number.isNaN(due.getTime()) || due.getTime() >= asOf.getTime()) continue;
    items.push({ id: `collection_alert:${request.id}`, kind: "collection_alert", severity: "critical", title: "Payment request is overdue", summary: `${customerName(request)} · request #${request.id} was due ${formatBelizeDate(String(request.due_date))}`, entityType: "payment_request", entityId: String(request.id), relatedEntityId: String(request.customer_id ?? ""), route: `/customers/${encodeURIComponent(String(request.customer_id ?? ""))}?tab=requests&request=${encodeURIComponent(String(request.id))}`, dueAt: String(request.due_date), ownerName: "Collections", currentStatus: String(request.status), sourceUpdatedAt: sourceUpdated(request) });
  }

  for (const checklist of input.postSalesChecklists ?? []) {
    if (![String(checklist.status), String(checklist.document_status), String(checklist.collections_handoff_status)].some((status) => status === "blocked")) continue;
    items.push({ id: `post_sales_blocker:${checklist.id}`, kind: "post_sales_blocker", severity: "critical", title: "Post-sales checklist is blocked", summary: `Customer #${checklist.customer_id ?? "unassigned"} · review post-sales blockers`, entityType: "post_sales_checklist", entityId: String(checklist.id), relatedEntityId: checklist.customer_id == null ? null : String(checklist.customer_id), route: `/customers/${encodeURIComponent(String(checklist.customer_id ?? ""))}?tab=post-sales&checklist=${encodeURIComponent(String(checklist.id))}`, dueAt: null, ownerName: "Unassigned", currentStatus: String(checklist.status ?? "blocked"), sourceUpdatedAt: sourceUpdated(checklist) });
  }

  for (const task of input.postSalesTasks ?? []) {
    const due = task.due_at ? new Date(String(task.due_at)) : null;
    if (!openPostSales.has(String(task.status)) || !due || Number.isNaN(due.getTime()) || due.getTime() >= asOf.getTime()) continue;
    items.push({ id: `post_sales_task_overdue:${task.id}`, kind: "post_sales_task_overdue", severity: "critical", title: String(task.title ?? "Post-sales task overdue"), summary: `Customer #${task.customer_id ?? "unassigned"} · due ${formatBelizeDate(String(task.due_at))}`, entityType: "post_sales_task", entityId: String(task.id), relatedEntityId: task.customer_id == null ? null : String(task.customer_id), route: `/customers/${encodeURIComponent(String(task.customer_id ?? ""))}?tab=post-sales&task=${encodeURIComponent(String(task.id))}`, dueAt: String(task.due_at), ownerName: "Unassigned", currentStatus: String(task.status), sourceUpdatedAt: sourceUpdated(task) });
  }

  for (const visit of input.siteVisits ?? []) {
    const scheduled = visit.scheduled_at ? new Date(String(visit.scheduled_at)) : null;
    const days = visit.scheduled_at ? belizeDayDifference(asOf, String(visit.scheduled_at)) : -1;
    if (!["scheduled", "rescheduled"].includes(String(visit.status)) || !scheduled || Number.isNaN(scheduled.getTime()) || scheduled.getTime() < asOf.getTime() || days < 0 || days > 7) continue;
    const lead = visit.lead_id ? leadById.get(String(visit.lead_id)) : null;
    const kind = days === 0 ? "site_visit_today" : "site_visit_upcoming";
    items.push({ id: `${kind}:${visit.id}`, kind, severity: days === 0 ? "warning" : "info", title: String(visit.visit_type ?? "Site visit"), summary: `${lead?.full_name ?? "Buyer record"} · ${formatBelizeDate(String(visit.scheduled_at))}`, entityType: "site_visit", entityId: String(visit.id), relatedEntityId: lead?.id ? String(lead.id) : visit.lead_id ? String(visit.lead_id) : null, route: lead ? `/leads?lead=${encodeURIComponent(String(lead.id))}&focus=site-visits&visit=${encodeURIComponent(String(visit.id))}` : "/leads?focus=site-visits", dueAt: String(visit.scheduled_at), ownerName: "Unassigned", currentStatus: String(visit.status), sourceUpdatedAt: sourceUpdated(visit) });
  }

  return items.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || new Date(a.dueAt ?? "9999-12-31").getTime() - new Date(b.dueAt ?? "9999-12-31").getTime() || a.id.localeCompare(b.id));
}

export function belizeDateKey(value: Date | string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: BELIZE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value instanceof Date ? value : new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function formatBelizeDate(value: string) {
  return new Intl.DateTimeFormat("en-BZ", { dateStyle: "medium", timeZone: BELIZE_TIME_ZONE }).format(new Date(value));
}

function belizeDayDifference(start: Date, target: string) {
  const first = Date.parse(`${belizeDateKey(start)}T00:00:00Z`);
  const second = Date.parse(`${belizeDateKey(target)}T00:00:00Z`);
  return Math.round((second - first) / 86_400_000);
}

function isWithinBelizeDays(value: string, asOf: Date, maxDays: number) {
  const days = belizeDayDifference(asOf, value);
  return days >= 0 && days <= maxDays;
}
