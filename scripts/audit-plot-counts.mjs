#!/usr/bin/env node
/**
 * Plot-count auditor — answers "how many plats should be mapped?".
 *
 * Compares three sources of truth and fails closed on mismatch:
 *   1. lots.json (detector output: total + per-tier counts)
 *   2. hopkins_lots.svg (shipped vector: <polygon> count + per-tier from <title>)
 *   3. Supabase parcels (live DB, optional: needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *      or --supabase-url/--service-key; skipped offline with a warning)
 *
 * Also checks the detector's expected-range gate from ingest-report.json.
 *
 *   node scripts/audit-plot-counts.mjs --tenant wamule --dir ./out/hopkins-grove
 *
 * Exit codes: 0 all agree, 2 mismatch / gate failure / bad usage.
 * Never writes to the DB (read-only selects).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function usage() {
  return `Usage:
  node scripts/audit-plot-counts.mjs --tenant <slug> --dir <out-dir>
    [--supabase-url <url>] [--service-key <key>] [--svg <name>]`;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) fail(`unexpected argument: ${a}\n${usage()}`);
    const key = a.slice(2);
    if (key === "help" || key === "h") {
      console.log(usage());
      process.exit(0);
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) fail(`missing value for ${a}\n${usage()}`);
    out[key] = val;
    i++;
  }
  return out;
}

function perTier(lots) {
  const counts = {};
  for (const lot of lots) counts[lot.tier_key] = (counts[lot.tier_key] ?? 0) + 1;
  return counts;
}

function auditSvg(svgPath) {
  const svg = readFileSync(svgPath, "utf8");
  const titles = [...svg.matchAll(/<polygon[^>]*><title>([^<]+)<\/title>/g)].map((m) => m[1]);
  const polys = (svg.match(/<polygon/g) ?? []).length;
  const tiers = {};
  for (const t of titles) {
    const tier = t.trim().split(/\s+/).pop();
    tiers[tier] = (tiers[tier] ?? 0) + 1;
  }
  return { polys, titled: titles.length, tiers };
}

async function auditDb(supabaseUrl, serviceKey, tenant) {
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", tenant)
    .eq("is_active", true)
    .maybeSingle();
  if (orgError) fail(`tenant lookup failed: ${orgError.message}`);
  if (!org) fail(`tenant not found or inactive: ${tenant}`);
  const { data: rows, error } = await supabase
    .from("parcels")
    .select("lot_number, tier_key, status, needs_review")
    .eq("tenant_id", org.id);
  if (error) fail(`parcels read failed: ${error.message}`);
  const tiers = {};
  const statuses = {};
  let review = 0;
  let untiered = 0;
  for (const r of rows ?? []) {
    if (r.tier_key) tiers[r.tier_key] = (tiers[r.tier_key] ?? 0) + 1;
    else untiered++;
    statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    if (r.needs_review) review++;
  }
  return { total: (rows ?? []).length, tiers, statuses, review, untiered };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tenant = ((args.tenant || "").trim() || "").toLowerCase();
  if (!tenant) fail(`--tenant is required\n${usage()}`);
  if (!args.dir) fail(`--dir is required\n${usage()}`);
  const dir = resolve(args.dir);

  const lotsPath = join(dir, "lots.json");
  if (!existsSync(lotsPath)) fail(`lots.json not found in ${dir}`);
  const lots = JSON.parse(readFileSync(lotsPath, "utf8"));
  const fileTiers = perTier(lots);

  const svgPath = join(dir, args.svg || "hopkins_lots.svg");
  const svgAudit = existsSync(svgPath) ? auditSvg(svgPath) : null;

  let report = null;
  const reportPath = join(dir, "ingest-report.json");
  if (existsSync(reportPath)) {
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      report = null;
    }
  }
  const expected = report?.gates?.expected_range ?? report?.expected_range ?? null;

  const supabaseUrl =
    args["supabase-url"] || process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = args["service-key"] || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const db = supabaseUrl && serviceKey ? await auditDb(supabaseUrl, serviceKey, tenant) : null;

  const errors = [];
  console.log(`tenant: ${tenant}`);
  console.log(`file:  lots.json = ${lots.length} ${JSON.stringify(fileTiers)}`);
  if (svgAudit) {
    console.log(`svg:   ${svgAudit.polys} polygons (${svgAudit.titled} titled) ${JSON.stringify(svgAudit.tiers)}`);
    if (svgAudit.polys !== lots.length) errors.push(`svg polygons (${svgAudit.polys}) != lots.json (${lots.length})`);
    for (const [k, v] of Object.entries(fileTiers)) {
      if ((svgAudit.tiers[k] ?? 0) !== v) errors.push(`svg tier ${k}: ${svgAudit.tiers[k] ?? 0} != file ${v}`);
    }
  } else {
    console.log(`svg:   (not found at ${svgPath} — skipped)`);
  }
  if (expected) {
    const [lo, hi] = expected;
    console.log(`gate:  expected [${lo},${hi}] → ${lots.length >= lo && lots.length <= hi ? "PASS" : "FAIL"}`);
    if (lots.length < lo || lots.length > hi) errors.push(`file total ${lots.length} outside expected [${lo},${hi}]`);
  }
  if (db) {
    console.log(`db:    parcels = ${db.total} ${JSON.stringify(db.tiers)} statuses=${JSON.stringify(db.statuses)} needs_review=${db.review} untiered_legacy=${db.untiered}`);
    for (const [k, v] of Object.entries(fileTiers)) {
      if ((db.tiers[k] ?? 0) !== v) errors.push(`db tier ${k}: ${db.tiers[k] ?? 0} != file ${v}`);
    }
  } else {
    console.log(`db:    (no credentials — skipped, rerun with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)`);
  }

  if (errors.length) {
    for (const e of errors) console.error(`mismatch: ${e}`);
    process.exit(2);
  }
  console.log(`verdict: all sources agree — ${lots.length} plats should be mapped.`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
