-- Template choice is a presentation setting. The fallback must not infer a
-- template from tenant or project identity; public site selection also stays
-- independent of application requirements and authorization.
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
  v_default_modules := jsonb_build_object(
    'map', true,
    'inquiry', true,
    'application', true,
    'pricing', true
  );

  return jsonb_build_object(
    'templateId', case when v_site_experience ->> 'templateId' in ('wamule-classic', 'hopkins-project')
      then v_site_experience ->> 'templateId' else 'wamule-classic' end,
    'enabledModules', v_default_modules || case
      when jsonb_typeof(v_site_experience -> 'enabledModules') = 'object'
        then v_site_experience -> 'enabledModules' else '{}'::jsonb end
  );
end;
$$;
