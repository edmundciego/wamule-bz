#!/usr/bin/env node
/** Idempotent, explicitly gated import of the packaged Hopkins public map. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const PRODUCTION_REF = "mtjlvzrtihslcftxnlso";
const DEFAULT_PACKAGE = "artifacts/hopkins-owner-pilot-release-20261016";
const PRODUCTION_ACK = "I understand this writes the Hopkins map to Wamule production";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stableJson = (value) => {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  return value;
};
const jsonEqual = (left, right) => JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right));

function argsFrom(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}.`);
    const key = arg.slice(2);
    if (["dry-run", "apply", "activate", "allow-production", "help"].includes(key)) args[key] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      args[key] = value;
    }
  }
  return args;
}

function validatePackage(packageDir) {
  const manifest = JSON.parse(readFileSync(resolve(packageDir, "release-manifest.json"), "utf8"));
  if (!Array.isArray(manifest.package_files) || manifest.package_files.length < 1) throw new Error("Release manifest has no complete package file checksum list.");
  for (const file of manifest.package_files) {
    if (typeof file.path !== "string" || file.path.startsWith("/") || file.path.split(/[\\/]/).includes("..")) {
      throw new Error("Release manifest contains an unsafe package path.");
    }
    const bytes = readFileSync(resolve(packageDir, file.path));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Package checksum mismatch: ${file.path}.`);
  }
  const snapshotPath = resolve(packageDir, "hopkins-775-outline-snapshot.json");
  const snapshotBytes = readFileSync(snapshotPath);
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  const settings = JSON.parse(readFileSync(resolve(packageDir, "hopkins-public-site-settings.json"), "utf8"));
  const tiersBytes = readFileSync(resolve(packageDir, "source/hopkins-tier-catalogue.json"));
  const tiers = JSON.parse(tiersBytes.toString("utf8"));
  const imageBytes = readFileSync(resolve(packageDir, "assets/hopkins-display-background.webp"));
  if (sha256(snapshotBytes) !== manifest.package_snapshot_sha256) throw new Error("Packaged snapshot checksum does not match release-manifest.json.");
  if (sha256(tiersBytes) !== snapshot.tier_catalogue_sha256) throw new Error("Packaged tier catalogue does not match the snapshot metadata.");
  if (sha256(imageBytes) !== snapshot.source_image_sha256) throw new Error("Packaged background raster does not match the snapshot source hash.");
  if (snapshot.tenant_slug !== "hopkins-grove" || snapshot.project_slug !== "hopkins-grove" || snapshot.phase_slug !== "initial") {
    throw new Error("The package scope is not Hopkins Grove / Initial phase.");
  }
  if (snapshot.feature_count !== 775 || snapshot.features?.length !== 775) throw new Error("The package must contain exactly 775 outlines.");
  if (settings.public_application?.outbound_notifications_enabled !== false
    || settings.public_application?.show_prices_publicly !== false
    || settings.public_application?.show_available_count_publicly !== false) {
    throw new Error("Hopkins public application settings do not meet the outbound/price safety checks.");
  }
  const keys = new Set();
  const tierCounts = {};
  let uniqueNumberReviews = 0;
  let ambiguousNumberReviews = 0;
  for (const feature of snapshot.features) {
    if (keys.has(feature.feature_key)) throw new Error(`Duplicate feature identity ${feature.feature_key}.`);
    keys.add(feature.feature_key);
    if (!/^Plot \d{3}$/.test(feature.demo_label)) throw new Error(`Generated display reference missing for ${feature.feature_key}.`);
    if (!Array.isArray(feature.map_polygon) || feature.map_polygon.length < 3
      || feature.map_polygon.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      throw new Error(`Invalid geometry for ${feature.feature_key}.`);
    }
    const tier = feature.provenance?.source_tier_key ?? null;
    if (tier && !tiers.tiers?.[tier]) throw new Error(`Unknown source tier ${tier} on ${feature.feature_key}.`);
    const tierKey = tier ?? "unassigned-source-fill";
    tierCounts[tierKey] = (tierCounts[tierKey] ?? 0) + 1;
    if (feature.source_number_review?.source_read) uniqueNumberReviews++;
    if (feature.source_number_review?.status === "ambiguous-multiple-printed-lots") ambiguousNumberReviews++;
    if (feature.source_number_review?.status === "source-read-agrees" || feature.source_number_review?.status === "source-read-corrects-ocr") {
      if (!/^\d+$/.test(feature.source_number_review.source_read)) throw new Error(`Invalid reviewed number on ${feature.feature_key}.`);
    }
    if ("parcel_id" in feature || "parcel_ids" in feature || "price" in feature || "availability" in feature) {
      throw new Error(`Feature ${feature.feature_key} contains inventory or pricing data.`);
    }
  }
  if (uniqueNumberReviews !== 80 || ambiguousNumberReviews !== 2) throw new Error("The source-number review counts are not 80 confirmed and two explicitly ambiguous outlines.");
  return { manifest, snapshot, settings, imageBytes, packageDir, tierCounts, uniqueNumberReviews, ambiguousNumberReviews };
}

async function importToProduction(bundle, { activate }) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Apply requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the production secret store.");
  const actualUrl = new URL(url);
  if (actualUrl.hostname !== `${PRODUCTION_REF}.supabase.co`) throw new Error("The configured backend is not the exact Wamule production project.");

  const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: tenants, error: tenantError } = await db.from("organizations").select("id,is_active").eq("slug", "hopkins-grove");
  if (tenantError || tenants?.length !== 1 || !tenants[0].is_active) throw new Error("The active Hopkins tenant is missing or ambiguous; no map writes were attempted.");
  const tenant = tenants[0];
  const { data: projects, error: projectError } = await db.from("projects").select("id,map_experience_mode")
    .eq("tenant_id", tenant.id).eq("slug", "hopkins-grove");
  if (projectError || projects?.length !== 1 || projects[0].map_experience_mode !== "demo") throw new Error("The Hopkins project is missing, ambiguous, or not in demo mode.");
  const project = projects[0];
  const { data: phases, error: phaseError } = await db.from("development_phases").select("id,is_active")
    .eq("tenant_id", tenant.id).eq("project_id", project.id).eq("slug", "initial");
  if (phaseError || phases?.length !== 1 || !phases[0].is_active) throw new Error("The Hopkins Initial phase is missing or ambiguous.");
  const phase = phases[0];

  const { data: settingRows, error: settingsError } = await db.from("project_settings").select("key,value")
    .eq("tenant_id", tenant.id).eq("project_id", project.id).in("key", ["tenant_theme", "company_profile", "public_application"]);
  if (settingsError) throw new Error(`Project settings verification failed: ${settingsError.message}`);
  const currentSettings = Object.fromEntries((settingRows ?? []).map((row) => [row.key, row.value]));
  for (const key of ["tenant_theme", "company_profile", "public_application"]) {
    if (!jsonEqual(currentSettings[key], bundle.settings[key])) throw new Error(`Hopkins ${key} differs from the reviewed package; resolve before map import.`);
  }

  const packageFingerprint = bundle.manifest.package_snapshot_sha256;
  let { data: snapshot, error: snapshotError } = await db.from("map_feature_snapshots").select("id,snapshot_version,outline_count")
    .eq("tenant_id", tenant.id).eq("project_id", project.id).eq("phase_id", phase.id)
    .eq("snapshot_fingerprint", packageFingerprint).maybeSingle();
  if (snapshotError) throw new Error(`Snapshot lookup failed: ${snapshotError.message}`);
  if (!snapshot) {
    const { data: prior, error: priorError } = await db.from("map_feature_snapshots").select("snapshot_version")
      .eq("tenant_id", tenant.id).eq("project_id", project.id).eq("phase_id", phase.id)
      .order("snapshot_version", { ascending: false }).limit(1).maybeSingle();
    if (priorError) throw new Error(`Snapshot version lookup failed: ${priorError.message}`);
    const inserted = await db.from("map_feature_snapshots").insert({
      tenant_id: tenant.id,
      project_id: project.id,
      phase_id: phase.id,
      snapshot_fingerprint: packageFingerprint,
      source_image_sha256: bundle.snapshot.source_image_sha256,
      detection_source_sha256: bundle.snapshot.detection_source_sha256,
      correction_manifest_sha256: bundle.snapshot.correction_manifest_sha256,
      correction_manifest_revision: bundle.snapshot.correction_manifest_revision,
      snapshot_version: Number(prior?.snapshot_version ?? 0) + 1,
      outline_count: 775,
      is_active: false
    }).select("id,snapshot_version,outline_count").single();
    snapshot = inserted.data;
    snapshotError = inserted.error;
  }
  if (snapshotError || !snapshot || Number(snapshot.outline_count) !== 775) throw new Error(`Snapshot creation/verification failed: ${snapshotError?.message ?? "outline count mismatch"}`);

  const { data: existingIdentities, error: identityError } = await db.from("map_feature_identities")
    .select("id,feature_key").eq("tenant_id", tenant.id).eq("project_id", project.id).eq("phase_id", phase.id).range(0, 999);
  if (identityError) throw new Error(`Identity lookup failed: ${identityError.message}`);
  const identityByKey = new Map((existingIdentities ?? []).map((row) => [row.feature_key, row.id]));
  const missing = bundle.snapshot.features.filter((feature) => !identityByKey.has(feature.feature_key));
  for (let offset = 0; offset < missing.length; offset += 100) {
    const batch = missing.slice(offset, offset + 100).map((feature) => ({
      tenant_id: tenant.id, project_id: project.id, phase_id: phase.id, feature_key: feature.feature_key
    }));
    const result = await db.from("map_feature_identities").upsert(batch, { onConflict: "tenant_id,project_id,phase_id,feature_key" });
    if (result.error) throw new Error(`Identity upsert failed: ${result.error.message}`);
  }
  const { data: refreshed, error: refreshError } = await db.from("map_feature_identities")
    .select("id,feature_key").eq("tenant_id", tenant.id).eq("project_id", project.id).eq("phase_id", phase.id).range(0, 999);
  if (refreshError || refreshed?.length !== 775) throw new Error(`Stable identity verification failed: ${refreshError?.message ?? `found ${refreshed?.length ?? 0}`}`);
  for (const row of refreshed) identityByKey.set(row.feature_key, row.id);

  for (let offset = 0; offset < 775; offset += 100) {
    const batch = bundle.snapshot.features.slice(offset, offset + 100).map((feature) => ({
      tenant_id: tenant.id,
      project_id: project.id,
      phase_id: phase.id,
      snapshot_id: snapshot.id,
      identity_id: identityByKey.get(feature.feature_key),
      demo_label: feature.demo_label,
      feature_kind: feature.feature_kind,
      parent_feature_key: feature.parent_feature_key,
      source_detection_id: feature.source_detection_id,
      map_polygon: feature.map_polygon,
      provenance: { ...feature.provenance, tier_catalogue_sha256: bundle.snapshot.tier_catalogue_sha256, source_number_review: feature.source_number_review },
      is_active: true,
      public_visible: true
    }));
    if (batch.some((row) => !row.identity_id)) throw new Error("A stable identity is missing; map rows were not written.");
    const result = await db.from("map_features").upsert(batch, { onConflict: "snapshot_id,identity_id" });
    if (result.error) throw new Error(`Map feature upsert failed: ${result.error.message}`);
  }

  const imageSha = bundle.snapshot.source_image_sha256;
  const objectPath = `${tenant.id}/${project.id}/${phase.id}/maps/hopkins-${imageSha.slice(0, 16)}.webp`;
  const upload = await db.storage.from("project-map-public").upload(objectPath, bundle.imageBytes, { contentType: "image/webp", upsert: true });
  if (upload.error) throw new Error(`Public display raster upload failed: ${upload.error.message}`);
  const imageUrl = db.storage.from("project-map-public").getPublicUrl(objectPath).data.publicUrl;
  let { data: version, error: versionError } = await db.from("masterplan_versions").select("id")
    .eq("tenant_id", tenant.id).eq("project_id", project.id).eq("phase_id", phase.id).eq("image_url", imageUrl).maybeSingle();
  if (versionError) throw new Error(`Display version lookup failed: ${versionError.message}`);
  if (!version) {
    const inserted = await db.from("masterplan_versions").insert({
      tenant_id: tenant.id, project_id: project.id, phase_id: phase.id,
      image_url: imageUrl, file_name: `hopkins-${imageSha.slice(0, 16)}.webp`, is_active: false
    }).select("id").single();
    version = inserted.data;
    versionError = inserted.error;
  }
  if (versionError || !version) throw new Error(`Display map version write failed: ${versionError?.message ?? "no row returned"}`);
  if (activate) {
    const activation = await db.rpc("activate_project_demo_map_snapshot", { p_snapshot_id: snapshot.id, p_masterplan_version_id: version.id });
    if (activation.error) throw new Error(`Atomic map activation failed: ${activation.error.message}`);
  }
  return { snapshotVersion: snapshot.snapshot_version, imported: 775, stableIdentities: 775, imageObject: objectPath, activated: activate };
}

async function main() {
  const args = argsFrom(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node scripts/import-hopkins-production-snapshot.mjs --dry-run --expected-project-ref ${PRODUCTION_REF}\n` +
      `Apply requires --apply --allow-production --expected-project-ref ${PRODUCTION_REF} --ack-production-text "${PRODUCTION_ACK}"; --activate is separately required to publish.`);
    return;
  }
  if (Boolean(args["dry-run"]) === Boolean(args.apply)) throw new Error("Specify exactly one of --dry-run or --apply.");
  if (args["expected-project-ref"] !== PRODUCTION_REF) throw new Error(`--expected-project-ref must equal ${PRODUCTION_REF}.`);
  if (args.activate && !args.apply) throw new Error("--activate is only valid with --apply.");
  if (args.apply && (!args["allow-production"] || args["ack-production-text"] !== PRODUCTION_ACK)) {
    throw new Error("Production apply requires --allow-production and the exact --ack-production-text phrase.");
  }
  const bundle = validatePackage(resolve(args.package ?? DEFAULT_PACKAGE));
  if (args["dry-run"]) {
    console.log(JSON.stringify({ dry_run: true, writes_performed: false, project_ref: PRODUCTION_REF,
      package_snapshot_sha256: bundle.manifest.package_snapshot_sha256, outline_count: 775,
      source_number_review: { unique_printed_number_reads: bundle.uniqueNumberReviews, ambiguous_multiple_lot_outlines: bundle.ambiguousNumberReviews },
      tier_counts: bundle.tierCounts, activation_requested: false }, null, 2));
    return;
  }
  const result = await importToProduction(bundle, { activate: Boolean(args.activate) });
  console.log(JSON.stringify({ project_ref: PRODUCTION_REF, ...result }, null, 2));
}

main().catch((error) => {
  console.error(`[hopkins-production-import] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
