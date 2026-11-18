-- Project-scoped public map inputs.
--
-- Projects must not share active imagery, public themes, tier catalogues, or
-- parcel-number uniqueness by accident. Existing tenant-wide values are kept
-- as the legacy/default-project fallback; non-default projects read only
-- project-scoped configuration. This migration is local source control only
-- until the reviewed release migration track is approved.

begin;

-- Composite parent key lets child rows prove project and tenant agree.
create unique index if not exists uniq_projects_id_tenant
  on public.projects (id, tenant_id);

-- The old single-tenant lot-number uniqueness prevented the same display
-- number in separate projects. Legacy NULL-project rows remain unique within
-- their tenant until explicitly assigned to a project.
alter table public.parcels
  drop constraint if exists parcels_lot_number_unique;
alter table public.parcels
  drop constraint if exists uniq_parcels_tenant_lot;
drop index if exists public.uniq_parcels_tenant_lot;
create unique index if not exists uniq_parcels_project_lot
  on public.parcels (tenant_id, project_id, lot_number)
  where project_id is not null;
create unique index if not exists uniq_parcels_legacy_lot
  on public.parcels (tenant_id, lot_number)
  where project_id is null;

-- Existing tenant-level parcels are the legacy/default project by contract.
update public.parcels p
set project_id = pr.id
from public.projects pr
where pr.tenant_id = p.tenant_id
  and pr.is_default
  and p.project_id is null;

alter table public.parcels
  drop constraint if exists parcels_project_id_fkey;
alter table public.parcels
  drop constraint if exists parcels_project_tenant_fkey;
alter table public.parcels
  add constraint parcels_project_tenant_fkey
  foreign key (project_id, tenant_id)
  references public.projects (id, tenant_id)
  on delete restrict;

-- Scope each masterplan version and its optional mobile rendition.
alter table public.masterplan_versions
  add column if not exists project_id uuid;
alter table public.masterplan_versions
  add column if not exists preview_url text;

update public.masterplan_versions v
set project_id = pr.id
from public.projects pr
where pr.tenant_id = v.tenant_id
  and pr.is_default
  and v.project_id is null;

alter table public.masterplan_versions
  drop constraint if exists masterplan_versions_project_tenant_fkey;
alter table public.masterplan_versions
  add constraint masterplan_versions_project_tenant_fkey
  foreign key (project_id, tenant_id)
  references public.projects (id, tenant_id)
  on delete restrict;

alter table public.masterplan_versions
  drop constraint if exists uniq_masterplan_versions_tenant_number;
create unique index if not exists uniq_masterplan_versions_project_number
  on public.masterplan_versions (tenant_id, project_id, version_number)
  where project_id is not null;
create unique index if not exists uniq_masterplan_versions_legacy_number
  on public.masterplan_versions (tenant_id, version_number)
  where project_id is null;
create unique index if not exists uniq_masterplan_versions_one_active_project
  on public.masterplan_versions (tenant_id, project_id)
  where project_id is not null and is_active;
create unique index if not exists uniq_masterplan_versions_one_active_legacy
  on public.masterplan_versions (tenant_id)
  where project_id is null and is_active;

create index if not exists idx_masterplan_versions_project_active
  on public.masterplan_versions (tenant_id, project_id, is_active, version_number desc);

-- Demote the previous active row before the new active row reaches the unique
-- partial index. The original AFTER trigger only demoted afterward, which is
-- too late once uniqueness is enforced per project.
create or replace function public.deactivate_other_project_masterplans()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_active = true then
    update public.masterplan_versions
    set is_active = false
    where tenant_id = new.tenant_id
      and project_id is not distinct from new.project_id
      and id is distinct from new.id
      and is_active = true;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_deactivate_other_project_masterplans on public.masterplan_versions;
create trigger trg_deactivate_other_project_masterplans
before insert or update of is_active on public.masterplan_versions
for each row execute function public.deactivate_other_project_masterplans();

create or replace function public.assign_masterplan_version_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Existing admin map controls predate a project selector. Route new
  -- tenant-level uploads to the is_default project instead of creating fresh
  -- NULL-scoped versions; NULL remains reserved for pre-migration legacy rows.
  if new.project_id is null then
    select id into new.project_id
    from public.projects
    where tenant_id = new.tenant_id and is_default
    limit 1;
  end if;

  if new.version_number is null then
    select coalesce(max(version_number), 0) + 1
      into new.version_number
    from public.masterplan_versions
    where tenant_id = new.tenant_id
      and project_id is not distinct from new.project_id;
  end if;
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function public.sync_active_masterplan()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_active = true then
    update public.masterplan_versions
    set is_active = false
    where tenant_id = new.tenant_id
      and project_id is not distinct from new.project_id
      and id <> new.id
      and is_active = true;

    -- Keep old tenant-level readers synchronized only for the tenant's
    -- default/legacy map. A phase/project map must never replace it.
    if new.project_id is null or exists (
      select 1
      from public.projects pr
      where pr.id = new.project_id
        and pr.tenant_id = new.tenant_id
        and pr.is_default
    ) then
      update public.organizations
      set masterplan_image_url = new.image_url,
          updated_at = now()
      where id = new.tenant_id;

      insert into public.business_settings (tenant_id, key, value)
      values (new.tenant_id, 'masterplan_image_url', jsonb_build_object('url', new.image_url))
      on conflict (tenant_id, key)
      do update set value = excluded.value, updated_at = now();
    end if;
  end if;
  return new;
end;
$$;

comment on column public.masterplan_versions.project_id is
  'Owning project/phase. NULL is reserved for legacy tenant-level versions.';
comment on column public.masterplan_versions.preview_url is
  'Optional mobile-capped rendition belonging to this exact map version.';

-- Public project settings are intentionally not Data API-readable. The public
-- Edge Function uses service_role and applies an explicit public-field allowlist.
create table if not exists public.project_settings (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint project_settings_key_valid check (key in ('tenant_theme', 'company_profile')),
  constraint project_settings_project_tenant_fkey
    foreign key (project_id, tenant_id)
    references public.projects (id, tenant_id)
    on delete cascade,
  constraint project_settings_project_key_unique unique (project_id, key)
);

create or replace function public.set_project_public_config_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_project_settings_updated_at on public.project_settings;
create trigger trg_project_settings_updated_at
before update on public.project_settings
for each row execute function public.set_project_public_config_updated_at();

alter table public.project_settings enable row level security;
revoke all on table public.project_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.project_settings to service_role;

comment on table public.project_settings is
  'Project-scoped public presentation settings. Read through get-public-lots service logic only.';

-- A normalized project-scoped tier catalogue. The old lot_tiers table remains
-- the tenant/default-project compatibility source; non-default projects use
-- this table and never inherit another project's tier prices.
create table if not exists public.project_lot_tiers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null,
  tier_key text not null,
  label text not null,
  price_cents bigint not null,
  corner_premium_cents bigint not null default 0,
  color_hex text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_lot_tiers_key_present check (tier_key ~ '^[a-z0-9_]+$'),
  constraint project_lot_tiers_label_present check (length(trim(label)) > 0),
  constraint project_lot_tiers_price_nonnegative check (price_cents >= 0),
  constraint project_lot_tiers_corner_premium_nonnegative check (corner_premium_cents >= 0),
  constraint project_lot_tiers_color_hex check (color_hex ~ '^#[0-9a-fA-F]{6}$'),
  constraint project_lot_tiers_project_tenant_fkey
    foreign key (project_id, tenant_id)
    references public.projects (id, tenant_id)
    on delete cascade,
  constraint project_lot_tiers_project_key_unique unique (project_id, tier_key)
);

drop trigger if exists trg_project_lot_tiers_updated_at on public.project_lot_tiers;
create trigger trg_project_lot_tiers_updated_at
before update on public.project_lot_tiers
for each row execute function public.set_project_public_config_updated_at();

create index if not exists idx_project_lot_tiers_scope_active
  on public.project_lot_tiers (tenant_id, project_id, is_active, sort_order);

alter table public.project_lot_tiers enable row level security;
revoke all on table public.project_lot_tiers from public, anon, authenticated;
grant select, insert, update, delete on table public.project_lot_tiers to service_role;

comment on table public.project_lot_tiers is
  'Normalized tier labels/prices/colors scoped to one project; public reads use the safe get-public-lots projection.';

commit;
