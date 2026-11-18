#!/usr/bin/env node
/** Apply candidate SQL overlays and exercise their behavior on the disposable replay database only. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const databaseUrl = process.env.SCHEMA_QUERY_DATABASE_URL ?? "";
const replayDir = resolve(process.env.REPLAY_DIR ?? "");
const POST_SALES_VERSION = "20261112033403";
const VIEW_VERSION = "20261112033404";
const POST_SALES_SHA256 = "18e060bd642cad681e5aef988aa06149d90e5627cb0ffe6b90828f8dd4ab12f5";
const VIEW_SHA256 = "e814ea50e238d58e94144cee4b4926f42a8dc49fd849873d66c48b64fe7a5672";
const M1_5_SHA256 = "d16b6fba02cb210e9e628f5cf11c555f74db7e18fbe6afe663150158cb72d631";

function fail(message) {
  throw new Error(message);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safePsql(args) {
  return spawnSync("psql", [databaseUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PGPASSWORD: undefined },
  });
}

function runPsql(args, label) {
  const result = safePsql(args);
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const errorLines = (result.stderr ?? "").split(/\r?\n/).filter(Boolean);
    const detail = [
      ...errorLines.slice(0, 4),
      ...(errorLines.length > 18 ? ["… additional PostgreSQL context omitted …"] : []),
      ...errorLines.slice(-14),
    ].join("\n");
    fail(`${label} (exit ${result.status}).\n${detail}`);
  }
  return result.stdout.trim();
}

function scalar(query) {
  return runPsql(["-t", "-A", "-c", query], "Read local replay assertion").trim();
}

async function apply(path, label) {
  runPsql(["-f", path], label);
  return { path: relative(ROOT, path), sha256: digest(await readFile(path)) };
}

async function main() {
  if (!databaseUrl || !process.env.REPLAY_DIR) fail("SCHEMA_QUERY_DATABASE_URL and REPLAY_DIR are required for the local replay repair test.");
  const parsed = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) fail("Refusing a non-local PostgreSQL target; hosted databases are out of scope.");
  const applied = JSON.parse(await readFile(resolve(replayDir, "applied-migrations.json"), "utf8"));
  if (applied.applied_migration_count !== 69 || applied.ordered_manifest_match !== true
      || applied.applied_migrations?.length !== 69) {
    fail("Repair overlays require the exact successful 69-entry baseline replay.");
  }
  const baselineVersions = applied.applied_migrations.map((entry) => String(entry.version));
  if (baselineVersions.includes(POST_SALES_VERSION) || baselineVersions.includes(VIEW_VERSION)
      || POST_SALES_VERSION <= baselineVersions.at(-1) || VIEW_VERSION <= POST_SALES_VERSION) {
    fail("Repair migration versions must remain separate and strictly after the captured 69-entry ledger.");
  }

  const postSalesPath = resolve(ROOT, "supabase/migrations/20261112033403_post_sales_project_phase_scope.sql");
  const viewPath = resolve(ROOT, "supabase/migrations/20261112033404_community_fee_view_tenant_scope.sql");
  const reviewerLinkPath = resolve(ROOT, "supabase/migrations/20261113050506_shareable_map_reviewer_links.sql");
  const m15Path = resolve(replayDir, "supabase/local-overlays/20261105000100_harden_sensitive_view_access.sql");
  const hashes = {
    postSales: digest(await readFile(postSalesPath)),
    m1_5: digest(await readFile(m15Path)),
    view: digest(await readFile(viewPath)),
  };
  if (hashes.postSales !== POST_SALES_SHA256) fail(`Post-sales migration SHA-256 differs from reviewed body: ${hashes.postSales}`);
  if (hashes.view !== VIEW_SHA256) fail(`Community-fee view migration SHA-256 differs from reviewed body: ${hashes.view}`);
  if (hashes.m1_5 !== M1_5_SHA256) fail(`M1.5 overlay SHA-256 differs from the separately reviewed correction: ${hashes.m1_5}`);

  runPsql(["-f", resolve(ROOT, "scripts/schema-repair-fixtures.sql")], "Seed synthetic legacy rows and phase-restricted users");

  // Exercise the migration's own conflict preflight and PostgreSQL transaction
  // rollback. The only writes after failure are deletion of two explicit
  // conflict fixtures, not repair or deletion of business rows.
  const rejected = safePsql(["-f", postSalesPath]);
  const rejectionText = `${rejected.stdout ?? ""}\n${rejected.stderr ?? ""}`;
  if (!rejected.status || !rejectionText.includes("Post-sales scope preflight found 2 rows")) {
    fail("Expected the forward migration to reject the two synthetic conflicting parent rows and roll back.");
  }
  const afterRejectedMigration = scalar(`SELECT
    (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('post_sales_tasks','post_sales_checklists') AND column_name IN ('project_id','phase_id')),
    (SELECT count(*) FROM public.post_sales_tasks),
    (SELECT count(*) FROM public.post_sales_checklists);`);
  if (afterRejectedMigration !== "0|4|4") fail(`Conflict preflight was not atomic; post-failure catalog/count probe returned ${afterRejectedMigration}.`);

  runPsql(["-c", `DELETE FROM public.post_sales_tasks WHERE id='e5000000-0000-4000-8000-000000000004'; DELETE FROM public.post_sales_checklists WHERE id='e7000000-0000-4000-8000-000000000004';`], "Remove only explicit rejected conflict fixtures");
  const appliedRepairs = [];
  appliedRepairs.push(await apply(postSalesPath, `Apply separate ${POST_SALES_VERSION} post-sales scope migration`));
  // Apply the separately reviewed M1.5 view-security correction between the
  // schema baselines and view repair, then assert the final replacement keeps it.
  appliedRepairs.push(await apply(m15Path, "Apply separate, hash-pinned M1.5 security-invoker overlay on disposable PostgreSQL"));
  appliedRepairs.push(await apply(viewPath, `Apply separate ${VIEW_VERSION} community-fee tenant-scope migration`));

  runPsql(["-f", resolve(ROOT, "scripts/assert-schema-repair-post-sales.sql")], "Run post-sales RLS, attribution, and view permission assertions");

  const activeStates = scalar(`DO $checks$ DECLARE v boolean; BEGIN
    IF NOT public.workspace_scope_is_active('e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'eligible workspace phase was not active'; END IF;
    UPDATE public.development_phases SET is_active=false WHERE id='e3000000-0000-4000-8000-000000000001';
    IF public.workspace_scope_is_active('e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'inactive phase was accepted'; END IF;
    UPDATE public.development_phases SET is_active=true WHERE id='e3000000-0000-4000-8000-000000000001';
    IF public.workspace_scope_is_active('e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000099','e3000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'mismatched project/phase was accepted'; END IF;
    UPDATE public.organizations SET is_active=false WHERE id='e1000000-0000-4000-8000-000000000001';
    IF public.workspace_scope_is_active('e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'inactive tenant was accepted'; END IF;
    UPDATE public.organizations SET is_active=true WHERE id='e1000000-0000-4000-8000-000000000001';
  END; $checks$; SELECT 'receipt scope lifecycle database checks passed';`);
  if (!activeStates.includes("receipt scope lifecycle database checks passed")) fail("Receipt lifecycle helper did not return the expected PostgreSQL assertions.");

  const anonDenied = safePsql(["-c", "SET ROLE anon; SELECT count(*) FROM public.community_fee_account_status;"]);
  const anonError = `${anonDenied.stdout ?? ""}\n${anonDenied.stderr ?? ""}`;
  if (!anonDenied.status || !anonError.toLowerCase().includes("permission denied")) fail("Anonymous SQL query was not denied by view grants.");

  const baseVersions = applied.applied_migrations.map((entry) => String(entry.version));
  const finalMigrations = [
    ...applied.applied_migrations,
    { position: 70, version: POST_SALES_VERSION, filename: `${POST_SALES_VERSION}_post_sales_project_phase_scope.sql`, sha256: hashes.postSales },
    { position: 71, version: VIEW_VERSION, filename: `${VIEW_VERSION}_community_fee_view_tenant_scope.sql`, sha256: hashes.view },
  ];
  const finalVersions = finalMigrations.map((entry) => String(entry.version));
  if (baseVersions.length !== 69 || finalMigrations.length !== 71
    || new Set(finalVersions).size !== 71 || finalVersions.some((version, index) => index > 0 && version <= finalVersions[index - 1])) {
    fail("The final numbered migration manifest is not the exact ordered 71-entry baseline plus candidate repairs.");
  }
  const numberedManifest = {
    mode: "disposable-local-supabase-postgresql-17",
    hosted_target_used: false,
    schema_baseline_commit: process.env.WAMULE_SCHEMA_BASE_COMMIT ?? null,
    tested_commit: process.env.GITHUB_SHA ?? null,
    base_ledger_count: 69,
    numbered_migration_count: 71,
    ordered_manifest_match: true,
    separately_applied_overlay: { name: "20261105000100_harden_sensitive_view_access.sql", sha256: hashes.m1_5, included_in_numbered_ledger: false },
    migrations: finalMigrations,
  };
  await writeFile(resolve(replayDir, "numbered-migrations.json"), `${JSON.stringify(numberedManifest, null, 2)}\n`, "utf8");
  const finalApplied = {
    ...applied,
    expected_migration_count: 71,
    applied_migration_count: 71,
    applied_migrations: finalMigrations,
    base_ledger_count: 69,
    ordered_manifest_match: true,
    m1_5_view_security_overlay: { name: "20261105000100_harden_sensitive_view_access.sql", sha256: hashes.m1_5, applied: true, included_in_numbered_ledger: false },
  };
  await writeFile(resolve(replayDir, "applied-migrations.json"), `${JSON.stringify(finalApplied, null, 2)}\n`, "utf8");


  const REVIEWER_VERSION = "20261113050506";
  const reviewerLinkSha = digest(await readFile(reviewerLinkPath));
  if (reviewerLinkSha !== "f17c9a0913c13de3393232e4a8f76151e13826daf71c73c5f4cab109d3d1795f") {
    fail("Reviewer-link migration SHA-256 differs from the reviewed candidate body: " + reviewerLinkSha);
  }
  const baselineVersions71 = finalMigrations.map((entry) => String(entry.version));
  if (baselineVersions71.length !== 71 || baselineVersions71.at(-2) !== POST_SALES_VERSION
      || baselineVersions71.at(-1) !== VIEW_VERSION || baselineVersions71.includes("20261112040000")) {
    fail("The candidate 71-entry staging ledger or compatibility-delta exclusion is incorrect.");
  }

  const reviewerLinkMigration = await apply(reviewerLinkPath, "Apply the reviewer-link migration to disposable PostgreSQL only");
  const reviewerEntry = {
    position: 72,
    version: REVIEWER_VERSION,
    filename: "20261113050506_shareable_map_reviewer_links.sql",
    sha256: reviewerLinkMigration.sha256,
    path: reviewerLinkMigration.path,
  };
  const finalMigrations72 = [...finalMigrations, reviewerEntry];
  const finalVersions72 = finalMigrations72.map((entry) => String(entry.version));
  if (finalMigrations72.length !== 72 || new Set(finalVersions72).size !== 72
      || finalVersions72.some((version, index) => index > 0 && version <= finalVersions72[index - 1])
      || finalVersions72.slice(-3).join(",") !== [POST_SALES_VERSION, VIEW_VERSION, REVIEWER_VERSION].join(",")
      || finalVersions72.includes("20261112040000")) {
    fail("The final numbered ledger is not the ordered 72-entry staging baseline without the compatibility delta.");
  }

  const anonReviewLinkRead = safePsql(["-c", "SET ROLE anon; SELECT count(*) FROM public.project_map_review_links;"]);
  if (anonReviewLinkRead.status === 0 || !((anonReviewLinkRead.stdout ?? "") + (anonReviewLinkRead.stderr ?? "")).toLowerCase().includes("permission denied")) {
    fail("Anonymous SQL access to project_map_review_links must remain denied.");
  }
  const authenticatedReviewLinkRead = safePsql(["-c", "SET ROLE authenticated; SELECT count(*) FROM public.project_map_review_links;"]);
  if (authenticatedReviewLinkRead.status === 0 || !((authenticatedReviewLinkRead.stdout ?? "") + (authenticatedReviewLinkRead.stderr ?? "")).toLowerCase().includes("permission denied")) {
    fail("Authenticated SQL access to project_map_review_links must remain denied.");
  }
  const serviceReviewLinkRead = scalar("SET ROLE service_role; SELECT count(*) FROM public.project_map_review_links; RESET ROLE;");
  if (serviceReviewLinkRead !== "0") fail("The local server-side service role cannot access the private review-link table.");

  const finalNumberedManifest = {
    ...numberedManifest,
    numbered_migration_count: 72,
    migrations: finalMigrations72,
    reviewer_link_migration: { name: "20261113050506_shareable_map_reviewer_links.sql", sha256: reviewerLinkSha, included_in_numbered_ledger: true },
  };
  await writeFile(resolve(replayDir, "numbered-migrations.json"), JSON.stringify(finalNumberedManifest, null, 2) + "\n", "utf8");
  const finalApplied72 = {
    ...finalApplied,
    expected_migration_count: 72,
    applied_migration_count: 72,
    applied_migrations: finalMigrations72,
    ordered_manifest_match: true,
    m1_5_view_security_overlay: { name: "20261105000100_harden_sensitive_view_access.sql", sha256: hashes.m1_5, applied: true, included_in_numbered_ledger: false },
    compatibility_delta_applied: false,
  };
  await writeFile(resolve(replayDir, "applied-migrations.json"), JSON.stringify(finalApplied72, null, 2) + "\n", "utf8");

  const reviewerEvidence = {
    name: "20261113050506_shareable_map_reviewer_links.sql",
    sha256: reviewerLinkSha,
    applied_after_numbered_baseline_count: 71,
    included_in_numbered_ledger: true,
    hosted_target_used: false,
  };
  await writeFile(resolve(replayDir, "reviewer-link-overlay.json"), JSON.stringify(reviewerEvidence, null, 2) + "\n", "utf8");
  const baselineEvidence = {
    mode: "disposable-local-supabase-postgresql-17",
    hosted_target_used: false,
    schema_baseline_commit: process.env.WAMULE_SCHEMA_BASE_COMMIT ?? null,
    tested_commit: process.env.GITHUB_SHA ?? null,
    numbered_migration_count: 72,
    ordered_manifest_match: true,
    versions: finalVersions72,
    m1_5_overlay: { name: "20261105000100_harden_sensitive_view_access.sql", sha256: hashes.m1_5, included_in_numbered_ledger: false },
    reviewer_migration: reviewerEvidence,
    compatibility_delta_applied: false,
  };
  await writeFile(resolve(replayDir, "onboarding-postgrest-baseline.json"), JSON.stringify(baselineEvidence, null, 2) + "\n", "utf8");

  const report = {
    mode: "disposable-local-supabase-postgresql-17",
    hosted_target_used: false,
    schema_baseline_commit: process.env.WAMULE_SCHEMA_BASE_COMMIT ?? null,
    tested_commit: process.env.GITHUB_SHA ?? null,
    baseline: { migration_count: 69, ordered_match: true },
    final_numbered_ledger: { migration_count: 72, ordered_match: true, manifest: "numbered-migrations.json" },
    compatibility_delta_applied: false,
    candidate_migrations: appliedRepairs.filter((entry) => entry.sha256 !== hashes.m1_5),
    separate_m1_5_overlay: appliedRepairs.find((entry) => entry.sha256 === hashes.m1_5),
    reviewer_link_migration: reviewerEvidence,
    sha256: { post_sales: hashes.postSales, m1_5: hashes.m1_5, community_fee_view: hashes.view, reviewer_link: reviewerLinkSha },
    checks: {
      post_sales_scope_and_backfill: "passed",
      m1_5_view_security_invoker_and_grants_retained: "passed",
      community_fee_tenant_view_scope: "passed",
      reviewer_link_table_anon_and_authenticated_denied: "passed",
      reviewer_link_table_service_role_only: "passed",
      ordered_72_entry_baseline_without_compatibility_delta: "passed",
    },
    limitations: [
      "PostgREST onboarding role-claim behavior is checked by the following HTTP integration step.",
      "All database and Auth effects are confined to the disposable local stack.",
    ],
  };
  const out = resolve(replayDir, "schema-repair-results.json");
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`[schema-repair] verified local disposable overlays; evidence written to ${relative(ROOT, out)}.`);
}

main().catch((error) => {
  console.error(`[schema-repair] FAIL: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
