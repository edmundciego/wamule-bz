import { supabase } from "./supabase";
import type { AuditAction, AuditEntityType, AuditEvent } from "../types/database";

export const auditEntityTypes: AuditEntityType[] = [
  "lead",
  "application",
  "customer",
  "contract",
  "payment",
  "payment_request",
  "parcel",
  "reservation",
  "post_sales_checklist",
  "post_sales_task",
  "document",
  "ai_summary",
  "settings",
  "user",
  "system",
];

export const auditActions: AuditAction[] = [
  "created",
  "updated",
  "deleted",
  "voided",
  "cancelled",
  "released",
  "status_changed",
  "assignment_changed",
  "generated",
  "uploaded",
  "reviewed",
  "settings_changed",
];

export const auditEntityLabels: Record<AuditEntityType, string> = {
  lead: "Lead",
  application: "Application",
  customer: "Customer",
  contract: "Contract",
  payment: "Payment",
  payment_request: "Payment Request",
  parcel: "Lot",
  reservation: "Reservation",
  post_sales_checklist: "Post-Sales Checklist",
  post_sales_task: "Post-Sales Task",
  document: "Document",
  ai_summary: "AI Summary",
  settings: "Settings",
  user: "User",
  system: "System",
};

export const auditActionLabels: Record<AuditAction, string> = {
  created: "Created",
  updated: "Updated",
  deleted: "Deleted",
  voided: "Voided",
  cancelled: "Cancelled",
  released: "Released",
  status_changed: "Status Changed",
  assignment_changed: "Assignment Changed",
  generated: "Generated",
  uploaded: "Uploaded",
  reviewed: "Reviewed",
  settings_changed: "Settings Changed",
};

type AuditEventInput = Pick<AuditEvent, "entity_type" | "action" | "title"> &
  Partial<
    Pick<
      AuditEvent,
      | "entity_id"
      | "summary"
      | "before_data"
      | "after_data"
      | "metadata"
      | "actor_user_id"
      | "actor_name"
      | "actor_email"
    >
  >;

const sensitiveAuditKeyPattern = /(?:api[_-]?key|secret|token|password|credential|authorization|raw[_-]?document|document[_-]?body|file[_-]?contents|base64)/i;

function sanitizeAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        sensitiveAuditKeyPattern.test(key) ? "[redacted]" : sanitizeAuditValue(nestedValue),
      ]),
    );
  }

  return value;
}

function sanitizeAuditObject(value: Record<string, unknown> | null | undefined) {
  if (!value) return null;
  return sanitizeAuditValue(value) as Record<string, unknown>;
}

export function formatAuditActor(event: Pick<AuditEvent, "actor_name" | "actor_email" | "actor_user_id">): string {
  if (event.actor_name?.trim()) return event.actor_name;
  if (event.actor_email?.trim()) return event.actor_email;
  if (event.actor_user_id?.trim()) return event.actor_user_id;
  return "System";
}

export async function createAuditEvent(event: AuditEventInput) {
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user ?? null;

  const { error } = await supabase.from("audit_events").insert({
    entity_type: event.entity_type,
    entity_id: event.entity_id ?? null,
    action: event.action,
    title: event.title,
    summary: event.summary ?? null,
    before_data: sanitizeAuditObject(event.before_data),
    after_data: sanitizeAuditObject(event.after_data),
    metadata: sanitizeAuditObject(event.metadata),
    actor_user_id: event.actor_user_id ?? user?.id ?? null,
    actor_name: event.actor_name ?? null,
    actor_email: event.actor_email ?? user?.email ?? null,
  });

  if (error) throw error;
}
