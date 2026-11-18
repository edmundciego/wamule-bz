begin;
set local lock_timeout = '5s';

-- Restore the tenant-specific inbound email credential lookup. Databases that
-- already use Vault keep their existing secret references and secret contents.
create schema if not exists vault;
create extension if not exists supabase_vault with schema vault;
revoke usage on schema vault from public, anon, authenticated;
revoke all on vault.decrypted_secrets from public, anon, authenticated;

create table if not exists public.organization_secret_refs (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  purpose text not null check (purpose = 'gemini_api_key'),
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, purpose)
);
alter table public.organization_secret_refs enable row level security;
revoke all on public.organization_secret_refs from public, anon, authenticated, service_role;

do $$
declare
  v_org record;
  v_secret_id uuid;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'organizations' and column_name = 'gemini_api_key'
  ) then
    -- Hold writes from other sessions until the legacy column is retired.
    lock table public.organizations in access exclusive mode;
    for v_org in
      select id, gemini_api_key from public.organizations
      where nullif(btrim(gemini_api_key), '') is not null
    loop
      if not exists (
        select 1 from public.organization_secret_refs r
        where r.tenant_id = v_org.id and r.purpose = 'gemini_api_key'
      ) then
        v_secret_id := vault.create_secret(
          v_org.gemini_api_key,
          'organization-' || v_org.id::text || '-gemini-api-key',
          'Server-only Gemini key for one Wamule tenant.'
        );
        insert into public.organization_secret_refs(tenant_id, purpose, vault_secret_id)
        values (v_org.id, 'gemini_api_key', v_secret_id);
      elsif not exists (
        select 1 from public.organization_secret_refs r
        join vault.decrypted_secrets ds on ds.id = r.vault_secret_id
        where r.tenant_id = v_org.id and r.purpose = 'gemini_api_key'
      ) then
        raise exception 'A tenant credential reference needs repair before retiring the legacy column.';
      end if;
    end loop;
    alter table public.organizations drop column gemini_api_key;
  end if;
end;
$$;

create or replace function public.get_organization_gemini_api_key(p_tenant_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Tenant credential lookup requires service-role authentication' using errcode = '42501';
  end if;
  select ds.decrypted_secret into v_secret
  from public.organization_secret_refs r
  join vault.decrypted_secrets ds on ds.id = r.vault_secret_id
  where r.tenant_id = p_tenant_id and r.purpose = 'gemini_api_key';
  return v_secret;
end;
$$;

revoke all on function public.get_organization_gemini_api_key(uuid) from public, anon, authenticated;
grant execute on function public.get_organization_gemini_api_key(uuid) to service_role;

-- The phase-scoped approval RPCs check workspace and availability. This
-- trigger also checks the parcel's provenance when an approval is recorded.
create or replace function public.guard_application_inventory_parcel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parcel record;
begin
  if new.status is distinct from 'Approved' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'Approved' and old.parcel_id is not distinct from new.parcel_id then
    return new;
  end if;
  if new.parcel_id is null then
    raise exception 'Choose an existing inventory record before approving this application.' using errcode = '23514';
  end if;

  select p.geometry_source, p.needs_review, p.status into v_parcel
  from public.parcels p
  where p.id = new.parcel_id and p.tenant_id = new.tenant_id
  for share;

  if not found then
    raise exception 'The selected parcel is outside the application tenant.' using errcode = '23514';
  end if;
  if v_parcel.geometry_source is distinct from 'manual' or v_parcel.needs_review is distinct from false then
    raise exception 'Only existing manual inventory records with a clear review flag can be selected.' using errcode = '23514';
  end if;
  if v_parcel.status is distinct from 'Available' then
    raise exception 'The selected inventory record is not available.' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_application_inventory_parcel() from public, anon, authenticated, service_role;
drop trigger if exists applications_inventory_selection_guard on public.applications;
create trigger applications_inventory_selection_guard
before insert or update of status, parcel_id on public.applications
for each row execute function public.guard_application_inventory_parcel();

notify pgrst, 'reload schema';
commit;
