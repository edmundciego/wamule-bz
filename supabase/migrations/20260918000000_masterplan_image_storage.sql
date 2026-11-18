-- Masterplan aerial image storage for tenant parcel mapping.
--
-- Adds organizations.masterplan_image_url, ensures the public business-assets
-- bucket, scopes business-assets writes to the caller's tenant folder
-- ({tenant_id}/...) with a Super Admin bypass, and provides a
-- SECURITY DEFINER RPC so tenant writers can update only their own
-- masterplan URL (organizations table itself stays Super-Admin-managed).
--
-- Idempotent: IF NOT EXISTS / DROP IF EXISTS / ON CONFLICT DO NOTHING.
-- Deployment order: apply after 20260917000000. Do not edit history.

begin;

-- -----------------------------------------------------------------------------
-- 1. Column addition on organizations.
-- -----------------------------------------------------------------------------
alter table public.organizations
  add column if not exists masterplan_image_url text;

comment on column public.organizations.masterplan_image_url is 'Public URL of the tenant aerial/site-map photo used as the ParcelMapCanvas background. Stored in the business-assets bucket.';

-- -----------------------------------------------------------------------------
-- 2. Storage bucket setup (public, for logos + masterplans).
-- -----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public) VALUES ('business-assets', 'business-assets', true) ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Storage RLS policies for business-assets.
--
-- Public read is retained (logos, masterplans are site assets). Writes require
-- the object to live under the caller's tenant folder, or Super Admin.
-- Legacy `company/...` logo paths remain writable by tenant writers so the
-- pre-tenant logo flow keeps working; new uploads use {tenant_id}/... paths.
-- -----------------------------------------------------------------------------
drop policy if exists "Business assets readable publicly" on storage.objects;
create policy "Business assets readable publicly"
on storage.objects
for select
to public
using (bucket_id = 'business-assets');

drop policy if exists "Business assets managed by admins" on storage.objects;
drop policy if exists "Business assets writable by tenant writers" on storage.objects;
create policy "Business assets writable by tenant writers"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'business-assets'
  and (
    public.is_super_admin_user()
    or (
      public.can_write_admin_data()
      and (
        (storage.foldername(name))[1] = public.get_current_user_tenant_id()::text
        or (storage.foldername(name))[1] = 'company'
      )
    )
  )
);

drop policy if exists "Business assets updateable by tenant writers" on storage.objects;
create policy "Business assets updateable by tenant writers"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'business-assets'
  and (
    public.is_super_admin_user()
    or (
      public.can_write_admin_data()
      and (
        (storage.foldername(name))[1] = public.get_current_user_tenant_id()::text
        or (storage.foldername(name))[1] = 'company'
      )
    )
  )
)
with check (
  bucket_id = 'business-assets'
  and (
    public.is_super_admin_user()
    or (
      public.can_write_admin_data()
      and (
        (storage.foldername(name))[1] = public.get_current_user_tenant_id()::text
        or (storage.foldername(name))[1] = 'company'
      )
    )
  )
);

drop policy if exists "Business assets deletable by tenant writers" on storage.objects;
create policy "Business assets deletable by tenant writers"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'business-assets'
  and (
    public.is_super_admin_user()
    or (
      public.is_admin_user()
      and (
        (storage.foldername(name))[1] = public.get_current_user_tenant_id()::text
        or (storage.foldername(name))[1] = 'company'
      )
    )
  )
);

-- -----------------------------------------------------------------------------
-- 4. Tenant-scoped masterplan update RPC (single-column, no broad org access).
-- -----------------------------------------------------------------------------
create or replace function public.set_tenant_masterplan(
  p_organization_id uuid,
  p_masterplan_image_url text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_organization_id is null then
    raise exception 'Organization id is required.';
  end if;

  if not (
    public.is_super_admin_user()
    or (
      public.can_write_admin_data()
      and p_organization_id = public.get_current_user_tenant_id()
    )
  ) then
    raise exception 'Only writers of this tenant (or Super Admin) can update its masterplan.';
  end if;

  update public.organizations
  set masterplan_image_url = nullif(trim(coalesce(p_masterplan_image_url, '')), ''),
      updated_at = now()
  where id = p_organization_id;
end;
$$;

comment on function public.set_tenant_masterplan(uuid, text) is 'Updates only masterplan_image_url for the caller tenant (writers) or any tenant (Super Admin). Pass NULL/empty to remove.';

grant execute on function public.set_tenant_masterplan(uuid, text) to authenticated;

commit;
