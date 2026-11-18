-- Lot tier catalogue, parcel map extensions, and development updates.
--
-- Turns the one-off Hopkins Grove raster ingest into a repeatable,
-- tenant-scoped workflow:
-- - public.lot_tiers: per-tenant price/colour catalogue (source of truth for
--   tier labels and prices; parcels carry a denormalized tier_key for fast
--   embed reads instead of a strict FK so ingest ordering stays simple).
-- - public.parcels: tier_key, is_corner, price_override_cents,
--   geometry_source ('manual' | 'raster-auto' | 'cad'), confidence,
--   needs_review (QA queue), masterplan_version_id (which map the polygon
--   was aligned against; NULL = legacy/unversioned, always visible).
-- - public.development_updates: tenant news feed (PoC "Updates" panel).
-- - public.parcel_effective_price_cents(...): single SQL definition of the
--   effective-price formula, reused by parcel_board_view. The public edge
--   function mirrors it in TypeScript (see get-public-lots).
-- - public.parcel_board_view: extended with tier + QA columns; existing
--   pricing/selection semantics untouched.
--
-- Back-compat: all parcel columns are nullable or defaulted, so legacy rows
-- keep serving with base_price until a tier catalogue + ingest stamps them.
--
-- Idempotent: IF NOT EXISTS / DROP IF EXISTS / pg_constraint guards.
-- Deployment order: apply after 20260920000000. Do not edit history.

begin;

-- -----------------------------------------------------------------------------
-- 1. Table lot_tiers (per-tenant catalogue).
-- -----------------------------------------------------------------------------

create table if not exists public.lot_tiers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  tier_key text not null,
  label text not null,
  price_cents bigint not null,
  corner_premium_cents bigint not null default 0,
  color_hex text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lot_tiers_key_present check (tier_key ~ '^[a-z0-9_]+$'),
  constraint lot_tiers_label_present check (length(trim(label)) > 0),
  constraint lot_tiers_price_nonnegative check (price_cents >= 0),
  constraint lot_tiers_corner_premium_nonnegative check (corner_premium_cents >= 0),
  constraint lot_tiers_color_hex check (color_hex ~ '^#[0-9a-fA-F]{6}$')
);

do $$
begin
  if to_regclass('public.lot_tiers') is not null
     and not exists (
       select 1 from pg_constraint
       where conname = 'uniq_lot_tiers_tenant_key'
         and conrelid = 'public.lot_tiers'::regclass
     ) then
    alter table public.lot_tiers
      add constraint uniq_lot_tiers_tenant_key unique (tenant_id, tier_key);
  end if;
end;
$$;

create index if not exists idx_lot_tiers_tenant_id
  on public.lot_tiers(tenant_id);
create index if not exists idx_lot_tiers_tenant_active
  on public.lot_tiers(tenant_id, is_active, sort_order);

comment on table public.lot_tiers is 'Per-tenant lot tier catalogue (labels, prices, map colours). Source of truth for tier display; parcels denormalize tier_key for fast reads.';
comment on column public.lot_tiers.price_cents is 'Base price in cents (BZD). Public embeds show dollars.';
comment on column public.lot_tiers.corner_premium_cents is 'Surcharge in cents for corner lots (parcels.is_corner).';

-- Tenant-defaulting (consistent with the other scoped tables).
drop trigger if exists trg_set_default_tenant_id on public.lot_tiers;
create trigger trg_set_default_tenant_id
before insert on public.lot_tiers
for each row execute function public.set_default_tenant_id();

drop trigger if exists trg_lot_tiers_updated_at on public.lot_tiers;
create trigger trg_lot_tiers_updated_at
before update on public.lot_tiers
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Table development_updates (tenant news feed).
-- -----------------------------------------------------------------------------

create table if not exists public.development_updates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  date date not null default current_date,
  tag text not null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,

  constraint development_updates_tag_present check (length(trim(tag)) > 0),
  constraint development_updates_body_present check (length(trim(body)) > 0)
);

create index if not exists idx_development_updates_tenant_date
  on public.development_updates(tenant_id, date desc);

comment on table public.development_updates is 'Per-tenant news feed surfaced on the public lot map (PoC Updates panel).';

drop trigger if exists trg_set_default_tenant_id on public.development_updates;
create trigger trg_set_default_tenant_id
before insert on public.development_updates
for each row execute function public.set_default_tenant_id();

drop trigger if exists trg_development_updates_updated_at on public.development_updates;
create trigger trg_development_updates_updated_at
before update on public.development_updates
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. Parcels extensions (all nullable/defaulted: legacy rows keep working).
-- -----------------------------------------------------------------------------

alter table public.parcels
  add column if not exists tier_key text,
  add column if not exists is_corner boolean not null default false,
  add column if not exists price_override_cents bigint,
  add column if not exists geometry_source text not null default 'manual',
  add column if not exists confidence numeric(4,3),
  add column if not exists needs_review boolean not null default false,
  add column if not exists masterplan_version_id uuid;

do $$
begin
  if to_regclass('public.parcels') is not null then
    if not exists (
      select 1 from pg_constraint
      where conname = 'parcels_geometry_source_valid'
        and conrelid = 'public.parcels'::regclass
    ) then
      alter table public.parcels
        add constraint parcels_geometry_source_valid
        check (geometry_source in ('manual', 'raster-auto', 'cad'));
    end if;
    if not exists (
      select 1 from pg_constraint
      where conname = 'parcels_confidence_range'
        and conrelid = 'public.parcels'::regclass
    ) then
      alter table public.parcels
        add constraint parcels_confidence_range
        check (confidence is null or (confidence >= 0 and confidence <= 1));
    end if;
    if not exists (
      select 1 from pg_constraint
      where conname = 'parcels_price_override_nonnegative'
        and conrelid = 'public.parcels'::regclass
    ) then
      alter table public.parcels
        add constraint parcels_price_override_nonnegative
        check (price_override_cents is null or price_override_cents >= 0);
    end if;
    if not exists (
      select 1 from pg_constraint
      where conname = 'fk_parcels_masterplan_version_id'
        and conrelid = 'public.parcels'::regclass
    ) then
      alter table public.parcels
        add constraint fk_parcels_masterplan_version_id
        foreign key (masterplan_version_id)
        references public.masterplan_versions(id)
        on delete set null;
    end if;
  end if;
end;
$$;

create index if not exists idx_parcels_tier_key
  on public.parcels(tenant_id, tier_key);
create index if not exists idx_parcels_masterplan_version_id
  on public.parcels(masterplan_version_id);
-- Review queue: unaligned / low-confidence lots awaiting staff QA.
create index if not exists idx_parcels_review_queue
  on public.parcels(tenant_id)
  where needs_review = true;

comment on column public.parcels.tier_key is 'Denormalized lot_tiers.tier_key for fast embed reads (no strict FK; catalogue is source of truth). NULL = unclassified legacy lot.';
comment on column public.parcels.is_corner is 'Corner lot: adds lot_tiers.corner_premium_cents to the effective price.';
comment on column public.parcels.price_override_cents is 'Per-lot price override in cents. Wins over the tier formula when set.';
comment on column public.parcels.geometry_source is 'How map_polygon was produced: manual draw, raster-auto ingest, or cad import.';
comment on column public.parcels.confidence is 'Detector confidence 0..1 for auto-ingested polygons. Admin-only; never public.';
comment on column public.parcels.needs_review is 'QA flag for low-confidence polygons. Admin-only; never public.';
comment on column public.parcels.masterplan_version_id is 'Map version the polygon was aligned against. NULL = legacy/unversioned (always publicly visible).';

-- -----------------------------------------------------------------------------
-- 4. Effective-price function (single SQL definition of the formula).
--    Plain immutable SQL (no SECURITY DEFINER): no search_path exposure, so
--    the hardening sweep has nothing to pin. The public edge function mirrors
--    this formula in TypeScript.
-- -----------------------------------------------------------------------------

create or replace function public.parcel_effective_price_cents(
  p_price_override_cents bigint,
  p_tier_price_cents bigint,
  p_tier_corner_premium_cents bigint,
  p_is_corner boolean,
  p_base_price numeric
)
returns bigint
language sql
immutable
as $$
  select coalesce(
    p_price_override_cents,
    case
      when p_tier_price_cents is not null then
        p_tier_price_cents
        + case
            when coalesce(p_is_corner, false) then coalesce(p_tier_corner_premium_cents, 0)
            else 0
          end
    end,
    (coalesce(p_base_price, 0) * 100)::bigint
  );
$$;

comment on function public.parcel_effective_price_cents(bigint, bigint, bigint, boolean, numeric) is 'Effective lot price in cents: per-lot override wins, else tier price (+ corner premium for corner lots), else legacy base_price fallback so unclassified rows keep serving.';

-- -----------------------------------------------------------------------------
-- 5. parcel_board_view: append tier + QA columns (existing semantics untouched).
--    DROP + CREATE (not OR REPLACE): Postgres forbids positional column changes
--    via CREATE OR REPLACE (42P16).
-- -----------------------------------------------------------------------------

drop view if exists public.parcel_board_view cascade;
create view public.parcel_board_view as
select
  p.id,
  p.tenant_id,
  p.lot_number,
  coalesce(ls.dimensions, p.dimensions) as dimensions,
  p.zoning,
  p.status,
  coalesce(nullif(p.base_price, 0), ls.default_price, p.base_price) as base_price,
  p.created_at,
  p.updated_at,
  p.lot_size_id,
  ls.name as lot_size_name,
  p.map_polygon,
  p.tier_key,
  t.label as tier_label,
  t.color_hex as tier_color_hex,
  t.price_cents as tier_price_cents,
  p.is_corner,
  p.price_override_cents,
  public.parcel_effective_price_cents(
    p.price_override_cents, t.price_cents, t.corner_premium_cents, p.is_corner, p.base_price
  ) as effective_price_cents,
  p.geometry_source,
  p.confidence,
  p.needs_review,
  p.masterplan_version_id,
  c.id as contract_id,
  cu.id as customer_id,
  trim(cu.first_name || ' ' || cu.last_name) as customer_name
from public.parcels p
left join public.lot_sizes ls on ls.id = p.lot_size_id
left join public.lot_tiers t on t.tenant_id = p.tenant_id and t.tier_key = p.tier_key
left join public.contracts c on c.parcel_id = p.id and c.is_active
left join public.customers cu on cu.id = c.customer_id
order by p.lot_number;

grant select on public.parcel_board_view to authenticated;

-- -----------------------------------------------------------------------------
-- 6. RLS: permissive role policies + restrictive tenant isolation.
--    Mirrors masterplan_versions (20260919000000 §4).
-- -----------------------------------------------------------------------------

alter table public.lot_tiers enable row level security;
alter table public.development_updates enable row level security;

drop policy if exists "Internal can read lot tiers" on public.lot_tiers;
create policy "Internal can read lot tiers"
on public.lot_tiers
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create lot tiers" on public.lot_tiers;
create policy "Staff can create lot tiers"
on public.lot_tiers
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Staff can update lot tiers" on public.lot_tiers;
create policy "Staff can update lot tiers"
on public.lot_tiers
for update
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists "Admins can delete lot tiers" on public.lot_tiers;
create policy "Admins can delete lot tiers"
on public.lot_tiers
for delete
to authenticated
using (public.is_admin_user());

drop policy if exists tenant_isolation on public.lot_tiers;
create policy tenant_isolation
on public.lot_tiers
as restrictive
for all
to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "Internal can read development updates" on public.development_updates;
create policy "Internal can read development updates"
on public.development_updates
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create development updates" on public.development_updates;
create policy "Staff can create development updates"
on public.development_updates
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Staff can update development updates" on public.development_updates;
create policy "Staff can update development updates"
on public.development_updates
for update
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists "Admins can delete development updates" on public.development_updates;
create policy "Admins can delete development updates"
on public.development_updates
for delete
to authenticated
using (public.is_admin_user());

drop policy if exists tenant_isolation on public.development_updates;
create policy tenant_isolation
on public.development_updates
as restrictive
for all
to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

grant select, insert, update, delete on public.lot_tiers to authenticated;
grant select, insert, update, delete on public.development_updates to authenticated;

commit;
