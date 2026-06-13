begin;

alter table public.applications
  alter column parcel_id drop not null;

commit;
