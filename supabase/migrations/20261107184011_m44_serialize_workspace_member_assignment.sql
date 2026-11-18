-- M4.4: serialize onboarding assignment/replay with M3.4 permission changes.
-- Forward correction only; the M4.3 migration and applied history remain unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.assign_workspace_member_onboarding_v1(
  p_manifest jsonb,
  p_auth_user_id uuid,
  p_tenant_id uuid,
  p_resolved_memberships jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_operation_id uuid := NULLIF(p_manifest->>'operation_id','')::uuid;
  v_payload_hash text := md5(p_manifest::text);
  v_user jsonb := p_manifest->'users'->0;
  v_requested jsonb := p_manifest->'users'->0->'memberships';
  v_member jsonb;
  v_project jsonb;
  v_phase_slug text;
  v_project_slug text;
  v_profile_role text := p_manifest->'users'->0->>'profile_role';
  v_actor_id uuid := auth.uid();
  v_request_role text := NULLIF(pg_catalog.current_setting('request.jwt.claim.role',true),'');
  v_current_role text;
  v_current_tenant uuid;
  v_actor_tenant uuid;
  v_current_count integer;
  v_requested_count integer;
  v_existing_matches integer;
  v_saved_count integer;
  v_profile_exists boolean := false;
  v_already_assigned boolean := false;
  v_operation provisioning_private.workspace_identity_operations%ROWTYPE;
  v_expected jsonb := '[]'::jsonb;
  v_result jsonb;
  v_profile_id uuid;
BEGIN
  IF v_request_role IS DISTINCT FROM 'authenticated' OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Workspace assignment requires an authenticated operator.' USING ERRCODE='42501';
  END IF;
  SELECT ap.role::text,ap.tenant_id INTO v_current_role,v_actor_tenant
  FROM public.admin_profiles ap WHERE ap.user_id=v_actor_id FOR SHARE;
  IF NOT FOUND OR v_current_role NOT IN ('Admin','Super Admin')
     OR (v_current_role='Admin' AND v_actor_tenant IS DISTINCT FROM p_tenant_id) THEN
    RAISE EXCEPTION 'The current operator is not authorized for this workspace.' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_operation FROM provisioning_private.workspace_identity_operations io
  WHERE io.operation_id=v_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.payload_hash IS DISTINCT FROM v_payload_hash
     OR v_operation.auth_user_id IS DISTINCT FROM p_auth_user_id
     OR v_operation.status NOT IN ('auth_ready','assigned') THEN
    RAISE EXCEPTION 'The verified Auth identity is not ready for workspace assignment.' USING ERRCODE='42501';
  END IF;
  -- Match M3.4 manage_workspace_member lock ordering before any target-profile
  -- row lock. This serializes first assignment and replay with demotion/removal.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('workspace-member:' || p_auth_user_id::text, 0)
  );
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id=p_tenant_id AND o.is_active
                 AND lower(o.slug)=lower(p_manifest->'company'->>'slug')) THEN
    RAISE EXCEPTION 'The applied target workspace no longer matches the validated tenant.' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_resolved_memberships) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_requested) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'The complete requested membership set is required.' USING ERRCODE='23514';
  END IF;

  FOR v_member IN SELECT m.value FROM jsonb_array_elements(v_requested) m(value) LOOP
    v_project_slug := v_member->>'project_slug';
    SELECT p.id INTO v_profile_id FROM public.projects p
    WHERE p.tenant_id=p_tenant_id AND lower(p.slug)=lower(v_project_slug);
    IF v_profile_id IS NULL THEN RAISE EXCEPTION 'A requested project is missing from the verified workspace.' USING ERRCODE='23514'; END IF;
    IF v_member->'all_phases'='true'::jsonb THEN
      IF v_member->>'confirm_scope' IS DISTINCT FROM 'all_current_and_future_phases_in_this_project' THEN
        RAISE EXCEPTION 'All-phase assignment requires its explicit confirmation.' USING ERRCODE='23514';
      END IF;
      v_expected := v_expected || jsonb_build_array(jsonb_build_object('project_id',v_profile_id,'phase_id',NULL,
        'member_role',v_member->>'member_role','all_phases_confirmed',true));
    ELSE
      FOR v_phase_slug IN SELECT jsonb_array_elements_text(v_member->'phase_slugs') LOOP
        SELECT ph.id INTO v_profile_id FROM public.development_phases ph
        JOIN public.projects p ON p.id=ph.project_id AND p.tenant_id=ph.tenant_id
        WHERE p.tenant_id=p_tenant_id AND lower(p.slug)=lower(v_project_slug) AND lower(ph.slug)=lower(v_phase_slug) AND ph.is_active;
        IF v_profile_id IS NULL THEN RAISE EXCEPTION 'A requested active phase is missing from its verified project.' USING ERRCODE='23514'; END IF;
        v_expected := v_expected || jsonb_build_array(jsonb_build_object('project_id',
          (SELECT p.id FROM public.projects p WHERE p.tenant_id=p_tenant_id AND lower(p.slug)=lower(v_project_slug)),
          'phase_id',v_profile_id,'member_role',v_member->>'member_role','all_phases_confirmed',false));
      END LOOP;
    END IF;
  END LOOP;
  v_requested_count := jsonb_array_length(v_expected);
  IF jsonb_array_length(p_resolved_memberships)<>v_requested_count
     OR EXISTS (
       SELECT 1 FROM jsonb_to_recordset(v_expected) AS e(project_id uuid,phase_id uuid,member_role text,all_phases_confirmed boolean)
       WHERE NOT EXISTS (
         SELECT 1 FROM jsonb_to_recordset(p_resolved_memberships) AS s(project_id uuid,phase_id uuid,member_role text,all_phases_confirmed boolean)
         WHERE s.project_id=e.project_id AND s.phase_id IS NOT DISTINCT FROM e.phase_id AND s.member_role=e.member_role
           AND COALESCE(s.all_phases_confirmed,false)=COALESCE(e.all_phases_confirmed,false)
       )
     ) THEN
    RAISE EXCEPTION 'Resolved project/phase IDs do not match the requested membership slugs.' USING ERRCODE='23514';
  END IF;

  IF v_operation.assignment_result IS NOT NULL THEN
    SELECT ap.role::text,ap.tenant_id INTO v_current_role,v_current_tenant
    FROM public.admin_profiles ap WHERE ap.user_id=p_auth_user_id;
    v_profile_exists := FOUND;
    v_saved_count := jsonb_array_length(COALESCE(v_operation.assignment_result->'memberships','[]'::jsonb));
    SELECT count(*) INTO v_current_count FROM public.project_memberships pm WHERE pm.user_id=p_auth_user_id;
    SELECT count(*) INTO v_existing_matches
    FROM public.project_memberships pm
    JOIN jsonb_to_recordset(COALESCE(v_operation.assignment_result->'memberships','[]'::jsonb))
      AS saved(id uuid,project_id uuid,phase_id uuid,member_role text)
      ON saved.id=pm.id AND saved.project_id=pm.project_id
       AND saved.phase_id IS NOT DISTINCT FROM pm.phase_id AND saved.member_role=pm.member_role
    WHERE pm.user_id=p_auth_user_id AND pm.tenant_id=p_tenant_id;
    IF NOT v_profile_exists OR v_current_role IS DISTINCT FROM v_profile_role OR v_current_tenant IS DISTINCT FROM p_tenant_id
       OR v_current_count<>v_saved_count OR v_existing_matches<>v_saved_count
       OR EXISTS (SELECT 1 FROM public.project_memberships pm WHERE pm.user_id=p_auth_user_id AND pm.tenant_id<>p_tenant_id) THEN
      RETURN jsonb_build_object('status','blocked','writes',0,'workspace_access_ready',false,
        'auth_user_id',p_auth_user_id,'operation_id',v_operation_id,
        'conflicts',jsonb_build_array(jsonb_build_object('code','assignment_state_changed','detail','The saved onboarding result no longer matches current profile or memberships; review current access before retrying.')));
    END IF;
    RETURN v_operation.assignment_result || jsonb_build_object('status','replayed','idempotent_replay',true,'writes',0);
  END IF;

  SELECT ap.role::text,ap.tenant_id INTO v_current_role,v_current_tenant
  FROM public.admin_profiles ap WHERE ap.user_id=p_auth_user_id FOR UPDATE;
  IF FOUND AND (v_current_role IS DISTINCT FROM v_profile_role OR v_current_tenant IS DISTINCT FROM p_tenant_id) THEN
    RAISE EXCEPTION 'The selected account already has a conflicting profile role or tenant.' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.project_memberships pm WHERE pm.user_id=p_auth_user_id AND pm.tenant_id<>p_tenant_id) THEN
    RAISE EXCEPTION 'The selected account has memberships outside this tenant.' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO v_current_count FROM public.project_memberships pm WHERE pm.user_id=p_auth_user_id;
  IF v_current_count>0 THEN
    SELECT count(*) INTO v_existing_matches
    FROM public.project_memberships pm
    JOIN jsonb_to_recordset(v_expected) AS e(project_id uuid,phase_id uuid,member_role text,all_phases_confirmed boolean)
      ON e.project_id=pm.project_id AND e.phase_id IS NOT DISTINCT FROM pm.phase_id AND e.member_role=pm.member_role
    WHERE pm.user_id=p_auth_user_id AND pm.tenant_id=p_tenant_id;
    IF v_current_count<>v_requested_count OR v_existing_matches<>v_current_count THEN
      RAISE EXCEPTION 'Existing membership scopes differ from the complete requested assignment; resolve them separately.' USING ERRCODE='23514';
    END IF;
    v_already_assigned:=true;
  ELSE
    PERFORM public.manage_workspace_member(
      p_auth_user_id,p_tenant_id,v_profile_role,p_resolved_memberships,NULL,NULL,NULL
    );
  END IF;

  SELECT ap.user_id INTO v_profile_id FROM public.admin_profiles ap WHERE ap.user_id=p_auth_user_id;
  SELECT jsonb_build_object(
    'status','assigned','writes',CASE WHEN v_already_assigned THEN 0 ELSE 1 END,
    'operation_id',v_operation_id,'identity_mode',v_operation.identity_mode,
    'identity_source',CASE WHEN v_operation.created_by_operation THEN 'created_by_operation' ELSE 'explicit_existing' END,
    'auth_user_id',p_auth_user_id,'profile_id',v_profile_id,'profile_role',v_profile_role,
    'workspace_access_ready',true,'provider_sign_in_ready',false,
    'memberships',COALESCE(jsonb_agg(jsonb_build_object('id',pm.id,'project_id',pm.project_id,'phase_id',pm.phase_id,
      'member_role',pm.member_role,'disposition',CASE WHEN v_already_assigned THEN 'reused' ELSE 'created' END)
      ORDER BY pm.project_id,pm.phase_id NULLS FIRST),'[]'::jsonb)
  ) INTO v_result
  FROM public.project_memberships pm WHERE pm.user_id=p_auth_user_id AND pm.tenant_id=p_tenant_id;
  UPDATE provisioning_private.workspace_identity_operations
  SET status='assigned',assignment_result=v_result,updated_at=now()
  WHERE operation_id=v_operation_id;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.assign_workspace_member_onboarding_v1(jsonb,uuid,uuid,jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assign_workspace_member_onboarding_v1(jsonb,uuid,uuid,jsonb) TO authenticated;

COMMENT ON FUNCTION public.preflight_workspace_member_onboarding_v1(jsonb) IS
  'Read-only authenticated operator check for a complete single-user onboarding request; it never creates an Auth identity or sends an invitation.';
COMMENT ON FUNCTION public.assign_workspace_member_onboarding_v1(jsonb,uuid,uuid,jsonb) IS
  'Idempotent M4.3 wrapper around the audited M3.4 manage_workspace_member operation; assignment result and stable membership IDs commit in one transaction.';

COMMIT;
