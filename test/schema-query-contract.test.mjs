import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { applyDynamicContracts, compareCatalog, scanSources } from "../scripts/schema-query-contract.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

function listSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listSources(path);
    return sourceExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

test("schema query scanner records selected, related, filtered, and written columns", () => {
  const directory = mkdtempSync(join(tmpdir(), "wamule-schema-query-"));
  try {
    const file = join(directory, "queries.ts");
    writeFileSync(file, `
      const q = client.from("applications")
        .select("id, phase_id, customer:customers(id,email)")
        .eq("project_id", projectId)
        .order("created_at");
      await client.from("applications").insert({ tenant_id, phase_id, applicant_full_name: name });
      await client.from("applications").update({ status: "approved" }).eq("id", applicationId);
      client.rpc("create_public_application", { phase_id });
    `);
    const result = scanSources([file], directory);
    assert.equal(result.queries.length, 3);
    assert.equal(result.remoteFunctions.length, 1);
    assert.deepEqual(result.queries[0].columns.map((item) => item.column), ["id", "phase_id"]);
    assert.deepEqual(result.queries[0].nestedColumns.map((item) => item.column), ["id", "email"]);
    assert.deepEqual(result.queries[0].filters.map((item) => item.column), ["project_id", "created_at"]);
    assert.deepEqual(result.queries[1].writes.map((item) => item.column), ["tenant_id", "phase_id", "applicant_full_name"]);
    assert.deepEqual(result.queries[2].writes.map((item) => item.column), ["status"]);
    assert.equal(result.unresolved.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scanner exposes dynamic query portions rather than treating them as verified", () => {
  const directory = mkdtempSync(join(tmpdir(), "wamule-schema-query-"));
  try {
    const file = join(directory, "queries.ts");
    writeFileSync(file, `const q = client.from(tableName).select(selectedColumns).eq(columnName, value);`);
    const result = scanSources([file], directory);
    assert.deepEqual(new Set(result.unresolved.map((item) => item.reason)), new Set([
      "dynamic_table_name", "dynamic_select", "dynamic_eq_column",
    ]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scanner ignores non-query Array.from calls and resolves literal selection constants", () => {
  const directory = mkdtempSync(join(tmpdir(), "wamule-schema-query-")).replace(/\\/g, "/");
  try {
    const file = join(directory, "queries.ts");
    writeFileSync(file, `
      const fields = "id, tenant_id";
      const digest = Array.from(bytes);
      const rows = client.from("projects").select(fields).eq("tenant_id", tenantId);
    `);
    const result = scanSources([file], directory);
    assert.equal(result.queries.length, 1);
    assert.equal(result.queries[0].table, "public.projects");
    assert.deepEqual(result.queries[0].columns.map((item) => item.column), ["id", "tenant_id"]);
    assert.deepEqual(result.unresolved, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scanner follows query variables through later project and phase filters", () => {
  const directory = mkdtempSync(join(tmpdir(), "wamule-schema-query-")).replace(/\\/g, "/");
  try {
    const file = join(directory, "queries.ts");
    writeFileSync(file, `
      async function load() {
        let query = client.from("post_sales_tasks").select("*").eq("tenant_id", tenantId);
        query = query.eq("project_id", projectId);
        query = query.eq("phase_id", phaseId);
        return query.order("due_at");
      }
    `);
    const result = scanSources([file], directory);
    assert.equal(result.queries.length, 1);
    assert.deepEqual(result.queries[0].filters.map((item) => item.column), ["tenant_id", "project_id", "phase_id", "due_at"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("RPC argument keys resolve from literal variables and detect computed key mutation", () => {
  const directory = mkdtempSync(join(tmpdir(), "wamule-schema-query-")).replace(/\\/g, "/");
  try {
    const file = join(directory, "queries.ts");
    writeFileSync(file, `
      const fixed = { p_tenant_id: tenantId, p_value: value };
      client.rpc("save_fixed", fixed);
      const dynamic = { p_action: action };
      for (const key of allowed) dynamic[key] = body[key];
      client.rpc("save_dynamic", dynamic);
    `);
    const result = scanSources([file], directory);
    assert.deepEqual(result.remoteFunctions.map((item) => [item.function, item.arguments, item.dynamic_arguments]), [
      ["save_fixed", ["p_tenant_id", "p_value"], false],
      ["save_dynamic", ["p_action"], true],
    ]);
    assert.deepEqual(result.unresolved.map((item) => item.reason), ["dynamic_rpc_arguments"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dynamic RPC contracts require the reviewed identity signature in the catalog", () => {
  const directory = mkdtempSync(join(tmpdir(), "wamule-schema-query-")).replace(/\\/g, "/");
  try {
    const file = join(directory, "queries.ts");
    writeFileSync(file, `client.rpc("save_dynamic", args);`);
    const scan = scanSources([file], directory);
    const contract = applyDynamicContracts(scan, {
      dynamic_rpcs: [{
        id: "save-dynamic-contract",
        file: "queries.ts",
        anchor: `client.rpc("save_dynamic", args)`,
        function: "save_dynamic",
        arguments: ["p_tenant_id"],
        signature: "(p_tenant_id uuid)",
      }],
    }, directory);
    const input = {
      queries: [],
      remoteFunctions: contract.remoteFunctions,
    };
    const matching = compareCatalog(input, {
      columns: new Map(),
      functions: [{ name: "save_dynamic", inputArguments: ["p_tenant_id"], defaults: 0, identityArguments: "p_tenant_id uuid" }],
    });
    assert.deepEqual(matching.mismatches, []);
    assert.equal(matching.rpcSignatures[0].exact_expected_signature_found, true);

    const mismatching = compareCatalog(input, {
      columns: new Map(),
      functions: [{ name: "save_dynamic", inputArguments: ["p_tenant_id"], defaults: 0, identityArguments: "p_tenant_id text" }],
    });
    assert.equal(mismatching.mismatches[0].reason, "rpc_identity_signature_mismatch");
    assert.equal(mismatching.rpcSignatures[0].exact_expected_signature_found, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("catalog comparison reports unresolved relationship tables without throwing", () => {
  const result = compareCatalog({
    queries: [{
      file: "src/example.ts",
      line: 12,
      table: "public.applications",
      columns: [],
      nestedColumns: [{ table: "missing_relation", column: "id" }],
      filters: [],
      writes: [],
    }],
    remoteFunctions: [],
    unresolved: [],
  }, {
    columns: new Map([["public.applications", new Set(["id"])]]),
    functions: [],
  });
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.unresolved, [{
    file: "src/example.ts",
    line: 12,
    table: "public.applications",
    reason: "relationship_table_not_resolved",
    relation: "missing_relation",
  }]);
});

test("all source-level dynamic queries and RPC arguments have anchored contracts", () => {
  const sourceFiles = ["src", "supabase/functions"].flatMap((path) => listSources(join(root, path)));
  const scan = scanSources(sourceFiles, root);
  const contracts = JSON.parse(readFileSync(join(root, "scripts/schema-query-contracts.json"), "utf8"));
  const result = applyDynamicContracts(scan, contracts, root);
  assert.equal(result.contractedFindings, 17);
  assert.equal(result.queries.length, 27);
  assert.equal(result.contractedRpcCalls, 4);
  assert.equal(result.remoteFunctions.filter((rpc) => rpc.contract_id).length, 4);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.contractErrors, []);
  assert.ok(result.remoteFunctions.every((rpc) => !rpc.dynamic_arguments));
});
