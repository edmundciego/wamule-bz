import assert from "node:assert/strict";
import test from "node:test";
import { DAILY_BRIEF_SOURCE_TABLES, resolveDailyBriefSourceTable } from "../src/lib/dailyBriefSourceTable.mjs";

test("daily brief source-type mapping is bounded to the supported business tables", () => {
  assert.equal(new Set(DAILY_BRIEF_SOURCE_TABLES).size, 10);
  assert.equal(resolveDailyBriefSourceTable("follow_up_task", null), "follow_up_tasks");
  assert.equal(resolveDailyBriefSourceTable("payment", "admin_profiles"), "transactions");
  assert.equal(resolveDailyBriefSourceTable("unknown_type", "leads"), null);
});

test("legacy related_table fallback rejects arbitrary schema objects", () => {
  assert.equal(resolveDailyBriefSourceTable(null, "transactions"), "transactions");
  assert.equal(resolveDailyBriefSourceTable(null, "admin_profiles"), null);
  assert.equal(resolveDailyBriefSourceTable(null, "auth.users"), null);
});
