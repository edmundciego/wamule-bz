-- Map Studio hands portable data to the CRM; extraction never needs DB keys.
-- Additive only: existing parcels, leads, settings and masterplans are untouched.
begin;

alter table public.project_lot_tiers add column if not exists currency text;
alter table public.project_lot_tiers add column if not exists price_basis text;
alter table public.project_lot_tiers add column if not exists map_price_is_set boolean not null default true;

create table public.project_map_packages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  project_id uuid not null,
  phase_id uuid not null,
  snapshot_id uuid not null unique,
  dataset_id uuid not null,
  package_digest text not null check (package_digest ~ '^[a-f0-9]{64}$'),
  package_data jsonb not null,
  background_path text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (tenant_id, project_id, phase_id, package_digest),
  foreign key (snapshot_id, tenant_id, project_id, phase_id)
    references public.map_feature_snapshots(id, tenant_id, project_id, phase_id) on delete restrict
);
create index project_map_packages_scope on public.project_map_packages(tenant_id,project_id,phase_id,created_at desc);

create table public.project_plot_content (
  identity_id uuid primary key,
  tenant_id uuid not null,
  project_id uuid not null,
  phase_id uuid not null,
  plot_number text check (plot_number is null or length(trim(plot_number)) between 1 and 80),
  area_value numeric check (area_value > 0 and area_value < 1e12),
  area_unit text check (area_unit in ('m2','ft2','acres')),
  area_basis text not null default 'unknown' check (area_basis in ('recorded','cad-calculated','unknown')),
  dimensions text check (length(dimensions) <= 160),
  category_key text,
  price_cents bigint check (price_cents between 0 and 1000000000000),
  currency text check (currency ~ '^[A-Z]{3}$'),
  price_basis text check (length(price_basis) <= 100),
  parcel_id bigint,
  public_visible boolean not null default true,
  revision integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  check ((area_value is null) = (area_unit is null)),
  foreign key (identity_id,tenant_id,project_id,phase_id)
    references public.map_feature_identities(id,tenant_id,project_id,phase_id) on delete restrict,
  foreign key (parcel_id,tenant_id,project_id,phase_id)
    references public.parcels(id,tenant_id,project_id,phase_id) on delete restrict,
  foreign key (project_id,category_key) references public.project_lot_tiers(project_id,tier_key) on delete restrict
);
create unique index project_plot_content_number_unique on public.project_plot_content(tenant_id,project_id,phase_id,lower(plot_number)) where plot_number is not null;
create unique index project_plot_content_parcel_unique on public.project_plot_content(tenant_id,project_id,phase_id,parcel_id) where parcel_id is not null;

alter table public.project_map_packages enable row level security;
alter table public.project_plot_content enable row level security;
revoke all on public.project_map_packages, public.project_plot_content from public, anon, authenticated;
grant select on public.project_map_packages, public.project_plot_content to authenticated;
grant all on public.project_map_packages, public.project_plot_content to service_role;
create policy project_map_packages_read on public.project_map_packages for select to authenticated
  using (public.user_has_project_access(tenant_id,project_id,phase_id));
create policy project_plot_content_read on public.project_plot_content for select to authenticated
  using (public.user_has_project_access(tenant_id,project_id,phase_id));
grant select on public.project_lot_tiers to authenticated;
create policy project_map_category_read on public.project_lot_tiers for select to authenticated
  using (public.user_has_project_access(tenant_id,project_id,null));

-- All mutating entry points validate the complete scope and the actual caller.
create function public.assert_map_package_scope(t uuid,p uuid,ph uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
  if auth.uid() is null or not public.is_admin_user()
    or not public.user_can_manage_project(t,p)
    or not public.user_has_project_access(t,p,ph)
    or not exists(select 1 from public.development_phases d join public.projects pr on pr.id=d.project_id and pr.tenant_id=d.tenant_id
      join public.organizations o on o.id=pr.tenant_id
      where d.id=ph and d.project_id=p and d.tenant_id=t and d.is_active and o.is_active)
  then raise exception 'An Admin with access to this tenant, project and phase is required.' using errcode='42501'; end if;
end $$;
revoke all on function public.assert_map_package_scope(uuid,uuid,uuid) from public,anon;
grant execute on function public.assert_map_package_scope(uuid,uuid,uuid) to authenticated,service_role;

create function public.studio_polygon_is_valid(poly jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare n integer; i integer; j integer; a jsonb; b jsonb; c jsonb; d jsonb;
  ax numeric; ay numeric; bx numeric; byy numeric; cx numeric; cy numeric; dx numeric; dy numeric;
  signed_area numeric:=0; cross1 numeric; cross2 numeric; cross3 numeric; cross4 numeric;
begin
  if jsonb_typeof(poly) is distinct from 'array' then return false; end if;
  n:=jsonb_array_length(poly); if n<3 or n>200 then return false; end if;
  if (select count(distinct value) from jsonb_array_elements(poly))<>n then return false; end if;
  for i in 0..n-1 loop
    a:=poly->i; b:=poly->((i+1)%n);
    if jsonb_typeof(a->'x') is distinct from 'number' or jsonb_typeof(a->'y') is distinct from 'number'
       or (a->>'x')::numeric not between 0 and 100 or (a->>'y')::numeric not between 0 and 100 then return false; end if;
    ax:=(a->>'x')::numeric; ay:=(a->>'y')::numeric; bx:=(b->>'x')::numeric; byy:=(b->>'y')::numeric;
    signed_area:=signed_area+ax*byy-bx*ay;
    for j in i+2..n-1 loop
      if i=0 and j=n-1 then continue; end if;
      c:=poly->j; d:=poly->((j+1)%n);
      cx:=(c->>'x')::numeric; cy:=(c->>'y')::numeric; dx:=(d->>'x')::numeric; dy:=(d->>'y')::numeric;
      cross1:=(bx-ax)*(cy-ay)-(byy-ay)*(cx-ax); cross2:=(bx-ax)*(dy-ay)-(byy-ay)*(dx-ax);
      cross3:=(dx-cx)*(ay-cy)-(dy-cy)*(ax-cx); cross4:=(dx-cx)*(byy-cy)-(dy-cy)*(bx-cx);
      if cross1*cross2<0 and cross3*cross4<0 then return false; end if;
    end loop;
  end loop;
  return abs(signed_area)>0.000002;
exception when others then return false;
end $$;
revoke all on function public.studio_polygon_is_valid(jsonb) from public,anon;
grant execute on function public.studio_polygon_is_valid(jsonb) to authenticated,service_role;

create function public.stage_project_map_package(
  p_tenant_id uuid,p_project_id uuid,p_phase_id uuid,p_package jsonb,p_background_path text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare digest text; dataset uuid; package_id uuid; snap uuid; next_version integer; item jsonb; category jsonb;
  feature_identity uuid; incoming integer; existing integer; created integer:=0; core jsonb;
begin
  perform public.assert_map_package_scope(p_tenant_id,p_project_id,p_phase_id);
  -- Serialise imports/publishes for one project phase; retries reuse one snapshot.
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_project_id::text||p_phase_id::text,0));
  if octet_length(p_package::text)>24000000 or p_package->>'format' is distinct from 'wamule-map-package'
    or p_package->>'version' is distinct from '1' or jsonb_typeof(p_package->'plots') is distinct from 'array'
    or jsonb_typeof(p_package->'categories') is distinct from 'array'
    or jsonb_array_length(p_package->'categories')>100
    or coalesce(p_package#>>'{source,sha256}','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_package#>>'{source,format}','') not in ('dxf','pdf','image','json')
    or coalesce(p_package#>>'{source,units}','') not in ('m','ft','us-ft','unknown')
    or coalesce(length(trim(p_package->>'title')),0) not between 1 and 160
    or coalesce((p_package->>'revision')::integer,0) not between 1 and 1000000
    or coalesce((p_package#>>'{canvas,width}')::numeric,0) not between 1 and 1e7
    or coalesce((p_package#>>'{canvas,height}')::numeric,0) not between 1 and 1e7
    or (p_package#>>'{canvas,width}')::numeric/(p_package#>>'{canvas,height}')::numeric not between 0.05 and 20
  then raise exception 'Invalid Map Studio package.'; end if;
  incoming:=jsonb_array_length(p_package->'plots');
  if incoming<1 or incoming>5000 then raise exception 'Package needs 1–5,000 outlines.'; end if;
  dataset:=(p_package->>'dataset_id')::uuid;
  if (select count(distinct value->>'key') from jsonb_array_elements(p_package->'plots'))<>incoming then raise exception 'Duplicate outline keys.'; end if;
  if exists(select 1 from jsonb_array_elements(p_package->'plots') a where nullif(trim(a->>'number'),'') is not null
      group by lower(trim(a->>'number')) having count(*)>1) then raise exception 'Duplicate plot numbers.'; end if;
  if (select count(distinct value->>'key') from jsonb_array_elements(p_package->'categories'))<>jsonb_array_length(p_package->'categories') then raise exception 'Duplicate category keys.'; end if;
  core:=p_package #- '{canvas,background,data_base64}';
  if coalesce(core#>>'{canvas,background,mime}','')<>'' then
    if coalesce(core#>>'{canvas,background,mime}','') not in ('image/png','image/jpeg','image/webp')
      or coalesce(core#>>'{canvas,background,sha256}','') !~ '^[a-f0-9]{64}$'
      or p_background_path is distinct from (p_tenant_id::text||'/'||p_project_id::text||'/'||p_phase_id::text||'/'||(core#>>'{canvas,background,sha256}')||'.'||case core#>>'{canvas,background,mime}' when 'image/png' then 'png' when 'image/jpeg' then 'jpg' else 'webp' end)
      or not exists(select 1 from storage.objects where bucket_id='project-map-packages' and name=p_background_path)
    then raise exception 'Upload the matching display image to this project phase first.'; end if;
  elsif p_background_path is not null then raise exception 'Unexpected background image.'; end if;
  digest:=encode(sha256(convert_to(core::text,'UTF8')),'hex');
  select id,snapshot_id into package_id,snap from public.project_map_packages
    where tenant_id=p_tenant_id and project_id=p_project_id and phase_id=p_phase_id and package_digest=digest;
  if found then return jsonb_build_object('id',package_id,'snapshot_id',snap,'reused',true,'total',incoming); end if;
  select coalesce(max(snapshot_version),0)+1 into next_version from public.map_feature_snapshots
    where tenant_id=p_tenant_id and project_id=p_project_id and phase_id=p_phase_id;
  insert into public.map_feature_snapshots(tenant_id,project_id,phase_id,snapshot_fingerprint,source_image_sha256,
    detection_source_sha256,correction_manifest_sha256,correction_manifest_revision,snapshot_version,outline_count,created_by)
    values(p_tenant_id,p_project_id,p_phase_id,digest,coalesce(core#>>'{canvas,background,sha256}',p_package#>>'{source,sha256}'),
      p_package#>>'{source,sha256}',digest,(p_package->>'revision')::integer,next_version,incoming,auth.uid()) returning id into snap;
  for category in select value from jsonb_array_elements(p_package->'categories') loop
    if coalesce(category->>'key','') !~ '^[a-z0-9_]{1,80}$' or coalesce(category->>'color','') !~ '^#[a-fA-F0-9]{6}$'
      or coalesce(length(trim(category->>'label')),0) not between 1 and 100
      or (category->>'currency' is not null and category->>'currency' !~ '^[A-Z]{3}$')
      or length(category->>'price_basis')>100
    then raise exception 'Invalid category data.'; end if;
    insert into public.project_lot_tiers(tenant_id,project_id,tier_key,label,price_cents,color_hex,currency,price_basis,map_price_is_set)
      values(p_tenant_id,p_project_id,category->>'key',trim(category->>'label'),coalesce((category->>'price_cents')::bigint,0),
        category->>'color',category->>'currency',category->>'price_basis',category->>'price_cents' is not null)
      on conflict(project_id,tier_key) do nothing; -- preserve Admin's category edits
  end loop;
  for item in select value from jsonb_array_elements(p_package->'plots') loop
    if coalesce(item->>'key','') !~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,79}$'
      or coalesce(item->>'kind','') not in ('plot','common_area','amenity')
      or not public.studio_polygon_is_valid(item->'polygon')
      or (item->>'category_key' is not null and not exists(select 1 from jsonb_array_elements(p_package->'categories') c where c->>'key'=item->>'category_key'))
      or length(item->>'number')>80 or length(item->>'dimensions')>160 or length(item->>'price_basis')>100
    then raise exception 'Invalid outline, category or plot content.'; end if;
    select id into feature_identity from public.map_feature_identities where tenant_id=p_tenant_id and project_id=p_project_id
      and phase_id=p_phase_id and feature_key='studio:'||dataset::text||':'||(item->>'key');
    if not found then
      insert into public.map_feature_identities(tenant_id,project_id,phase_id,feature_key)
        values(p_tenant_id,p_project_id,p_phase_id,'studio:'||dataset::text||':'||(item->>'key')) returning id into feature_identity;
      created:=created+1;
    end if;
    insert into public.map_features(tenant_id,project_id,phase_id,snapshot_id,identity_id,demo_label,feature_kind,map_polygon,provenance)
      values(p_tenant_id,p_project_id,p_phase_id,snap,feature_identity,coalesce(nullif(trim(item->>'number'),''),item->>'key'),
        case item->>'kind' when 'plot' then 'demo_plot' else item->>'kind' end,item->'polygon',
        jsonb_build_object('map_studio',true,'reviewed',coalesce((item->>'reviewed')::boolean,false),'source_key',item->>'key'));
    insert into public.project_plot_content(identity_id,tenant_id,project_id,phase_id,plot_number,area_value,area_unit,area_basis,
      dimensions,category_key,price_cents,currency,price_basis,updated_by)
      values(feature_identity,p_tenant_id,p_project_id,p_phase_id,nullif(trim(item->>'number'),''),(item->>'area_value')::numeric,
        item->>'area_unit',coalesce(item->>'area_basis','unknown'),item->>'dimensions',item->>'category_key',
        (item->>'price_cents')::bigint,item->>'currency',item->>'price_basis',auth.uid())
      on conflict(identity_id) do nothing; -- geometry reimports never reset business content
  end loop;
  insert into public.project_map_packages(tenant_id,project_id,phase_id,snapshot_id,dataset_id,package_digest,package_data,background_path,created_by)
    values(p_tenant_id,p_project_id,p_phase_id,snap,dataset,digest,core,p_background_path,auth.uid()) returning id into package_id;
  return jsonb_build_object('id',package_id,'snapshot_id',snap,'reused',false,'total',incoming,'new_plots',created,'matched',incoming-created);
end $$;
revoke all on function public.stage_project_map_package(uuid,uuid,uuid,jsonb,text) from public,anon;
grant execute on function public.stage_project_map_package(uuid,uuid,uuid,jsonb,text) to authenticated;

create function public.publish_project_map_package(p_package_id uuid,p_expected_active_id uuid,p_replace_current boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare pkg public.project_map_packages%rowtype; current_id uuid;
begin
  select * into strict pkg from public.project_map_packages where id=p_package_id;
  perform public.assert_map_package_scope(pkg.tenant_id,pkg.project_id,pkg.phase_id);
  perform pg_advisory_xact_lock(hashtextextended(pkg.tenant_id::text||pkg.project_id::text||pkg.phase_id::text,0));
  select id into current_id from public.map_feature_snapshots where tenant_id=pkg.tenant_id and project_id=pkg.project_id and phase_id=pkg.phase_id and is_active;
  if current_id=pkg.snapshot_id then return jsonb_build_object('published',true,'snapshot_id',current_id,'reused',true); end if;
  if current_id is distinct from p_expected_active_id then raise exception 'The active map changed. Refresh the comparison before publishing.' using errcode='40001'; end if;
  if not p_replace_current and (current_id is not null or exists(select 1 from public.parcels where tenant_id=pkg.tenant_id and project_id=pkg.project_id and phase_id=pkg.phase_id)) then
    raise exception 'Confirm replacement of the displayed map. Existing inventory and history will be retained.';
  end if;
  if exists(select 1 from public.map_features where snapshot_id=pkg.snapshot_id and coalesce((provenance->>'reviewed')::boolean,false)=false) then
    raise exception 'Review every imported boundary before publishing.'; end if;
  update public.map_feature_snapshots set is_active=false where tenant_id=pkg.tenant_id and project_id=pkg.project_id and phase_id=pkg.phase_id and is_active;
  update public.map_features set public_visible=true where snapshot_id=pkg.snapshot_id;
  update public.map_feature_snapshots set is_active=true where id=pkg.snapshot_id;
  update public.project_map_packages set published_at=now() where id=pkg.id;
  return jsonb_build_object('published',true,'snapshot_id',pkg.snapshot_id,'reused',false);
end $$;
revoke all on function public.publish_project_map_package(uuid,uuid,boolean) from public,anon;
grant execute on function public.publish_project_map_package(uuid,uuid,boolean) to authenticated;

create function public.review_project_map_package(p_package_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare pkg public.project_map_packages%rowtype;
begin
  select * into strict pkg from public.project_map_packages where id=p_package_id;
  perform public.assert_map_package_scope(pkg.tenant_id,pkg.project_id,pkg.phase_id);
  update public.map_features set provenance=jsonb_set(provenance,'{reviewed}','true'),updated_at=now() where snapshot_id=pkg.snapshot_id;
end $$;
revoke all on function public.review_project_map_package(uuid) from public,anon;
grant execute on function public.review_project_map_package(uuid) to authenticated;

create function public.save_project_plot_content(p_identity_id uuid,p_expected_revision integer,p_content jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare plot public.project_plot_content%rowtype;
begin
  select * into strict plot from public.project_plot_content where identity_id=p_identity_id for update;
  perform public.assert_map_package_scope(plot.tenant_id,plot.project_id,plot.phase_id);
  if plot.revision<>p_expected_revision then raise exception 'Plot details changed. Reload before saving.' using errcode='40001'; end if;
  update public.project_plot_content set plot_number=nullif(trim(p_content->>'plot_number'),''),
    area_value=(p_content->>'area_value')::numeric,area_unit=p_content->>'area_unit',area_basis=coalesce(p_content->>'area_basis','recorded'),
    dimensions=nullif(trim(p_content->>'dimensions'),''), category_key=nullif(p_content->>'category_key',''),
    price_cents=(p_content->>'price_cents')::bigint,currency=nullif(p_content->>'currency',''),price_basis=nullif(p_content->>'price_basis',''),
    parcel_id=(p_content->>'parcel_id')::bigint,public_visible=coalesce((p_content->>'public_visible')::boolean,false),
    revision=revision+1,updated_at=now(),updated_by=auth.uid() where identity_id=p_identity_id returning * into plot;
  return to_jsonb(plot);
end $$;
revoke all on function public.save_project_plot_content(uuid,integer,jsonb) from public,anon;
grant execute on function public.save_project_plot_content(uuid,integer,jsonb) to authenticated;

create function public.save_project_map_category(p_tenant_id uuid,p_project_id uuid,p_phase_id uuid,p_category jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.assert_map_package_scope(p_tenant_id,p_project_id,p_phase_id);
  if coalesce(p_category->>'key','') !~ '^[a-z0-9_]{1,80}$' or coalesce(length(trim(p_category->>'label')),0) not between 1 and 100
    or coalesce(p_category->>'color','') !~ '^#[a-fA-F0-9]{6}$'
    or (p_category->>'currency' is not null and p_category->>'currency' !~ '^[A-Z]{3}$')
    or length(p_category->>'price_basis')>100 then raise exception 'Invalid plot category.'; end if;
  update public.project_lot_tiers set label=trim(p_category->>'label'),color_hex=p_category->>'color',
    price_cents=coalesce((p_category->>'price_cents')::bigint,0),map_price_is_set=p_category->>'price_cents' is not null,
    currency=p_category->>'currency',price_basis=p_category->>'price_basis',updated_at=now()
    where tenant_id=p_tenant_id and project_id=p_project_id and tier_key=p_category->>'key';
  if not found then raise exception 'Category not found in this project.'; end if;
end $$;
revoke all on function public.save_project_map_category(uuid,uuid,uuid,jsonb) from public,anon;
grant execute on function public.save_project_map_category(uuid,uuid,uuid,jsonb) to authenticated;

-- Only the public Edge Function can read this projection. Private package
-- contents, source coordinates, review notes and creator data never leave it.
create function public.get_published_project_map_package(p_tenant_id uuid,p_project_id uuid,p_phase_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'package_id',pkg.id,'revision',pkg.package_data->'revision','title',pkg.package_data->>'title',
    'canvas',jsonb_build_object('width',pkg.package_data#>'{canvas,width}','height',pkg.package_data#>'{canvas,height}'),
    'background_path',pkg.background_path,
    'categories',(select coalesce(jsonb_agg(jsonb_build_object('key',c.tier_key,'label',c.label,'color',c.color_hex,
      'price_cents',case when c.map_price_is_set then c.price_cents end,'currency',c.currency,'price_basis',c.price_basis) order by c.sort_order,c.tier_key),'[]'::jsonb)
      from public.project_lot_tiers c where c.tenant_id=pkg.tenant_id and c.project_id=pkg.project_id and c.is_active),
    'features',(select coalesce(jsonb_agg(jsonb_build_object(
      'map_feature_ref',f.identity_id,'demo_label',coalesce(p.lot_number,pc.plot_number,'Ref '||upper(right(replace(f.identity_id::text,'-',''),6))),'plot_number',coalesce(p.lot_number,pc.plot_number),
      'kind',case when f.feature_kind='demo_plot' then 'plot' else f.feature_kind end,
      'map_polygon',f.map_polygon,'category_key',pc.category_key,'area_value',pc.area_value,'area_unit',pc.area_unit,
      'dimensions',coalesce(p.dimensions,pc.dimensions),'category_label',c.label,'category_color',c.color_hex,
      'price_cents',case when p.id is not null then coalesce(p.price_override_cents,lc.price_cents+case when p.is_corner then lc.corner_premium_cents else 0 end,round(p.base_price*100)::bigint)
        else coalesce(pc.price_cents,case when c.map_price_is_set then c.price_cents end) end,
      'currency',case when p.id is not null then lc.currency else coalesce(pc.currency,c.currency) end,
      'price_basis',case when p.id is not null then lc.price_basis else coalesce(pc.price_basis,c.price_basis) end
      ) order by f.demo_label),'[]'::jsonb)
      from public.map_features f join public.project_plot_content pc on pc.identity_id=f.identity_id
      left join public.project_lot_tiers c on c.tenant_id=pc.tenant_id and c.project_id=pc.project_id and c.tier_key=pc.category_key and c.is_active
      left join public.parcels p on p.id=pc.parcel_id and p.tenant_id=pc.tenant_id and p.project_id=pc.project_id and p.phase_id=pc.phase_id
      left join public.project_lot_tiers lc on lc.tenant_id=p.tenant_id and lc.project_id=p.project_id and lc.tier_key=p.tier_key and lc.is_active
      where f.snapshot_id=pkg.snapshot_id and f.tenant_id=pkg.tenant_id and f.project_id=pkg.project_id and f.phase_id=pkg.phase_id
        and f.is_active and f.public_visible and pc.public_visible))
  from public.project_map_packages pkg join public.map_feature_snapshots s on s.id=pkg.snapshot_id and s.is_active
  where pkg.tenant_id=p_tenant_id and pkg.project_id=p_project_id and pkg.phase_id=p_phase_id
$$;
revoke all on function public.get_published_project_map_package(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_published_project_map_package(uuid,uuid,uuid) to service_role;

-- Display assets stay private until the public API signs the active package.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('project-map-packages','project-map-packages',false,10485760,array['image/png','image/jpeg','image/webp'])
  on conflict(id) do nothing;
create function public.can_access_map_package_asset(object_name text,manage boolean) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare parts text[];
begin
  parts:=string_to_array(object_name,'/');
  if cardinality(parts)<>4 or parts[4] !~ '^[a-f0-9]{64}\.(png|jpg|webp)$' then return false; end if;
  if not exists(select 1 from public.development_phases where id=parts[3]::uuid and project_id=parts[2]::uuid and tenant_id=parts[1]::uuid) then return false; end if;
  return auth.uid() is not null and public.user_has_project_access(parts[1]::uuid,parts[2]::uuid,parts[3]::uuid)
    and (not manage or (public.is_admin_user() and public.user_can_manage_project(parts[1]::uuid,parts[2]::uuid)));
exception when invalid_text_representation then return false;
end $$;
revoke all on function public.can_access_map_package_asset(text,boolean) from public,anon;
grant execute on function public.can_access_map_package_asset(text,boolean) to authenticated;
create policy map_package_asset_read on storage.objects for select to authenticated
  using(bucket_id='project-map-packages' and public.can_access_map_package_asset(name,false));
create policy map_package_asset_insert on storage.objects for insert to authenticated
  with check(bucket_id='project-map-packages' and public.can_access_map_package_asset(name,true));
create policy map_package_asset_immutable_update on storage.objects as restrictive for update to authenticated
  using(bucket_id<>'project-map-packages') with check(bucket_id<>'project-map-packages');
create policy map_package_asset_immutable_delete on storage.objects as restrictive for delete to authenticated
  using(bucket_id<>'project-map-packages');

-- Published Studio outlines accept questions in sales or demo projects.
-- The existing atomic lead/follow-up and retry behavior is retained.
create or replace function public.create_scoped_public_inquiry(
  p_tenant_id uuid,
  p_project_id uuid,
  p_phase_id uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_message text,
  p_page_url text,
  p_interests jsonb,
  p_client_reference_id text,
  p_parcel_id bigint default null,
  p_map_feature_id uuid default null,
  p_duplicate_reason text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_lead_id uuid;
  v_existing public.leads%rowtype;
  v_scope_tenant uuid;
  v_scope_project uuid;
  v_scope_phase uuid;
  v_label text;
  v_status text;
  v_waitlist boolean := false;
  v_notes text;
  v_due_at timestamptz := now() + interval '24 hours';
begin
  if p_tenant_id is null or p_project_id is null or p_phase_id is null
     or nullif(trim(p_name), '') is null or nullif(trim(p_email), '') is null
     or nullif(trim(p_client_reference_id), '') is null then
    raise exception 'Public inquiry scope, contact and idempotency fields are required.';
  end if;
  if p_parcel_id is not null and p_map_feature_id is not null then
    raise exception 'An inquiry cannot reference both an inventory parcel and a map feature.';
  end if;
  if not exists (
    select 1 from public.development_phases ph
    join public.projects p on p.id=ph.project_id and p.tenant_id=ph.tenant_id
    join public.organizations o on o.id=p.tenant_id and o.is_active
    where ph.id=p_phase_id and ph.project_id=p_project_id and ph.tenant_id=p_tenant_id and ph.is_active
  ) then raise exception 'Inquiry project/phase scope is invalid or inactive.'; end if;

  if p_map_feature_id is not null then
    select i.tenant_id, i.project_id, i.phase_id, coalesce(linked.lot_number, pc.plot_number, f.demo_label)
      into v_scope_tenant, v_scope_project, v_scope_phase, v_label
    from public.map_feature_identities i
    join public.map_features f on f.identity_id=i.id
    join public.map_feature_snapshots s on s.id=f.snapshot_id
    join public.projects p on p.id=i.project_id and p.tenant_id=i.tenant_id
    left join public.project_map_packages pkg on pkg.snapshot_id=s.id
      and pkg.tenant_id=i.tenant_id and pkg.project_id=i.project_id and pkg.phase_id=i.phase_id
    left join public.project_plot_content pc on pc.identity_id=i.id
      and pc.tenant_id=i.tenant_id and pc.project_id=i.project_id and pc.phase_id=i.phase_id
    left join public.parcels linked on linked.id=pc.parcel_id
      and linked.tenant_id=pc.tenant_id and linked.project_id=pc.project_id and linked.phase_id=pc.phase_id
    where i.id=p_map_feature_id and s.is_active and f.is_active and f.public_visible
      and ((pkg.id is null and p.map_experience_mode='demo')
        or (pkg.id is not null and pc.public_visible and f.feature_kind='demo_plot'))
    order by f.created_at desc limit 1;
    if v_scope_tenant is null then raise exception 'Selected mapped plot is not part of an active public map.'; end if;
    if v_scope_tenant<>p_tenant_id or v_scope_project<>p_project_id or v_scope_phase<>p_phase_id then
      raise exception 'Selected mapped plot does not belong to the requested project/phase.';
    end if;
  elsif p_parcel_id is not null then
    select parcel.tenant_id, parcel.project_id, parcel.phase_id, parcel.lot_number, parcel.status
      into v_scope_tenant, v_scope_project, v_scope_phase, v_label, v_status
    from public.parcels parcel
    join public.projects p on p.id=parcel.project_id and p.tenant_id=parcel.tenant_id
      and p.map_experience_mode='sales'
    where parcel.id=p_parcel_id;
    if v_scope_tenant is null or v_scope_tenant<>p_tenant_id or v_scope_project<>p_project_id or v_scope_phase<>p_phase_id then
      raise exception 'Selected parcel does not belong to the requested project/phase.';
    end if;
    if v_status not in ('Available', 'Reserved') then raise exception 'Selected parcel is no longer available for inquiry.'; end if;
    v_waitlist := v_status='Reserved';
  end if;

  v_notes := concat_ws(E'\n',
    case when p_map_feature_id is not null then 'Specific mapped plot interest: ' || coalesce(v_label, 'Mapped plot')
         when p_parcel_id is not null then 'Specific lot interest: Lot ' || coalesce(v_label, '')
         else null end,
    case when nullif(trim(p_phone), '') is not null then 'Phone / WhatsApp: ' || trim(p_phone) end,
    case when nullif(trim(p_message), '') is not null then 'Buyer message: ' || trim(p_message) end
  );

  insert into public.leads(
    tenant_id, project_id, phase_id, parcel_id, map_feature_id, full_name, email, phone,
    source, pipeline_stage, buyer_journey_stage, preferred_contact_method, assigned_to,
    next_action, next_action_due_at, notes, client_reference_id, possible_duplicate,
    duplicate_reason, duplicate_checked_at, created_by
  ) values (
    p_tenant_id, p_project_id, p_phase_id, p_parcel_id, p_map_feature_id, trim(p_name), lower(trim(p_email)),
    nullif(trim(p_phone), ''), 'public_inquiry', 'new_lead', 'Public Information Request',
    case when nullif(trim(p_phone), '') is not null then 'Email or Phone / WhatsApp' else 'Email' end,
    null, 'Follow up on public project information inquiry', v_due_at, nullif(v_notes, ''),
    p_client_reference_id, nullif(trim(p_duplicate_reason), '') is not null,
    nullif(trim(p_duplicate_reason), ''), now(), null
  ) on conflict (tenant_id, client_reference_id) where client_reference_id is not null do nothing
  returning id into v_lead_id;

  if v_lead_id is null then
    select * into v_existing from public.leads
    where tenant_id=p_tenant_id and client_reference_id=p_client_reference_id;
    if not found then raise exception 'Inquiry idempotency resolution failed.'; end if;
    if v_existing.project_id is distinct from p_project_id or v_existing.phase_id is distinct from p_phase_id
      or v_existing.full_name<>trim(p_name) or lower(coalesce(v_existing.email,''))<>lower(trim(p_email))
      or coalesce(v_existing.phone,'')<>coalesce(nullif(trim(p_phone),''),'')
      or v_existing.parcel_id is distinct from p_parcel_id
      or v_existing.map_feature_id is distinct from p_map_feature_id then
      return jsonb_build_object('ok',false,'conflict',true);
    end if;
    return jsonb_build_object('ok',true,'deduplicated',true,'lead_id',v_existing.id,'follow_up_created',true);
  end if;

  insert into public.lead_activities(tenant_id, project_id, phase_id, lead_id, activity_type, title, description, metadata, created_by)
  values (
    p_tenant_id, p_project_id, p_phase_id, v_lead_id, 'note',
    case when nullif(trim(p_duplicate_reason),'') is null then 'Public information request received'
      else 'Public information request received - possible duplicate' end,
    v_notes,
    jsonb_build_object('source','public_inquiry','interests',coalesce(p_interests,'[]'::jsonb),
      'specific_map_feature_id',p_map_feature_id,'specific_parcel_id',p_parcel_id,'page_url',p_page_url,
      'possible_duplicate',nullif(trim(p_duplicate_reason),'') is not null,'duplicate_reason',nullif(trim(p_duplicate_reason),'')),
    null
  );
  insert into public.follow_up_tasks(tenant_id, project_id, phase_id, lead_id, title, description, due_at, status, priority, assigned_to, created_by)
  values (
    p_tenant_id, p_project_id, p_phase_id, v_lead_id,
    case when nullif(trim(p_duplicate_reason),'') is null then 'Follow up on public project information inquiry' else 'Review possible duplicate public inquiry' end,
    case when v_waitlist then 'Contact the buyer about their waitlist request; do not promise current availability.'
      else 'Contact the buyer about their public project information request and answer their questions.' end,
    v_due_at, 'open', case when nullif(trim(p_duplicate_reason),'') is null then 'normal' else 'high' end, null, null
  );
  return jsonb_build_object('ok',true,'deduplicated',false,'lead_id',v_lead_id,'follow_up_created',true,'waitlist',v_waitlist);
end;
$$;

revoke all on function public.create_scoped_public_inquiry(uuid, uuid, uuid, text, text, text, text, text, jsonb, text, bigint, uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_scoped_public_inquiry(uuid, uuid, uuid, text, text, text, text, text, jsonb, text, bigint, uuid, text)
  to service_role;
comment on function public.create_scoped_public_inquiry(uuid, uuid, uuid, text, text, text, text, text, jsonb, text, bigint, uuid, text) is
  'Service-role-only atomic public inquiry create; derives trusted project scope from active source records and writes lead/activity/follow-up together.';

commit;
