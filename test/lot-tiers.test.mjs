import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const MIGRATION = "supabase/migrations/20260921000000_lot_tiers_and_parcel_extensions.sql";

test("lot_tiers catalogue is tenant-scoped with price/colour guards", async () => {
  const migration = await read(MIGRATION);

  assert.match(migration, /create table if not exists public\.lot_tiers/);
  assert.match(migration, /tenant_id uuid not null references public\.organizations\(id\) on delete cascade/);
  for (const column of ["tier_key", "label", "price_cents", "corner_premium_cents", "color_hex", "is_active", "sort_order"]) {
    assert.ok(migration.includes(column), `lot_tiers must declare ${column}`);
  }
  // Catalogue integrity: unique key per tenant, non-negative cents, hex colour.
  assert.match(migration, /uniq_lot_tiers_tenant_key.*unique \(tenant_id, tier_key\)/s);
  assert.match(migration, /lot_tiers_price_nonnegative check \(price_cents >= 0\)/);
  assert.match(migration, /lot_tiers_corner_premium_nonnegative check \(corner_premium_cents >= 0\)/);
  assert.match(migration, /color_hex ~ '\^#\[0-9a-fA-F\]\{6\}\$'/);
  assert.match(migration, /idx_lot_tiers_tenant_active/);
});

test("parcels extensions are back-compatible (nullable/defaulted) with QA + version columns", async () => {
  const migration = await read(MIGRATION);

  assert.match(migration, /add column if not exists tier_key/);
  assert.match(migration, /add column if not exists is_corner boolean not null default false/);
  assert.match(migration, /add column if not exists price_override_cents/);
  assert.match(migration, /add column if not exists geometry_source text not null default 'manual'/);
  assert.match(migration, /add column if not exists confidence numeric\(4,3\)/);
  assert.match(migration, /add column if not exists needs_review boolean not null default false/);
  assert.match(migration, /add column if not exists masterplan_version_id uuid/);
  // Guards: source enum, confidence range, override floor, version FK.
  assert.match(migration, /geometry_source in \('manual', 'raster-auto', 'cad'\)/);
  assert.match(migration, /confidence is null or \(confidence >= 0 and confidence <= 1\)/);
  assert.match(migration, /price_override_cents is null or price_override_cents >= 0/);
  assert.match(migration, /fk_parcels_masterplan_version_id[\s\S]*?references public\.masterplan_versions\(id\)/);
  assert.match(migration, /on delete set null/);
  // Review-queue partial index + version index.
  assert.match(migration, /idx_parcels_review_queue[\s\S]*?where needs_review = true/);
  assert.match(migration, /idx_parcels_masterplan_version_id/);
});

test("development_updates table carries the tenant news feed", async () => {
  const migration = await read(MIGRATION);

  assert.match(migration, /create table if not exists public\.development_updates/);
  assert.match(migration, /tenant_id uuid not null references public\.organizations\(id\) on delete cascade/);
  for (const column of ["date", "tag", "body"]) {
    assert.ok(migration.includes(column), `development_updates must declare ${column}`);
  }
  assert.match(migration, /idx_development_updates_tenant_date/);
});

test("effective-price formula prefers override, then tier+corner, then legacy base_price", async () => {
  const migration = await read(MIGRATION);

  const fnMatch = migration.match(
    /create or replace function public\.parcel_effective_price_cents\([\s\S]*?^\$\$;/m,
  );
  assert.ok(fnMatch, "parcel_effective_price_cents function must be defined.");
  assert.match(fnMatch[0], /language sql/);
  assert.match(fnMatch[0], /immutable/);
  // Plain SQL (not SECURITY DEFINER): nothing for the hardening sweep to pin.
  assert.doesNotMatch(fnMatch[0], /security definer/i);
  // Precedence: override first, tier+corner second, base_price fallback last.
  const coalesce = fnMatch[0].indexOf("coalesce(");
  assert.ok(coalesce >= 0, "Formula must be a coalesce chain.");
  const tail = fnMatch[0].slice(coalesce);
  assert.ok(
    tail.indexOf("p_price_override_cents") < tail.indexOf("p_tier_price_cents") &&
      tail.indexOf("p_tier_price_cents") < tail.indexOf("p_base_price"),
    "Precedence must be override -> tier -> base_price.",
  );
  assert.match(fnMatch[0], /coalesce\(p_is_corner, false\)/);
  assert.match(fnMatch[0], /\(coalesce\(p_base_price, 0\) \* 100\)::bigint/);
});

test("parcel_board_view gains tier + QA columns without changing existing semantics", async () => {
  const migration = await read(MIGRATION);

  assert.match(migration, /drop view if exists public\.parcel_board_view cascade;/);
  assert.match(migration, /left join public\.lot_tiers t on t\.tenant_id = p\.tenant_id and t\.tier_key = p\.tier_key/);
  for (const column of [
    "p.tier_key",
    "t.label as tier_label",
    "t.color_hex as tier_color_hex",
    "effective_price_cents",
    "p.geometry_source",
    "p.confidence",
    "p.needs_review",
    "p.masterplan_version_id",
  ]) {
    assert.ok(migration.includes(column), `parcel_board_view must select ${column}`);
  }
  // Existing pricing/selection semantics untouched.
  assert.match(migration, /coalesce\(nullif\(p\.base_price, 0\), ls\.default_price, p\.base_price\) as base_price/);
  assert.match(migration, /grant select on public\.parcel_board_view to authenticated;/);
});

test("new tables follow tenant RLS + idempotent deployment conventions", async () => {
  const migration = await read(MIGRATION);

  for (const table of ["lot_tiers", "development_updates"]) {
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security;`),
      `${table} must enable RLS.`,
    );
    const isolationBlock = [
      "create policy tenant_isolation",
      `on public.${table}`,
      "as restrictive",
      "for all",
      "to authenticated",
      "using (public.user_has_tenant_access(tenant_id))",
      "with check (public.user_has_tenant_access(tenant_id))",
    ].join("\n");
    assert.ok(
      migration.includes(isolationBlock),
      `${table} must carry the restrictive tenant_isolation policy keyed on user_has_tenant_access(tenant_id).`,
    );
    assert.match(
      migration,
      new RegExp(`grant select, insert, update, delete on public\\.${table} to authenticated;`),
      `${table} must grant scoped access to authenticated.`,
    );
    assert.match(
      migration,
      new RegExp(`create trigger trg_set_default_tenant_id\\s+before insert on public\\.${table}`, "s"),
      `${table} must default tenant_id on insert.`,
    );
  }
  // Deployment order + rerun safety.
  assert.match(migration, /apply after 20260920000000/);
  assert.match(migration, /Do not edit history/);
});
