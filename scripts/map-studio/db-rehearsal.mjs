#!/usr/bin/env node
// Executes the real migrations in local PostgreSQL (PGlite/WASM). This checks
// SQL/RLS, not managed Supabase Auth sessions, HTTP Storage or concurrency.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  validateMapPackage,
  mapPackageCore,
} from "../../src/lib/mapPackage.mjs";
const { PGlite } = await import(
  process.env.MAP_STUDIO_PGLITE_MODULE || "@electric-sql/pglite"
);
const root = resolve(import.meta.dirname, "../..");
const db = new PGlite();
const work = mkdtempSync(join(tmpdir(), "wamule-studio-db-"));
const T1 = "11111111-1111-4111-8111-111111111111",
  T2 = "22222222-2222-4222-8222-222222222222";
const P1 = "11111111-aaaa-4aaa-8aaa-111111111111",
  P2 = "22222222-aaaa-4aaa-8aaa-222222222222";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  U3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let checks = 0;
const read = (path) => readFileSync(join(root, path), "utf8");
const sql = async (query, params = []) => db.query(query, params);
const scalar = async (query, params = []) =>
  Object.values((await sql(query, params)).rows[0])[0];
async function as(uid = "", role = null) {
  await db.exec("reset role");
  if (role) await db.exec(`set role ${role}`);
  await sql("select set_config('request.jwt.claim.sub',$1,false)", [uid]);
}
async function denied(query, params = []) {
  await assert.rejects(() => sql(query, params));
}
function passed(name) {
  checks++;
  console.log("ok - " + name);
}

try {
  await db.exec(
    read("scripts/hosted-pilot-db-bootstrap.sql")
      .split("\n")
      .filter((line) => !line.toLowerCase().includes("create extension"))
      .join("\n"),
  );
  await sql(
    "insert into public.organizations(id,name,slug) values($1,'Fixture one','one'),($2,'Fixture two','two')",
    [T1, T2],
  );
  await sql(
    "insert into public.projects(id,tenant_id,slug,name,is_default) values($1,$2,'main','Main',true),($3,$4,'main','Main',true)",
    [P1, T1, P2, T2],
  );
  for (const [uid, tenant, role] of [
    [U1, T1, "Admin"],
    [U2, T2, "Admin"],
    [U3, T1, "Staff"],
  ]) {
    await sql("insert into auth.users(id,email) values($1,$2)", [
      uid,
      uid + "@example.test",
    ]);
    await sql(
      "insert into public.admin_profiles(user_id,tenant_id,role) values($1,$2,$3)",
      [uid, tenant, role],
    );
  }
  await sql(
    "insert into public.parcels(tenant_id,lot_number,status,base_price) values($1,'EXISTING-1','Reserved',12345)",
    [T1],
  );
  await sql(
    "insert into public.leads(tenant_id,full_name,source,client_reference_id) values($1,'Preservation fixture','manual','keep-this')",
    [T1],
  );
  for (const name of [
    "20261012020651_project_scoped_public_maps.sql",
    "20261014000000_project_phase_hosted_pilot.sql",
  ])
    await db.exec(read("supabase/migrations/" + name));
  // Only the older fixture needs these already-existing inventory/managed
  // Storage columns. No part of the migration is removed or mocked.
  await db.exec(
    "alter table public.parcels add column price_override_cents bigint; alter table public.parcels add column tier_key text; alter table public.parcels add column is_corner boolean not null default false; alter table storage.buckets add column file_size_limit bigint; alter table storage.buckets add column allowed_mime_types text[]",
  );
  const ph1 = await scalar(
    "select id from public.development_phases where project_id=$1 and is_default",
    [P1],
  );
  const ph2 = await scalar(
    "select id from public.development_phases where project_id=$1 and is_default",
    [P2],
  );
  await db.exec(
    read(
      "supabase/migrations/20261019194346_map_studio_packages_and_project_plot_content.sql",
    ),
  );
  passed(
    "actual additive migration compiles against the existing project/phase baseline",
  );
  const baselineQuery =
    "select jsonb_build_object('parcels',(select jsonb_agg(to_jsonb(p) order by id) from public.parcels p),'leads',(select jsonb_agg(to_jsonb(l) order by id) from public.leads l))";
  const baseline = await scalar(baselineQuery);
  const source = join(work, "three-plots.dxf");
  execFileSync(
    "python3",
    [
      "-c",
      "import importlib.util,sys; s=importlib.util.spec_from_file_location('f','test/map-studio/test_extraction.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.create_dxf(sys.argv[1])",
      source,
    ],
    { cwd: root },
  );
  const extracted = JSON.parse(
    execFileSync(
      "python3",
      [
        "scripts/map-studio/extract.py",
        "--source",
        source,
        "--name",
        "three-plots.dxf",
      ],
      { cwd: root, encoding: "utf8" },
    ),
  ).package;
  extracted.categories = [
    {
      key: "standard",
      label: "Standard",
      color: "#b5d5ad",
      price_cents: 2500000,
      currency: "BZD",
      price_basis: "Per plot",
    },
  ];
  for (const plot of extracted.plots) plot.category_key = "standard";
  const pkg = mapPackageCore(validateMapPackage(extracted));
  const stage = (value = pkg, t = T1, p = P1, ph = ph1) =>
    scalar("select public.stage_project_map_package($1,$2,$3,$4,null)", [
      t,
      p,
      ph,
      JSON.stringify(value),
    ]);
  await as(U1, "authenticated");
  const first = await stage();
  assert.equal(first.total, 3);
  assert.equal(first.new_plots, 3);
  const firstId = first.id,
    firstSnapshot = first.snapshot_id;
  await as();
  assert.equal(await scalar("select count(*)::int from public.parcels"), 1);
  assert.equal(
    await scalar("select public.get_published_project_map_package($1,$2,$3)", [
      T1,
      P1,
      ph1,
    ]),
    null,
  );
  passed(
    "DXF -> portable validator -> draft import, without creating saleable inventory",
  );
  await as(U1, "authenticated");
  assert.equal((await stage()).reused, true);
  await as();
  assert.equal(
    await scalar("select count(*)::int from public.map_feature_snapshots"),
    1,
  );
  passed("repeat import reuses one snapshot and stable plot identities");
  for (const [uid, role] of [
    [U2, "authenticated"],
    [U3, "authenticated"],
    ["", "anon"],
  ]) {
    await as(uid, role);
    await denied("select public.stage_project_map_package($1,$2,$3,$4,null)", [
      T1,
      P1,
      ph1,
      JSON.stringify(pkg),
    ]);
  }
  await as(U1, "authenticated");
  await denied("select public.stage_project_map_package($1,$2,$3,$4,null)", [
    T1,
    P2,
    ph1,
    JSON.stringify(pkg),
  ]);
  await denied("update public.map_features set public_visible=true");
  await as(U2, "authenticated");
  assert.equal(
    await scalar("select count(*)::int from public.project_map_packages"),
    0,
  );
  passed(
    "anonymous/staff/wrong tenant/inconsistent scope and direct mutation are denied",
  );
  const broken = structuredClone(pkg);
  broken.revision = 2;
  broken.plots[0].polygon = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 2 },
  ];
  await as(U1, "authenticated");
  await denied("select public.stage_project_map_package($1,$2,$3,$4,null)", [
    T1,
    P1,
    ph1,
    JSON.stringify(broken),
  ]);
  await as();
  assert.equal(
    await scalar("select count(*)::int from public.map_feature_snapshots"),
    1,
  );
  passed("invalid geometry rolls back the entire import");
  await as(U1, "authenticated");
  await denied("select public.publish_project_map_package($1,null,true)", [
    firstId,
  ]);
  await sql("select public.review_project_map_package($1)", [firstId]);
  await sql("select public.publish_project_map_package($1,null,true)", [
    firstId,
  ]);
  await as();
  let published = await scalar(
    "select public.get_published_project_map_package($1,$2,$3)",
    [T1, P1, ph1],
  );
  assert.equal(published.features.length, 3);
  assert.equal(published.features[0].price_cents, 2500000);
  assert.equal(published.features[0].area_value, 150);
  assert.ok(!JSON.stringify(published).includes("source_key"));
  assert.ok(!JSON.stringify(published).includes("source_polygon"));
  passed(
    "reviewed publish serves extracted numbers/areas and category pricing without source metadata",
  );
  const inquiryQuery = "select public.create_scoped_public_inquiry($1,$2,$3,'Studio fixture','fixture@example.test',null,'Question',null,'[]','studio-inquiry-retry',null,$4,null)";
  const inquiryFeature = published.features[0].map_feature_ref;
  await as(U1, "authenticated");
  await denied(inquiryQuery, [T1, P1, ph1, inquiryFeature]);
  await as("", "service_role");
  await denied(inquiryQuery, [T2, P2, ph2, inquiryFeature]);
  const inquiry = await scalar(inquiryQuery, [T1, P1, ph1, inquiryFeature]);
  assert.equal(inquiry.ok, true);
  assert.equal(inquiry.deduplicated, false);
  const retriedInquiry = await scalar(inquiryQuery, [T1, P1, ph1, inquiryFeature]);
  assert.equal(retriedInquiry.deduplicated, true);
  assert.equal(retriedInquiry.lead_id, inquiry.lead_id);
  await as();
  assert.equal(await scalar("select count(*)::int from public.follow_up_tasks where lead_id=$1", [inquiry.lead_id]), 1);
  await sql("update public.project_plot_content set public_visible=false where identity_id=$1", [inquiryFeature]);
  await as("", "service_role");
  await denied(inquiryQuery, [T1, P1, ph1, inquiryFeature]);
  await as();
  await sql("update public.project_plot_content set public_visible=true where identity_id=$1", [inquiryFeature]);
  await sql("delete from public.leads where id=$1", [inquiry.lead_id]);
  passed("published Studio inquiries work in sales projects, deduplicate and reject private/wrong-scope references");
  await as(U1, "authenticated");
  await denied("select public.get_published_project_map_package($1,$2,$3)", [
    T1,
    P1,
    ph1,
  ]);
  passed("published projection RPC is server-only");
  let content = await scalar(
    "select to_jsonb(p) from public.project_plot_content p order by plot_number limit 1",
  );
  const changed = { ...content, price_cents: 2712345 };
  await sql("select public.save_project_plot_content($1,$2,$3)", [
    content.identity_id,
    content.revision,
    JSON.stringify(changed),
  ]);
  await denied("select public.save_project_plot_content($1,$2,$3)", [
    content.identity_id,
    content.revision,
    JSON.stringify(content),
  ]);
  await as(U2, "authenticated");
  await denied("select public.save_project_plot_content($1,$2,$3)", [
    content.identity_id,
    2,
    JSON.stringify(changed),
  ]);
  await as();
  published = await scalar(
    "select public.get_published_project_map_package($1,$2,$3)",
    [T1, P1, ph1],
  );
  assert.equal(published.features[0].price_cents, 2712345);
  passed(
    "Admin edits drive published prices; stale and cross-tenant saves are rejected",
  );
  const revised = structuredClone(pkg);
  revised.revision = 2;
  revised.plots[0].polygon[0].x += 0.1;
  await as(U1, "authenticated");
  const second = await stage(revised);
  assert.equal(second.new_plots, 0);
  assert.equal(second.matched, 3);
  assert.equal(
    Number(
      await scalar(
        "select price_cents from public.project_plot_content where identity_id=$1",
        [content.identity_id],
      ),
    ),
    2712345,
  );
  await sql("select public.review_project_map_package($1)", [second.id]);
  await denied("select public.publish_project_map_package($1,null,true)", [
    second.id,
  ]);
  await sql("select public.publish_project_map_package($1,$2,true)", [
    second.id,
    firstSnapshot,
  ]);
  await as();
  assert.equal(
    await scalar("select count(*)::int from public.map_feature_identities"),
    3,
  );
  assert.equal(
    await scalar("select count(*)::int from public.map_feature_snapshots"),
    2,
  );
  assert.equal(
    await scalar(
      "select count(*)::int from public.map_feature_snapshots where is_active",
    ),
    1,
  );
  passed(
    "geometry revisions preserve Admin edits and history; stale publication is refused",
  );
  const parcel = await scalar("select id from public.parcels limit 1");
  await as(U1, "authenticated");
  content = await scalar(
    "select to_jsonb(p) from public.project_plot_content p where identity_id=$1",
    [content.identity_id],
  );
  content.parcel_id = parcel;
  await sql("select public.save_project_plot_content($1,$2,$3)", [
    content.identity_id,
    content.revision,
    JSON.stringify(content),
  ]);
  await as();
  published = await scalar(
    "select public.get_published_project_map_package($1,$2,$3)",
    [T1, P1, ph1],
  );
  assert.equal(published.features[0].plot_number, "EXISTING-1");
  assert.equal(published.features[0].price_cents, 1234500);
  assert.equal(published.features[0].currency, null);
  assert.equal(published.features[0].price_basis, null);
  const foreign = await scalar(
    "insert into public.parcels(tenant_id,project_id,phase_id,lot_number,status,base_price) values($1,$2,$3,'FOREIGN','Sold',50000) returning id",
    [T2, P2, ph2],
  );
  await as(U1, "authenticated");
  await denied("select public.save_project_plot_content($1,$2,$3)", [
    content.identity_id,
    content.revision + 1,
    JSON.stringify({ ...content, parcel_id: foreign }),
  ]);
  await as();
  await sql("delete from public.parcels where id=$1", [foreign]);
  passed(
    "existing inventory stays authoritative and cross-tenant parcel links fail atomically",
  );
  const path = `${T1}/${P1}/${ph1}/${"a".repeat(64)}.webp`;
  await as(U1, "authenticated");
  await sql(
    "insert into storage.objects(bucket_id,name) values('project-map-packages',$1)",
    [path],
  );
  assert.equal(
    (
      await sql(
        "delete from storage.objects where bucket_id='project-map-packages'",
      )
    ).affectedRows,
    0,
  );
  await as(U2, "authenticated");
  assert.equal(
    await scalar(
      "select count(*)::int from storage.objects where bucket_id='project-map-packages'",
    ),
    0,
  );
  await denied(
    "insert into storage.objects(bucket_id,name) values('project-map-packages',$1)",
    [path.replace("a".repeat(64), "b".repeat(64))],
  );
  await as();
  assert.equal(
    await scalar(
      "select public from storage.buckets where id='project-map-packages'",
    ),
    false,
  );
  passed("Storage SQL policies keep assets private, scoped and immutable");
  await as(U1, "authenticated");
  await sql("select public.publish_project_map_package($1,$2,true)", [
    firstId,
    second.snapshot_id,
  ]);
  await as();
  assert.equal(
    await scalar("select id from public.map_feature_snapshots where is_active"),
    firstSnapshot,
  );
  assert.deepEqual(await scalar(baselineQuery), baseline);
  passed(
    "earlier map can be republished; existing inventory and lead rows remain unchanged",
  );
  console.log(
    `# ${checks}/${checks} passed; local PostgreSQL WASM, synthetic CAD fixture, no hosted writes`,
  );
} finally {
  await db.close();
  rmSync(work, { recursive: true, force: true });
}
