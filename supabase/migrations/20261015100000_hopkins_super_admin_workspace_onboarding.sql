-- A Super Admin may receive a project-scoped membership for Hopkins while
-- retaining the existing admin_profiles tenant assignment and global role.
-- The workspace selector already exposes every active tenant/project/phase
-- to Super Admins; do not rewrite admin_profiles to make Hopkins selectable.
create or replace function public.onboard_project_tenant(
  p_tenant_slug text,
  p_tenant_name text,
  p_project_slug text,
  p_project_name text,
  p_phase_slug text,
  p_phase_name text,
  p_theme jsonb,
  p_company_profile jsonb,
  p_staff_user_id uuid,
  p_member_role text default 'owner',
  p_demo_mode boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_tenant public.organizations%rowtype;
  v_project public.projects%rowtype;
  v_phase public.development_phases%rowtype;
  v_profile public.admin_profiles%rowtype;
  v_existing_role text;
  v_user_email text;
  v_user_name text;
  v_is_default boolean;
begin
  if p_tenant_slug !~ '^[a-z0-9][a-z0-9-]{0,62}$'
    or p_project_slug !~ '^[a-z0-9][a-z0-9-]{0,62}$'
    or p_phase_slug !~ '^[a-z0-9][a-z0-9-]{0,62}$'
    or nullif(trim(p_tenant_name),'') is null
    or nullif(trim(p_project_name),'') is null
    or nullif(trim(p_phase_name),'') is null
    or p_staff_user_id is null
    or p_member_role not in ('owner','admin','staff','read_only')
    or jsonb_typeof(coalesce(p_theme,'{}'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_company_profile,'{}'::jsonb)) <> 'object' then
    raise exception 'Tenant onboarding payload is incomplete or invalid.';
  end if;
  perform pg_advisory_xact_lock(hashtext('tenant-onboard:' || p_tenant_slug));
  select * into v_tenant from public.organizations where lower(slug)=lower(p_tenant_slug) for update;
  if not found then
    insert into public.organizations(name,slug,is_active)
      values (trim(p_tenant_name),p_tenant_slug,true) returning * into v_tenant;
  elsif not v_tenant.is_active then
    raise exception 'Tenant slug already exists but is inactive; onboarding will not reactivate it.';
  elsif v_tenant.name <> trim(p_tenant_name) then
    raise exception 'Existing tenant name differs from onboarding config; review it rather than overwriting.';
  end if;

  select * into v_profile from public.admin_profiles where user_id=p_staff_user_id for update;
  if found then
    if v_profile.role::text <> 'Super Admin'
      and v_profile.tenant_id is distinct from v_tenant.id then
      raise exception 'The selected account already belongs to another tenant; it was not reassigned.';
    end if;
    -- Super Admin profiles keep their current tenant_id, role, and Wamule
    -- membership. Only the separate Hopkins project_membership is added below.
  else
    select email, coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', '')
      into v_user_email, v_user_name from auth.users where id=p_staff_user_id;
    if not found or nullif(trim(v_user_email),'') is null then
      raise exception 'The selected staff account must already exist in Auth and have an email; no invitation was sent.';
    end if;
    insert into public.admin_profiles(user_id,email,full_name,role,tenant_id)
      values (p_staff_user_id,lower(trim(v_user_email)),coalesce(nullif(trim(v_user_name),''),trim(v_user_email)),'Staff',v_tenant.id)
      returning * into v_profile;
  end if;

  select * into v_project from public.projects
    where tenant_id=v_tenant.id and lower(slug)=lower(p_project_slug) for update;
  if not found then
    select not exists(select 1 from public.projects where tenant_id=v_tenant.id and is_default) into v_is_default;
    insert into public.projects(tenant_id,slug,name,is_default,map_experience_mode)
      values (v_tenant.id,p_project_slug,trim(p_project_name),v_is_default,case when p_demo_mode then 'demo' else 'sales' end)
      returning * into v_project;
  elsif v_project.name <> trim(p_project_name)
    or v_project.map_experience_mode <> (case when p_demo_mode then 'demo' else 'sales' end) then
    raise exception 'Existing project settings differ from this onboarding config; review them rather than overwriting.';
  end if;

  select * into v_phase from public.development_phases
    where tenant_id=v_tenant.id and project_id=v_project.id and lower(slug)=lower(p_phase_slug) for update;
  if not found then
    select not exists(select 1 from public.development_phases where project_id=v_project.id and is_default) into v_is_default;
    insert into public.development_phases(tenant_id,project_id,slug,name,is_default)
      values (v_tenant.id,v_project.id,p_phase_slug,trim(p_phase_name),v_is_default)
      returning * into v_phase;
  elsif v_phase.name <> trim(p_phase_name) or not v_phase.is_active then
    raise exception 'Existing project phase differs from onboarding config; review it rather than overwriting.';
  end if;

  select member_role into v_existing_role from public.project_memberships
    where tenant_id=v_tenant.id and project_id=v_project.id and phase_id=v_phase.id and user_id=p_staff_user_id for update;
  if found and v_existing_role <> p_member_role then
    raise exception 'The account already has a different project role; review that assignment instead of changing it implicitly.';
  elsif not found then
    insert into public.project_memberships(tenant_id,project_id,phase_id,user_id,member_role)
      values(v_tenant.id,v_project.id,v_phase.id,p_staff_user_id,p_member_role);
  end if;

  insert into public.project_settings(tenant_id,project_id,key,value)
    values(v_tenant.id,v_project.id,'tenant_theme',coalesce(p_theme,'{}'::jsonb))
    on conflict(project_id,key) do nothing;
  insert into public.project_settings(tenant_id,project_id,key,value)
    values(v_tenant.id,v_project.id,'company_profile',coalesce(p_company_profile,'{}'::jsonb))
    on conflict(project_id,key) do nothing;
  if not exists (select 1 from public.project_settings where tenant_id=v_tenant.id and project_id=v_project.id
      and key='tenant_theme' and value=coalesce(p_theme,'{}'::jsonb))
    or not exists (select 1 from public.project_settings where tenant_id=v_tenant.id and project_id=v_project.id
      and key='company_profile' and value=coalesce(p_company_profile,'{}'::jsonb)) then
    raise exception 'Existing project branding differs from onboarding config; review it rather than overwriting.';
  end if;

  return jsonb_build_object('tenant_id',v_tenant.id,'project_id',v_project.id,'phase_id',v_phase.id,
    'staff_user_id',p_staff_user_id,'member_role',p_member_role,'created_or_reused',true);
end;
$$;
revoke all on function public.onboard_project_tenant(text,text,text,text,text,text,jsonb,jsonb,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.onboard_project_tenant(text,text,text,text,text,text,jsonb,jsonb,uuid,text,boolean) to service_role;
comment on function public.onboard_project_tenant(text,text,text,text,text,text,jsonb,jsonb,uuid,text,boolean) is
  'Atomic onboarding for an existing Auth user. Existing non-super-admin profiles cannot move tenants; Super Admin profiles retain their profile and use project-scoped memberships/workspace selection. Never creates or invites users.';
