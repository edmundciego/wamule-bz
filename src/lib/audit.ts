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

export function formatAuditActor(event: Pick<AuditEvent, "actor_name" | "actor_email" | "actor_user_id">): string {
  if (event.actor_name?.trim()) return event.actor_name;
  if (event.actor_email?.trim()) return event.actor_email;
  if (event.actor_user_id?.trim()) return event.actor_user_id;
  return "System";
}
