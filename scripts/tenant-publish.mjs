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
 *   3. Geometry via scripts/publish-lots.mjs --tenant <slug> --dir build/
 *      (its own safety rules: gate errors fail, never deletes, never
 *      touches status/dimensions; new rows stamped to the active version).
 *   4. Tiers upserted into lot_tiers (by tier_key; missing rows left alone).
 *   5. Theme allowlisted into business_settings tenant_theme; overrides.css
 *      uploaded to business-assets/<tenant_id>/ and its public URL stored
 *      as theme.css_url. No per-tenant JS, ever.
 *   6. Display assets uploaded as INACTIVE masterplan versions (drafts never
 *      public). --activate flips the uploaded version active after the 2%
 *      aspect-drift check; without it nothing user-visible changes.
 *   7. Project row ensured by slug (immutable afterwards); published rows
 *      with NULL project_id are stamped to it.
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

  --project defaults to "default" (created on first publish for the tenant).
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
  const projectSlug = ((args.project || "default").trim() || "").toLowerCase();
  if (!/^[a-z0-9-]+$/.test(projectSlug)) fail("--project must be lowercase letters, digits, hyphens");
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
  const theme = allowlistTheme(themeRaw, null);
  const buildDir = join(tenantDir, "build");
  mkdirSync(join(buildDir, "snapshots"), { recursive: true });

  const supabaseUrl = args["supabase-url"] || process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = args["service-key"] || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if ((!supabaseUrl || !serviceKey) && !dryRun) {
    fail("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required for --apply (or pass flags)");
  }

  let supabase = null;
  let org = null;
  if (supabaseUrl && serviceKey) {
    const { createClient } = await import("@supabase/supabase-js");
    supabase = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await supabase
      .from("organizations").select("id, slug, is_active").eq("slug", slug).eq("is_active", true).maybeSingle();
    if (error) fail(`tenant lookup failed: ${error.message}`);
    if (!data && !dryRun) fail(`tenant not found or inactive: ${slug}`);
    org = data ?? null;
  } else {
    console.log("[tenant:publish] no credentials — offline plan mode (zero hosted writes)");
  }

  // Snapshot existing tenant state (reads only; local file even in dry-run).
  let snapshotPath = null;
  if (supabase && org) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    snapshotPath = join(buildDir, "snapshots", `snapshot-${stamp}.json`);
    const snapshot = { tenant: slug, at: new Date().toISOString(), parcels: [], tiers: [], theme: null, versions: [] };
    let parcels = await supabase.from("parcels")
      .select("id, lot_number, status, base_price, map_polygon, tier_key, project_id, masterplan_version_id")
      .eq("tenant_id", org.id).order("lot_number");
    if (parcels.error && /project_id|masterplan_version_id/.test(parcels.error.message)) {
      console.warn("[tenant:publish] parcel extensions predate deploy — snapshot without new columns");
      parcels = await supabase.from("parcels")
        .select("id, lot_number, status, base_price, map_polygon, tier_key")
        .eq("tenant_id", org.id).order("lot_number");
    }
    if (parcels.error) fail(`snapshot parcels read failed: ${parcels.error.message}`);
    snapshot.parcels = parcels.data ?? [];
    const tierRows = await supabase.from("lot_tiers").select("*").eq("tenant_id", org.id);
    snapshot.tiers = tierRows.data ?? [];
    const themeRow = await supabase.from("business_settings").select("key, value")
      .eq("tenant_id", org.id).eq("key", "tenant_theme").maybeSingle();
    snapshot.theme = themeRow.data ?? null;
    const versions = await supabase.from("masterplan_versions")
      .select("id, version_number, image_url, file_name, is_active").eq("tenant_id", org.id).order("version_number");
    snapshot.versions = versions.data ?? [];
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n");
    console.log(`[tenant:publish] snapshot -> ${snapshotPath} (${snapshot.parcels.length} parcels)`);
  }

  // Project row (slug immutable by DB trigger afterwards) — ensured before
  // any write so a missing table/failure fails fast with zero mutations.
  // Pre-migration databases (no projects table yet) degrade like the
  // legacy map:publish step3 probe — default project implied, no stamping.
  let projectId = null;
  let projectsDeployed = true;
  if (supabase && org) {
    const probe = await supabase.from("projects").select("id").limit(0);
    if (probe.error) {
      console.warn(`[tenant:publish] projects extension not deployed (${probe.error.message}) — default project implied`);
      projectsDeployed = false;
    } else {
      const existing = await supabase.from("projects").select("id, slug, is_default")
        .eq("tenant_id", org.id).eq("slug", projectSlug).maybeSingle();
      if (existing.error) fail(`project lookup failed: ${existing.error.message}`);
      if (existing.data) {
        projectId = existing.data.id;
      } else {
        const count = await supabase.from("projects").select("id", { count: "exact", head: true }).eq("tenant_id", org.id);
        const makeDefault = (count.count ?? 0) === 0;
        if (dryRun) {
          console.log(`[tenant:publish] would create project '${projectSlug}' (default: ${makeDefault})`);
        } else {
          const created = await supabase.from("projects")
            .insert({ tenant_id: org.id, slug: projectSlug, name: projectSlug, is_default: makeDefault })
            .select("id").single();
          if (created.error) fail(`project create failed: ${created.error.message}`);
          projectId = created.data.id;
          console.log(`[tenant:publish] created project '${projectSlug}' (default: ${makeDefault})`);
        }
      }
    }
  }

  // Geometry via the existing publisher (its own gates still apply).
  console.log(`[tenant:publish] geometry: publish-lots.mjs --tenant ${slug} --dir build ${dryRun ? "--dry-run" : "--apply"}`);
  if (supabase) {
    const env = { ...process.env, SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: serviceKey };
    const res = spawnSync("node", [
      "scripts/publish-lots.mjs", "--tenant", slug, "--dir", buildDir, dryRun ? "--dry-run" : "--apply",
    ], { stdio: "inherit", env });
    if (res.status !== 0) fail("publish-lots.mjs failed — see errors above");
  }

  // Project row (slug immutable by DB trigger afterwards) + stamp NULL rows.
  if (supabase && org) {
    if (!projectsDeployed) {
      console.log("[tenant:publish] skipping project stamp (extension not deployed)");
    } else if (!dryRun && projectId) {
      const stamped = await supabase.from("parcels").update({ project_id: projectId })
        .eq("tenant_id", org.id).is("project_id", null);
      if (stamped.error) fail(`project stamp failed: ${stamped.error.message}`);
      console.log("[tenant:publish] stamped NULL project_id rows to the publish project");
    }
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
        const { error } = await supabase.from("lot_tiers").upsert(row, { onConflict: "tenant_id,tier_key" });
        if (error) fail(`tier upsert failed (${tierKey}): ${error.message}`);
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
      console.log("[tenant:publish] would write business_settings tenant_theme (allowlisted)");
    } else {
      const { error: themeError } = await supabase.from("business_settings").upsert(
        { key: "tenant_theme", value: themed, tenant_id: org.id },
        { onConflict: "tenant_id,key" },
      );
      if (themeError) fail(`theme write failed: ${themeError.message}`);
      console.log("[tenant:publish] wrote business_settings tenant_theme");
    }
  }

  // Display assets as INACTIVE versions (drafts never public).
  let uploadedVersionId = null;
  const bgPath = join(buildDir, "masterplan_background.webp");
  if (supabase && org && existsSync(bgPath)) {
    if (dryRun) {
      console.log("[tenant:publish] would upload background + preview as inactive versions");
    } else {
      const stamp = Date.now();
      for (const [local, suffix, mime] of [
        [bgPath, "background", "image/webp"],
        [join(buildDir, "masterplan_preview.webp"), "preview", "image/webp"],
      ]) {
        if (!existsSync(local)) continue;
        const remote = `${org.id}/masterplan-${stamp}-${slug}-${suffix}.webp`;
        const { error: upError } = await supabase.storage.from("business-assets")
          .upload(remote, readFileSync(local), { contentType: mime, upsert: false });
        if (upError) fail(`asset upload failed (${suffix}): ${upError.message}`);
        const publicUrl = supabase.storage.from("business-assets").getPublicUrl(remote).data.publicUrl;
        const inserted = await supabase.from("masterplan_versions")
          .insert({ tenant_id: org.id, image_url: publicUrl, file_name: `${slug}-${suffix}.webp`, is_active: false })
          .select("id").single();
        if (inserted.error || !inserted.data) fail(`version record failed (${suffix}): ${inserted.error?.message ?? "unknown"}`);
        if (suffix === "background") uploadedVersionId = inserted.data.id;
        console.log(`[tenant:publish] uploaded ${suffix} as inactive version ${inserted.data.id}`);
      }
    }
  }

  // Activation gate: explicit flag + aspect-drift check, else nothing visible changes.
  if (args.activate) {
    if (dryRun) {
      console.log("[tenant:publish] --activate with --dry-run: would drift-check then flip the uploaded version active");
    } else if (!uploadedVersionId) {
      fail("--activate needs a freshly uploaded background version");
    } else {
      await activateVersion(supabase, org, uploadedVersionId, buildDir);
    }
  }

  console.log(`[tenant:publish] done (${dryRun ? "dry-run, zero hosted writes" : "applied"})${snapshotPath ? ` snapshot: ${snapshotPath}` : ""}`);
}

async function activateVersion(supabase, org, versionId, buildDir) {
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
    const { data } = await supabase.from("masterplan_versions").select("image_url")
      .eq("tenant_id", org.id).eq("is_active", true).maybeSingle();
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
  const { error } = await supabase.from("masterplan_versions").update({ is_active: true }).eq("id", versionId);
  if (error) fail(`activation failed: ${error.message}`);
  console.log(`[tenant:publish] activated version ${versionId} (single-active trigger syncs the rest)`);
}

await main();
