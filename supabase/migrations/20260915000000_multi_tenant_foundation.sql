-- Multi-tenant foundation for Wamule Staged.
--
-- Converts the single-tenant schema (~40 tables) to a shared-database,
-- tenant-isolated model using public.organizations + tenant_id + RLS.
--
-- Design notes:
-- - Idempotent where possible (IF NOT EXISTS / ON CONFLICT DO NOTHING /
--   DROP ... IF EXISTS + pg_constraint guards) so `supabase db push` reruns safely.
-- - Existing production rows are backfilled to the default tenant
--   'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' ('default-client').
-- - Super Admins bypass tenant checks via public.is_super_admin_user().
-- - Row enforcement uses RESTRICTIVE tenant policies (ANDed with the existing
--   ~223 permissive role policies) so no existing policy needs rewriting.
-- - Anon public reads (public application form) are intentionally left unscoped
--   in this foundation; per-tenant public resolution (slug/subdomain) is follow-up.
-- - Config singletons/uniques are converted to composite (tenant_id, key) forms
--   so a second tenant can insert its own settings/plans/fees.
--
-- Deployment order: apply after 20260715050000. Do not edit history.

begin;

-- -----------------------------------------------------------------------------
-- 0. Prerequisites
-- -----------------------------------------------------------------------------
create extension if not exists pgcrypto;

-- Ensure the generic updated_at trigger function exists (foundation defines it,
-- but staged envs with partial history may lack it).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 1. CREATION OF ORGANIZATIONS TABLE
-- -----------------------------------------------------------------------------
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  inbound_alias text unique,
  gemini_api_key text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint organizations_name_present check (length(trim(name)) > 0),
  constraint organizations_slug_present check (length(trim(slug)) > 0)
);

create unique index if not exists uniq_organizations_slug
  on public.organizations(lower(slug));

create unique index if not exists uniq_organizations_inbound_alias
  on public.organizations(lower(inbound_alias))
  where inbound_alias is not null;

drop trigger if exists trg_organizations_updated_at on public.organizations;
create trigger trg_organizations_updated_at
before update on public.organizations
for each row execute function public.set_updated_at();

alter table public.organizations enable row level security;

drop policy if exists "Organizations readable by internal users" on public.organizations;
create policy "Organizations readable by internal users"
on public.organizations
for select
to authenticated
using (public.is_internal_user() or public.is_super_admin_user());

drop policy if exists "Organizations manageable by super admins" on public.organizations;
create policy "Organizations manageable by super admins"
on public.organizations
for all
to authenticated
using (public.is_super_admin_user())
with check (public.is_super_admin_user());

grant select on public.organizations to authenticated;

comment on table public.organizations is 'Tenants (real-estate developer organizations) sharing one database. Data isolation via tenant_id + RLS; Super Admins bypass.';
comment on column public.organizations.inbound_alias is 'Unique inbound email alias for payment-proof ingestion, e.g. oceanview-payments@inbound.streetside.com';
comment on column public.organizations.gemini_api_key is 'Optional tenant-specific Gemini override. Falls back to server-side GEMINI_API_KEY secret.';

-- -----------------------------------------------------------------------------
-- 2. INITIAL DEFAULT TENANT SEED
-- -----------------------------------------------------------------------------
INSERT INTO public.organizations (id, name, slug) VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Default Client', 'default-client') ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. THREAD TENANT_ID ACROSS ALL PUBLIC TABLES
--    Adds tenant_id uuid -> organizations(id), backfills default, indexes.
-- -----------------------------------------------------------------------------
do $$
declare
  tbl text;
  tables_to_scope text[] := array[
    -- Core
    'parcels', 'applications', 'customers', 'contracts', 'transactions',
    -- Payments
    'payment_documents', 'payment_requests', 'payment_methods', 'receipt_jobs', 'installment_plans',
    -- Configuration
    'business_settings', 'lot_sizes', 'fee_types', 'community_fee_settings',
    -- Pipeline
    'leads', 'lead_activities', 'follow_up_tasks', 'site_visits',
    -- Reservations
    'lot_reservations', 'reservation_activities',
    -- Post-sales
    'post_sales_checklists', 'post_sales_tasks', 'post_sales_activities',
    -- AI Layer
    'ai_settings', 'application_ai_reviews', 'ai_daily_briefs', 'customer_ai_summaries',
    'lead_ai_summaries', 'post_sales_ai_summaries',
    -- Ops/Notifications
    'brief_action_items', 'email_notifications', 'notification_settings', 'developer_feedback',
    'audit_events', 'contract_void_resolutions',
    -- Information Centre
    'information_topics', 'information_requests', 'information_request_topics', 'information_packs'
  ];
begin
  foreach tbl in array tables_to_scope loop
    if to_regclass('public.' || tbl) is null then
      raise notice 'multi-tenant: table public.% does not exist, skipping tenant_id add', tbl;
      continue;
    end if;

    -- 3a. Column (FK added separately so reruns add missing constraint).
    execute format('alter table public.%I add column if not exists tenant_id uuid', tbl);

    -- 3b. FK -> organizations (explicit name for idempotent drops).
    if not exists (
      select 1 from pg_constraint
      where conname = 'fk_' || tbl || '_tenant_id'
        and conrelid = ('public.' || tbl)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (tenant_id) references public.organizations(id) on delete restrict',
        tbl, 'fk_' || tbl || '_tenant_id'
      );
    end if;

    -- 3c. Index for tenant-filtered queries + RLS performance.
    execute format(
      'create index if not exists idx_%I_tenant_id on public.%I(tenant_id)',
      tbl, tbl
    );

    -- 3d. Ensure RLS stays enabled (idempotent).
    execute format('alter table public.%I enable row level security', tbl);
  end loop;
end;
$$;

-- 3e. BACKFILL existing rows to the default tenant (idempotent: only NULLs).
do $$
declare
  tbl text;
  tables_to_scope text[] := array[
    'parcels', 'applications', 'customers', 'contracts', 'transactions',
    'payment_documents', 'payment_requests', 'payment_methods', 'receipt_jobs', 'installment_plans',
    'business_settings', 'lot_sizes', 'fee_types', 'community_fee_settings',
    'leads', 'lead_activities', 'follow_up_tasks', 'site_visits',
    'lot_reservations', 'reservation_activities',
    'post_sales_checklists', 'post_sales_tasks', 'post_sales_activities',
    'ai_settings', 'application_ai_reviews', 'ai_daily_briefs', 'customer_ai_summaries',
    'lead_ai_summaries', 'post_sales_ai_summaries',
    'brief_action_items', 'email_notifications', 'notification_settings', 'developer_feedback',
    'audit_events', 'contract_void_resolutions',
    'information_topics', 'information_requests', 'information_request_topics', 'information_packs'
  ];
begin
  foreach tbl in array tables_to_scope loop
    if to_regclass('public.' || tbl) is null then
      continue;
    end if;
    execute format(
      'update public.%I set tenant_id = %L::uuid where tenant_id is null',
      tbl, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
    );
  end loop;
end;
$$;

-- 3f. CONSTRAINT: tenant_id NOT NULL on all scoped tables (after backfill).
--     Rerunning SET NOT NULL on an already-NOT-NULL column is a no-op.
--     admin_profiles is handled separately (nullable for Super Admin).
do $$
declare
  tbl text;
  tables_to_scope text[] := array[
    'parcels', 'applications', 'customers', 'contracts', 'transactions',
    'payment_documents', 'payment_requests', 'payment_methods', 'receipt_jobs', 'installment_plans',
    'business_settings', 'lot_sizes', 'fee_types', 'community_fee_settings',
    'leads', 'lead_activities', 'follow_up_tasks', 'site_visits',
    'lot_reservations', 'reservation_activities',
    'post_sales_checklists', 'post_sales_tasks', 'post_sales_activities',
    'ai_settings', 'application_ai_reviews', 'ai_daily_briefs', 'customer_ai_summaries',
    'lead_ai_summaries', 'post_sales_ai_summaries',
    'brief_action_items', 'email_notifications', 'notification_settings', 'developer_feedback',
    'audit_events', 'contract_void_resolutions',
    'information_topics', 'information_requests', 'information_request_topics', 'information_packs'
  ];
begin
  foreach tbl in array tables_to_scope loop
    if to_regclass('public.' || tbl) is null then
      continue;
    end if;
    -- Fail fast if any NULL remains (operator must backfill before retry).
    execute format('alter table public.%I alter column tenant_id set not null', tbl);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. TENANT-SCOPED CONSTRAINTS & EXTENSIONS
-- -----------------------------------------------------------------------------

-- 4a. parcels.map_polygon for the interactive lot-map visualizer.
--     Relative percentage coordinates, e.g. '[{"x":10.5,"y":20},{"x":30,"y":20}]'.
alter table public.parcels
  add column if not exists map_polygon jsonb default '[]'::jsonb;

comment on column public.parcels.map_polygon is 'Relative percentage coordinates for the interactive lot map visualizer. Array of {x,y} points; [] = unmapped.';

-- 4b. parcels(lot_number) single-tenant unique -> composite (tenant_id, lot_number).
alter table public.parcels
  drop constraint if exists parcels_lot_number_unique;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'uniq_parcels_tenant_lot'
      and conrelid = 'public.parcels'::regclass
  ) then
    alter table public.parcels
      add constraint uniq_parcels_tenant_lot unique (tenant_id, lot_number);
  end if;
end;
$$;

create index if not exists idx_parcels_tenant_status
  on public.parcels(tenant_id, status);

-- 4c. Config tables: single-tenant PKs/uniques -> tenant-scoped composites.
--     Required so a second tenant can insert its own keys/plans/fees.
--     All existing rows share the default tenant, so no duplicate violations.

-- business_settings: PK (key) -> PK (tenant_id, key).
do $$
begin
  if to_regclass('public.business_settings') is not null
     and exists (select 1 from pg_constraint where conname = 'business_settings_pkey') then
    alter table public.business_settings drop constraint business_settings_pkey;
  end if;
  if to_regclass('public.business_settings') is not null
     and not exists (select 1 from pg_constraint where conname = 'business_settings_pkey') then
    alter table public.business_settings add constraint business_settings_pkey primary key (tenant_id, key);
  end if;
end;
$$;

-- community_fee_settings: singleton PK (id) -> PK (tenant_id) with id kept for compat.
-- Existing app code filters `where id = true`; multi-tenant callers must now
-- filter `where tenant_id = get_current_user_tenant_id()`.
do $$
begin
  if to_regclass('public.community_fee_settings') is not null
     and exists (select 1 from pg_constraint where conname = 'community_fee_settings_pkey') then
    alter table public.community_fee_settings drop constraint community_fee_settings_pkey;
  end if;
  if to_regclass('public.community_fee_settings') is not null
     and not exists (select 1 from pg_constraint where conname = 'community_fee_settings_pkey') then
    alter table public.community_fee_settings add constraint community_fee_settings_pkey primary key (tenant_id);
  end if;
end;
$$;

-- notification_settings: UNIQUE (notification_type) -> UNIQUE (tenant_id, notification_type).
do $$
begin
  if to_regclass('public.notification_settings') is not null
     and exists (select 1 from pg_constraint where conname = 'uniq_notification_settings_type') then
    alter table public.notification_settings drop constraint uniq_notification_settings_type;
  end if;
  if to_regclass('public.notification_settings') is not null
     and not exists (select 1 from pg_constraint where conname = 'uniq_notification_settings_tenant_type') then
    alter table public.notification_settings
      add constraint uniq_notification_settings_tenant_type unique (tenant_id, notification_type);
  end if;
end;
$$;

-- installment_plans: UNIQUE (name) -> UNIQUE (tenant_id, name).
do $$
begin
  if to_regclass('public.installment_plans') is not null
     and exists (select 1 from pg_constraint where conname = 'installment_plans_name_key') then
    alter table public.installment_plans drop constraint installment_plans_name_key;
  end if;
  if to_regclass('public.installment_plans') is not null
     and not exists (select 1 from pg_constraint where conname = 'uniq_installment_plans_tenant_name') then
    alter table public.installment_plans
      add constraint uniq_installment_plans_tenant_name unique (tenant_id, name);
  end if;
end;
$$;

-- payment_methods / lot_sizes / fee_types: lower(name) unique indexes -> composite with tenant_id.
drop index if exists public.uniq_payment_methods_name;
create unique index if not exists uniq_payment_methods_tenant_name
  on public.payment_methods(tenant_id, lower(name));

drop index if exists public.uniq_lot_sizes_name;
create unique index if not exists uniq_lot_sizes_tenant_name
  on public.lot_sizes(tenant_id, lower(name));

drop index if exists public.uniq_fee_types_name;
create unique index if not exists uniq_fee_types_tenant_name
  on public.fee_types(tenant_id, lower(name));

-- information_topics: UNIQUE (code) -> UNIQUE (tenant_id, code).
do $$
begin
  if to_regclass('public.information_topics') is not null
     and exists (select 1 from pg_constraint where conname = 'information_topics_code_key') then
    alter table public.information_topics drop constraint information_topics_code_key;
  end if;
  if to_regclass('public.information_topics') is not null
     and not exists (select 1 from pg_constraint where conname = 'uniq_information_topics_tenant_code') then
    alter table public.information_topics
      add constraint uniq_information_topics_tenant_code unique (tenant_id, code);
  end if;
end;
$$;

-- NOTE: admin_profiles.email stays globally unique (one login per email across tenants).

-- -----------------------------------------------------------------------------
-- 5. LINK ADMIN PROFILES TO TENANTS
--    Nullable for Super Admin (cross-tenant support); required otherwise.
-- -----------------------------------------------------------------------------
alter table public.admin_profiles
  add column if not exists tenant_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'fk_admin_profiles_tenant_id'
      and conrelid = 'public.admin_profiles'::regclass
  ) then
    alter table public.admin_profiles
      add constraint fk_admin_profiles_tenant_id
      foreign key (tenant_id) references public.organizations(id) on delete restrict;
  end if;
end;
$$;

create index if not exists idx_admin_profiles_tenant_id
  on public.admin_profiles(tenant_id);

-- Backfill existing profiles (including Super Admins) to the default tenant so
-- current logins keep working. Future Super Admins may be created with NULL.
update public.admin_profiles
set tenant_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid
where tenant_id is null;

-- Conditional NOT NULL via CHECK (plain SET NOT NULL would block NULL Super Admins).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_admin_profiles_tenant_or_super_admin'
      and conrelid = 'public.admin_profiles'::regclass
  ) then
    alter table public.admin_profiles
      add constraint chk_admin_profiles_tenant_or_super_admin
      check (tenant_id is not null or role::text = 'Super Admin');
  end if;
end;
$$;

comment on column public.admin_profiles.tenant_id is 'Tenant scope. NULL only for Super Admin (cross-tenant support).';

-- -----------------------------------------------------------------------------
-- 6. UPDATE RLS SECURITY DEFINER HELPERS
-- -----------------------------------------------------------------------------
create or replace function public.get_current_user_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select ap.tenant_id
  from public.admin_profiles ap
  where ap.user_id = auth.uid()
  limit 1;
$$;

comment on function public.get_current_user_tenant_id() is 'Returns the caller tenant_id from admin_profiles for auth.uid(). NULL for unknown users and NULL-tenant Super Admins.';

create or replace function public.is_super_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_profiles ap
    where ap.user_id = auth.uid()
      and ap.role::text = 'Super Admin'
  );
$$;

create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_profiles ap
    where ap.user_id = auth.uid()
      and ap.role::text in ('Super Admin', 'Admin')
  );
$$;

-- Tenant-aware: caller must have a profile; non-Super-Admins must belong to a tenant.
create or replace function public.is_internal_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_profiles ap
    where ap.user_id = auth.uid()
      and ap.role::text in ('Super Admin', 'Admin', 'Staff', 'Read Only')
      and (ap.tenant_id is not null or ap.role::text = 'Super Admin')
  );
$$;

-- Tenant-aware: write roles must belong to a tenant (or be Super Admin).
create or replace function public.can_write_admin_data()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_profiles ap
    where ap.user_id = auth.uid()
      and ap.role::text in ('Super Admin', 'Admin', 'Staff')
      and (ap.tenant_id is not null or ap.role::text = 'Super Admin')
  );
$$;

-- Row-level tenant check used by RESTRICTIVE policies below.
create or replace function public.user_has_tenant_access(row_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    row_tenant_id is not null
    and (
      row_tenant_id = public.get_current_user_tenant_id()
      or public.is_super_admin_user()
    );
$$;

comment on function public.user_has_tenant_access(uuid) is 'True when row_tenant_id equals the caller tenant or caller is Super Admin.';

-- -----------------------------------------------------------------------------
-- 7. REFACTOR RLS POLICIES FOR TENANT ISOLATION
--    RESTRICTIVE policies AND with existing permissive role policies, so the
--    ~223 existing statements keep working and tenant isolation is enforced.
-- -----------------------------------------------------------------------------
do $$
declare
  tbl text;
  scoped_tables text[] := array[
    'parcels', 'applications', 'customers', 'contracts', 'transactions',
    'payment_documents', 'payment_requests', 'payment_methods', 'receipt_jobs', 'installment_plans',
    'business_settings', 'lot_sizes', 'fee_types', 'community_fee_settings',
    'leads', 'lead_activities', 'follow_up_tasks', 'site_visits',
    'lot_reservations', 'reservation_activities',
    'post_sales_checklists', 'post_sales_tasks', 'post_sales_activities',
    'ai_settings', 'application_ai_reviews', 'ai_daily_briefs', 'customer_ai_summaries',
    'lead_ai_summaries', 'post_sales_ai_summaries',
    'brief_action_items', 'email_notifications', 'notification_settings', 'developer_feedback',
    'audit_events', 'contract_void_resolutions',
    'information_topics', 'information_requests', 'information_request_topics', 'information_packs'
  ];
begin
  foreach tbl in array scoped_tables loop
    if to_regclass('public.' || tbl) is null then
      raise notice 'multi-tenant: table public.% missing, skipping tenant policy', tbl;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', tbl);
    execute format('drop policy if exists tenant_isolation on public.%I', tbl);
    execute format(
      'create policy tenant_isolation on public.%I as restrictive for all to authenticated '
      'using (public.user_has_tenant_access(tenant_id)) '
      'with check (public.user_has_tenant_access(tenant_id))',
      tbl
    );
  end loop;
end;
$$;

-- admin_profiles: same-tenant visibility + self-read (for provisioning) + Super Admin bypass.
drop policy if exists tenant_isolation_admin_profiles on public.admin_profiles;
create policy tenant_isolation_admin_profiles
on public.admin_profiles
as restrictive
for all
to authenticated
using (
  public.is_super_admin_user()
  or user_id = auth.uid()
  or (
    tenant_id is not null
    and tenant_id = public.get_current_user_tenant_id()
  )
)
with check (
  public.is_super_admin_user()
  or user_id = auth.uid()
  or (
    tenant_id is not null
    and tenant_id = public.get_current_user_tenant_id()
  )
);

-- organizations: readable by internal users (permissive policies in §1 already scope
-- management to Super Admin). No restrictive policy here so tenant switching stays possible.
grant select on public.organizations to authenticated;

-- -----------------------------------------------------------------------------
-- 8. TENANT-AWARE VIEWS (frontend filtering without breaking grants)
-- -----------------------------------------------------------------------------
-- DROP + CREATE (not OR REPLACE): Postgres forbids reordering/inserting view
-- columns positionally via CREATE OR REPLACE (42P16).
drop view if exists public.public_parcel_options cascade;
create view public.public_parcel_options as
select
  p.id,
  p.tenant_id,
  p.lot_number,
  coalesce(ls.dimensions, p.dimensions) as dimensions,
  p.zoning,
  p.status,
  coalesce(nullif(p.base_price, 0), ls.default_price, p.base_price) as base_price,
  p.lot_size_id,
  ls.name as lot_size_name
from public.parcels p
left join public.lot_sizes ls on ls.id = p.lot_size_id
where p.lot_number ~ '^[0-9]{2}$'
  and p.status = 'Available'
order by p.lot_number;

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
  c.id as contract_id,
  cu.id as customer_id,
  trim(cu.first_name || ' ' || cu.last_name) as customer_name
from public.parcels p
left join public.lot_sizes ls on ls.id = p.lot_size_id
left join public.contracts c on c.parcel_id = p.id and c.is_active
left join public.customers cu on cu.id = c.customer_id
order by p.lot_number;

grant select on public.public_parcel_options to anon, authenticated;
grant select on public.parcel_board_view to authenticated;

comment on function public.get_current_user_tenant_id() is 'Multi-tenant foundation 20260915: caller tenant scope.';
comment on table public.organizations is 'Multi-tenant foundation 20260915: tenants sharing one database with RLS isolation.';

commit;
