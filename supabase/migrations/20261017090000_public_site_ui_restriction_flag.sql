-- Store a tenant/project-scoped preview gate independently from application
-- rules and membership. This flag only hides the page in the UI: public API
-- endpoints remain public until a separate server-side access policy exists.

create or replace function public.get_project_site_experience(
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
  v_project_exists boolean;
  v_theme jsonb;
  v_site_experience jsonb;
  v_default_modules jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select ap.role, ap.tenant_id
    into v_role, v_profile_tenant
    from public.admin_profiles ap
   where ap.user_id = auth.uid();

  if v_role is null or v_role not in ('Super Admin', 'Admin')
     or (v_role = 'Admin' and v_profile_tenant is distinct from p_tenant_id) then
    raise exception 'Not authorized to manage this project site' using errcode = '42501';
  end if;
  if p_tenant_id is null or p_project_id is null then
    raise exception 'Tenant and project are required' using errcode = '22023';
  end if;

  select exists (
    select 1 from public.projects p
     where p.id = p_project_id and p.tenant_id = p_tenant_id
  ) into v_project_exists;
  if not v_project_exists then
    raise exception 'Project does not belong to the selected tenant' using errcode = '42501';
  end if;

  select ps.value into v_theme
    from public.project_settings ps
   where ps.tenant_id = p_tenant_id and ps.project_id = p_project_id and ps.key = 'tenant_theme';

  v_site_experience := coalesce(v_theme -> 'site_experience', '{}'::jsonb);
  v_default_modules := jsonb_build_object('map', true, 'inquiry', true, 'application', true, 'pricing', true);

  return jsonb_build_object(
    'templateId', 'wamule-classic',
    'enabledModules', v_default_modules || case
      when jsonb_typeof(v_site_experience -> 'enabledModules') = 'object'
        then v_site_experience -> 'enabledModules' else '{}'::jsonb end,
    'uiRestrictedAccess', coalesce(v_site_experience -> 'uiRestrictedAccess' = 'true'::jsonb, false)
  );
end;
$$;

drop function if exists public.save_project_site_experience(uuid, uuid, text, jsonb);

create function public.save_project_site_experience(
  p_tenant_id uuid,
  p_project_id uuid,
  p_template_id text,
  p_enabled_modules jsonb,
  p_ui_restricted_access_enabled boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_profile_tenant uuid;
  v_value jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select ap.role, ap.tenant_id
    into v_role, v_profile_tenant
    from public.admin_profiles ap
   where ap.user_id = auth.uid();

  if v_role is null or v_role not in ('Super Admin', 'Admin')
     or (v_role = 'Admin' and v_profile_tenant is distinct from p_tenant_id) then
    raise exception 'Not authorized to manage this project site' using errcode = '42501';
  end if;
  if p_tenant_id is null or p_project_id is null then
    raise exception 'Tenant and project are required' using errcode = '22023';
  end if;
  if p_template_id is distinct from 'wamule-classic' then
    raise exception 'Unknown public site template' using errcode = '22023';
  end if;
  if p_enabled_modules is null or jsonb_typeof(p_enabled_modules) <> 'object'
     or p_enabled_modules - array['map', 'inquiry', 'application', 'pricing'] <> '{}'::jsonb
     or exists (select 1 from jsonb_each(p_enabled_modules) item where jsonb_typeof(item.value) <> 'boolean') then
    raise exception 'Invalid public site modules' using errcode = '22023';
  end if;

  insert into public.project_settings (tenant_id, project_id, key, value, updated_by)
  values (
    p_tenant_id,
    p_project_id,
    'tenant_theme',
    jsonb_build_object('site_experience', jsonb_build_object(
      'templateId', 'wamule-classic',
      'enabledModules', p_enabled_modules,
      'uiRestrictedAccess', coalesce(p_ui_restricted_access_enabled, false)
    )),
    auth.uid()
  )
  on conflict (project_id, key) do update
    set value = coalesce(public.project_settings.value, '{}'::jsonb) || jsonb_build_object(
          'site_experience',
          coalesce(public.project_settings.value -> 'site_experience', '{}'::jsonb)
            || coalesce(excluded.value -> 'site_experience', '{}'::jsonb)
        ),
        updated_by = auth.uid()
    where public.project_settings.tenant_id = p_tenant_id
  returning value into v_value;

  if v_value is null then
    raise exception 'Project site settings could not be saved for this tenant' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'templateId', 'wamule-classic',
    'enabledModules', v_value #> '{site_experience,enabledModules}',
    'uiRestrictedAccess', v_value #> '{site_experience,uiRestrictedAccess}' = 'true'::jsonb
  );
end;
$$;

revoke all on function public.get_project_site_experience(uuid, uuid) from public, anon;
revoke all on function public.save_project_site_experience(uuid, uuid, text, jsonb, boolean) from public, anon;
grant execute on function public.get_project_site_experience(uuid, uuid) to authenticated;
grant execute on function public.save_project_site_experience(uuid, uuid, text, jsonb, boolean) to authenticated;

comment on function public.save_project_site_experience(uuid, uuid, text, jsonb, boolean) is
  'Updates project presentation modules and a UI-only restricted preview flag. The flag does not enforce server-side access control.';
