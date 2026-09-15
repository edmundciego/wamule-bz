-- Masterplan image versioning with alignment-safe activation.
--
-- Developers upload higher-resolution maps, drone shots, or updated CAD
-- blueprints over time. Percentage-based map_polygon coordinates stay valid
-- across versions as long as the image covers the same site extent; this
-- table keeps every iteration, enforces exactly one active version per
-- tenant, and syncs the active image_url to organizations + business_settings
-- so existing readers keep working unchanged.
--
-- Idempotent: IF NOT EXISTS / DROP IF EXISTS / pg_constraint guards.
-- Deployment order: apply after 20260918000000. Do not edit history.

begin;

-- -----------------------------------------------------------------------------
-- 1. Table masterplan_versions.
-- -----------------------------------------------------------------------------
create table if not exists public.masterplan_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  version_number integer not null,
  image_url text not null,
  file_name text not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,

  constraint masterplan_versions_number_positive check (version_number > 0),
  constraint masterplan_versions_image_present check (length(trim(image_url)) > 0),
  constraint masterplan_versions_file_present check (length(trim(file_name)) > 0)
);

do $$
begin
  if to_regclass('public.masterplan_versions') is not null
     and not exists (
       select 1 from pg_constraint
       where conname = 'uniq_masterplan_versions_tenant_number'
         and conrelid = 'public.masterplan_versions'::regclass
     ) then
    alter table public.masterplan_versions
      add constraint uniq_masterplan_versions_tenant_number unique (tenant_id, version_number);
  end if;
end;
$$;

create index if not exists idx_masterplan_versions_tenant_active
  on public.masterplan_versions(tenant_id, is_active, version_number desc);

comment on table public.masterplan_versions is 'Aerial/site-map image iterations per tenant. Exactly one active version; activation syncs organizations + business_settings.';

-- Tenant-defaulting (consistent with the other 39 scoped tables).
drop trigger if exists trg_set_default_tenant_id on public.masterplan_versions;
create trigger trg_set_default_tenant_id
before insert on public.masterplan_versions
for each row execute function public.set_default_tenant_id();

-- -----------------------------------------------------------------------------
-- 2. Per-tenant auto-increment of version_number (+ created_by default).
--    Runs before the NOT NULL check, so clients may omit version_number.
-- -----------------------------------------------------------------------------
create or replace function public.assign_masterplan_version_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.version_number is null then
    select coalesce(max(version_number), 0) + 1
      into new.version_number
    from public.masterplan_versions
    where tenant_id = new.tenant_id;
  end if;
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

comment on function public.assign_masterplan_version_number() is 'BEFORE INSERT defaulting for masterplan_versions: per-tenant version_number sequence and created_by.';

drop trigger if exists trg_assign_masterplan_version_number on public.masterplan_versions;
create trigger trg_assign_masterplan_version_number
before insert on public.masterplan_versions
for each row execute function public.assign_masterplan_version_number();

-- -----------------------------------------------------------------------------
-- 3. Single-active enforcement + downstream sync.
-- -----------------------------------------------------------------------------
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
      and id <> new.id
      and is_active = true;

    update public.organizations
    set masterplan_image_url = new.image_url,
        updated_at = now()
    where id = new.tenant_id;

    insert into public.business_settings (tenant_id, key, value)
    values (new.tenant_id, 'masterplan_image_url', jsonb_build_object('url', new.image_url))
    on conflict (tenant_id, key)
    do update set value = excluded.value, updated_at = now();
  end if;
  return new;
end;
$$;

comment on function public.sync_active_masterplan() is 'Keeps exactly one active masterplan per tenant and mirrors its image_url to organizations + business_settings.';

drop trigger if exists trg_sync_active_masterplan on public.masterplan_versions;
create trigger trg_sync_active_masterplan
after insert or update of is_active on public.masterplan_versions
for each row execute function public.sync_active_masterplan();

-- -----------------------------------------------------------------------------
-- 4. RLS: same-tenant access + Super Admin override.
-- -----------------------------------------------------------------------------
alter table public.masterplan_versions enable row level security;

drop policy if exists "Internal can read masterplan versions" on public.masterplan_versions;
create policy "Internal can read masterplan versions"
on public.masterplan_versions
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create masterplan versions" on public.masterplan_versions;
create policy "Staff can create masterplan versions"
on public.masterplan_versions
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Staff can update masterplan versions" on public.masterplan_versions;
create policy "Staff can update masterplan versions"
on public.masterplan_versions
for update
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists "Admins can delete masterplan versions" on public.masterplan_versions;
create policy "Admins can delete masterplan versions"
on public.masterplan_versions
for delete
to authenticated
using (public.is_admin_user());

drop policy if exists tenant_isolation on public.masterplan_versions;
create policy tenant_isolation
on public.masterplan_versions
as restrictive
for all
to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

grant select, insert, update, delete on public.masterplan_versions to authenticated;

commit;
