begin;

-- Enforce the same provenance boundary as the sales selectors if an approval
-- is attempted through a direct table update or either approve_application RPC.
-- This does not rewrite existing applications or parcel records.
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

  if tg_op = 'UPDATE'
    and old.status = 'Approved'
    and old.parcel_id is not distinct from new.parcel_id then
    return new;
  end if;

  if new.parcel_id is null then
    raise exception 'Choose an existing inventory record before approving this application.';
  end if;

  select p.geometry_source, p.needs_review, p.status
  into v_parcel
  from public.parcels p
  where p.id = new.parcel_id
    and p.tenant_id = new.tenant_id
  for share;

  if not found then
    raise exception 'The selected parcel is outside the application tenant.';
  end if;
  if v_parcel.geometry_source is distinct from 'manual'
    or v_parcel.needs_review is distinct from false then
    raise exception 'Only existing manual inventory records with a clear review flag can be selected.';
  end if;
  if v_parcel.status is distinct from 'Available' then
    raise exception 'The selected inventory record is not available.';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_application_inventory_parcel() from public, anon, authenticated, service_role;

drop trigger if exists applications_inventory_selection_guard on public.applications;
create trigger applications_inventory_selection_guard
before insert or update of status, parcel_id on public.applications
for each row execute function public.guard_application_inventory_parcel();

comment on function public.guard_application_inventory_parcel() is
  'Prevents sales application approval from assigning raster detections or unreviewed parcels.';

commit;
