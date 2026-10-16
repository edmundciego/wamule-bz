#!/usr/bin/env node
/** Offline integrity and scope validation for the reviewed Hopkins release package. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageDir = resolve(process.argv[2] ?? "artifacts/hopkins-owner-pilot-release-20261016");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function main() {
  const manifest = JSON.parse(readFileSync(resolve(packageDir, "release-manifest.json"), "utf8"));
  if (manifest.staging_source_ref !== "kvocwmrcuhiaezlcgzjf") throw new Error("The package does not identify the confirmed staging source.");
  if (!Array.isArray(manifest.package_files) || manifest.package_files.length === 0) throw new Error("The package file checksum list is missing.");
  for (const file of manifest.package_files) {
    if (file.path.startsWith("/") || file.path.split(/[\\/]/).includes("..")) throw new Error(`Unsafe package path ${file.path}.`);
    const bytes = readFileSync(resolve(packageDir, file.path));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Package file failed checksum validation: ${file.path}.`);
  }
  const manifestHashLine = readFileSync(resolve(packageDir, "release-manifest.sha256"), "utf8").trim();
  const manifestHash = manifestHashLine.split(/\s+/)[0];
  if (manifestHash !== sha256(readFileSync(resolve(packageDir, "release-manifest.json")))) throw new Error("The release-manifest.sha256 receipt is stale.");

  const snapshotBytes = readFileSync(resolve(packageDir, "hopkins-775-outline-snapshot.json"));
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  if (sha256(snapshotBytes) !== manifest.package_snapshot_sha256 || snapshot.features?.length !== 775 || snapshot.feature_count !== 775) {
    throw new Error("The 775-outline snapshot count or checksum failed.");
  }
  if (snapshot.tenant_slug !== "hopkins-grove" || snapshot.project_slug !== "hopkins-grove" || snapshot.phase_slug !== "initial") {
    throw new Error("The map snapshot has an unexpected tenant/project/phase scope.");
  }
  const keys = new Set();
  let reviewed = 0;
  let ambiguous = 0;
  for (const feature of snapshot.features) {
    if (keys.has(feature.feature_key)) throw new Error(`Duplicate stable feature key ${feature.feature_key}.`);
    keys.add(feature.feature_key);
    if (!/^Plot \d{3}$/.test(feature.demo_label)) throw new Error(`Missing separate generated reference for ${feature.feature_key}.`);
    if (feature.source_number_review?.source_read) reviewed++;
    if (feature.source_number_review?.status === "ambiguous-multiple-printed-lots") ambiguous++;
    if (["parcel_id", "parcel_ids", "price", "availability"].some((field) => field in feature)) throw new Error("Snapshot unexpectedly contains sellable inventory fields.");
  }
  if (reviewed !== 80 || ambiguous !== 2) throw new Error(`Expected 80 source-number reads and two ambiguous outlines; found ${reviewed}/${ambiguous}.`);

  const migrationManifest = JSON.parse(readFileSync(resolve(packageDir, "migration-manifest.json"), "utf8"));
  if (migrationManifest.candidate_migration_count !== 25 || migrationManifest.ordered_after_alias_reconciliation.length !== 25) throw new Error("The migration package must include 25 ordered candidate migrations.");
  for (const migration of migrationManifest.ordered_after_alias_reconciliation) {
    const bytes = readFileSync(resolve(process.cwd(), migration.path));
    if (bytes.length !== migration.bytes || sha256(bytes) !== migration.sha256) throw new Error(`Migration file failed checksum validation: ${migration.path}.`);
  }
  const baseline = JSON.parse(readFileSync(resolve(packageDir, "production-baseline.json"), "utf8"));
  if (baseline.captured_read_only !== true || baseline.relation_rowset_fingerprints.table_count !== 40) throw new Error("Production preservation baseline is missing or incomplete.");
  const storage = JSON.parse(readFileSync(resolve(packageDir, "storage-backup-manifest.json"), "utf8"));
  if (storage.target_project_ref !== "mtjlvzrtihslcftxnlso" || storage.object_count !== 0 || storage.total_object_bytes !== 0) throw new Error("Storage empty-object backup does not match the production baseline.");
  const target = JSON.parse(readFileSync(resolve(packageDir, "production-target.json"), "utf8"));
  if (target.supabase_project_ref !== "mtjlvzrtihslcftxnlso" || target.netlify_site_name !== "wamule-bz" || target.production_change_performed !== false) throw new Error("Production target manifest is incorrect or indicates a production change.");

  console.log(JSON.stringify({ valid: true, production_writes_performed: false, package_files_verified: manifest.package_files.length,
    outline_count: snapshot.features.length, reviewed_printed_number_reads: reviewed, ambiguous_outlines: ambiguous,
    candidate_migrations: migrationManifest.candidate_migration_count, production_baseline_groups: baseline.relation_rowset_fingerprints.table_count,
    storage_objects_at_baseline: storage.object_count, outbound_notifications_enabled: false }, null, 2));
}

try { main(); } catch (error) {
  console.error(`[hopkins-package-verify] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
