-- Project application requirements live in project_settings, independently
-- of the tenant-wide intake gate and public-site/map publication controls.
-- These security-definer RPCs are the supported browser path for Admins.

create or replace function public.get_project_application_settings(
  p_tenant_id uuid,
  p_project_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_profile_tenant uuid;
  v_project_slug text;
  v_project_application jsonb;
  v_company_application jsonb;
  v_phases jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select ap.role, ap.tenant_id into v_role, v_profile_tenant
    from public.admin_profiles ap where ap.user_id = auth.uid();
  if v_role is null or v_role not in ('Super Admin', 'Admin')
     or (v_role = 'Admin' and v_profile_tenant is distinct from p_tenant_id) then
    raise exception 'Not authorized to manage this project application' using errcode = '42501';
  end if;
  if p_tenant_id is null or p_project_id is null then
    raise exception 'Tenant and project are required' using errcode = '22023';
  end if;

  select p.slug into v_project_slug from public.projects p
   where p.id = p_project_id and p.tenant_id = p_tenant_id;
  if v_project_slug is null then
    raise exception 'Project does not belong to the selected tenant' using errcode = '42501';
  end if;

  select coalesce(ps.value, '{}'::jsonb) into v_project_application
    from public.project_settings ps
   where ps.tenant_id = p_tenant_id and ps.project_id = p_project_id and ps.key = 'public_application';
  select coalesce(bs.value, '{}'::jsonb) into v_company_application
    from public.business_settings bs
   where bs.tenant_id = p_tenant_id and bs.key = 'public_application';
  select coalesce(jsonb_agg(jsonb_build_object('id', dp.id, 'name', dp.name, 'slug', dp.slug)
    order by dp.slug), '[]'::jsonb) into v_phases
    from public.development_phases dp
   where dp.tenant_id = p_tenant_id and dp.project_id = p_project_id and dp.is_active = true;

  return jsonb_build_object(
    'projectApplication', coalesce(v_project_application, '{}'::jsonb),
    'companyApplication', coalesce(v_company_application, '{}'::jsonb),
    'phases', coalesce(v_phases, '[]'::jsonb)
  );
end;
$$;

create or replace function public.save_project_application_settings(
  p_tenant_id uuid,
  p_project_id uuid,
  p_application_settings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_profile_tenant uuid;
  v_project_slug text;
  v_saved jsonb;
  v_allowed_phases jsonb;
  v_intended_uses jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select ap.role, ap.tenant_id into v_role, v_profile_tenant
    from public.admin_profiles ap where ap.user_id = auth.uid();
  if v_role is null or v_role not in ('Super Admin', 'Admin')
     or (v_role = 'Admin' and v_profile_tenant is distinct from p_tenant_id) then
    raise exception 'Not authorized to manage this project application' using errcode = '42501';
  end if;
  if p_tenant_id is null or p_project_id is null then
    raise exception 'Tenant and project are required' using errcode = '22023';
  end if;
  if p_application_settings is null or jsonb_typeof(p_application_settings) <> 'object'
     or p_application_settings - array[
       'application_type', 'applications_open', 'allowed_phase_ids', 'notice_version',
       'public_notice_text', 'application_acknowledgment_text', 'allowed_intended_uses',
       'max_map_preferences', 'default_confirmation_message'
     ] <> '{}'::jsonb then
    raise exception 'Invalid project application settings' using errcode = '22023';
  end if;

  select p.slug into v_project_slug from public.projects p
   where p.id = p_project_id and p.tenant_id = p_tenant_id;
  if v_project_slug is null then
    raise exception 'Project does not belong to the selected tenant' using errcode = '42501';
  end if;

  if coalesce(p_application_settings->>'application_type', '') not in ('land_purchase', 'project_application')
     or jsonb_typeof(p_application_settings->'applications_open') is distinct from 'boolean'
     or jsonb_typeof(p_application_settings->'allowed_phase_ids') is distinct from 'array'
     or jsonb_typeof(p_application_settings->'allowed_intended_uses') is distinct from 'array'
     or jsonb_typeof(p_application_settings->'max_map_preferences') is distinct from 'number'
     or (p_application_settings->>'max_map_preferences') !~ '^(0|[1-9]|10)$'
     or length(btrim(coalesce(p_application_settings->>'notice_version', ''))) not between 1 and 80
     or length(btrim(coalesce(p_application_settings->>'public_notice_text', ''))) not between 1 and 5000
     or length(btrim(coalesce(p_application_settings->>'application_acknowledgment_text', ''))) not between 1 and 2000
     or length(btrim(coalesce(p_application_settings->>'default_confirmation_message', ''))) > 500 then
    raise exception 'Project application type, notice, acknowledgment, intended-use or preference settings are incomplete or invalid' using errcode = '22023';
  end if;

  v_allowed_phases := p_application_settings->'allowed_phase_ids';
  if exists (
    select 1 from jsonb_array_elements(v_allowed_phases) item(value)
     where jsonb_typeof(item.value) <> 'string'
        or (item.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or not exists (
          select 1 from public.development_phases dp
           where dp.id::text = item.value #>> '{}'
             and dp.tenant_id = p_tenant_id and dp.project_id = p_project_id and dp.is_active = true
        )
  ) then
    raise exception 'Allowed phases must belong to the selected active project' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_array_elements(v_allowed_phases)) <>
     (select count(distinct value #>> '{}') from jsonb_array_elements(v_allowed_phases) as phase(value)) then
    raise exception 'Allowed phases cannot contain duplicates' using errcode = '22023';
  end if;

  v_intended_uses := p_application_settings->'allowed_intended_uses';
  if jsonb_array_length(v_intended_uses) < 1 or jsonb_array_length(v_intended_uses) > 20
     or exists (select 1 from jsonb_array_elements(v_intended_uses) item(value)
       where jsonb_typeof(item.value) <> 'string'
          or length(btrim(item.value #>> '{}')) not between 1 and 40) then
    raise exception 'At least one valid intended use is required' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_array_elements(v_intended_uses)) <>
     (select count(distinct lower(btrim(value #>> '{}'))) from jsonb_array_elements(v_intended_uses) as intended(value)) then
    raise exception 'Intended uses cannot contain duplicates' using errcode = '22023';
  end if;

  insert into public.project_settings (tenant_id, project_id, key, value, updated_by)
  values (p_tenant_id, p_project_id, 'public_application', p_application_settings, auth.uid())
  on conflict (project_id, key) do update
    set value = coalesce(public.project_settings.value, '{}'::jsonb) || excluded.value,
        updated_by = auth.uid()
    where public.project_settings.tenant_id = p_tenant_id
  returning value into v_saved;
  if v_saved is null then
    raise exception 'Project application settings could not be saved for this tenant' using errcode = '42501';
  end if;

  return public.get_project_application_settings(p_tenant_id, p_project_id);
end;
$$;

revoke all on function public.get_project_application_settings(uuid, uuid) from public, anon;
revoke all on function public.save_project_application_settings(uuid, uuid, jsonb) from public, anon;
grant execute on function public.get_project_application_settings(uuid, uuid) to authenticated;
grant execute on function public.save_project_application_settings(uuid, uuid, jsonb) to authenticated;

comment on function public.get_project_application_settings(uuid, uuid) is
  'Returns project application settings and intake gate context to authorized Admins for one tenant project.';
comment on function public.save_project_application_settings(uuid, uuid, jsonb) is
  'Updates only validated project application controls while preserving other public_application JSON settings.';
