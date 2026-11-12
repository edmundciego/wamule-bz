-- M5.2: narrow, actor-verified hierarchy maintenance for the Super Admin console.
-- Company/project/phase deletion is intentionally unsupported. Provisioning of
-- a new hierarchy remains in M4.2's atomic provision_workspace_v1 operation.
BEGIN;

-- Successful human-operated hierarchy mutations retain the authenticated
-- Super Admin and the verified tenant/project/phase target in the M3.5 audit
-- contract. Rejected mutations never reach this helper.
CREATE OR REPLACE FUNCTION audit_private.record_super_admin_hierarchy_event(
  p_actor_id uuid,
  p_tenant_id uuid,
  p_project_id uuid,
  p_phase_id uuid,
  p_action text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.audit_events(
    tenant_id,target_tenant_id,target_project_id,target_phase_id,
    entity_type,action,title,summary,metadata,actor_user_id
  ) VALUES (
    p_tenant_id,p_tenant_id,p_project_id,p_phase_id,
    'system','updated','Workspace hierarchy changed',
    'A Super Admin changed verified tenant, project, or phase configuration.',
    jsonb_build_object('event_code','workspace_hierarchy_changed','source',p_action),p_actor_id
  );
END;
$function$;
REVOKE ALL ON FUNCTION audit_private.record_super_admin_hierarchy_event(uuid,uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.super_admin_manage_workspace_hierarchy_v1(
  p_action text,
  p_tenant_id uuid,
  p_name text DEFAULT NULL,
  p_slug text DEFAULT NULL,
  p_project_id uuid DEFAULT NULL,
  p_phase_id uuid DEFAULT NULL,
  p_is_active boolean DEFAULT NULL,
  p_map_experience_mode text DEFAULT NULL,
  p_phase_slug text DEFAULT NULL,
  p_phase_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_tenant public.organizations%ROWTYPE;
  v_project public.projects%ROWTYPE;
  v_phase public.development_phases%ROWTYPE;
  v_company_profile jsonb;
  v_tenant_theme jsonb := '{"site_experience":{"templateId":"wamule-classic","enabledModules":{"map":false,"inquiry":false,"application":false,"pricing":false}}}'::jsonb;
  v_public_application jsonb := '{"applications_open":false,"show_lot_prices_publicly":false,"show_available_lot_count_publicly":false}'::jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'An authenticated Super Admin is required.' USING ERRCODE = '42501';
  END IF;

  SELECT ap.role::text INTO v_actor_role
  FROM public.admin_profiles ap
  WHERE ap.user_id = v_actor
  FOR SHARE;
  IF v_actor_role IS DISTINCT FROM 'Super Admin' THEN
    RAISE EXCEPTION 'Only a current Super Admin may manage workspace hierarchy.' USING ERRCODE = '42501';
  END IF;

  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Select a verified tenant.';
  END IF;
  SELECT * INTO v_tenant FROM public.organizations o WHERE o.id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The selected tenant does not exist.'; END IF;

  IF p_action = 'set_tenant_active' THEN
    IF p_is_active IS NULL THEN RAISE EXCEPTION 'Tenant active state is required.'; END IF;
    UPDATE public.organizations SET is_active = p_is_active WHERE id = p_tenant_id RETURNING * INTO v_tenant;
    PERFORM audit_private.record_super_admin_hierarchy_event(v_actor,p_tenant_id,NULL,NULL,p_action);
    RETURN jsonb_build_object('action',p_action,'tenant',jsonb_build_object('id',v_tenant.id,'name',v_tenant.name,'slug',v_tenant.slug,'is_active',v_tenant.is_active),'deleted',false);
  END IF;

  IF p_action = 'create_project' THEN
    IF NOT v_tenant.is_active THEN RAISE EXCEPTION 'Reactivate the tenant before adding a project.'; END IF;
    IF COALESCE(p_slug,'') !~ '^[a-z0-9][a-z0-9-]{0,62}$' OR NULLIF(btrim(p_name),'') IS NULL
       OR COALESCE(p_phase_slug,'') !~ '^[a-z0-9][a-z0-9-]{0,62}$' OR NULLIF(btrim(p_phase_name),'') IS NULL THEN
      RAISE EXCEPTION 'A valid immutable project slug/name and initial default phase slug/name are required.';
    END IF;
    IF COALESCE(p_map_experience_mode,'sales') NOT IN ('sales','demo') THEN RAISE EXCEPTION 'Map experience mode must be sales or demo.'; END IF;
    IF EXISTS (SELECT 1 FROM public.projects p WHERE p.tenant_id=p_tenant_id AND lower(p.slug)=lower(p_slug)) THEN
      RAISE EXCEPTION 'That project slug is already in use by this tenant.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.tenant_id=p_tenant_id AND p.is_default) THEN
      INSERT INTO public.projects(tenant_id,slug,name,is_default,map_experience_mode)
      VALUES(p_tenant_id,p_slug,btrim(p_name),true,COALESCE(p_map_experience_mode,'sales')) RETURNING * INTO v_project;
    ELSE
      INSERT INTO public.projects(tenant_id,slug,name,is_default,map_experience_mode)
      VALUES(p_tenant_id,p_slug,btrim(p_name),false,COALESCE(p_map_experience_mode,'sales')) RETURNING * INTO v_project;
    END IF;
    SELECT COALESCE(b.value,'{}'::jsonb) INTO v_company_profile FROM public.business_settings b
    WHERE b.tenant_id=p_tenant_id AND b.key='company_profile';
    v_company_profile := COALESCE(v_company_profile,'{}'::jsonb) || jsonb_build_object('company_name',COALESCE(NULLIF(v_company_profile->>'company_name',''),v_tenant.name));
    INSERT INTO public.project_settings(tenant_id,project_id,key,value) VALUES(p_tenant_id,v_project.id,'company_profile',v_company_profile) ON CONFLICT(project_id,key) DO NOTHING;
    INSERT INTO public.project_settings(tenant_id,project_id,key,value) VALUES(p_tenant_id,v_project.id,'tenant_theme',v_tenant_theme) ON CONFLICT(project_id,key) DO NOTHING;
    INSERT INTO public.project_settings(tenant_id,project_id,key,value) VALUES(p_tenant_id,v_project.id,'public_application',v_public_application) ON CONFLICT(project_id,key) DO NOTHING;
    INSERT INTO public.development_phases(tenant_id,project_id,slug,name,is_default,is_active)
    VALUES(p_tenant_id,v_project.id,p_phase_slug,btrim(p_phase_name),true,true) RETURNING * INTO v_phase;
    PERFORM audit_private.record_super_admin_hierarchy_event(v_actor,p_tenant_id,v_project.id,v_phase.id,p_action);
    RETURN jsonb_build_object('action',p_action,
      'project',jsonb_build_object('id',v_project.id,'tenant_id',v_project.tenant_id,'slug',v_project.slug,'name',v_project.name,'is_default',v_project.is_default,'map_experience_mode',v_project.map_experience_mode),
      'phase',jsonb_build_object('id',v_phase.id,'tenant_id',v_phase.tenant_id,'project_id',v_phase.project_id,'slug',v_phase.slug,'name',v_phase.name,'is_default',v_phase.is_default,'is_active',v_phase.is_active),
      'settings',jsonb_build_object('applications_open',false,'inventory_created',false),'deleted',false);
  END IF;

  IF p_action = 'update_project' THEN
    IF p_project_id IS NULL OR NULLIF(btrim(p_name),'') IS NULL THEN RAISE EXCEPTION 'Select a project and provide a name.'; END IF;
    SELECT * INTO v_project FROM public.projects p WHERE p.id=p_project_id AND p.tenant_id=p_tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The project does not belong to the selected tenant.'; END IF;
    IF p_map_experience_mode IS NOT NULL AND p_map_experience_mode NOT IN ('sales','demo') THEN RAISE EXCEPTION 'Map experience mode must be sales or demo.'; END IF;
    IF p_map_experience_mode IS NOT NULL AND p_map_experience_mode IS DISTINCT FROM v_project.map_experience_mode THEN
      RAISE EXCEPTION 'Project mode is fixed at creation; create a separate project instead of reclassifying existing inventory.';
    END IF;
    UPDATE public.projects SET name=btrim(p_name), map_experience_mode=COALESCE(p_map_experience_mode,map_experience_mode)
    WHERE id=p_project_id AND tenant_id=p_tenant_id RETURNING * INTO v_project;
    PERFORM audit_private.record_super_admin_hierarchy_event(v_actor,p_tenant_id,v_project.id,NULL,p_action);
    RETURN jsonb_build_object('action',p_action,'project',jsonb_build_object('id',v_project.id,'tenant_id',v_project.tenant_id,'slug',v_project.slug,'name',v_project.name,'is_default',v_project.is_default,'map_experience_mode',v_project.map_experience_mode),'deleted',false);
  END IF;

  IF p_action = 'set_default_project' THEN
    IF p_project_id IS NULL THEN RAISE EXCEPTION 'Select a project.'; END IF;
    SELECT * INTO v_project FROM public.projects p WHERE p.id=p_project_id AND p.tenant_id=p_tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The project does not belong to the selected tenant.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.development_phases ph WHERE ph.tenant_id=p_tenant_id AND ph.project_id=p_project_id AND ph.is_active AND ph.is_default) THEN
      RAISE EXCEPTION 'The default project must contain an active default phase.';
    END IF;
    UPDATE public.projects SET is_default=false WHERE tenant_id=p_tenant_id AND is_default;
    UPDATE public.projects SET is_default=true WHERE id=p_project_id AND tenant_id=p_tenant_id RETURNING * INTO v_project;
    PERFORM audit_private.record_super_admin_hierarchy_event(v_actor,p_tenant_id,v_project.id,NULL,p_action);
    RETURN jsonb_build_object('action',p_action,'project',jsonb_build_object('id',v_project.id,'tenant_id',v_project.tenant_id,'slug',v_project.slug,'name',v_project.name,'is_default',v_project.is_default),'deleted',false);
  END IF;

  IF p_action IN ('create_phase','update_phase','set_default_phase','set_phase_active') THEN
    IF p_project_id IS NULL THEN RAISE EXCEPTION 'Select a project.'; END IF;
    SELECT * INTO v_project FROM public.projects p WHERE p.id=p_project_id AND p.tenant_id=p_tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The project does not belong to the selected tenant.'; END IF;
  END IF;

  IF p_action = 'create_phase' THEN
    IF NOT v_tenant.is_active THEN RAISE EXCEPTION 'Reactivate the tenant before adding a phase.'; END IF;
    IF COALESCE(p_slug,'') !~ '^[a-z0-9][a-z0-9-]{0,62}$' OR NULLIF(btrim(p_name),'') IS NULL THEN
      RAISE EXCEPTION 'A valid immutable phase slug and non-empty name are required.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.development_phases ph WHERE ph.project_id=p_project_id AND lower(ph.slug)=lower(p_slug)) THEN
      RAISE EXCEPTION 'That phase slug is already in use by this project.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.development_phases ph WHERE ph.project_id=p_project_id AND ph.is_active AND ph.is_default) THEN
      UPDATE public.development_phases SET is_default=false WHERE project_id=p_project_id AND is_default;
      INSERT INTO public.development_phases(tenant_id,project_id,slug,name,is_default,is_active)
      VALUES(p_tenant_id,p_project_id,p_slug,btrim(p_name),true,true) RETURNING * INTO v_phase;
    ELSE
      INSERT INTO public.development_phases(tenant_id,project_id,slug,name,is_default,is_active)
      VALUES(p_tenant_id,p_project_id,p_slug,btrim(p_name),false,true) RETURNING * INTO v_phase;
    END IF;
    PERFORM audit_private.record_super_admin_hierarchy_event(v_actor,p_tenant_id,v_project.id,v_phase.id,p_action);
    RETURN jsonb_build_object('action',p_action,'phase',jsonb_build_object('id',v_phase.id,'tenant_id',v_phase.tenant_id,'project_id',v_phase.project_id,'slug',v_phase.slug,'name',v_phase.name,'is_default',v_phase.is_default,'is_active',v_phase.is_active),'deleted',false);
  END IF;

  IF p_action = 'update_phase' THEN
    IF p_phase_id IS NULL OR NULLIF(btrim(p_name),'') IS NULL THEN RAISE EXCEPTION 'Select a phase and provide a name.'; END IF;
    SELECT * INTO v_phase FROM public.development_phases ph WHERE ph.id=p_phase_id AND ph.project_id=p_project_id AND ph.tenant_id=p_tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The phase does not belong to the selected project and tenant.'; END IF;
    UPDATE public.development_phases SET name=btrim(p_name) WHERE id=p_phase_id AND project_id=p_project_id RETURNING * INTO v_phase;
    PERFORM audit_private.record_super_admin_hierarchy_event(v_actor,p_tenant_id,v_project.id,v_phase.id,p_action);
    RETURN jsonb_build_object('action',p_action,'phase',jsonb_build_object('id',v_phase.id,'tenant_id',v_phase.tenant_id,'project_id',v_phase.project_id,'slug',v_phase.slug,'name',v_phase.name,'is_default',v_phase.is_default,'is_active',v_phase.is_active),'deleted',false);
  END IF;

  IF p_action = 'set_default_phase' THEN
    IF p_phase_id IS NULL THEN RAISE EXCEPTION 'Select a phase.'; END IF;
    SELECT * INTO v_phase FROM public.development_phases ph WHERE ph.id=p_phase_id AND ph.project_id=p_project_id AND ph.tenant_id=p_tenant_id FOR UPDATE;
    IF NOT FOUND OR NOT v_phase.is_active THEN RAISE EXCEPTION 'The default phase must belong to the selected project and be active.'; END IF;
    UPDATE public.development_phases SET is_default=false WHERE project_id=p_project_id AND is_default;
    UPDATE public.development_phases SET is_default=true WHERE id=p_phase_id AND project_id=p_project_id RETURNING * INTO v_phase;
    PERFORM audit_private.record_super_admin_hierarchy_event(v_actor,p_tenant_id,v_project.id,v_phase.id,p_action);
    RETURN jsonb_build_object('action',p_action,'phase',jsonb_build_object('id',v_phase.id,'tenant_id',v_phase.tenant_id,'project_id',v_phase.project_id,'slug',v_phase.slug,'name',v_phase.name,'is_default',v_phase.is_default,'is_active',v_phase.is_active),'deleted',false);
  END IF;

  IF p_action = 'set_phase_active' THEN
    IF p_phase_id IS NULL OR p_is_active IS NULL THEN RAISE EXCEPTION 'Select a phase and provide its active state.'; END IF;
    SELECT * INTO v_phase FROM public.development_phases ph WHERE ph.id=p_phase_id AND ph.project_id=p_project_id AND ph.tenant_id=p_tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The phase does not belong to the selected project and tenant.'; END IF;
    IF NOT p_is_active AND (v_phase.is_default OR NOT EXISTS (
      SELECT 1 FROM public.development_phases other
      WHERE other.project_id=p_project_id AND other.id<>p_phase_id AND other.is_active AND other.is_default
    )) THEN
      RAISE EXCEPTION 'Choose another active default phase before deactivating the current default.';
    END IF;
    UPDATE public.development_phases SET is_active=p_is_active WHERE id=p_phase_id AND project_id=p_project_id RETURNING * INTO v_phase;
    PERFORM audit_private.record_super_admin_hierarchy_event(v_actor,p_tenant_id,v_project.id,v_phase.id,p_action);
    RETURN jsonb_build_object('action',p_action,'phase',jsonb_build_object('id',v_phase.id,'tenant_id',v_phase.tenant_id,'project_id',v_phase.project_id,'slug',v_phase.slug,'name',v_phase.name,'is_default',v_phase.is_default,'is_active',v_phase.is_active),'deleted',false);
  END IF;

  RAISE EXCEPTION 'Unsupported hierarchy action.';
END;
$function$;

REVOKE ALL ON FUNCTION public.super_admin_manage_workspace_hierarchy_v1(text,uuid,text,text,uuid,uuid,boolean,text,text,text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.super_admin_manage_workspace_hierarchy_v1(text,uuid,text,text,uuid,uuid,boolean,text,text,text)
  TO authenticated;

COMMENT ON FUNCTION public.super_admin_manage_workspace_hierarchy_v1(text,uuid,text,text,uuid,uuid,boolean,text,text,text) IS
  'M5 console: authenticates the live Super Admin in-transaction; updates hierarchy without delete operations or immutable slug changes. Project availability is derived from active tenant and phase because projects has no is_active field.';

COMMIT;
