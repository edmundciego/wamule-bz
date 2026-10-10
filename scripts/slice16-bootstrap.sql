-- Slice 1.6 local-only bootstrap for embedded Postgres (pgserver).
-- Creates the minimal prerequisites that the hosted env already has:
-- roles, auth schema stub, organizations, admin_profiles, RLS helpers.
-- The slice-1.5 migration is applied AFTER this file.
-- Never applied to staging/prod (local test harness only).

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key
);

-- Stub for Supabase auth.uid(): reads the impersonated uid from GUC app.uid.
-- Tests do: SELECT set_config('app.uid', '<uuid>', false); SET ROLE authenticated;
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.uid', true), '')::uuid;
$$;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null
);

create table if not exists public.admin_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid references public.organizations(id) on delete restrict,
  role text not null
);

-- RLS helpers mirroring
-- supabase/migrations/20260915000000_multi_tenant_foundation.sql §6.
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

grant usage on schema public to authenticated;
grant usage on schema auth to authenticated;
