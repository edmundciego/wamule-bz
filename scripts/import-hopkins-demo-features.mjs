#!/usr/bin/env node
/**
 * Versioned idempotent import of Hopkins demo geometry to map_features.
 * No parcels, official lot numbers, prices, sale statuses, or source OCR are
 * written. By default this only validates locally; --apply needs an explicit
 * exact backend ref, and activation is a separate opt-in flag.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildHopkinsFeatureSnapshot } from "./lib/hopkins-feature-snapshot.mjs";

const PROD_PROJECT_REF = "mtjlvzrtihslcftxnlso";
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (["dry-run", "apply", "activate-demo", "help"].includes(key)) out[key] = true;
    else { const value = argv[++i]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`); out[key] = value; }
  }
  return out;
}
function projectRefFromUrl(value) {
  const url = new URL(value);
  if (["localhost", "127.0.0.1"].includes(url.hostname)) return "local";
  const match = url.hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
  if (!match) throw new Error("SUPABASE_URL must be a Supabase project URL; custom hosts require reviewed target identification.");
  return match[1];
}
function requiredString(object, key, label) {
  const value = object?.[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${label}.`);
  return value.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/import-hopkins-demo-features.mjs [--manifest path] [--lots path] [--image path] [--dry-run|--apply] [--expected-project-ref ref] [--activate-demo]");
    return;
  }
  if (Boolean(args["dry-run"]) === Boolean(args.apply)) throw new Error("Specify exactly one of --dry-run or --apply.");
  const manifestPath = resolve(args.manifest ?? "artifacts/hopkins-five-plot-approval-20261014/local-corrections.approved.json");
  const lotsPath = resolve(args.lots ?? "out/hopkins-ocr/lots.json");
  const imagePath = resolve(args.image ?? "out/hopkins-ocr/masterplan_background.webp");
  const built = await buildHopkinsFeatureSnapshot({ manifestPath, lotsPath, imagePath });
  if (args["activate-demo"] && !args.apply) throw new Error("--activate-demo is only valid with --apply.");
  console.log(`[hopkins:features] ${args.apply ? "APPLY" : "DRY RUN"}: ${built.features.length} geometry-only features`);
  console.log(`[hopkins:features] manifest revision ${built.manifest.revision}; parent splits ${built.manifest.approved_splits.length}; source and correction fingerprints verified.`);
  const tierCounts = Object.fromEntries(Object.keys(built.tierCatalogue.tiers ?? {}).map((key) => [key, 0]));
  let sourcePrintCandidates = 0;
  for (const feature of built.features) {
    const key = feature.provenance.source_tier_key;
    if (!(key in tierCounts)) throw new Error(`The feature has an unknown Hopkins source tier: ${key}`);
    tierCounts[key]++;
    if (feature.provenance.source_printed_lot_number_candidate) sourcePrintCandidates++;
  }
  console.log(`[hopkins:features] source tier crosswalk ${JSON.stringify(tierCounts)}; ${sourcePrintCandidates} non-split OCR candidates remain marked for human review.`);
  console.log(`[hopkins:features] stable snapshot fingerprint ${built.snapshotFingerprint}; generated Plot labels remain separate from printed lot-number candidates.`);
  if (!args.apply) {
    console.log("[hopkins:features] validation only; no database, storage, inventory, or local source files changed.");
    return;
  }
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("--apply requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in environment variables.");
  const actualRef = projectRefFromUrl(url);
  if (actualRef === PROD_PROJECT_REF) throw new Error("Production Wamule is blocked by this local Hopkins demo importer.");
  if (!args["expected-project-ref"] || args["expected-project-ref"] !== actualRef) throw new Error("--apply requires --expected-project-ref to exactly match the configured backend.");

  const config = JSON.parse(readFileSync(resolve("map-input/hosted-pilot/hopkins-grove.json"), "utf8"));
  const tenantSlug = requiredString(config.tenant, "slug", "tenant slug");
  const projectSlug = requiredString(config.project, "slug", "project slug");
  const phaseSlug = requiredString(config.phase, "slug", "phase slug");
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: tenant, error: tenantError } = await db.from("organizations").select("id,is_active").eq("slug", tenantSlug).maybeSingle();
  if (tenantError || !tenant?.is_active) throw new Error("The active Hopkins tenant is missing; run and review the tenant onboarding step first.");
  const { data: project, error: projectError } = await db.from("projects").select("id,map_experience_mode").eq("tenant_id", tenant.id).eq("slug", projectSlug).maybeSingle();
  if (projectError || !project || project.map_experience_mode !== "demo") throw new Error("The exact Hopkins project is missing or not in demo mode; no import was made.");
  const { data: phase, error: phaseError } = await db.from("development_phases").select("id").eq("tenant_id", tenant.id).eq("project_id", project.id).eq("slug", phaseSlug).eq("is_active", true).maybeSingle();
  if (phaseError || !phase) throw new Error("The active Hopkins phase was not found; no import was made.");

  let snapshot = await db.from("map_feature_snapshots").select("id,snapshot_version,outline_count")
    .eq("tenant_id", tenant.id).eq("project_id", project.id).eq("phase_id", phase.id)
    .eq("snapshot_fingerprint", built.snapshotFingerprint).maybeSingle();
  if (snapshot.error) throw new Error(`Snapshot lookup failed: ${snapshot.error.message}`);
  if (!snapshot.data) {
    const previous = await db.from("map_feature_snapshots").select("snapshot_version")
      .eq("tenant_id", tenant.id).eq("project_id", project.id).eq("phase_id", phase.id)
      .order("snapshot_version", { ascending: false }).limit(1).maybeSingle();
    if (previous.error) throw new Error(`Snapshot version lookup failed: ${previous.error.message}`);
    const snapshotVersion = Number(previous.data?.snapshot_version ?? 0) + 1;
    snapshot = await db.from("map_feature_snapshots").insert({
      tenant_id: tenant.id, project_id: project.id, phase_id: phase.id,
      snapshot_fingerprint: built.snapshotFingerprint, source_image_sha256: built.imageSha,
      detection_source_sha256: built.detectionSha, correction_manifest_sha256: built.manifestSha,
      correction_manifest_revision: built.manifest.revision, snapshot_version: snapshotVersion,
      outline_count: built.features.length, is_active: false,
    }).select("id,snapshot_version,outline_count").single();
    if (snapshot.error) throw new Error(`Snapshot creation failed: ${snapshot.error.message}`);
  }
  if (Number(snapshot.data.outline_count) !== built.features.length) throw new Error("Existing snapshot fingerprint has a conflicting outline count.");
  const snapshotId = snapshot.data.id;

  const existingIdentity = await db.from("map_feature_identities").select("id,feature_key")
    .eq("tenant_id", tenant.id).eq("project_id", project.id).eq("phase_id", phase.id);
  if (existingIdentity.error) throw new Error(`Stable identity lookup failed: ${existingIdentity.error.message}`);
  const identityByKey = new Map((existingIdentity.data ?? []).map((item) => [item.feature_key, item.id]));
  const missingIdentity = built.features.filter((feature) => !identityByKey.has(feature.feature_key));
  for (let offset = 0; offset < missingIdentity.length; offset += 100) {
    const batch = missingIdentity.slice(offset, offset + 100).map(({ feature_key }) => ({ tenant_id: tenant.id, project_id: project.id, phase_id: phase.id, feature_key }));
    const inserted = await db.from("map_feature_identities").upsert(batch, { onConflict: "tenant_id,project_id,phase_id,feature_key" });
    if (inserted.error) throw new Error(`Stable identity import failed: ${inserted.error.message}`);
  }
  const allIdentities = missingIdentity.length
    ? await db.from("map_feature_identities").select("id,feature_key").eq("tenant_id", tenant.id).eq("project_id", project.id).eq("phase_id", phase.id)
    : existingIdentity;
  if (allIdentities.error) throw new Error(`Stable identity refresh failed: ${allIdentities.error.message}`);
  for (const row of allIdentities.data ?? []) identityByKey.set(row.feature_key, row.id);

  for (let offset = 0; offset < built.features.length; offset += 100) {
    const batch = built.features.slice(offset, offset + 100).map((feature) => ({
      tenant_id: tenant.id, project_id: project.id, phase_id: phase.id, snapshot_id: snapshotId,
      identity_id: identityByKey.get(feature.feature_key), demo_label: feature.demo_label,
      feature_kind: feature.feature_kind, parent_feature_key: feature.parent_feature_key,
      source_detection_id: feature.source_detection_id, map_polygon: feature.map_polygon,
      provenance: feature.provenance, is_active: true, public_visible: true,
    }));
    if (batch.some((row) => !row.identity_id)) throw new Error("A stable feature identity is missing.");
    const saved = await db.from("map_features").upsert(batch, { onConflict: "snapshot_id,identity_id" });
    if (saved.error) throw new Error(`Geometry snapshot import failed: ${saved.error.message}`);
  }

  const objectPath = `${tenant.id}/${project.id}/${phase.id}/maps/hopkins-${built.imageSha.slice(0, 16)}.webp`;
  const uploaded = await db.storage.from("project-map-public").upload(objectPath, built.imageBytes, { contentType: "image/webp", upsert: true });
  if (uploaded.error) throw new Error(`Display image upload failed: ${uploaded.error.message}`);
  const imageUrl = db.storage.from("project-map-public").getPublicUrl(objectPath).data.publicUrl;
  let version = await db.from("masterplan_versions").select("id")
    .eq("tenant_id", tenant.id).eq("project_id", project.id).eq("phase_id", phase.id).eq("image_url", imageUrl).maybeSingle();
  if (version.error) throw new Error(`Map version lookup failed: ${version.error.message}`);
  if (!version.data) {
    version = await db.from("masterplan_versions").insert({
      tenant_id: tenant.id, project_id: project.id, phase_id: phase.id,
      image_url: imageUrl, file_name: `hopkins-${built.imageSha.slice(0, 16)}.webp`, is_active: false,
    }).select("id").single();
    if (version.error) throw new Error(`Inactive map version creation failed: ${version.error.message}`);
  }
  if (args["activate-demo"]) {
    const activated = await db.rpc("activate_project_demo_map_snapshot", {
      p_snapshot_id: snapshotId, p_masterplan_version_id: version.data.id,
    });
    if (activated.error) throw new Error(`Atomic demo activation failed: ${activated.error.message}`);
  }
  console.log(`[hopkins:features] snapshot saved (${args["activate-demo"] ? "activated as demo" : "inactive; prior map remains active"}); source PDF, crops, OCR, prices, inventory status, and canonical identities were not uploaded or modified.`);
}

main().catch((error) => {
  console.error(`[hopkins:features] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
