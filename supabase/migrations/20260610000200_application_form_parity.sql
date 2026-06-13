begin;

alter table public.applications
  add column if not exists applicant_full_name text,
  add column if not exists applicant_address text,
  add column if not exists nationality text,
  add column if not exists occupation text,
  add column if not exists intended_use text,
  add column if not exists intended_use_other text,
  add column if not exists parcel_count integer,
  add column if not exists preferred_parcel_ids bigint[] not null default '{}',
  add column if not exists alternate_lot_preference text,
  add column if not exists payment_option text,
  add column if not exists legal_notice_acknowledged boolean not null default false,
  add column if not exists applicant_acknowledgement_signature text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'applications_intended_use_valid'
  ) then
    alter table public.applications
      add constraint applications_intended_use_valid
      check (
        intended_use is null
        or intended_use in ('Residential', 'Commercial', 'Agriculture', 'Investment', 'Rental Property', 'Other')
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'applications_payment_option_valid'
  ) then
    alter table public.applications
      add constraint applications_payment_option_valid
      check (payment_option is null or payment_option in ('Installment Plan', 'Paid in Full'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'applications_parcel_count_positive'
  ) then
    alter table public.applications
      add constraint applications_parcel_count_positive
      check (parcel_count is null or parcel_count > 0);
  end if;
end $$;

update public.parcels
set dimensions = '65ft x 101ft or 75ft x 101ft',
    base_price = 25000,
    updated_at = now()
where lot_number ~ '^[0-9]{2}$';

drop view if exists public.public_parcel_options cascade;
create view public.public_parcel_options as
select id, lot_number, dimensions, zoning, status, base_price
from public.parcels
where lot_number ~ '^[0-9]{2}$'
  and status = 'Available'
order by lot_number;

grant select on public.public_parcel_options to anon, authenticated;

create or replace function public.approve_application(p_application_id bigint, p_parcel_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_application public.applications%rowtype;
  v_parcel_status public.parcel_status;
begin
  if not public.can_write_admin_data() then
    raise exception 'Missing permission to approve applications.';
  end if;

  select * into v_application
  from public.applications
  where id = p_application_id
  for update;

  if not found then
    raise exception 'Application not found.';
  end if;

  select status into v_parcel_status
  from public.parcels
  where id = p_parcel_id
  for update;

  if not found then
    raise exception 'Selected lot does not exist.';
  end if;

  if v_parcel_status <> 'Available' then
    raise exception 'Selected lot is not available.';
  end if;

  update public.applications
  set status = 'Approved',
      parcel_id = p_parcel_id,
      updated_at = now()
  where id = p_application_id;

  insert into public.customers (application_id, first_name, last_name, phone, email, address)
  values (
    v_application.id,
    v_application.first_name,
    v_application.last_name,
    v_application.phone,
    v_application.email,
    v_application.applicant_address
  )
  on conflict (application_id) do update set
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    phone = excluded.phone,
    email = excluded.email,
    address = excluded.address,
    updated_at = now();

  update public.parcels
  set status = 'Reserved',
      updated_at = now()
  where id = p_parcel_id;
end;
$$;

drop policy if exists "Public can submit applications" on public.applications;
drop policy if exists "Staff can insert applications" on public.applications;

create policy "Public can submit applications"
on public.applications
for insert
with check (
  status = 'Pending Review'
  and legal_notice_acknowledged = true
);

create policy "Staff can insert applications"
on public.applications
for insert
with check (public.can_write_admin_data());

commit;
