#!/usr/bin/env node
/** Export the reviewed Hopkins public map package from staging. Read-only. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const STAGING_REF = "kvocwmrcuhiaezlcgzjf";
const OUTPUT = resolve("artifacts/hopkins-owner-pilot-release-20261016");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(value); value = ""; }
    else if (char === "\n") { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += char;
  }
  if (value.length || row.length) { row.push(value.replace(/\r$/, "")); rows.push(row); }
  if (quoted) throw new Error("The Hopkins crosswalk CSV has an unterminated quoted field.");
  const [headers, ...records] = rows;
  return records.filter((record) => record.some(Boolean)).map((record) => Object.fromEntries(headers.map((key, i) => [key, record[i] ?? ""])));
}

function outlineNumbers(value) {
  return [...value.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function postgresJsonbText(value) {
  if (Array.isArray(value)) return `[${value.map(postgresJsonbText).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}: ${postgresJsonbText(value[key])}`).join(", ")}}`;
  }
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function requireOne(data, error, description) {
  if (error) throw new Error(`${description} lookup failed: ${error.message}`);
  if (!data) throw new Error(`${description} was not found.`);
  return data;
}

function packageFileHashes(directory, relative = "") {
  const current = resolve(directory, relative);
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return packageFileHashes(directory, rel);
    if (!entry.isFile() || rel === "release-manifest.json" || rel === "release-manifest.sha256") return [];
    const bytes = readFileSync(resolve(directory, rel));
    return [{ path: rel, bytes: bytes.length, sha256: sha256(bytes) }];
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function sourceOrPackaged(primary, packagedRelative) {
  const preferred = resolve(primary);
  if (existsSync(preferred)) return preferred;
  const packaged = resolve(OUTPUT, packagedRelative);
  if (existsSync(packaged)) return packaged;
  throw new Error(`Required source file is missing: ${primary} (and package fallback ${packagedRelative}).`);
}

function copyToPackage(source, destination) {
  const target = resolve(OUTPUT, destination);
  if (resolve(source) !== target) copyFileSync(source, target);
}

async function main() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the staging environment.");
  const parsedUrl = new URL(url);
  if (parsedUrl.hostname !== `${STAGING_REF}.supabase.co`) throw new Error("This export only reads the confirmed staging project; production and other hosts are blocked.");

  const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: tenantData, error: tenantError } = await supabase.from("organizations")
    .select("id,slug,name,is_active").eq("slug", "hopkins-grove").maybeSingle();
  const tenant = requireOne(tenantData, tenantError, "Hopkins tenant");
  if (!tenant.is_active) throw new Error("Hopkins staging tenant is inactive.");
  const { data: projectData, error: projectError } = await supabase.from("projects").select("id,tenant_id,slug,name,map_experience_mode").eq("tenant_id", tenant.id).eq("slug", "hopkins-grove").maybeSingle();
  const project = requireOne(projectData, projectError, "Hopkins project");
  const { data: phaseData, error: phaseError } = await supabase.from("development_phases").select("id,tenant_id,project_id,slug,name,is_active").eq("tenant_id", tenant.id).eq("project_id", project.id).eq("slug", "initial").eq("is_active", true).maybeSingle();
  const phase = requireOne(phaseData, phaseError, "Active Hopkins phase");

  const { data: activeRows, error: snapshotError } = await supabase.from("map_feature_snapshots")
    .select("id,snapshot_version,snapshot_fingerprint,outline_count,source_image_sha256,detection_source_sha256,correction_manifest_sha256,correction_manifest_revision")
    .eq("tenant_id", tenant.id).eq("project_id", project.id).eq("phase_id", phase.id).eq("is_active", true);
  if (snapshotError) throw new Error(`Active map snapshot lookup failed: ${snapshotError.message}`);
  if (activeRows?.length !== 1) throw new Error(`Expected exactly one active Hopkins snapshot; found ${activeRows?.length ?? 0}.`);
  const snapshot = activeRows[0];
  if (Number(snapshot.outline_count) !== 775) throw new Error(`Expected 775 approved outlines; staging records ${snapshot.outline_count}.`);

  const { data: identityRows, error: identityError } = await supabase.from("map_feature_identities")
    .select("id,feature_key").eq("tenant_id", tenant.id).eq("project_id", project.id).eq("phase_id", phase.id).range(0, 999);
  if (identityError) throw new Error(`Map identity lookup failed: ${identityError.message}`);
  const featureKeyById = new Map((identityRows ?? []).map((item) => [item.id, item.feature_key]));
  if (featureKeyById.size !== 775) throw new Error(`Expected 775 stable feature identities; found ${featureKeyById.size}.`);

  const activeFeatures = [];
  for (let offset = 0; offset < 775; offset += 100) {
    const { data, error } = await supabase.from("map_features")
      .select("identity_id,demo_label,feature_kind,parent_feature_key,source_detection_id,map_polygon,provenance,is_active,public_visible")
      .eq("snapshot_id", snapshot.id).eq("is_active", true).eq("public_visible", true)
      .order("identity_id", { ascending: true }).range(offset, Math.min(offset + 99, 774));
    if (error) throw new Error(`Map geometry page ${offset / 100 + 1} failed: ${error.message}`);
    activeFeatures.push(...(data ?? []));
  }
  if (activeFeatures.length !== 775) throw new Error(`Expected 775 active public outlines; found ${activeFeatures.length}.`);

  const tierPath = resolve("map-input/hopkins.tiers.json");
  const tierBytes = readFileSync(tierPath);
  const tierCatalogue = JSON.parse(tierBytes.toString("utf8"));
  const tierHash = sha256(tierBytes);
  const crosswalkPath = sourceOrPackaged("artifacts/hopkins-source-accuracy-20261016/number-crosswalk.csv", "source/number-crosswalk.csv");
  const crosswalkBytes = readFileSync(crosswalkPath);
  const crosswalk = parseCsv(crosswalkBytes.toString("utf8"));
  if (crosswalk.length !== 82) throw new Error(`Expected 82 visually reviewed number candidates; found ${crosswalk.length}.`);

  const reviewsByFeatureKey = new Map();
  for (const review of crosswalk) {
    const featureKey = featureKeyById.get(review.map_feature_ref);
    if (!featureKey) throw new Error(`Reviewed map reference ${review.review_id} does not resolve to a stable feature key.`);
    if (reviewsByFeatureKey.has(featureKey)) throw new Error(`Duplicate printed-number review for ${featureKey}.`);
    if (review.status !== "source-read-agrees" && review.status !== "source-read-corrects-ocr" && review.status !== "ambiguous-multiple-printed-lots") {
      throw new Error(`Unsupported printed-number review status on ${review.review_id}.`);
    }
    reviewsByFeatureKey.set(featureKey, {
      review_id: review.review_id,
      generated_reference: review.generated_reference,
      ocr_candidate: review.ocr_candidate || null,
      source_read: review.source_read || null,
      source_numbers_in_outline: outlineNumbers(review.source_numbers_in_outline || ""),
      status: review.status,
      evidence: "visual comparison against the 2026 Hopkins Map source raster; not legal lot identity or sales approval"
    });
  }

  const features = activeFeatures.map((row) => {
    const featureKey = featureKeyById.get(row.identity_id);
    if (!featureKey) throw new Error("A public map feature has no stable identity.");
    const polygon = row.map_polygon;
    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      throw new Error(`Feature ${featureKey} has an invalid outline.`);
    }
    if (!/^Plot \d{3}$/.test(row.demo_label)) throw new Error(`Feature ${featureKey} does not use a separate generated Plot reference.`);
    const provenance = { ...(row.provenance ?? {}), tier_catalogue_sha256: tierHash };
    const tierKey = provenance.source_tier_key;
    if (tierKey && !tierCatalogue.tiers?.[tierKey]) throw new Error(`Feature ${featureKey} has an unknown source tier ${tierKey}.`);
    return {
      feature_key: featureKey,
      demo_label: row.demo_label,
      feature_kind: row.feature_kind,
      parent_feature_key: row.parent_feature_key,
      source_detection_id: row.source_detection_id,
      map_polygon: polygon,
      provenance,
      source_number_review: reviewsByFeatureKey.get(featureKey) ?? null
    };
  }).sort((a, b) => a.feature_key.localeCompare(b.feature_key));
  if (new Set(features.map((item) => item.feature_key)).size !== 775) throw new Error("Feature keys are not unique.");
  if (reviewsByFeatureKey.size !== 82) throw new Error("Number review crosswalk was not fully matched to features.");
  const uniqueNumbers = features.filter((feature) => feature.source_number_review?.source_read).length;
  const ambiguousNumbers = features.filter((feature) => feature.source_number_review?.status === "ambiguous-multiple-printed-lots").length;
  if (uniqueNumbers !== 80 || ambiguousNumbers !== 2) throw new Error(`Expected 80 unique source reads and two ambiguous outlines; found ${uniqueNumbers} and ${ambiguousNumbers}.`);

  const settingsKeys = ["tenant_theme", "company_profile", "public_application"];
  const { data: settingsRows, error: settingsError } = await supabase.from("project_settings")
    .select("key,value").eq("tenant_id", tenant.id).eq("project_id", project.id).in("key", settingsKeys);
  if (settingsError) throw new Error(`Hopkins public settings lookup failed: ${settingsError.message}`);
  const publicSettings = Object.fromEntries((settingsRows ?? []).map((row) => [row.key, row.value]));
  if (settingsKeys.some((key) => !publicSettings[key])) throw new Error("A required Hopkins public setting is missing.");
  if (publicSettings.public_application.outbound_notifications_enabled !== false) throw new Error("The package source must have outbound messages disabled.");

  const sourceImagePath = sourceOrPackaged("out/hopkins-ocr/masterplan_background.webp", "assets/hopkins-display-background.webp");
  const imageBytes = readFileSync(sourceImagePath);
  const imageHash = sha256(imageBytes);
  if (imageHash !== snapshot.source_image_sha256) throw new Error("The local display raster does not match the active staging snapshot source hash.");
  const detectionPath = sourceOrPackaged("out/hopkins-ocr/lots.json", "source/hopkins-source-detections.json");
  const detectionBytes = readFileSync(detectionPath);
  if (sha256(detectionBytes) !== snapshot.detection_source_sha256) throw new Error("Local detection source does not match the active staging snapshot.");
  const manifestPath = sourceOrPackaged("artifacts/hopkins-five-plot-approval-20261014/local-corrections.approved.json", "source/hopkins-approved-correction-manifest.json");
  const manifestBytes = readFileSync(manifestPath);
  if (sha256(manifestBytes) !== snapshot.correction_manifest_sha256) throw new Error("The local approved correction manifest does not match the active staging snapshot.");

  const snapshotContent = {
    format_version: 1,
    tenant_slug: "hopkins-grove",
    project_slug: "hopkins-grove",
    phase_slug: "initial",
    source_snapshot_version: snapshot.snapshot_version,
    source_snapshot_fingerprint: snapshot.snapshot_fingerprint,
    source_image_sha256: snapshot.source_image_sha256,
    detection_source_sha256: snapshot.detection_source_sha256,
    correction_manifest_sha256: snapshot.correction_manifest_sha256,
    correction_manifest_revision: snapshot.correction_manifest_revision,
    tier_catalogue_sha256: tierHash,
    feature_count: features.length,
    geometry_md5: createHash("md5").update(features.map((feature) => `${feature.feature_key}:${postgresJsonbText(feature.map_polygon)}`).join("\n")).digest("hex"),
    features
  };
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshotContent, null, 2)}\n`);
  const packageSnapshotSha256 = sha256(snapshotBytes);

  const sourceFiles = [
    ["source/number-crosswalk.csv", crosswalkPath],
    ["source/hopkins-source-comparison.md", sourceOrPackaged("docs/Hopkins_Source_Comparison.md", "source/hopkins-source-comparison.md")],
    ["source/hopkins-source-review.md", sourceOrPackaged("artifacts/hopkins-source-accuracy-20261016/README.md", "source/hopkins-source-review.md")],
    ["source/hopkins-tier-catalogue.json", tierPath],
    ["source/hopkins-project-config.json", resolve("map-input/hosted-pilot/hopkins-grove.json")],
    ["source/hopkins-approved-correction-manifest.json", manifestPath],
    ["source/hopkins-source-detections.json", detectionPath]
  ];
  mkdirSync(resolve(OUTPUT, "source"), { recursive: true });
  mkdirSync(resolve(OUTPUT, "assets"), { recursive: true });
  for (const [destination, source] of sourceFiles) {
    if (destination === "source/number-crosswalk.csv") {
      const normalized = readFileSync(source, "utf8").replace(/\r\n/g, "\n");
      writeFileSync(resolve(OUTPUT, destination), normalized);
    } else copyToPackage(source, destination);
  }
  copyToPackage(sourceImagePath, "assets/hopkins-display-background.webp");
  writeFileSync(resolve(OUTPUT, "hopkins-775-outline-snapshot.json"), snapshotBytes);
  writeFileSync(resolve(OUTPUT, "hopkins-public-site-settings.json"), `${JSON.stringify(publicSettings, null, 2)}\n`);
  writeFileSync(resolve(OUTPUT, "production-target.json"), `${JSON.stringify({
    supabase_project_ref: "mtjlvzrtihslcftxnlso",
    netlify_site_name: "wamule-bz",
    netlify_site_id: "d4091452-ceb8-40a6-9d3d-4068e91a0d09",
    existing_primary_domain: "wamuledevelopment.com",
    planned_hopkins_domain: "hopkinsgrove.ceiba.bz",
    production_change_performed: false
  }, null, 2)}\n`);

  const files = [...sourceFiles.map(([path]) => {
    const bytes = readFileSync(resolve(OUTPUT, path));
    return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }),
    { path: "assets/hopkins-display-background.webp", bytes: imageBytes.length, sha256: imageHash },
    { path: "hopkins-775-outline-snapshot.json", bytes: snapshotBytes.length, sha256: packageSnapshotSha256 },
    { path: "hopkins-public-site-settings.json", bytes: Buffer.byteLength(JSON.stringify(publicSettings, null, 2) + "\n"), sha256: sha256(Buffer.from(JSON.stringify(publicSettings, null, 2) + "\n")) }];
  const tierCounts = {};
  for (const feature of features) tierCounts[feature.provenance.source_tier_key ?? "unassigned-source-fill"] = (tierCounts[feature.provenance.source_tier_key ?? "unassigned-source-fill"] ?? 0) + 1;
  const manifest = {
    generated_at: new Date().toISOString(),
    staging_source_ref: STAGING_REF,
    source_snapshot_version: snapshot.snapshot_version,
    source_snapshot_fingerprint: snapshot.snapshot_fingerprint,
    package_snapshot_sha256: packageSnapshotSha256,
    source_image_sha256: imageHash,
    detection_source_sha256: sha256(detectionBytes),
    correction_manifest_sha256: sha256(manifestBytes),
    tier_catalogue_sha256: tierHash,
    outline_count: features.length,
    source_number_review: { reviewed_candidates: crosswalk.length, unique_source_reads: uniqueNumbers, ambiguous_multiple_lot_outlines: ambiguousNumbers },
    tier_counts: tierCounts,
    imported_tables: ["map_feature_identities", "map_feature_snapshots", "map_features", "masterplan_versions", "Storage/project-map-public"],
    excluded_staging_data: ["applications", "leads", "lead_activities", "follow_up_tasks", "email_notifications", "Auth users"],
    files,
    package_files: packageFileHashes(OUTPUT)
  };
  const releaseManifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(resolve(OUTPUT, "release-manifest.json"), releaseManifestBytes);
  writeFileSync(resolve(OUTPUT, "release-manifest.sha256"), `${sha256(releaseManifestBytes)}  release-manifest.json\n`);
  console.log(JSON.stringify({
    database_read_only: true,
    staging_ref: STAGING_REF,
    outline_count: features.length,
    source_snapshot_version: snapshot.snapshot_version,
    source_snapshot_fingerprint: snapshot.snapshot_fingerprint,
    package_snapshot_sha256: packageSnapshotSha256,
    unique_source_reads: uniqueNumbers,
    ambiguous_multiple_lot_outlines: ambiguousNumbers,
    tier_counts: tierCounts,
    outbound_notifications_enabled: false,
    copied_source_files: files.length
  }, null, 2));
}

main().catch((error) => {
  console.error(`[hopkins-release-package] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
