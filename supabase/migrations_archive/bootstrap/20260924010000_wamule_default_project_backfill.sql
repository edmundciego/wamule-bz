-- Seed the existing Wamule tenant's default project before project-scoped
-- public-map migration backfills legacy parcel and masterplan ownership.
-- Do not merge, re-parent, or rename an existing project on ambiguity.

begin;

do $$
declare
  v_tenant_id uuid;
  v_tenant_name text;
  v_tenant_active boolean;
  v_tenant_count bigint;
  v_project_id uuid;
  v_project_slug text;
  v_project_name text;
  v_project_is_default boolean;
  v_slug_count bigint;
  v_default_count bigint;
begin
  if to_regclass('public.organizations') is null
     or to_regclass('public.projects') is null
     or to_regclass('public.parcels') is null then
    raise exception 'Wamule default-project backfill prerequisites are missing.';
  end if;

  -- The tenant UUID is fixed by the original Wamule tenant seed migration.
  -- Require both that identity and the unique public slug; never infer a
  -- tenant from a display name or move records between organizations.
  select count(*) into v_tenant_count
  from public.organizations
  where slug = 'wamule';

  if v_tenant_count <> 1 then
    raise exception 'Expected exactly one Wamule tenant with slug wamule; found %.', v_tenant_count;
  end if;

  select id, name, is_active
  into v_tenant_id, v_tenant_name, v_tenant_active
  from public.organizations
  where slug = 'wamule'
  for update;

  if v_tenant_id <> 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid
     or v_tenant_name <> 'Wamule Development'
     or v_tenant_active is distinct from true then
    raise exception 'The Wamule tenant identity does not match the reviewed seed; refusing project backfill.';
  end if;

  select count(*) into v_slug_count
  from public.projects
  where tenant_id = v_tenant_id and lower(slug) = 'wamule';

  if v_slug_count > 1 then
    raise exception 'Multiple Wamule projects claim slug wamule; resolve the ambiguity before retrying.';
  end if;

  if v_slug_count = 1 then
    select id, slug, name, is_default
    into v_project_id, v_project_slug, v_project_name, v_project_is_default
    from public.projects
    where tenant_id = v_tenant_id and lower(slug) = 'wamule'
    for update;

    if v_project_slug <> 'wamule' or v_project_name <> 'Wamule' then
      raise exception 'The existing Wamule project conflicts with the reviewed slug/name; refusing to rename it.';
    end if;

    if not v_project_is_default then
      select count(*) into v_default_count
      from public.projects
      where tenant_id = v_tenant_id and is_default;

      if v_default_count > 0 then
        raise exception 'Wamule already has a different default project; refusing ambiguous promotion.';
      end if;

      update public.projects
      set is_default = true
      where id = v_project_id and tenant_id = v_tenant_id;
    end if;
  else
    select count(*) into v_default_count
    from public.projects
    where tenant_id = v_tenant_id and is_default;

    if v_default_count > 0 then
      raise exception 'Wamule already has a differently named default project; refusing to create a second default.';
    end if;

    insert into public.projects (tenant_id, slug, name, is_default)
    values (v_tenant_id, 'wamule', 'Wamule', true)
    returning id into v_project_id;
  end if;

  select count(*) into v_default_count
  from public.projects
  where tenant_id = v_tenant_id and is_default;

  if v_default_count <> 1 or not exists (
    select 1 from public.projects
    where id = v_project_id
      and tenant_id = v_tenant_id
      and slug = 'wamule'
      and name = 'Wamule'
      and is_default
  ) then
    raise exception 'Wamule default-project identity is not unique and consistent.';
  end if;

  -- Reject broken or cross-tenant assignments instead of silently repairing
  -- ownership. Valid existing project assignments remain unchanged.
  if exists (
    select 1
    from public.parcels p
    left join public.projects pr on pr.id = p.project_id
    where p.tenant_id = v_tenant_id
      and p.project_id is not null
      and (pr.id is null or pr.tenant_id <> p.tenant_id)
  ) then
    raise exception 'Wamule parcel project ownership is missing or cross-tenant; reconcile linked records before retrying.';
  end if;

  if exists (
    select 1 from public.parcels p
    where p.project_id = v_project_id and p.tenant_id <> v_tenant_id
  ) then
    raise exception 'A parcel from another tenant is assigned to the Wamule default project; refusing cross-tenant repair.';
  end if;

  if exists (
    select 1
    from public.leads l
    left join public.parcels p on p.id = l.parcel_id
    where l.parcel_id is not null
      and (l.tenant_id = v_tenant_id or p.tenant_id = v_tenant_id)
      and (p.id is null or p.tenant_id <> l.tenant_id)
  ) then
    raise exception 'A lead has a missing or cross-tenant parcel relationship; refusing project/phase backfill.';
  end if;

  if exists (
    select 1
    from public.lead_activities a
    left join public.leads l on l.id = a.lead_id
    where a.lead_id is not null
      and (a.tenant_id = v_tenant_id or l.tenant_id = v_tenant_id)
      and (l.id is null or l.tenant_id <> a.tenant_id)
  ) then
    raise exception 'A lead activity has a missing or cross-tenant lead relationship; refusing project/phase backfill.';
  end if;

  if exists (
    select 1
    from public.follow_up_tasks f
    left join public.leads l on l.id = f.lead_id
    where f.lead_id is not null
      and (f.tenant_id = v_tenant_id or l.tenant_id = v_tenant_id)
      and (l.id is null or l.tenant_id <> f.tenant_id)
  ) then
    raise exception 'A follow-up task has a missing or cross-tenant lead relationship; refusing project/phase backfill.';
  end if;

  -- Only unassigned legacy parcels owned by this exact tenant receive the
  -- default project. The following project-scoping migration assigns
  -- masterplan versions after it creates their project_id column.
  update public.parcels
  set project_id = v_project_id
  where tenant_id = v_tenant_id
    and project_id is null;

  if exists (
    select 1 from public.parcels
    where tenant_id = v_tenant_id and project_id is null
  ) then
    raise exception 'Wamule parcels remain without project scope after the backfill.';
  end if;
end;
$$;

commit;
