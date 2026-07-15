import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Customer Detail separates current account values from historical activity", async () => {
  const source = await read("src/pages/CustomerDetailPage.tsx");
  for (const label of ["No active contract", "Current land payments", "Historical land payments", "Historical Transactions", "Current Contract Payments", "Current Account Statement"]) {
    assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(source, /postedLandPaymentsForContract/);
  assert.match(source, /remainingLandBalance/);
  assert.match(source, /row\.status === "posted" && row\.contract_id === activeContractId/);
});

test("Customer Detail uses explicit lot relationship labels and state-aware actions", async () => {
  const source = await read("src/pages/CustomerDetailPage.tsx");
  for (const label of ["Requested Lot", "Reserved Lot", "Contract Lot", "hasAuthorizedContractLot", "Land payments require an active contract"]) {
    assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(source, /disabled={!hasAuthorizedContractLot}/);
  assert.match(source, /landPaymentsEnabled=\{Boolean\(activeCustomerContract\)\}/);
});

test("Customer Detail keeps zero-task post-sales and advisory summary states explicit", async () => {
  const [page, paymentForm, schemas] = await Promise.all([
    read("src/pages/CustomerDetailPage.tsx"),
    read("src/components/forms/PaymentForm.tsx"),
    read("src/lib/schemas.ts"),
  ]);
  assert.match(page, /Started — no tasks created/);
  assert.match(page, /No active contract is recorded\. This advisory summary cannot establish/);
  assert.match(page, /Requested Lot \{requestedLot\} through Application/);
  assert.match(paymentForm, /landPaymentsEnabled/);
  assert.match(schemas, /Land payments require a contract/);
});
