#!/usr/bin/env node
/**
 * Per-tenant interactive lot map pipeline — Stage 3 publisher.
 *
 *   npm run map:publish -- --tenant hopkins-grove --dir ./out/hopkins-grove --dry-run
 *   npm run map:publish -- --tenant hopkins-grove --dir ./out/hopkins-grove --apply
 *
 * Maps lots.json onto the existing public.parcels model:
 *   lot_number  -> lot_number   (unique per tenant: uniq_parcels_tenant_lot)
 *   price       -> base_price   (get-public-lots exposes effective `price`)
 *   polygon_pct -> map_polygon  (0-100% space, same contract as useParcelMap)
 *   tier_key / geometry_source / confidence / needs_review /
 *     masterplan_version_id -> same-named parcel columns (Step 3 migration).
 *   New rows are stamped with the tenant's active masterplan version so the
 *   public embed's version scoping shows them immediately; legacy rows with
 *   NULL stay visible via the NULL-tolerant filter.
 *
 * Pre-migration fallback: if the parcel extensions are not deployed yet
 * (tier_key probe fails), publish degrades to the legacy payload
 * (lot_number/base_price/map_polygon) instead of erroring.
 *
 * Safety:
 *   --dry-run performs zero writes. Without Supabase credentials it validates
 *     offline (schema + plan summary from files only).
 *   --apply requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or flags),
 *     refuses when ingest-report.json lists gate errors, never deletes stale
 *     rows, and never overwrites status/dimensions on existing parcels
 *     (new rows are inserted as Available).
 *
 * Exit codes: 0 ok, 2 validation / gate / usage failure.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function usage() {
  return `Usage:
  node scripts/publish-lots.mjs --tenant <slug> --dir <out-dir> (--dry-run | --apply)
    [--supabase-url <url>] [--service-key <key>] [--batch-size 100]

  Shorthand: --development <slug> resolves tenant + dir from
    map-input/developments.json (explicit flags win, except a conflicting
    --tenant is refused). E.g.:
    node scripts/publish-lots.mjs --development hopkins-grove --dry-run

  Credentials default to SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}\n${usage()}`);
    const key = a.slice(2);
    if (key === "dry-run" || key === "apply" || key === "help" || key === "h") {
      out[key] = true;
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) throw new Error(`missing value for ${a}\n${usage()}`);
    out[key] = val;
    i++;
  }
  return out;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

/** Fill --tenant/--dir from map-input/developments.json via --development. */
function applyDevelopment(args) {
  if (!args.development) return args;
  const regPath = resolve("map-input/developments.json");
  if (!existsSync(regPath)) fail(`--development needs ${regPath} (run from the repo root)`);
  const reg = JSON.parse(readFileSync(regPath, "utf8"));
  const dev = reg.developments?.[args.development];
  if (!dev) fail(`unknown development ${JSON.stringify(args.development)} — see map-input/developments.json`);
  if (args.tenant && args.tenant.trim().toLowerCase() !== dev.tenant) {
    fail(`--tenant ${JSON.stringify(args.tenant)} conflicts with registry tenant ${JSON.stringify(dev.tenant)} for development ${JSON.stringify(args.development)}`);
  }
  return { ...args, tenant: dev.tenant, dir: args.dir || `out/${args.development}` };
}

function validateLots(lots, expectedMin = 1, expectedMax = 100000) {
  const errors = [];
  if (!Array.isArray(lots) || lots.length === 0) return ["lots.json is empty or not an array"];
  const seen = new Set();
  for (const lot of lots) {
    if (!lot || typeof lot !== "object") {
      errors.push("lot entry is not an object");
      continue;
    }
    if (typeof lot.lot_number !== "string" || !lot.lot_number) errors.push("lot with missing lot_number");
    else if (seen.has(lot.lot_number)) errors.push(`duplicate lot_number ${lot.lot_number}`);
    else seen.add(lot.lot_number);
    const pts = lot.polygon_pct;
    const okGeom =
      Array.isArray(pts) && pts.length >= 3 && pts.length <= 200 &&
      pts.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100);
    if (!okGeom) errors.push(`lot ${lot.lot_number ?? "?"}: invalid polygon_pct`);
    if (typeof lot.price !== "number" || !Number.isFinite(lot.price) || lot.price <= 0) {
      errors.push(`lot ${lot.lot_number ?? "?"}: invalid price`);
    }
  }
  if (lots.length < expectedMin || lots.length > expectedMax) {
    errors.push(`lot count ${lots.length} outside [${expectedMin},${expectedMax}]`);
  }
  return errors;
}

function samePolygon(a, b) {
  const sa = JSON.stringify(a ?? []);
  const sb = JSON.stringify(b ?? []);
  return sa === sb;
}

function diffLots(fileLots, dbRows) {
  const dbByLot = new Map((dbRows ?? []).map((r) => [r.lot_number, r]));
  const creates = [];
  const updates = [];
  const unchanged = [];
  for (const lot of fileLots) {
    const existing = dbByLot.get(lot.lot_number);
    if (!existing) {
      creates.push(lot);
      continue;
    }
    const priceChanged = Number(existing.base_price ?? 0) !== Number(lot.price);
    const polyChanged = !samePolygon(existing.map_polygon, lot.polygon_pct);
    const tierChanged = (existing.tier_key ?? null) !== (lot.tier_key ?? null);
    const reviewChanged = (existing.needs_review ?? false) !== Boolean(lot.needs_review);
    const confidenceChanged =
      existing.confidence != null && lot.confidence != null
        ? Number(existing.confidence) !== Number(lot.confidence)
        : existing.confidence != null !== (lot.confidence != null);
    if (priceChanged || polyChanged || tierChanged || reviewChanged || confidenceChanged) {
      updates.push({ lot, existing, priceChanged, polyChanged, tierChanged, reviewChanged, confidenceChanged });
    } else unchanged.push(lot);
  }
  const fileSet = new Set(fileLots.map((l) => l.lot_number));
  const stale = (dbRows ?? []).filter((r) => !fileSet.has(r.lot_number));
  return { creates, updates, unchanged, stale };
}

function ingestPayload(lot, activeVersionId) {
  return {
    tier_key: lot.tier_key ?? null,
    geometry_source: lot.source ?? "raster-auto",
    confidence: lot.confidence ?? null,
    needs_review: Boolean(lot.needs_review),
    masterplan_version_id: activeVersionId,
  };
}

function printPlan({ tenant, dir, lots, report, diff }) {
  const counts = {};
  for (const lot of lots) counts[lot.tier_key] = (counts[lot.tier_key] ?? 0) + 1;
  const needsReview = lots.filter((l) => l.needs_review).length;
  console.log(`tenant:  ${tenant}`);
  console.log(`dir:     ${dir}`);
  console.log(`file:    ${lots.length} lots (${needsReview} needs_review), tiers ${JSON.stringify(counts)}`);
  if (report?.background) {
    console.log(`bg:      ${report.background.width}x${report.background.height}, ${report.background.megabytes}MB`);
  }
  if (!diff) {
    console.log(`plan:    (offline — no Supabase credentials, DB diff skipped)`);
    console.log(`action:  would upsert ${lots.length} lots on --apply with credentials`);
    return;
  }
  console.log(`plan:    ${diff.creates.length} create, ${diff.updates.length} update, ${diff.unchanged.length} unchanged, ${diff.stale.length} stale (kept, never deleted)`);
  if (diff.updates.length) {
    console.log(`updates: ${diff.updates.slice(0, 10).map((u) => u.lot.lot_number).join(", ")}${diff.updates.length > 10 ? ` … +${diff.updates.length - 10} more` : ""}`);
  }
  if (diff.stale.length) {
    console.log(`stale:   ${diff.stale.slice(0, 10).map((r) => r.lot_number).join(", ")}${diff.stale.length > 10 ? ` … +${diff.stale.length - 10} more` : ""} (left untouched)`);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    fail(e.message);
  }
  args = applyDevelopment(args);
  if (args.help || args.h) {
    console.log(usage());
    return;
  }
  const tenant = ((args.tenant || "").trim() || "").toLowerCase();
  if (!tenant) fail(`--tenant is required\n${usage()}`);
  if (!args.dir) fail(`--dir is required\n${usage()}`);
  if ((args["dry-run"] ? 1 : 0) + (args.apply ? 1 : 0) !== 1) {
    fail(`exactly one of --dry-run or --apply is required\n${usage()}`);
  }
  const dryRun = Boolean(args["dry-run"]);
  const dir = resolve(args.dir);
  const batchSize = args["batch-size"] ? Number(args["batch-size"]) : 100;
  if (!Number.isFinite(batchSize) || batchSize <= 0) fail("--batch-size must be a positive number");

  const lotsPath = join(dir, "lots.json");
  if (!existsSync(lotsPath)) fail(`lots.json not found in ${dir} — run map:build first`);
  const lots = JSON.parse(readFileSync(lotsPath, "utf8"));
  let report = null;
  const reportPath = join(dir, "ingest-report.json");
  if (existsSync(reportPath)) {
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      report = null;
    }
  }
  if (report && Array.isArray(report.errors) && report.errors.length) {
    fail(`ingest-report.json lists gate errors — fix before publishing: ${report.errors.join("; ")}`);
  }
  const schemaErrors = validateLots(lots);
  if (schemaErrors.length) {
    for (const e of schemaErrors.slice(0, 10)) console.error(`error: ${e}`);
    if (schemaErrors.length > 10) console.error(`error: … +${schemaErrors.length - 10} more`);
    process.exit(2);
  }

  const supabaseUrl = args["supabase-url"] || process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = args["service-key"] || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    if (!dryRun) fail("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required for --apply (or pass --supabase-url/--service-key)");
    console.log("[publish] no Supabase credentials — offline validation mode (zero writes, DB diff skipped)");
    printPlan({ tenant, dir, lots, report, diff: null });
    return;
  }

  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("id, slug, is_active")
    .eq("slug", tenant)
    .eq("is_active", true)
    .maybeSingle();
  if (orgError) fail(`tenant lookup failed: ${orgError.message}`);
  if (!org) fail(`tenant not found or inactive: ${tenant}`);

  // Step 3 columns may predate deployment: probe once, degrade gracefully.
  let step3 = true;
  {
    const { error: probeError } = await supabase
      .from("parcels")
      .select("tier_key")
      .eq("tenant_id", org.id)
      .limit(0);
    if (probeError) {
      console.warn(`[publish] parcel extensions not deployed (${probeError.message}) — legacy payload mode`);
      step3 = false;
    }
  }

  const { data: existing, error: parcelsError } = await supabase
    .from("parcels")
    .select(
      step3
        ? "id, lot_number, status, base_price, map_polygon, tier_key, needs_review, confidence"
        : "id, lot_number, status, base_price, map_polygon",
    )
    .eq("tenant_id", org.id)
    .order("lot_number");
  if (parcelsError) fail(`parcels read failed: ${parcelsError.message}`);

  // Active map version for stamping ingested rows (null when none/unknown).
  let activeVersionId = null;
  if (step3) {
    const { data: version, error: versionError } = await supabase
      .from("masterplan_versions")
      .select("id")
      .eq("tenant_id", org.id)
      .eq("is_active", true)
      .maybeSingle();
    if (versionError) {
      console.warn(`[publish] active version lookup failed (${versionError.message}) — stamping NULL`);
    } else if (version) {
      activeVersionId = version.id;
    }
  }

  const diff = diffLots(lots, existing ?? []);

  if (dryRun) {
    console.log("[publish] dry-run — zero writes performed");
    printPlan({ tenant, dir, lots, report, diff });
    return;
  }

  // --apply: inserts for new lots (Available), price+geometry+ingest-field updates.
  // Status/dimensions on existing rows are never touched.
  let created = 0;
  let updated = 0;
  for (let i = 0; i < diff.creates.length; i += batchSize) {
    const batch = diff.creates.slice(i, i + batchSize).map((lot) => ({
      tenant_id: org.id,
      lot_number: lot.lot_number,
      status: "Available",
      base_price: lot.price,
      map_polygon: lot.polygon_pct,
      ...(step3 ? ingestPayload(lot, activeVersionId) : {}),
    }));
    const { error } = await supabase.from("parcels").insert(batch);
    if (error) fail(`insert batch failed (${i}/${diff.creates.length}): ${error.message}`);
    created += batch.length;
  }
  for (let i = 0; i < diff.updates.length; i += batchSize) {
    const batch = diff.updates.slice(i, i + batchSize);
    for (const { lot, existing: row } of batch) {
      const { error } = await supabase
        .from("parcels")
        .update({
          base_price: lot.price,
          map_polygon: lot.polygon_pct,
          ...(step3 ? ingestPayload(lot, activeVersionId) : {}),
        })
        .eq("id", row.id)
        .eq("tenant_id", org.id);
      if (error) fail(`update of lot ${lot.lot_number} failed: ${error.message}`);
      updated++;
    }
  }

  const publishReport = {
    tenant,
    tenant_id: org.id,
    dir,
    at: new Date().toISOString(),
    file_lots: lots.length,
    created,
    updated,
    unchanged: diff.unchanged.length,
    stale_kept: diff.stale.map((r) => r.lot_number),
    needs_review: lots.filter((l) => l.needs_review).length,
    masterplan_version_id: activeVersionId,
    note: "status/dimensions on existing rows untouched; stale rows kept.",
  };
  writeFileSync(join(dir, "publish-report.json"), JSON.stringify(publishReport, null, 2) + "\n", "utf8");

  console.log("[publish] applied — publish-report.json written");
  printPlan({ tenant, dir, lots, report, diff });
  console.log(`result:  ${created} created, ${updated} updated`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
