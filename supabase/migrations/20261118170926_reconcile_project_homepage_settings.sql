-- Converge fresh databases and both legacy RPC versions on one signature.
-- Optional arguments keep four-argument and preview-flag callers compatible.
begin;

drop function if exists public.save_project_site_experience(uuid, uuid, text, jsonb);
drop function if exists public.save_project_site_experience(uuid, uuid, text, jsonb, boolean);

create or replace function public.get_project_site_experience(
  p_tenant_id uuid,
  p_project_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_profile_tenant uuid;
  v_site jsonb;
begin
  select ap.role, ap.tenant_id into v_role, v_profile_tenant
  from public.admin_profiles ap where ap.user_id = auth.uid();
  if v_role is null or v_role not in ('Super Admin', 'Admin')
     or (v_role = 'Admin' and v_profile_tenant is distinct from p_tenant_id) then
    raise exception 'Not authorized to manage this project site' using errcode = '42501';
  end if;
  if p_tenant_id is null or p_project_id is null then
    raise exception 'Tenant and project are required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.projects p where p.id = p_project_id and p.tenant_id = p_tenant_id
  ) then
    raise exception 'Project does not belong to the selected tenant' using errcode = '42501';
  end if;

  select ps.value -> 'site_experience' into v_site from public.project_settings ps
  where ps.tenant_id = p_tenant_id and ps.project_id = p_project_id and ps.key = 'tenant_theme';

  return jsonb_build_object(
    'templateId', case when v_site ->> 'templateId' = 'hopkins-project' then 'hopkins-project' else 'wamule-classic' end,
    'headline', case when jsonb_typeof(v_site -> 'headline') = 'string' then v_site ->> 'headline' end,
    'enabledModules', jsonb_build_object(
      'map', v_site #> '{enabledModules,map}' is distinct from 'false'::jsonb,
      'inquiry', v_site #> '{enabledModules,inquiry}' is distinct from 'false'::jsonb,
      'application', v_site #> '{enabledModules,application}' is distinct from 'false'::jsonb,
      'pricing', v_site #> '{enabledModules,pricing}' is distinct from 'false'::jsonb
    ),
    'uiRestrictedAccess', coalesce(v_site -> 'uiRestrictedAccess' = 'true'::jsonb, false)
  );
end;
$$;

create or replace function public.save_project_site_experience(
  p_tenant_id uuid,
  p_project_id uuid,
  p_template_id text,
  p_enabled_modules jsonb,
  p_ui_restricted_access_enabled boolean default null,
  p_headline text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_site jsonb;
  v_headline text := nullif(btrim(regexp_replace(p_headline, '[[:space:]]+', ' ', 'g')), '');
  v_saved boolean;
begin
  -- Use the same authenticated tenant/project access check for read and write.
  perform public.get_project_site_experience(p_tenant_id, p_project_id);
  if p_template_id is null or p_template_id not in ('wamule-classic', 'hopkins-project') then
    raise exception 'Unknown public site template' using errcode = '22023';
  end if;
  if jsonb_typeof(p_enabled_modules) is distinct from 'object' then
    raise exception 'Invalid public site modules' using errcode = '22023';
  end if;
  if p_enabled_modules - array['map', 'inquiry', 'application', 'pricing'] <> '{}'::jsonb
    or exists (select 1 from jsonb_each(p_enabled_modules) item where jsonb_typeof(item.value) <> 'boolean') then
    raise exception 'Invalid public site modules' using errcode = '22023';
  end if;
  if length(v_headline) > 120 then
    raise exception 'Homepage headline must be 120 characters or fewer' using errcode = '22023';
  end if;

  v_site := jsonb_build_object('templateId', p_template_id, 'enabledModules', p_enabled_modules);
  if p_headline is not null then
    v_site := v_site || jsonb_build_object('headline', v_headline);
  end if;
  if p_ui_restricted_access_enabled is not null then
    v_site := v_site || jsonb_build_object('uiRestrictedAccess', p_ui_restricted_access_enabled);
  end if;

  insert into public.project_settings (tenant_id, project_id, key, value, updated_by)
  values (p_tenant_id, p_project_id, 'tenant_theme', jsonb_build_object('site_experience', v_site), auth.uid())
  on conflict (project_id, key) do update
    set value = coalesce(public.project_settings.value, '{}'::jsonb) || jsonb_build_object(
          'site_experience',
          case when jsonb_typeof(public.project_settings.value -> 'site_experience') = 'object'
            then public.project_settings.value -> 'site_experience' else '{}'::jsonb end || v_site
        ),
        updated_by = auth.uid()
    where public.project_settings.tenant_id = p_tenant_id
  returning true into v_saved;

  if v_saved is distinct from true then
    raise exception 'Project site settings could not be saved for this tenant' using errcode = '42501';
  end if;
  return public.get_project_site_experience(p_tenant_id, p_project_id);
end;
$$;

revoke all on function public.get_project_site_experience(uuid, uuid) from public, anon, service_role;
revoke all on function public.save_project_site_experience(uuid, uuid, text, jsonb, boolean, text) from public, anon, service_role;
grant execute on function public.get_project_site_experience(uuid, uuid) to authenticated;
grant execute on function public.save_project_site_experience(uuid, uuid, text, jsonb, boolean, text) to authenticated;

notify pgrst, 'reload schema';
commit;
