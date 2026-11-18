#!/usr/bin/env node
/**
 * Tenant package publisher — applies one tenant package to staging.
 *
 *   npm run tenant:publish -- --slug <slug> [--project <slug>] (--dry-run | --apply) [--activate]
 *
 * Order of operations:
 *   1. Load + validate the package (tenant.json, tiers.json, theme.json,
 *      overrides.css via src/lib/theme.ts — invalid CSS fails closed).
 *   2. Snapshot existing tenant parcels/tiers/theme/versions into
 *      build/snapshots/<ts>.json (reads only; also in dry-run).
 *   3. Geometry via scripts/publish-lots.mjs --tenant <slug> --project <slug> --dir build/
 *      (its own safety rules: gate errors fail, never deletes, never
 *      touches status/dimensions; new rows stamped to the active version).
 *   4. Tiers upserted into the project catalogue (legacy default mirror only).
 *   5. Theme allowlisted into project_settings; overrides.css
 *      uploaded to business-assets/<tenant_id>/ and its public URL stored
 *      as theme.css_url. No per-tenant JS, ever.
 *   6. Display assets uploaded as one INACTIVE project masterplan version (drafts never
 *      public). --activate flips the uploaded version active after the 2%
 *      aspect-drift check; without it nothing user-visible changes.
 *   7. Project row ensured by slug (immutable afterwards); legacy NULL rows
 *      are never reassigned by a publisher.
 *
 * --dry-run performs zero hosted writes (snapshot file is local only).
 * Without credentials it validates offline like map:publish.
 *
 * Exit codes: 0 ok, 2 bad usage / validation / gate failure.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { allowlistTheme, validateTenantCss } from "../src/lib/theme.ts";

function usage() {
  return `Usage:
  node scripts/tenant-publish.mjs --slug <slug> [--project <slug>] (--dry-run | --apply) [--activate]
    [--supabase-url <url>] [--service-key <key>]

  --project defaults to the tenant's is_default project (or creates "default"
  on first publish).
  --activate publishes the uploaded background as the live version after the
  aspect-drift check; without it uploads stay inactive drafts.`;
}

function fail(message) {
  console.error(`error: ${message}\n${usage()}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "dry-run" || key === "apply" || key === "activate" || key === "help" || key === "h") {
      out[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${arg}`);
    out[key] = value;
    i++;
  }
  return out;
}

function scopeClassFor(slug) {
  return `.lotmap-t-${slug}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(usage());
    return;
  }
  const slug = ((args.slug || "").trim() || "").toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) fail("--slug must be lowercase letters, digits, hyphens");
  let projectSlug = args.project ? args.project.trim().toLowerCase() : null;
  if (projectSlug !== null && !/^[a-z0-9-]+$/.test(projectSlug)) fail("--project must be lowercase letters, digits, hyphens");
  if ((args["dry-run"] ? 1 : 0) + (args.apply ? 1 : 0) !== 1) fail("exactly one of --dry-run or --apply is required");
  const dryRun = Boolean(args["dry-run"]);
  const tenantDir = resolve(join("tenants", slug));
  const need = ["tenant.json", "tiers.json", "theme.json"];
  for (const file of need) {
    if (!existsSync(join(tenantDir, file))) fail(`tenants/${slug}/${file} missing — run tenant:init first`);
  }
  const tenant = JSON.parse(readFileSync(join(tenantDir, "tenant.json"), "utf8"));
  if (tenant.slug !== slug) fail("tenant.json slug mismatch");
  const tiers = JSON.parse(readFileSync(join(tenantDir, "tiers.json"), "utf8"));
  const themeRaw = JSON.parse(readFileSync(join(tenantDir, "theme.json"), "utf8"));
  const scope = scopeClassFor(slug);
  const cssPath = join(tenantDir, "overrides.css");
  const cssText = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";
  const cssErrors = cssText.trim() ? validateTenantCss(cssText, scope) : [];
  if (cssErrors.length) {
    for (const err of cssErrors) console.error(`css: ${err}`);
    fail("overrides.css failed validation — refusing to publish");
  }
  const buildDir = join(tenantDir, "build");
  mkdirSync(join(buildDir, "snapshots"), { recursive: true });

  const supabaseUrl = args["supabase-url"] || process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = args["service-key"] || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if ((!supabaseUrl || !serviceKey) && !dryRun) {
    fail("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required for --apply (or pass flags)");
  }

  let supabase = null;
  let org = null;
  let projectId = null;
  let projectIsDefault = false;
  let projectsDeployed = false;
  let projectExists = false;
  if (supabaseUrl && serviceKey) {
    const { createClient } = await import("@supabase/supabase-js");
    supabase = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await supabase
      .from("organizations").select("id, slug, is_active").eq("slug", slug).eq("is_active", true).maybeSingle();
    if (error) fail(`tenant lookup failed: ${error.message}`);
    if (!data && !dryRun) fail(`tenant not found or inactive: ${slug}`);
    org = data ?? null;
    if (org) {
      const projectProbe = await supabase.from("projects").select("id").limit(0);
      projectsDeployed = !projectProbe.error;
      if (projectsDeployed) {
        // All project-dependent schema is probed before the first possible
        // write (including creating a missing project row).
        const probes = await Promise.all([
          supabase.from("parcels").select("project_id").limit(0),
          supabase.from("masterplan_versions").select("project_id, preview_url").limit(0),
          supabase.from("project_settings").select("project_id, key, value").limit(0),
          supabase.from("project_lot_tiers").select("project_id, tier_key").limit(0),
        ]);
        const failedProbe = probes.find((probe) => probe.error);
        if (failedProbe) {
          fail(`project-scoped map migration is incomplete; refusing publish before writes: ${failedProbe.error.message}`);
        }
        let projectLookup = supabase.from("projects").select("id, slug, is_default").eq("tenant_id", org.id);
        projectLookup = projectSlug ? projectLookup.eq("slug", projectSlug) : projectLookup.eq("is_default", true);
        const found = await projectLookup.maybeSingle();
        if (found.error) fail(`project lookup failed: ${found.error.message}`);
        if (found.data) {
          projectId = found.data.id;
          projectSlug = found.data.slug;
          projectIsDefault = found.data.is_default === true;
          projectExists = true;
        } else {
          const count = await supabase.from("projects").select("id", { count: "exact", head: true })
            .eq("tenant_id", org.id);
          if (count.error) fail(`project count failed: ${count.error.message}`);
          projectIsDefault = (count.count ?? 0) === 0;
          projectSlug ??= "default";
          if (dryRun) console.log(`[tenant:publish] would create project '${projectSlug}' (default: ${projectIsDefault})`);
        }
        if (!projectIsDefault && cssText.trim()) {
          fail("project-specific overrides.css is not supported yet; selectors currently scope to the tenant wrapper and could affect sibling project embeds");
        }
      } else {
        if (projectSlug && projectSlug !== "default") fail(`project-scoped migrations are not deployed; refusing non-default project '${projectSlug}'`);
        projectSlug ??= "default";
        console.warn(`[tenant:publish] projects extension not deployed (${projectProbe.error.message}) — legacy default project mode`);
      }
    }
  } else {
    console.log("[tenant:publish] no credentials — offline plan mode (zero hosted writes)");
  }

  // Snapshot existing tenant state (reads only; local file even in dry-run).
  let snapshotPath = null;
  if (supabase && org && (!projectsDeployed || projectId)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    snapshotPath = join(buildDir, "snapshots", `snapshot-${stamp}.json`);
    const snapshot = { tenant: slug, at: new Date().toISOString(), parcels: [], tiers: [], theme: null, versions: [] };
    let parcelQuery = supabase.from("parcels")
      .select("id, lot_number, status, base_price, map_polygon, tier_key, project_id, masterplan_version_id")
      .eq("tenant_id", org.id);
    if (projectsDeployed && projectId) parcelQuery = parcelQuery.eq("project_id", projectId);
    let parcels = await parcelQuery.order("lot_number");
    if (parcels.error && /project_id|masterplan_version_id/.test(parcels.error.message)) {
      console.warn("[tenant:publish] parcel extensions predate deploy — snapshot without new columns");
      parcels = await supabase.from("parcels")
        .select("id, lot_number, status, base_price, map_polygon, tier_key")
        .eq("tenant_id", org.id).order("lot_number");
    }
    if (parcels.error) fail(`snapshot parcels read failed: ${parcels.error.message}`);
    snapshot.parcels = parcels.data ?? [];
    const tierRows = projectsDeployed && projectId
      ? await supabase.from("project_lot_tiers").select("*").eq("tenant_id", org.id).eq("project_id", projectId)
      : await supabase.from("lot_tiers").select("*").eq("tenant_id", org.id);
    snapshot.tiers = tierRows.data ?? [];
    const themeRow = projectsDeployed && projectId
      ? await supabase.from("project_settings").select("key, value")
        .eq("tenant_id", org.id).eq("project_id", projectId).eq("key", "tenant_theme").maybeSingle()
      : await supabase.from("business_settings").select("key, value")
        .eq("tenant_id", org.id).eq("key", "tenant_theme").maybeSingle();
    snapshot.theme = themeRow.data ?? null;
    let versionQuery = supabase.from("masterplan_versions")
      .select("id, version_number, image_url, file_name, is_active").eq("tenant_id", org.id);
    if (projectsDeployed && projectId) versionQuery = versionQuery.eq("project_id", projectId);
    const versions = await versionQuery.order("version_number");
    snapshot.versions = versions.data ?? [];
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n");
    console.log(`[tenant:publish] snapshot -> ${snapshotPath} (${snapshot.parcels.length} parcels)`);
  } else if (supabase && org && projectsDeployed) {
    console.log("[tenant:publish] new project has no existing state to snapshot");
  }

  // Create the named project only after all dependent tables/columns passed
  // their read-only preflight above. Legacy NULL rows are never stamped.
  if (supabase && org && projectsDeployed && !projectExists && !dryRun) {
    const created = await supabase.from("projects")
      .insert({ tenant_id: org.id, slug: projectSlug, name: projectSlug, is_default: projectIsDefault })
      .select("id").single();
    if (created.error) fail(`project create failed: ${created.error.message}`);
    projectId = created.data.id;
    console.log(`[tenant:publish] created project '${projectSlug}' (default: ${projectIsDefault})`);
  }

  // Geometry via the existing publisher (its own gates still apply).
  console.log(`[tenant:publish] geometry: publish-lots.mjs --tenant ${slug}${projectsDeployed ? ` --project ${projectSlug}` : ""} --dir build ${dryRun ? "--dry-run" : "--apply"}`);
  if (supabase) {
    const env = { ...process.env, SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: serviceKey };
    const publishArgs = ["scripts/publish-lots.mjs", "--tenant", slug];
    if (projectsDeployed) publishArgs.push("--project", projectSlug);
    publishArgs.push("--dir", buildDir, dryRun ? "--dry-run" : "--apply");
    const res = spawnSync("node", publishArgs, { stdio: "inherit", env });
    if (res.status !== 0) fail("publish-lots.mjs failed — see errors above");
  }

  // Tiers upsert (by tier_key; absent rows left alone, never deleted).
  const tierEntries = Object.entries(tiers.tiers ?? {});
  if (supabase && org) {
    if (dryRun) {
      console.log(`[tenant:publish] would upsert ${tierEntries.length} tiers (present rows only)`);
    } else {
      for (const [tierKey, tier] of tierEntries) {
        const row = {
          tenant_id: org.id,
          tier_key: tierKey,
          label: String(tier.label ?? tierKey),
          price_cents: Math.round(Number(tier.price ?? 0) * 100),
          corner_premium_cents: 0,
          color_hex: String(tier.legend ?? "#999999"),
          is_active: true,
        };
        if (projectsDeployed) {
          const scoped = await supabase.from("project_lot_tiers").upsert(
            { ...row, project_id: projectId },
            { onConflict: "project_id,tier_key" },
          );
          if (scoped.error) fail(`project tier upsert failed (${tierKey}): ${scoped.error.message}`);
          if (projectIsDefault) {
            const legacy = await supabase.from("lot_tiers").upsert(row, { onConflict: "tenant_id,tier_key" });
            if (legacy.error) fail(`default tier compatibility mirror failed (${tierKey}): ${legacy.error.message}`);
          }
        } else {
          const legacy = await supabase.from("lot_tiers").upsert(row, { onConflict: "tenant_id,tier_key" });
          if (legacy.error) fail(`tier upsert failed (${tierKey}): ${legacy.error.message}`);
        }
      }
      console.log(`[tenant:publish] upserted ${tierEntries.length} tiers`);
    }
  }

  // Theme: allowlisted object to business_settings + validated CSS to storage.
  if (supabase && org) {
    let cssUrl = null;
    if (cssText.trim()) {
      if (dryRun) {
        console.log("[tenant:publish] would upload overrides.css (validated, no errors)");
      } else {
        const cssName = `theme-${Date.now()}.css`;
        const cssPathRemote = `${org.id}/${cssName}`;
        const { error: cssError } = await supabase.storage.from("business-assets")
          .upload(cssPathRemote, Buffer.from(cssText, "utf8"), { contentType: "text/css", upsert: false });
        if (cssError) fail(`CSS upload failed: ${cssError.message}`);
        cssUrl = supabase.storage.from("business-assets").getPublicUrl(cssPathRemote).data.publicUrl;
        console.log(`[tenant:publish] uploaded overrides.css -> ${cssUrl}`);
      }
    }
    const themed = allowlistTheme(themeRaw, cssUrl);
    if (dryRun) {
      console.log(`[tenant:publish] would write ${projectsDeployed ? "project_settings" : "business_settings"} tenant_theme (allowlisted)`);
    } else {
      if (projectsDeployed) {
        const { error: themeError } = await supabase.from("project_settings").upsert(
          { key: "tenant_theme", value: themed, tenant_id: org.id, project_id: projectId },
          { onConflict: "project_id,key" },
        );
        if (themeError) fail(`project theme write failed: ${themeError.message}`);
        if (projectIsDefault) {
          const { error: mirrorError } = await supabase.from("business_settings").upsert(
            { key: "tenant_theme", value: themed, tenant_id: org.id },
            { onConflict: "tenant_id,key" },
          );
          if (mirrorError) fail(`default theme compatibility mirror failed: ${mirrorError.message}`);
        }
        console.log("[tenant:publish] wrote project_settings tenant_theme");
      } else {
        const { error: themeError } = await supabase.from("business_settings").upsert(
          { key: "tenant_theme", value: themed, tenant_id: org.id },
          { onConflict: "tenant_id,key" },
        );
        if (themeError) fail(`theme write failed: ${themeError.message}`);
        console.log("[tenant:publish] wrote business_settings tenant_theme");
      }
    }
  }

  // Display assets as INACTIVE versions (drafts never public).
  let uploadedVersionId = null;
  const bgPath = join(buildDir, "masterplan_background.webp");
  if (supabase && org && existsSync(bgPath)) {
    if (dryRun) {
      console.log("[tenant:publish] would upload background + preview into one inactive project version");
    } else {
      const stamp = Date.now();
      const uploadMapAsset = async (local, suffix) => {
        if (!existsSync(local)) return null;
        const remote = `${org.id}/${projectsDeployed ? `projects/${projectSlug}/` : ""}masterplan-${stamp}-${slug}-${suffix}.webp`;
        const { error: upError } = await supabase.storage.from("business-assets")
          .upload(remote, readFileSync(local), { contentType: "image/webp", upsert: false });
        if (upError) fail(`asset upload failed (${suffix}): ${upError.message}`);
        return supabase.storage.from("business-assets").getPublicUrl(remote).data.publicUrl;
      };
      const imageUrl = await uploadMapAsset(bgPath, "background");
      const previewUrl = await uploadMapAsset(join(buildDir, "masterplan_preview.webp"), "preview");
      if (!imageUrl) fail("background asset disappeared before upload");
      const versionRow = {
        tenant_id: org.id,
        ...(projectsDeployed ? { project_id: projectId, preview_url: previewUrl } : {}),
        image_url: imageUrl,
        file_name: `${projectSlug}-${slug}-background.webp`,
        is_active: false,
      };
      const inserted = await supabase.from("masterplan_versions").insert(versionRow).select("id").single();
      if (inserted.error || !inserted.data) fail(`version record failed: ${inserted.error?.message ?? "unknown"}`);
      uploadedVersionId = inserted.data.id;
      console.log(`[tenant:publish] uploaded map assets as one inactive version ${uploadedVersionId}`);
    }
  }

  // Activation gate: explicit flag + aspect-drift check, else nothing visible changes.
  if (args.activate) {
    if (dryRun) {
      console.log("[tenant:publish] --activate with --dry-run: would drift-check then flip the uploaded version active");
    } else if (!uploadedVersionId) {
      fail("--activate needs a freshly uploaded background version");
    } else {
      await activateVersion(supabase, org, uploadedVersionId, buildDir, projectsDeployed ? projectId : null);
    }
  }

  console.log(`[tenant:publish] done (${dryRun ? "dry-run, zero hosted writes" : "applied"})${snapshotPath ? ` snapshot: ${snapshotPath}` : ""}`);
}

async function activateVersion(supabase, org, versionId, buildDir, projectId = null) {
  const { execFileSync } = await import("node:child_process");
  const dims = (file) => {
    const out = execFileSync("python3", ["-c",
      "from PIL import Image; import sys; im = Image.open(sys.argv[1]); print(f'{im.size[0]}x{im.size[1]}')",
      file,
    ], { encoding: "utf8" }).trim();
    const [w, h] = out.split("x").map(Number);
    return { w, h };
  };
  let activeUrl = null;
  {
    let activeQuery = supabase.from("masterplan_versions").select("image_url")
      .eq("tenant_id", org.id).eq("is_active", true);
    if (projectId) activeQuery = activeQuery.eq("project_id", projectId);
    const { data } = await activeQuery.maybeSingle();
    activeUrl = data?.image_url ?? null;
  }
  const fresh = dims(join(buildDir, "masterplan_background.webp"));
  if (activeUrl) {
    const tmp = join(buildDir, ".tmp-active-check.webp");
    const res = await fetch(activeUrl);
    if (!res.ok) fail(`could not fetch active masterplan for drift check (${res.status})`);
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    const live = dims(tmp);
    const drift = Math.abs(fresh.w / fresh.h - live.w / live.h) / (live.w / live.h);
    if (drift > 0.02) fail(`aspect drift ${(drift * 100).toFixed(1)}% exceeds 2% — refusing activation`);
    console.log(`[tenant:publish] aspect drift ${(drift * 100).toFixed(2)}% — within gate`);
  } else {
    console.log("[tenant:publish] no active version — first activation, drift check skipped");
  }
  let activation = supabase.from("masterplan_versions").update({ is_active: true })
    .eq("id", versionId).eq("tenant_id", org.id);
  if (projectId) activation = activation.eq("project_id", projectId);
  const { error } = await activation;
  if (error) fail(`activation failed: ${error.message}`);
  console.log(`[tenant:publish] activated version ${versionId} (single-active trigger syncs the rest)`);
}

await main();
