-- Keep site presentation settings separate from application requirements and
-- access control. project_settings stays private to service_role; these narrow
-- RPCs are the only browser path for authorized admins to preview and update
-- template/module choices.

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
  v_project_slug text;
  v_theme jsonb;
  v_site_experience jsonb;
  v_default_template text;
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

  select p.slug
    into v_project_slug
    from public.projects p
   where p.id = p_project_id and p.tenant_id = p_tenant_id;
  if v_project_slug is null then
    raise exception 'Project does not belong to the selected tenant' using errcode = '42501';
  end if;

  select ps.value into v_theme
    from public.project_settings ps
   where ps.tenant_id = p_tenant_id and ps.project_id = p_project_id and ps.key = 'tenant_theme';

  v_site_experience := coalesce(v_theme -> 'site_experience', '{}'::jsonb);
  v_default_template := case when v_project_slug = 'hopkins-grove' then 'hopkins-project' else 'wamule-classic' end;
  v_default_modules := jsonb_build_object(
    'map', true,
    'inquiry', true,
    'application', true,
    'pricing', true
  );

  return jsonb_build_object(
    'templateId', case when v_site_experience ->> 'templateId' in ('wamule-classic', 'hopkins-project')
      then v_site_experience ->> 'templateId' else v_default_template end,
    'enabledModules', v_default_modules || case
      when jsonb_typeof(v_site_experience -> 'enabledModules') = 'object'
        then v_site_experience -> 'enabledModules' else '{}'::jsonb end
  );
end;
$$;

create or replace function public.save_project_site_experience(
  p_tenant_id uuid,
  p_project_id uuid,
  p_template_id text,
  p_enabled_modules jsonb
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
  v_value jsonb;
  v_site_experience jsonb;
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
  if p_template_id is null or p_template_id not in ('wamule-classic', 'hopkins-project') then
    raise exception 'Unknown public site template' using errcode = '22023';
  end if;
  if p_enabled_modules is null or jsonb_typeof(p_enabled_modules) <> 'object'
     or p_enabled_modules - array['map', 'inquiry', 'application', 'pricing'] <> '{}'::jsonb
     or exists (select 1 from jsonb_each(p_enabled_modules) item where jsonb_typeof(item.value) <> 'boolean') then
    raise exception 'Invalid public site modules' using errcode = '22023';
  end if;

  select p.slug into v_project_slug
    from public.projects p
   where p.id = p_project_id and p.tenant_id = p_tenant_id;
  if v_project_slug is null then
    raise exception 'Project does not belong to the selected tenant' using errcode = '42501';
  end if;

  insert into public.project_settings (tenant_id, project_id, key, value, updated_by)
  values (
    p_tenant_id,
    p_project_id,
    'tenant_theme',
    jsonb_build_object('site_experience', jsonb_build_object(
      'templateId', p_template_id,
      'enabledModules', p_enabled_modules
    )),
    auth.uid()
  )
  on conflict (project_id, key) do update
    set value = coalesce(public.project_settings.value, '{}'::jsonb) || excluded.value,
        updated_by = auth.uid()
    where public.project_settings.tenant_id = p_tenant_id
  returning value into v_value;

  if v_value is null then
    raise exception 'Project site settings could not be saved for this tenant' using errcode = '42501';
  end if;

  v_site_experience := v_value -> 'site_experience';
  return jsonb_build_object('templateId', v_site_experience -> 'templateId', 'enabledModules', v_site_experience -> 'enabledModules');
end;
$$;

revoke all on function public.get_project_site_experience(uuid, uuid) from public, anon;
revoke all on function public.save_project_site_experience(uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.get_project_site_experience(uuid, uuid) to authenticated;
grant execute on function public.save_project_site_experience(uuid, uuid, text, jsonb) to authenticated;

comment on function public.get_project_site_experience(uuid, uuid) is
  'Returns the authorized admin view of template and enabled public site modules for one tenant project.';
comment on function public.save_project_site_experience(uuid, uuid, text, jsonb) is
  'Updates only the project public presentation template and module flags; it does not change application requirements, tenant membership, or permissions.';
