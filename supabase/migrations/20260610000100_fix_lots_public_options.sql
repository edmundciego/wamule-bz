begin;

-- Consolidate earlier seed formats. The draft migration used LOT-01..LOT-24,
-- while the app migration used 01..24. Keep 01..24 and move references over.
do $$
declare
  i integer;
  canonical_id bigint;
  duplicate_id bigint;
  canonical_status public.parcel_status;
  duplicate_status public.parcel_status;
begin
  for i in 1..24 loop
    select id, status
      into canonical_id, canonical_status
    from public.parcels
    where lot_number = lpad(i::text, 2, '0');

    select id, status
      into duplicate_id, duplicate_status
    from public.parcels
    where lot_number = 'LOT-' || lpad(i::text, 2, '0');

    if canonical_id is not null and duplicate_id is not null then
      update public.applications
        set parcel_id = canonical_id
      where parcel_id = duplicate_id;

      update public.contracts
        set parcel_id = canonical_id
      where parcel_id = duplicate_id
        and not exists (
          select 1
          from public.contracts existing
          where existing.parcel_id = canonical_id
            and existing.is_active = true
            and existing.id <> public.contracts.id
        );

      update public.parcels
        set status = case
          when canonical_status = 'Sold' or duplicate_status = 'Sold' then 'Sold'::public.parcel_status
          when canonical_status = 'Reserved' or duplicate_status = 'Reserved' then 'Reserved'::public.parcel_status
          else 'Available'::public.parcel_status
        end,
        base_price = greatest(public.parcels.base_price, (select base_price from public.parcels where id = duplicate_id)),
        updated_at = now()
      where id = canonical_id;

      delete from public.parcels
      where id = duplicate_id
        and not exists (select 1 from public.applications where parcel_id = duplicate_id)
        and not exists (select 1 from public.contracts where parcel_id = duplicate_id);
    elsif canonical_id is null and duplicate_id is not null then
      update public.parcels
        set lot_number = lpad(i::text, 2, '0'),
            updated_at = now()
      where id = duplicate_id;
    end if;
  end loop;
end $$;

insert into public.parcels (lot_number, dimensions, zoning, status, base_price)
select lpad(i::text, 2, '0'), '75x100 ft', 'Residential', 'Available', 0
from generate_series(1, 24) as s(i)
on conflict (lot_number) do nothing;

drop view if exists public.public_parcel_options cascade;
create view public.public_parcel_options as
select id, lot_number, dimensions, zoning, status, base_price
from public.parcels
where lot_number ~ '^[0-9]{2}$'
  and status = 'Available'
order by lot_number;

grant select on public.public_parcel_options to anon, authenticated;

commit;
