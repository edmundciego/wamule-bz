-- Minimal local-only schema representing the pre-project-scope hosted schema.
-- Used only by project-scope-db-harness.py on disposable embedded Postgres.
create extension if not exists pgcrypto;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid; $$;

create table public.organizations (
  id uuid primary key,
  name text not null,
  slug text not null unique,
  masterplan_image_url text,
  updated_at timestamptz not null default now()
);
create table public.business_settings (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);
create table public.projects (
  id uuid primary key,
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  slug text not null,
  name text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, slug)
);
create table public.parcels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  lot_number text not null,
  status text not null default 'Available',
  base_price numeric not null default 0,
  map_polygon jsonb,
  constraint uniq_parcels_tenant_lot unique (tenant_id, lot_number)
);
create table public.lot_tiers (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  tier_key text not null,
  label text not null,
  price_cents bigint not null,
  corner_premium_cents bigint not null default 0,
  color_hex text not null,
  is_active boolean not null default true,
  primary key (tenant_id, tier_key)
);
create table public.masterplan_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  version_number integer not null,
  image_url text not null,
  file_name text not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  constraint masterplan_versions_number_positive check (version_number > 0),
  constraint uniq_masterplan_versions_tenant_number unique (tenant_id, version_number)
);

create or replace function public.assign_masterplan_version_number()
returns trigger language plpgsql as $$
begin
  if new.version_number is null then
    select coalesce(max(version_number), 0) + 1 into new.version_number
    from public.masterplan_versions where tenant_id = new.tenant_id;
  end if;
  return new;
end $$;
create trigger trg_assign_masterplan_version_number before insert on public.masterplan_versions
for each row execute function public.assign_masterplan_version_number();

create or replace function public.sync_active_masterplan()
returns trigger language plpgsql as $$
begin
  if new.is_active then
    update public.masterplan_versions set is_active = false
    where tenant_id = new.tenant_id and id <> new.id and is_active;
    update public.organizations set masterplan_image_url = new.image_url, updated_at = now()
    where id = new.tenant_id;
    insert into public.business_settings (tenant_id, key, value)
    values (new.tenant_id, 'masterplan_image_url', jsonb_build_object('url', new.image_url))
    on conflict (tenant_id, key) do update set value = excluded.value, updated_at = now();
  end if;
  return new;
end $$;
create trigger trg_sync_active_masterplan after insert or update of is_active on public.masterplan_versions
for each row execute function public.sync_active_masterplan();

grant usage on schema public, auth to anon, authenticated, service_role;
