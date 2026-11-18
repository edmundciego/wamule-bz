begin;

-- Keep the existing view column order and append the project/phase keys that
-- workspace-aware admin pages need to filter the inventory correctly.
create or replace view public.parcel_board_view
with (security_invoker = true)
as
select
  p.id,
  p.tenant_id,
  p.lot_number,
  coalesce(ls.dimensions, p.dimensions) as dimensions,
  p.zoning,
  p.status,
  coalesce(nullif(p.base_price, 0), ls.default_price, p.base_price) as base_price,
  p.created_at,
  p.updated_at,
  p.lot_size_id,
  ls.name as lot_size_name,
  p.map_polygon,
  p.tier_key,
  t.label as tier_label,
  t.color_hex as tier_color_hex,
  t.price_cents as tier_price_cents,
  p.is_corner,
  p.price_override_cents,
  public.parcel_effective_price_cents(
    p.price_override_cents, t.price_cents, t.corner_premium_cents, p.is_corner, p.base_price
  ) as effective_price_cents,
  p.geometry_source,
  p.confidence,
  p.needs_review,
  p.masterplan_version_id,
  c.id as contract_id,
  cu.id as customer_id,
  trim(cu.first_name || ' ' || cu.last_name) as customer_name,
  p.project_id,
  p.phase_id
from public.parcels p
left join public.lot_sizes ls on ls.id = p.lot_size_id
left join public.lot_tiers t on t.tenant_id = p.tenant_id and t.tier_key = p.tier_key
left join public.contracts c on c.parcel_id = p.id and c.is_active
left join public.customers cu on cu.id = c.customer_id
order by p.lot_number;

revoke all on public.parcel_board_view from public, anon;
grant select on public.parcel_board_view to authenticated;

comment on view public.parcel_board_view is
  'Tenant/project/phase scoped parcel inventory for authenticated workspace pages.';

commit;
