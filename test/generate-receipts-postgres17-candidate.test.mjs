import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tenantId = "10000000-0000-4000-8000-000000000011";

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.action = "select";
  }
  select() { return this; }
  update(values) { this.action = "update"; this.values = values; return this; }
  eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
  order() { return this; }
  limit() { return this; }
  matched() {
    return (globalThis.__m36JobRows[this.table] ?? []).filter((row) => this.filters.every((filter) => filter(row)));
  }
  async execute() {
    const rows = this.matched();
    if (this.action === "update") {
      for (const row of rows) Object.assign(row, this.values);
    }
    return { data: rows.map((row) => ({ ...row })), error: null };
  }
  async maybeSingle() {
    const result = await this.execute();
    return { data: result.data[0] ?? null, error: null };
  }
  async single() {
    const result = await this.execute();
    return result.data.length === 1
      ? { data: result.data[0], error: null }
      : { data: null, error: { message: "Expected one synthetic row." } };
  }
  then(resolve, reject) { return this.execute().then(resolve, reject); }
}

function freshRows(deactivateBeforeFinalCheck = false) {
  const now = new Date().toISOString();
  const transaction = {
    id: 11,
    tenant_id: tenantId,
    customer_id: 21,
    contract_id: null,
    receipt_number: "R-11",
    transaction_type: "Deposit",
    amount: 100,
    currency: null,
    allocation_version: "legacy",
    collection_method: "Cash",
    bank_reference: null,
    created_at: now,
    authorized_by: "synthetic actor",
    status: "Posted",
    receipt_file_path: null,
  };
  return {
    receipt_jobs: [{ id: 31, tenant_id: tenantId, transaction_id: 11, attempts: 0, status: "Pending", created_at: now }],
    transactions: [transaction],
    organizations: [{ id: tenantId, is_active: true }],
    projects: [],
    customers: [{ id: 21, tenant_id: tenantId, first_name: "Synthetic", last_name: "Customer" }],
    contracts: [],
    transaction_allocations: [],
    fee_charges: [],
    development_phases: [],
    business_settings: [],
    deactivateBeforeFinalCheck,
  };
}

function serviceRequest(role = "service_role") {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = encode({ role, exp: Math.floor(Date.now() / 1000) + 60 });
  return new Request("https://edge.invalid/generate-receipts", {
    method: "POST",
    headers: { Authorization: `Bearer ${encode({ alg: "none" })}.${payload}.local-signature` },
  });
}

test("actual receipt Edge worker rejects ordinary callers and rechecks state before side effects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wamule-m36-receipt-"));
  const previousCrypto = globalThis.crypto;
  try {
    if (!globalThis.crypto) globalThis.crypto = webcrypto;
    globalThis.Deno = {
      env: { get: () => "local-test-value" },
      serve(handler) { globalThis.__m36ReceiptHandler = handler; },
    };
    globalThis.__m36JobRows = freshRows();
    globalThis.__m36WorkspaceReads = 0;
    globalThis.__m36Uploads = [];
    globalThis.__m36ScopeRpcCalls = [];
    await build({
      entryPoints: [new URL("../supabase/functions/generate-receipts/index.ts", import.meta.url).pathname],
      outfile: join(directory, "generate-receipts.mjs"),
      bundle: true,
      format: "esm",
      platform: "node",
      plugins: [{
        name: "local-supabase-client-stub",
        setup(builder) {
          builder.onResolve({ filter: /^https:\/\/esm\.sh\/@supabase\/supabase-js@2$/ }, () => ({ path: "supabase-client", namespace: "m36-stub" }));
          builder.onLoad({ filter: /.*/, namespace: "m36-stub" }, () => ({
            contents: `export function createClient(){ return {
              from(table){
                if (table === "organizations") globalThis.__m36WorkspaceReads += 1;
                if (table === "organizations" && globalThis.__m36JobRows.deactivateBeforeFinalCheck && globalThis.__m36WorkspaceReads > 2) {
                  globalThis.__m36JobRows.organizations[0].is_active = false;
                }
                return new globalThis.__m36Query(table);
              },
              async rpc(name,args){
                globalThis.__m36ScopeRpcCalls.push({name,args});
                if(name !== "workspace_scope_is_active") return {data:null,error:{message:"unexpected RPC"}};
                const tenant = globalThis.__m36JobRows.organizations.find(row => row.id === args.p_tenant_id && row.is_active);
                const project = args.p_project_id === null ? true : globalThis.__m36JobRows.projects.some(row => row.id === args.p_project_id && row.tenant_id === args.p_tenant_id);
                const phase = args.p_phase_id === null ? true : globalThis.__m36JobRows.development_phases.some(row => row.id === args.p_phase_id && row.tenant_id === args.p_tenant_id && row.project_id === args.p_project_id && row.is_active);
                return {data:Boolean(tenant && project && phase && !(args.p_phase_id && !args.p_project_id)),error:null};
              },
              storage:{from(bucket){return {upload:async(path,body,options)=>{globalThis.__m36Uploads.push({bucket,path,text:await body.text(),options}); return {error:null};}};}}
            };}`,
            loader: "js",
          }));
        },
      }],
    });
    globalThis.__m36Query = Query;
    await import(pathToFileURL(join(directory, "generate-receipts.mjs")).href);

    const unauthorized = await globalThis.__m36ReceiptHandler(serviceRequest("authenticated"));
    assert.equal(unauthorized.status, 403);
    assert.equal(globalThis.__m36WorkspaceReads, 0);
    assert.equal(globalThis.__m36Uploads.length, 0);

    globalThis.__m36JobRows = freshRows(true);
    globalThis.__m36WorkspaceReads = 0;
    const paused = await globalThis.__m36ReceiptHandler(serviceRequest());
    assert.equal(paused.status, 200);
    assert.equal(globalThis.__m36Uploads.length, 0);
    assert.equal(globalThis.__m36JobRows.transactions[0].receipt_file_path, null);
    assert.equal(globalThis.__m36JobRows.receipt_jobs[0].status, "Pending");
    assert.equal(globalThis.__m36JobRows.receipt_jobs[0].attempts, 0);

    globalThis.__m36JobRows = freshRows();
    globalThis.__m36WorkspaceReads = 0;
    const completed = await globalThis.__m36ReceiptHandler(serviceRequest());
    assert.equal(completed.status, 200);
    assert.equal(globalThis.__m36Uploads.length, 1);
    assert.equal(globalThis.__m36JobRows.transactions[0].receipt_file_path, `${tenantId}/21/R-11.pdf`);
    assert.equal(globalThis.__m36JobRows.receipt_jobs[0].status, "Completed");
    const completedUploadCount = globalThis.__m36Uploads.length;
    await globalThis.__m36ReceiptHandler(serviceRequest());
    assert.equal(globalThis.__m36Uploads.length, completedUploadCount, "a completed receipt retry does not re-upload its deterministic asset");

    const splitTenantId = "10000000-0000-4000-8000-000000000013";
    const projectId = "20000000-0000-4000-8000-000000000013";
    const northPhaseId = "30000000-0000-4000-8000-000000000013";
    const southPhaseId = "30000000-0000-4000-8000-000000000014";
    globalThis.__m36JobRows = freshRows();
    globalThis.__m36JobRows.transactions[0] = {
      ...globalThis.__m36JobRows.transactions[0],
      tenant_id: splitTenantId,
      amount: 15000,
      currency: "BZD",
      allocation_version: "allocations_v1",
      receipt_number: "R-SPLIT",
      contract_id: null,
    };
    globalThis.__m36JobRows.receipt_jobs[0].tenant_id = splitTenantId;
    globalThis.__m36JobRows.customers[0].tenant_id = splitTenantId;
    globalThis.__m36JobRows.organizations = [{ id: splitTenantId, is_active: true }];
    globalThis.__m36JobRows.projects = [{ id: projectId, tenant_id: splitTenantId }];
    globalThis.__m36JobRows.development_phases = [
      { id: northPhaseId, tenant_id: splitTenantId, project_id: projectId, is_active: true },
      { id: southPhaseId, tenant_id: splitTenantId, project_id: projectId, is_active: true },
    ];
    globalThis.__m36JobRows.contracts = [
      { id: 41, tenant_id: splitTenantId, customer_id: 21, project_id: projectId, phase_id: northPhaseId, parcel_id: 141, currency: "BZD" },
      { id: 42, tenant_id: splitTenantId, customer_id: 21, project_id: projectId, phase_id: southPhaseId, parcel_id: 142, currency: "BZD" },
    ];
    globalThis.__m36JobRows.parcels = [
      { id: 141, tenant_id: splitTenantId, project_id: projectId, phase_id: northPhaseId, lot_number: "Lot 01" },
      { id: 142, tenant_id: splitTenantId, project_id: projectId, phase_id: southPhaseId, lot_number: "Lot 01" },
    ];
    globalThis.__m36JobRows.transaction_allocations = [
      { id: 51, tenant_id: splitTenantId, transaction_id: 11, customer_id: 21, amount: 10000, currency: "BZD", scope_kind: "phase", allocation_kind: "applied", contract_id: 41, reservation_id: null, fee_charge_id: null, project_id: projectId, phase_id: northPhaseId, allocation_reason: null },
      { id: 52, tenant_id: splitTenantId, transaction_id: 11, customer_id: 21, amount: 5000, currency: "BZD", scope_kind: "phase", allocation_kind: "applied", contract_id: 42, reservation_id: null, fee_charge_id: null, project_id: projectId, phase_id: southPhaseId, allocation_reason: null },
    ];
    globalThis.__m36Uploads = [];
    const splitResponse = await globalThis.__m36ReceiptHandler(serviceRequest());
    assert.equal(splitResponse.status, 200);
    assert.equal(globalThis.__m36Uploads.length, 1);
    assert.equal(globalThis.__m36Uploads[0].path, `${splitTenantId}/21/R-SPLIT.pdf`);
    assert.match(globalThis.__m36Uploads[0].text, /BZD 10000\.00 — Contract 41, Lot Lot 01/);
    assert.match(globalThis.__m36Uploads[0].text, /BZD 5000\.00 — Contract 42, Lot Lot 01/);
    assert.equal(globalThis.__m36ScopeRpcCalls.length, 2, "each split phase is checked immediately before storage I/O");
    assert.ok(globalThis.__m36ScopeRpcCalls.every((call) => call.name === "workspace_scope_is_active"));

    // Simulate a phase deactivation after the job is queued. The actual handler
    // must pause before uploading or changing the transaction, then retry once
    // the exact scope is active again.
    const resetScopedReceipt = (phaseActive) => {
      globalThis.__m36JobRows = freshRows();
      globalThis.__m36JobRows.transactions[0] = {
        ...globalThis.__m36JobRows.transactions[0], tenant_id: splitTenantId, amount: 100,
        currency: "BZD", allocation_version: "allocations_v1", receipt_number: "R-LIFECYCLE",
      };
      globalThis.__m36JobRows.receipt_jobs[0].tenant_id = splitTenantId;
      globalThis.__m36JobRows.customers[0].tenant_id = splitTenantId;
      globalThis.__m36JobRows.organizations = [{ id: splitTenantId, is_active: true }];
      globalThis.__m36JobRows.projects = [{ id: projectId, tenant_id: splitTenantId }];
      globalThis.__m36JobRows.development_phases = [
        { id: northPhaseId, tenant_id: splitTenantId, project_id: projectId, is_active: phaseActive },
      ];
      globalThis.__m36JobRows.contracts = [
        { id: 41, tenant_id: splitTenantId, customer_id: 21, project_id: projectId, phase_id: northPhaseId, parcel_id: 141, currency: "BZD" },
      ];
      globalThis.__m36JobRows.parcels = [
        { id: 141, tenant_id: splitTenantId, project_id: projectId, phase_id: northPhaseId, lot_number: "Lot 01" },
      ];
      globalThis.__m36JobRows.transaction_allocations = [
        { id: 53, tenant_id: splitTenantId, transaction_id: 11, customer_id: 21, amount: 100, currency: "BZD", scope_kind: "phase", allocation_kind: "applied", contract_id: 41, reservation_id: null, fee_charge_id: null, project_id: projectId, phase_id: northPhaseId, allocation_reason: null },
      ];
      globalThis.__m36Uploads = [];
      globalThis.__m36ScopeRpcCalls = [];
    };
    resetScopedReceipt(false);
    const inactivePhaseResponse = await globalThis.__m36ReceiptHandler(serviceRequest());
    assert.equal(inactivePhaseResponse.status, 200);
    assert.equal(globalThis.__m36Uploads.length, 0);
    assert.equal(globalThis.__m36JobRows.receipt_jobs[0].status, "Pending");
    assert.equal(globalThis.__m36JobRows.transactions[0].receipt_file_path, null);
    assert.ok(globalThis.__m36ScopeRpcCalls.some((call) => call.args.p_phase_id === northPhaseId));

    resetScopedReceipt(true);
    const reactivatedRetry = await globalThis.__m36ReceiptHandler(serviceRequest());
    assert.equal(reactivatedRetry.status, 200);
    assert.equal(globalThis.__m36Uploads.length, 1);
    assert.equal(globalThis.__m36JobRows.receipt_jobs[0].status, "Completed");

    globalThis.__m36JobRows = freshRows();
    globalThis.__m36JobRows.receipt_jobs[0].status = "Processing";
    globalThis.__m36JobRows.receipt_jobs[0].error_message = `m77-receipt-lease:${Date.now() - (11 * 60 * 1000)}:expired-owner`;
    globalThis.__m36Uploads = [];
    const recoveredLease = await globalThis.__m36ReceiptHandler(serviceRequest());
    assert.equal(recoveredLease.status, 200);
    assert.equal(globalThis.__m36JobRows.receipt_jobs[0].status, "Completed", "expired receipt leases can be recovered");
    assert.equal(globalThis.__m36Uploads.length, 1);

    const secondTenantId = "10000000-0000-4000-8000-000000000012";
    globalThis.__m36Uploads = [];
    globalThis.__m36JobRows = freshRows();
    globalThis.__m36JobRows.organizations.push({ id: secondTenantId, is_active: true });
    globalThis.__m36JobRows.receipt_jobs.push({ id: 32, tenant_id: secondTenantId, transaction_id: 12, attempts: 0, status: "Pending", created_at: new Date().toISOString() });
    globalThis.__m36JobRows.transactions.push({ ...globalThis.__m36JobRows.transactions[0], id: 12, tenant_id: secondTenantId, customer_id: 22, receipt_number: "R-12", receipt_file_path: null });
    globalThis.__m36JobRows.customers.push({ id: 22, tenant_id: secondTenantId, first_name: "Other", last_name: "Tenant" });
    globalThis.__m36WorkspaceReads = 0;
    const oneTenantBatch = await globalThis.__m36ReceiptHandler(serviceRequest());
    assert.equal(oneTenantBatch.status, 200);
    assert.equal(globalThis.__m36JobRows.receipt_jobs[0].status, "Completed");
    assert.equal(globalThis.__m36JobRows.receipt_jobs[1].status, "Pending");
    assert.equal(globalThis.__m36JobRows.transactions[1].receipt_file_path, null);
    assert.equal(globalThis.__m36Uploads.length, 1);
  } finally {
    if (previousCrypto === undefined) delete globalThis.crypto;
    delete globalThis.Deno;
    delete globalThis.__m36ReceiptHandler;
    delete globalThis.__m36JobRows;
    delete globalThis.__m36WorkspaceReads;
    delete globalThis.__m36Uploads;
    delete globalThis.__m36ScopeRpcCalls;
    delete globalThis.__m36Query;
    await rm(directory, { recursive: true, force: true });
  }
});
