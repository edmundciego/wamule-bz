import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("critical correctness migration replaces hard-delete payment correction paths", async () => {
  const [migration, retiredPaymentMigration, retiredPurgeMigration] = await Promise.all([
    read("supabase/migrations/20260714223959_20260714210447_critical_correctness_batch_1.sql"),
    read("supabase/migrations/20260714220611_20260714203000_controlled_payment_removal.sql"),
    read("supabase/migrations/20260714220603_20260714074603_release_quality_data_management.sql"),
  ]);
  assert.match(migration, /drop policy if exists "Transactions deletable by admins"/);
  assert.match(migration, /Internal writers can create transactions/);
  assert.match(migration, /drop function if exists public\.remove_payment_record/);
  assert.match(migration, /create or replace function public\.void_payment_record/);
  assert.match(migration, /create or replace function public\.prevent_transaction_delete/);
  assert.match(migration, /Payment records cannot be deleted/);
  assert.match(migration, /status = 'voided'/);
  assert.match(migration, /from public\.payment_documents/);
  assert.doesNotMatch(migration, /delete from public\.transactions/);
  for (const retiredMigration of [retiredPaymentMigration, retiredPurgeMigration]) {
    assert.match(retiredMigration, /NO-OP/);
    assert.doesNotMatch(retiredMigration, /create or replace function/);
    assert.doesNotMatch(retiredMigration, /delete from public\./);
  }
});

test("critical correctness migration preserves lot authorization and void resolution controls", async () => {
  const migration = await read("supabase/migrations/20260714223959_20260714210447_critical_correctness_batch_1.sql");
  for (const requirement of [
    "contract_void_resolutions",
    "Lot resolution is required before another contract can use this parcel",
    "Contract parcel must match the customer active reservation lot",
    "An approved application or active reservation must authorize the selected contract lot",
    "resolve_contract_void_resolution",
    "release_lot",
    "return_to_reservation",
    "retain_sold",
    "Created % pending legacy contract-void resolution record",
  ]) assert.match(migration, new RegExp(requirement));
});

test("canonical financial definitions only count posted payments tied to the active contract", async () => {
  const [clientHelper, edgeHelper, paymentsPage, contractForm] = await Promise.all([
    read("src/lib/financial.ts"),
    read("supabase/functions/_shared/financial.ts"),
    read("src/pages/PaymentsPage.tsx"),
    read("src/components/forms/ContractForm.tsx"),
  ]);
  for (const helper of [clientHelper, edgeHelper]) {
    assert.match(helper, /is_active/);
    assert.match(helper, /status === "active"/);
    assert.match(helper, /status === "posted"/);
    assert.match(helper, /contract_id/);
  }
  assert.match(paymentsPage, /Void payment/);
  assert.doesNotMatch(paymentsPage, /Remove payment/);
  assert.match(contractForm, /Authorized lot/);
  assert.match(contractForm, /Active Reservation/);
  assert.match(contractForm, /Approved Application/);
});

test("customer balance view preserves the existing unconstrained numeric column types", async () => {
  const migration = await read("supabase/migrations/20260714223959_20260714210447_critical_correctness_batch_1.sql");
  const customerBalanceView = migration.match(/create or replace view public\.customer_balance_view[\s\S]*?grant select on public\.customer_balance_view/iu)?.[0];

  assert.ok(customerBalanceView, "customer balance view definition should be present");
  assert.match(customerBalanceView, /with \(security_invoker = true\)/i);
  assert.match(customerBalanceView, /0::numeric\) as land_paid/i);
  assert.match(customerBalanceView, /0::numeric\) as community_paid/i);
  assert.match(customerBalanceView, /0::numeric\) as land_balance/i);
  assert.doesNotMatch(customerBalanceView, /customer_balance_view[\s\S]*?numeric\(12,2\)/i);
});
