import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const file = (path) => readFile(new URL(path, root), "utf8");

test("post-sales forward migration is the reviewed body and preserves project/phase filters", async () => {
  const migration = await file("supabase/migrations/20261112033403_post_sales_project_phase_scope.sql");
  assert.equal(createHash("sha256").update(migration).digest("hex"), "18e060bd642cad681e5aef988aa06149d90e5627cb0ffe6b90828f8dd4ab12f5");
  assert.match(migration, /count\(DISTINCT \(project_id, phase_id\)\) > 1/);
  assert.match(migration, /HAVING bool_and\(project_id IS NOT NULL AND phase_id IS NOT NULL\)/);
  assert.match(migration, /A legacy sale parent without verified phase scope cannot be assigned/);
  assert.match(migration, /CREATE TRIGGER post_sales_checklists_scope_guard/);
  assert.match(migration, /CREATE TRIGGER post_sales_tasks_scope_guard/);
  assert.match(migration, /CREATE POLICY post_sales_scope_select ON public\.post_sales_tasks AS RESTRICTIVE/);

  const dashboard = await file("src/pages/DashboardPage.tsx");
  const reports = await file("src/pages/ReportsPage.tsx");
  const scopeBlock = (source, marker, endMarker) => {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `missing query marker ${marker}`);
    const end = source.indexOf(endMarker, start + marker.length);
    assert.notEqual(end, -1, `missing query end marker ${endMarker}`);
    return source.slice(start, end);
  };
  for (const marker of ["dashboard-post-sales-tasks", "dashboard-post-sales-checklists"]) {
    const block = scopeBlock(dashboard, marker, "queryKey:");
    assert.match(block, /query = query\.eq\("project_id", workspace!\.projectId\)/, `${marker} keeps its project filter`);
    assert.match(block, /query = query\.eq\("phase_id", workspace!\.phaseId\)/, `${marker} keeps its phase filter`);
  }
  for (const marker of ["postSalesChecklistsQuery", "postSalesTasksQuery"]) {
    const start = reports.indexOf(`const ${marker}`);
    assert.notEqual(start, -1, `missing report query ${marker}`);
    const end = reports.indexOf("\n  const ", start + 10);
    const block = reports.slice(start, end === -1 ? reports.length : end);
    assert.match(block, /query = query\.eq\("project_id", workspace!\.projectId\)/, `${marker} keeps its project filter`);
    assert.match(block, /query = query\.eq\("phase_id", workspace!\.phaseId\)/, `${marker} keeps its phase filter`);
  }
});

test("community-fee view adds contract-owned tenant scope without widening access", async () => {
  const migration = await file("supabase/migrations/20261112033404_community_fee_view_tenant_scope.sql");
  assert.match(migration, /c\.tenant_id AS tenant_id/);
  assert.match(migration, /JOIN public\.community_fee_settings cfg ON cfg\.tenant_id = c\.tenant_id/);
  assert.match(migration, /t\.tenant_id = c\.tenant_id/);
  assert.match(migration, /security_invoker = true/);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON TABLE public\.community_fee_account_status FROM anon, PUBLIC/);
  assert.match(migration, /GRANT SELECT ON TABLE public\.community_fee_account_status TO authenticated/);
  assert.doesNotMatch(migration, /GRANT .* TO anon/);
});

test("receipt lifecycle guard uses the authoritative tenant/project/phase helper", async () => {
  const source = await file("supabase/functions/generate-receipts/index.ts");
  const guard = source.slice(source.indexOf("async function verifyReceiptWorkspace"), source.indexOf("async function resolveReceiptAllocations"));
  assert.match(guard, /rpc\("workspace_scope_is_active"/);
  assert.match(guard, /p_tenant_id: transaction\.tenant_id/);
  assert.match(guard, /p_project_id: scope\.projectId/);
  assert.match(guard, /p_phase_id: scope\.phaseId/);
  assert.match(guard, /activeScope !== true/);
  assert.doesNotMatch(guard, /from\("projects"\)[\s\S]*?is_active/);
  assert.match(guard, /phaseId !== null && scope\.projectId === null/);
});
