const ENTITY_TO_TABLE = Object.freeze({
  lead: "leads",
  follow_up_task: "follow_up_tasks",
  site_visit: "site_visits",
  application: "applications",
  reservation: "lot_reservations",
  payment: "transactions",
  payment_request: "payment_requests",
  customer: "customers",
  post_sales_task: "post_sales_tasks",
  post_sales_checklist: "post_sales_checklists",
});

export const DAILY_BRIEF_SOURCE_TABLES = Object.freeze([...new Set(Object.values(ENTITY_TO_TABLE))]);
const ALLOWED_TABLES = new Set(DAILY_BRIEF_SOURCE_TABLES);

export function resolveDailyBriefSourceTable(entityType, relatedTable) {
  if (entityType) return ENTITY_TO_TABLE[entityType] ?? null;
  return typeof relatedTable === "string" && ALLOWED_TABLES.has(relatedTable) ? relatedTable : null;
}
