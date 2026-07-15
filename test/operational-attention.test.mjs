import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("operational attention uses one source-backed Belize-time rule set", async () => {
  const [helper, leads, dashboard, insights, edge] = await Promise.all([
    read("src/lib/operationalAttention.ts"),
    read("src/pages/LeadsPage.tsx"),
    read("src/pages/DashboardPage.tsx"),
    read("src/lib/smartInsights.ts"),
    read("supabase/functions/_shared/operationalAttention.ts"),
  ]);
  for (const source of [helper, edge]) {
    assert.match(source, /America\/Belize/);
    assert.match(source, /overdue_follow_up/);
    assert.match(source, /follow_up_due_today/);
    assert.match(source, /lead_id/);
    assert.match(source, /open|in_progress/);
  }
  assert.match(leads, /buildOperationalAttention/);
  assert.match(dashboard, /groupOperationalAttention/);
  assert.match(insights, /buildOperationalAttention/);
});

test("attention drill-downs retain exact source identifiers", async () => {
  const [helper, edge, dailyBrief] = await Promise.all([
    read("src/lib/operationalAttention.ts"),
    read("supabase/functions/_shared/operationalAttention.ts"),
    read("src/pages/DailyBriefsPage.tsx"),
  ]);
  for (const source of [helper, edge]) {
    assert.match(source, /focus=followups/);
    assert.match(source, /focus=reservation/);
    assert.match(source, /application=/);
    assert.match(source, /payment=/);
  }
  assert.match(dailyBrief, /Current/);
  assert.match(dailyBrief, /Resolved since brief/);
  assert.match(dailyBrief, /Updated since brief/);
  assert.match(dailyBrief, /Source unavailable/);
  assert.match(dailyBrief, /destination_route/);
});

test("brief action storage captures generated source metadata for revalidation", async () => {
  const [migration, databaseTypes, dailyBrief] = await Promise.all([
    read("supabase/migrations/20260714231118_operational_attention_source_metadata.sql"),
    read("src/types/database.ts"),
    read("supabase/functions/generate-daily-brief/index.ts"),
  ]);
  for (const field of ["attention_kind", "source_entity_type", "source_entity_id", "related_entity_id", "generated_status", "generated_due_at", "generated_source_updated_at", "destination_route"]) {
    assert.match(migration, new RegExp(`add column if not exists ${field}`));
    assert.match(databaseTypes, new RegExp(`${field}:`));
    assert.match(dailyBrief, new RegExp(field));
  }
  assert.match(dailyBrief, /buildOperationalAttention/);
  assert.match(dailyBrief, /sourceAction/);
});

test("known edge cases are represented in the shared implementation", async () => {
  const helper = await read("src/lib/operationalAttention.ts");
  for (const expectation of [
    /!openFollowUpStatuses\.has/,
    /closed_won/,
    /lost_inactive/,
    /dueToday/,
    /missing_receipt/,
    /missing_transfer_proof/,
    /post_sales_task_overdue/,
    /site_visit_today/,
  ]) assert.match(helper, expectation);
});
