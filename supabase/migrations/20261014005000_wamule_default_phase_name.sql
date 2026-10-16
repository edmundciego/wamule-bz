-- Give the Wamule default phase the reviewed display name after the pilot
-- migration creates development_phases and performs the phase backfill.

begin;

do $$
declare
  v_tenant_id uuid;
  v_project_id uuid;
  v_phase_id uuid;
  v_phase_name text;
  v_phase_is_default boolean;
  v_tenant_count bigint;
  v_project_count bigint;
  v_phase_count bigint;
begin
  if to_regclass('public.organizations') is null
     or to_regclass('public.projects') is null
     or to_regclass('public.development_phases') is null then
    raise exception 'Wamule default-phase name migration prerequisites are missing.';
  end if;

  select count(*) into v_tenant_count
  from public.organizations
  where id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid
    and slug = 'wamule'
    and name = 'Wamule Development'
    and is_active;

  if v_tenant_count <> 1 then
    raise exception 'The reviewed Wamule tenant identity is missing or ambiguous.';
  end if;
  v_tenant_id := 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid;

  select count(*) into v_project_count
  from public.projects
  where tenant_id = v_tenant_id
    and slug = 'wamule'
    and name = 'Wamule'
    and is_default;

  if v_project_count <> 1 then
    raise exception 'The reviewed Wamule default project is missing or ambiguous.';
  end if;

  select id into v_project_id
  from public.projects
  where tenant_id = v_tenant_id
    and slug = 'wamule'
    and name = 'Wamule'
    and is_default
  for update;

  select count(*) into v_phase_count
  from public.development_phases
  where tenant_id = v_tenant_id
    and project_id = v_project_id
    and slug = 'default';

  if v_phase_count <> 1 then
    raise exception 'The Wamule default phase is missing or ambiguous.';
  end if;

  select id, name, is_default
  into v_phase_id, v_phase_name, v_phase_is_default
  from public.development_phases
  where tenant_id = v_tenant_id
    and project_id = v_project_id
    and slug = 'default'
  for update;

  if v_phase_is_default is distinct from true then
    raise exception 'The Wamule phase with slug default is not marked as the default phase.';
  end if;

  if v_phase_name = 'Default phase' then
    update public.development_phases
    set name = 'Default'
    where id = v_phase_id and project_id = v_project_id and tenant_id = v_tenant_id;
  elsif v_phase_name is distinct from 'Default' then
    raise exception 'The Wamule default phase has a conflicting display name; refusing to overwrite it.';
  end if;
end;
$$;

commit;
