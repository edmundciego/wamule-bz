#!/usr/bin/env node
/** Read-only check of literal Supabase query contracts against a Postgres catalog. */
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative, extname } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const QUERY_METHODS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "contains", "containedBy", "overlaps", "match", "not", "order", "textSearch"]);
const MUTATION_METHODS = new Set(["insert", "update", "upsert"]);
const QUERY_OPERATIONS = new Set(["select", "insert", "update", "upsert", "delete"]);
const QUERY_TERMINATORS = new Set(["single", "maybeSingle", "limit", "throwOnError"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const QUERY_CONTRACT_PATH = resolve(ROOT, "scripts/schema-query-contracts.json");

function literalString(node, constants = new Map()) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return constants.get(node.text) ?? null;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return literalString(node.expression, constants);
  }
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;
    for (const span of node.templateSpans) {
      const substitution = literalString(span.expression, constants);
      if (substitution === null) return null;
      result += substitution + span.literal.text;
    }
    return result;
  }
  return null;
}

function stringConstants(source) {
  const constants = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = node.initializer;
      if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
        constants.set(node.name.text, initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return constants;
}

function methodCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  return { name: node.expression.name.text, args: node.arguments, expression: node.expression.expression };
}

function chainRoot(node) {
  let current = node;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    if (current.expression.name.text === "from") return current;
    current = current.expression.expression;
  }
  return null;
}

function collectChain(node) {
  const calls = [];
  let current = node;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    calls.push(current);
    current = current.expression.expression;
  }
  return calls.reverse();
}

function topChain(fromCall) {
  let current = fromCall;
  while (current.parent && ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current
    && current.parent.parent && ts.isCallExpression(current.parent.parent)) {
    current = current.parent.parent;
  }
  return current;
}

function rootIdentifier(node) {
  let current = node;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) current = current.expression.expression;
  return ts.isIdentifier(current) ? current.text : null;
}

function functionScopeStart(node, source) {
  let current = node;
  while (current && current !== source) {
    if (ts.isFunctionLike(current)) return current.getStart(source);
    current = current.parent;
  }
  return 0;
}

function splitTopLevel(value) {
  const result = [];
  let depth = 0;
  let quote = null;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) result.push(last);
  return result;
}

function parseSelection(value, table, query, unresolved, nested = false) {
  for (const tokenRaw of splitTopLevel(value)) {
    if (!tokenRaw || tokenRaw === "*") continue;
    const token = tokenRaw.trim();
    const open = token.indexOf("(");
    if (open >= 0 && token.endsWith(")")) {
      const relationHead = token.slice(0, open).trim();
      const [alias, rawRelation] = relationHead.includes(":") ? relationHead.split(":", 2) : [null, relationHead];
      const relation = rawRelation.split("!")[0].trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(relation)) {
        unresolved.push({ ...query, reason: "computed_or_unresolved_relation", selection: tokenRaw });
        continue;
      }
      query.relations.push({ table, relation, alias, columns: splitTopLevel(token.slice(open + 1, -1)).map((part) => part.trim()).filter(Boolean) });
      parseSelection(token.slice(open + 1, -1), relation, query, unresolved, true);
      continue;
    }
    const field = token.includes(":") ? token.split(":", 2)[1].trim() : token;
    const normalized = field.split("!")[0].replace(/^\"|\"$/g, "");
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
      (nested ? query.nestedColumns : query.columns).push({ table, column: normalized });
    } else if (normalized !== "*") {
      unresolved.push({ ...query, reason: "computed_or_unresolved_selection", selection: tokenRaw });
    }
  }
}

function literalObjectKeys(node) {
  if (!ts.isObjectLiteralExpression(node)) return null;
  const keys = [];
  let hasSpread = false;
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      hasSpread = true;
      continue;
    }
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      const name = property.name;
      if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) keys.push(name.text);
      else hasSpread = true;
    } else hasSpread = true;
  }
  return { keys, hasSpread };
}

function simpleRpcArgumentKeys(node, source, beforePosition) {
  const direct = literalObjectKeys(node);
  if (direct) return direct;
  if (!node || !ts.isIdentifier(node)) return null;
  let declaration = null;
  function find(nodeToVisit) {
    if (ts.isVariableDeclaration(nodeToVisit) && ts.isIdentifier(nodeToVisit.name)
      && nodeToVisit.name.text === node.text && nodeToVisit.initializer
      && nodeToVisit.getStart(source) < beforePosition
      && (!declaration || nodeToVisit.getStart(source) > declaration.getStart(source))) {
      declaration = nodeToVisit;
    }
    ts.forEachChild(nodeToVisit, find);
  }
  find(source);
  if (!declaration || !declaration.initializer) return null;
  const resolved = literalObjectKeys(declaration.initializer);
  if (!resolved) return null;
  let dynamicMutation = false;
  function inspect(nodeToVisit) {
    if (nodeToVisit.getStart(source) < beforePosition && ts.isBinaryExpression(nodeToVisit)
      && nodeToVisit.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isElementAccessExpression(nodeToVisit.left)
      && ts.isIdentifier(nodeToVisit.left.expression)
      && nodeToVisit.left.expression.text === node.text
      && nodeToVisit.left.argumentExpression
      && !ts.isStringLiteral(nodeToVisit.left.argumentExpression)
      && !ts.isNoSubstitutionTemplateLiteral(nodeToVisit.left.argumentExpression)) {
      dynamicMutation = true;
    }
    ts.forEachChild(nodeToVisit, inspect);
  }
  inspect(source);
  return { ...resolved, hasSpread: resolved.hasSpread || dynamicMutation };
}

function listSources(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", ".netlify", "coverage"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSources(path));
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

export function scanSources(files, root = ROOT) {
  const queries = [];
  const unresolved = [];
  const remoteFunctions = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const constants = stringConstants(source);
    const queryVariables = [];
    function applyOperations(chain, query) {
      for (const part of chain.slice(1)) {
        const method = methodCall(part);
        if (!method) continue;
        if (method.name === "select") {
          const selection = literalString(method.args[0], constants);
          if (selection == null) unresolved.push({ ...query, reason: "dynamic_select" });
          else parseSelection(selection, query.table?.split(".").at(-1) ?? "<dynamic>", query, unresolved);
        } else if (QUERY_METHODS.has(method.name)) {
          const field = literalString(method.args[0], constants);
          if (field == null) unresolved.push({ ...query, reason: `dynamic_${method.name}_column` });
          else query.filters.push({ table: query.table, column: field });
        } else if (MUTATION_METHODS.has(method.name)) {
          const payload = method.args[0];
          const objects = ts.isArrayLiteralExpression(payload) ? payload.elements : [payload];
          let anyDynamic = false;
          for (const object of objects) {
            const keys = object && literalObjectKeys(object);
            if (!keys) { anyDynamic = true; continue; }
            if (keys.hasSpread) anyDynamic = true;
            for (const column of keys.keys) query.writes.push({ table: query.table, column });
          }
          if (anyDynamic) unresolved.push({ ...query, reason: `dynamic_${method.name}_payload` });
        }
      }
    }
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const call = methodCall(node);
        if (call?.name === "from") {
          const outer = topChain(node);
          const chain = collectChain(outer);
          // `.from()` is also a common JavaScript collection, crypto and
          // browser API method. Treat it as a database query only when the
          // returned builder is used for a Supabase table operation.
          if (!chain.slice(1).some((part) => QUERY_OPERATIONS.has(methodCall(part)?.name))) {
            ts.forEachChild(node, visit);
            return;
          }
          const from = methodCall(node);
          const tableLiteral = literalString(from.args[0], constants);
          const location = source.getLineAndCharacterOfPosition(node.getStart(source));
          const query = {
            file: relative(root, file).split("\\").join("/"), line: location.line + 1,
            table: tableLiteral?.includes(".") ? tableLiteral : tableLiteral ? `public.${tableLiteral}` : null,
            columns: [], nestedColumns: [], relations: [], filters: [], writes: [],
          };
          if (!tableLiteral) unresolved.push({ ...query, reason: "dynamic_table_name" });
          applyOperations(chain, query);
          queries.push(query);
          let expression = outer;
          while ((ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) && expression.parent) expression = expression.parent;
          const declaration = expression.parent && ts.isVariableDeclaration(expression.parent) ? expression.parent : null;
          if (declaration && ts.isIdentifier(declaration.name)) {
            queryVariables.push({
              name: declaration.name.text,
              scope: functionScopeStart(declaration, source),
              start: declaration.getStart(source),
              query,
            });
          }
        } else if (call && node === topChain(node) && !chainRoot(node)
          && (QUERY_OPERATIONS.has(call.name) || QUERY_METHODS.has(call.name) || QUERY_TERMINATORS.has(call.name))) {
          // Track filters added in a later statement, e.g. `query = query.eq(...)`.
          // Without this second pass those project/phase columns are invisible
          // to schema-vs-query checks.
          const outer = topChain(node);
          const chain = collectChain(outer);
          const hasQueryOperation = chain.some((part) => QUERY_OPERATIONS.has(methodCall(part)?.name)
            || QUERY_METHODS.has(methodCall(part)?.name) || QUERY_TERMINATORS.has(methodCall(part)?.name));
          const variableName = rootIdentifier(outer);
          if (hasQueryOperation && variableName) {
            const scope = functionScopeStart(node, source);
            const declaration = [...queryVariables].reverse().find((entry) => entry.name === variableName
              && entry.scope === scope && entry.start < node.getStart(source));
            if (declaration) applyOperations([null, ...chain], declaration.query);
          }
        } else if (call?.name === "rpc") {
          const fn = literalString(call.args[0], constants);
          const location = source.getLineAndCharacterOfPosition(node.getStart(source));
          const argNode = call.args[1];
          const argInfo = argNode ? simpleRpcArgumentKeys(argNode, source, node.getStart(source)) : { keys: [], hasSpread: false };
          const rpc = {
            file: relative(root, file).split("\\").join("/"), line: location.line + 1,
            function: fn ?? null, dynamic: fn == null,
            arguments: argInfo?.keys ?? [], dynamic_arguments: Boolean(argNode && (!argInfo || argInfo.hasSpread)),
          };
          remoteFunctions.push(rpc);
          if (fn == null) unresolved.push({ file: relative(root, file).split("\\").join("/"), line: location.line + 1, reason: "dynamic_rpc_name" });
          if (rpc.dynamic_arguments) unresolved.push({ ...rpc, reason: "dynamic_rpc_arguments" });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { queries, unresolved, remoteFunctions };
}

function lineForAnchor(content, anchor, occurrence = 1, expectedOccurrences = 1) {
  const positions = [];
  let start = 0;
  while (true) {
    const index = content.indexOf(anchor, start);
    if (index < 0) break;
    positions.push(index);
    start = index + anchor.length;
  }
  if (positions.length !== expectedOccurrences || occurrence < 1 || occurrence > positions.length) return null;
  return content.slice(0, positions[occurrence - 1]).split("\n").length;
}

export function applyDynamicContracts(scan, document, root = ROOT) {
  const unresolved = [...scan.unresolved];
  const queries = [];
  const remoteFunctions = scan.remoteFunctions.map((rpc) => ({ ...rpc }));
  const contractErrors = [];
  const usedAnchors = new Set();
  const files = new Map();
  const loadFile = (relativePath) => {
    if (!files.has(relativePath)) files.set(relativePath, readFileSync(resolve(root, relativePath), "utf8"));
    return files.get(relativePath);
  };

  for (const entry of document.dynamic_queries ?? []) {
    const content = loadFile(entry.file);
    const line = lineForAnchor(content, entry.anchor, entry.occurrence ?? 1, entry.expected_occurrences ?? 1);
    const anchorKey = `${entry.file}:${entry.anchor}`;
    usedAnchors.add(anchorKey);
    if (line === null) {
      contractErrors.push({ id: entry.id, reason: "missing_or_ambiguous_source_anchor" });
      continue;
    }
    const expectedReasons = new Set(entry.reasons);
    const matches = unresolved.filter((item) => item.file === entry.file && item.line === line && expectedReasons.has(item.reason));
    if (matches.length !== expectedReasons.size || [...expectedReasons].some((reason) => !matches.some((item) => item.reason === reason))) {
      contractErrors.push({ id: entry.id, reason: "source_finding_set_changed", expected: [...expectedReasons], actual: matches.map((item) => item.reason) });
      continue;
    }
    for (const item of matches) unresolved.splice(unresolved.indexOf(item), 1);
    for (const table of entry.tables ?? []) {
      const tableName = table.name.includes(".") ? table.name : `public.${table.name}`;
      queries.push({
        file: entry.file, line, table: tableName,
        columns: [...new Set([...(table.select ?? []), ...(table.required ?? [])])]
          .filter((column) => column !== "*" && !column.includes("."))
          .map((column) => ({ table: tableName.split(".").at(-1), column })),
        nestedColumns: (table.related ?? []).flatMap((relation) => (relation.columns ?? []).map((column) => ({ table: relation.table, column }))),
        relations: table.related ?? [],
        filters: (table.filters ?? []).map((column) => ({ table: tableName, column })),
        writes: (table.writes ?? []).map((column) => ({ table: tableName, column })),
        contract_id: entry.id,
      });
    }
  }

  for (const entry of document.dynamic_rpcs ?? []) {
    const content = loadFile(entry.file);
    const line = lineForAnchor(content, entry.anchor, entry.occurrence ?? 1, entry.expected_occurrences ?? 1);
    const anchorKey = `${entry.file}:${entry.anchor}`;
    usedAnchors.add(anchorKey);
    if (line === null) {
      contractErrors.push({ id: entry.id, reason: "missing_or_ambiguous_source_anchor" });
      continue;
    }
    const matches = unresolved.filter((item) => item.file === entry.file && item.line === line && item.reason === "dynamic_rpc_arguments");
    const rpcIndex = remoteFunctions.findIndex((rpc) => rpc.file === entry.file && rpc.line === line && rpc.function === entry.function);
    if (rpcIndex < 0) {
      contractErrors.push({ id: entry.id, reason: "rpc_call_not_found" });
      continue;
    }
    const rpc = remoteFunctions[rpcIndex];
    const declared = new Set(entry.arguments);
    if (!rpc.dynamic_arguments && (rpc.arguments.length !== declared.size || rpc.arguments.some((name) => !declared.has(name)))) {
      contractErrors.push({ id: entry.id, reason: "declared_rpc_arguments_differ_from_source", source: rpc.arguments, declared: [...declared] });
      continue;
    }
    if (rpc.dynamic_arguments && matches.length !== 1) {
      contractErrors.push({ id: entry.id, reason: "dynamic_rpc_finding_not_found" });
      continue;
    }
    for (const item of matches) unresolved.splice(unresolved.indexOf(item), 1);
    remoteFunctions[rpcIndex] = {
      ...rpc,
      arguments: [...declared].sort(),
      dynamic_arguments: false,
      expected_signature: entry.signature ?? null,
      contract_id: entry.id,
    };
  }

  const expectedAnchorKeys = new Set([
    ...(document.dynamic_queries ?? []).map((entry) => `${entry.file}:${entry.anchor}`),
    ...(document.dynamic_rpcs ?? []).map((entry) => `${entry.file}:${entry.anchor}`),
  ]);
  for (const anchor of expectedAnchorKeys) if (!usedAnchors.has(anchor)) contractErrors.push({ anchor, reason: "unused_contract_anchor" });
  return {
    unresolved,
    queries,
    remoteFunctions,
    contractErrors,
    contractedFindings: (document.dynamic_queries ?? []).reduce((sum, entry) => sum + new Set(entry.reasons).size, 0),
    contractedRpcCalls: (document.dynamic_rpcs ?? []).length,
  };
}

function loadDynamicContracts() {
  return JSON.parse(readFileSync(QUERY_CONTRACT_PATH, "utf8"));
}

function catalogWithPsql(connectionString, { targetProject = null } = {}) {
  const url = new URL(connectionString);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (targetProject && targetProject !== "kvocwmrcuhiaezlcgzjf") throw new Error("Target catalog checks are restricted to the authorized staging project ref.");
  if (targetProject && !new RegExp(`(^|\\.)${targetProject.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(\\.|$)`).test(url.hostname)) {
    throw new Error("Target catalog host does not identify the authorized staging project.");
  }
  if (!targetProject && !local) throw new Error("Local schema replay accepts only localhost database connections.");
  const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")), PGSSLMODE: targetProject ? "require" : "prefer" };
  const psql = (sql) => {
    const result = spawnSync("psql", ["-X", "-q", "-t", "-A", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", env, maxBuffer: 30 * 1024 * 1024 });
    if (result.error) throw new Error("psql is unavailable for catalog inspection.");
    if (result.status !== 0) throw new Error(`Read-only catalog query failed: ${result.stderr.trim().slice(0, 500)}`);
    return result.stdout.trim();
  };
  const roleSql = "BEGIN READ ONLY; SELECT current_database(), current_user, current_setting('transaction_read_only'), r.rolsuper, has_schema_privilege(current_user, 'public', 'CREATE') FROM pg_catalog.pg_roles r WHERE r.rolname=current_user; COMMIT;";
  const roleFields = psql(roleSql).split("\t");
  if (roleFields.length !== 5 || roleFields[2] !== "on") throw new Error("Catalog session did not prove transaction_read_only=on.");
  if (targetProject && (roleFields[3] !== "f" || roleFields[4] !== "f")) throw new Error("Target catalog credential must be non-superuser and lack public-schema CREATE privilege.");
  const columnsSql = "BEGIN READ ONLY; SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_schema IN ('public','auth','storage') ORDER BY table_schema, table_name, ordinal_position; COMMIT;";
  const columns = new Map();
  for (const line of psql(columnsSql).split(/\r?\n/).filter(Boolean)) {
    const [schema, table, column] = line.split("\t");
    if (schema && table && column) {
      const key = `${schema}.${table}`;
      if (!columns.has(key)) columns.set(key, new Set());
      columns.get(key).add(column);
    }
  }
  const functionsSql = `BEGIN READ ONLY; SELECT p.proname, COALESCE(p.proargnames::text, '{}'), COALESCE(p.proargmodes::text, '{}'), p.pronargdefaults, pg_get_function_identity_arguments(p.oid) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid); COMMIT;`;
  const functions = psql(functionsSql).split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, rawNames, rawModes, defaults, identityArguments] = line.split("\t");
    const parseArray = (value) => value && value.startsWith("{") && value.endsWith("}")
      ? value.slice(1, -1).split(",").filter(Boolean).map((item) => item.replace(/^\"|\"$/g, ""))
      : [];
    const names = parseArray(rawNames);
    const modes = parseArray(rawModes);
    const inputs = modes.length ? names.filter((_, index) => ["i", "b", "v"].includes(modes[index])) : names;
    return { name, inputArguments: inputs, defaults: Number(defaults ?? 0), identityArguments };
  });
  return {
    columns, functions,
    role: { database: roleFields[0], name: roleFields[1], transaction_read_only: roleFields[2], superuser: roleFields[3] === "t", public_schema_create: roleFields[4] === "t" },
    host: url.hostname,
  };
}

export function compareCatalog(contract, catalog) {
  const mismatches = [];
  const unresolved = [...(contract.unresolved ?? [])];
  for (const query of contract.queries) {
    if (!query.table) continue;
    const tableColumns = catalog.columns.get(query.table);
    if (!tableColumns) {
      mismatches.push({ file: query.file, line: query.line, table: query.table, reason: "table_missing_from_catalog" });
      continue;
    }
    for (const reference of [...query.columns.map((entry) => ({ ...entry, kind: "select" })), ...query.nestedColumns.map((entry) => ({ ...entry, kind: "related_select" })), ...query.filters.map((entry) => ({ ...entry, kind: "filter" })), ...query.writes.map((entry) => ({ ...entry, kind: "write" }))]) {
      const querySchema = query.table.includes(".") ? query.table.slice(0, query.table.lastIndexOf(".")) : "public";
      const relationName = reference.table.includes(".") ? reference.table : `${querySchema}.${reference.table}`;
      const relationColumns = catalog.columns.get(relationName) ?? (relationName === query.table ? tableColumns : null);
      if (!relationColumns) {
        unresolved.push({ file: query.file, line: query.line, table: query.table, reason: "relationship_table_not_resolved", relation: relationName });
      } else if (!relationColumns.has(reference.column)) {
        mismatches.push({ file: query.file, line: query.line, table: relationName, column: reference.column, access: reference.kind, reason: "column_missing_from_catalog" });
      }
    }
  }
  const rpcSignatures = [];
  for (const rpc of contract.remoteFunctions) {
    if (!rpc.function || rpc.dynamic_arguments) continue;
    const supplied = new Set(rpc.arguments);
    const candidates = catalog.functions.filter((fn) => {
      if (fn.name !== rpc.function) return false;
      const names = fn.inputArguments;
      const required = names.slice(0, Math.max(0, names.length - fn.defaults));
      return rpc.arguments.every((name) => names.includes(name)) && required.every((name) => supplied.has(name));
    });
    const normalizeSignature = (signature) => String(signature ?? "").trim().replace(/^\(/, "").replace(/\)$/, "").replace(/\s+/g, " ");
    const expectedSignature = rpc.expected_signature ? normalizeSignature(rpc.expected_signature) : null;
    const exactCandidates = expectedSignature
      ? candidates.filter((fn) => normalizeSignature(fn.identityArguments) === expectedSignature)
      : candidates;
    rpcSignatures.push({
      file: rpc.file, line: rpc.line, function: rpc.function,
      supplied_arguments: rpc.arguments,
      matching_signatures: candidates.map((fn) => fn.identityArguments),
      expected_signature: rpc.expected_signature ?? null,
      exact_expected_signature_found: expectedSignature ? exactCandidates.length > 0 : null,
    });
    if (candidates.length === 0) {
      mismatches.push({ file: rpc.file, line: rpc.line, function: rpc.function, supplied_arguments: rpc.arguments, reason: "rpc_signature_missing_or_arguments_mismatch" });
    } else if (expectedSignature && exactCandidates.length === 0) {
      mismatches.push({ file: rpc.file, line: rpc.line, function: rpc.function, supplied_arguments: rpc.arguments, expected_signature: rpc.expected_signature, matching_signatures: candidates.map((fn) => fn.identityArguments), reason: "rpc_identity_signature_mismatch" });
    } else if (candidates.length > 1) {
      mismatches.push({ file: rpc.file, line: rpc.line, function: rpc.function, supplied_arguments: rpc.arguments, matching_signatures: candidates.map((fn) => fn.identityArguments), reason: "rpc_overload_ambiguous_from_source_arguments" });
    }
  }
  return { mismatches, rpcSignatures, unresolved };
}

function main() {
  const args = process.argv.slice(2);
  const sourceOnly = args.includes("--source-only");
  const targetIndex = args.indexOf("--target-project");
  const targetProject = targetIndex >= 0 ? args[targetIndex + 1] : null;
  const roots = [resolve(ROOT, "src"), resolve(ROOT, "supabase/functions")];
  const sources = roots.flatMap((path) => listSources(path));
  const contract = scanSources(sources, ROOT);
  const dynamic = applyDynamicContracts(contract, loadDynamicContracts(), ROOT);
  if (sourceOnly) {
    process.stdout.write(`${JSON.stringify({ mode: "source-only", source_files: sources.length, query_chains: contract.queries.length, contracted_dynamic_query_findings: dynamic.contractedFindings, expanded_dynamic_query_table_contracts: dynamic.queries.length, contracted_dynamic_rpc_calls: dynamic.contractedRpcCalls, rpc_calls: dynamic.remoteFunctions.length, remote_functions: dynamic.remoteFunctions, dynamic_or_unresolved: dynamic.unresolved.length, unresolved_examples: dynamic.unresolved, contract_errors: dynamic.contractErrors }, null, 2)}\n`);
    process.exitCode = dynamic.unresolved.length || dynamic.contractErrors.length ? 1 : 0;
    return;
  }
  const connectionString = process.env.SCHEMA_QUERY_DATABASE_URL;
  if (!connectionString) throw new Error("Set SCHEMA_QUERY_DATABASE_URL to the local replay URL or the dedicated staging read-only URL.");
  const catalog = catalogWithPsql(connectionString, { targetProject });
  const catalogContract = {
    queries: [...contract.queries, ...dynamic.queries],
    remoteFunctions: dynamic.remoteFunctions,
  };
  const compared = compareCatalog(catalogContract, catalog);
  const mismatches = compared.mismatches;
  for (const error of dynamic.contractErrors) mismatches.push({ ...error, reason: "query_contract_declaration_invalid" });
  const report = {
    mode: targetProject ? "hosted-staging-read-only" : "local-replayed-schema",
    target_project: targetProject ?? "local",
    postgres_database: catalog.role.database,
    query_chains: catalogContract.queries.length,
    contracted_dynamic_query_findings: dynamic.contractedFindings,
    expanded_dynamic_query_table_contracts: dynamic.queries.length,
    contracted_dynamic_rpc_calls: dynamic.contractedRpcCalls,
    rpc_calls: catalogContract.remoteFunctions.length,
    mismatch_count: mismatches.length,
    rpc_signature_count: compared.rpcSignatures.length,
    rpc_signatures: compared.rpcSignatures,
    dynamic_or_unresolved_count: compared.unresolved.length,
    dynamic_or_unresolved: compared.unresolved,
    mismatches,
    rpc_signatures: compared.rpcSignatures,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (mismatches.length || dynamic.unresolved.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try { main(); } catch (error) {
    process.stderr.write(`[schema-query-contract] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
