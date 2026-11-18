-- M4.3: recoverable Auth identity creation and M3.4-scoped membership assignment.
-- The CLI never invites users; newly created accounts remain unconfirmed until
-- a separately approved provider-sign-in workflow is implemented.

BEGIN;

CREATE TABLE provisioning_private.workspace_identity_operations (
  operation_id uuid PRIMARY KEY,
  payload_hash text NOT NULL,
  identity_mode text NOT NULL CHECK (identity_mode IN ('existing','create')),
  email_normalized text,
  auth_user_id uuid,
  created_by_operation boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('auth_pending','auth_ready','assigned')),
  assignment_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((identity_mode='existing' AND auth_user_id IS NOT NULL AND email_normalized IS NULL)
      OR (identity_mode='create' AND email_normalized IS NOT NULL)),
  CHECK ((status='assigned') = (assignment_result IS NOT NULL))
);
ALTER TABLE provisioning_private.workspace_identity_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE provisioning_private.workspace_identity_operations FROM PUBLIC, anon, authenticated, service_role;
CREATE UNIQUE INDEX workspace_identity_create_email_unique
  ON provisioning_private.workspace_identity_operations(email_normalized)
  WHERE identity_mode='create';

CREATE OR REPLACE FUNCTION public.preflight_workspace_member_onboarding_v1(p_manifest jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_conflicts jsonb := '[]'::jsonb;
  v_identity jsonb;
  v_memberships jsonb;
  v_projects jsonb;
  v_user jsonb;
  v_membership jsonb;
  v_project jsonb;
  v_phase_slug text;
  v_project_slug text;
  v_scope_key text;
  v_seen_scopes text[] := ARRAY[]::text[];
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_actor_tenant uuid;
  v_tenant_id uuid;
  v_tenant_active boolean;
  v_target_user_id uuid;
  v_target_role text;
  v_target_tenant uuid;
  v_profile_role text;
  v_identity_mode text;
  v_email text;
  v_request_role text := NULLIF(pg_catalog.current_setting('request.jwt.claim.role',true),'');
  v_operation_id uuid;
  v_payload_hash text;
  v_current_count integer := 0;
  v_requested_count integer := 0;
  v_count integer := 0;
  v_existing_scope_mismatch boolean := false;
BEGIN
  IF v_request_role IS DISTINCT FROM 'authenticated' OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Workspace identity preflight requires an authenticated operator.' USING ERRCODE='42501';
  END IF;
  SELECT ap.role::text,ap.tenant_id INTO v_actor_role,v_actor_tenant
  FROM public.admin_profiles ap WHERE ap.user_id=v_actor_id;
  IF NOT FOUND OR v_actor_role NOT IN ('Admin','Super Admin') THEN
    RETURN jsonb_build_object('status','blocked','can_apply',false,'writes',0,
      'conflicts',jsonb_build_array(jsonb_build_object('code','operator_not_authorized')));
  END IF;
  IF p_manifest IS NULL OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_manifest->'company') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_manifest->'projects') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_manifest->'users') IS DISTINCT FROM 'array'
     OR jsonb_array_length(CASE WHEN jsonb_typeof(p_manifest->'users')='array' THEN p_manifest->'users' ELSE '[]'::jsonb END)<>1 THEN
    RETURN jsonb_build_object('status','blocked','can_apply',false,'writes',0,
      'conflicts',jsonb_build_array(jsonb_build_object('code','one_user_assignment_required')));
  END IF;

  v_operation_id := NULLIF(p_manifest->>'operation_id','')::uuid;
  v_payload_hash := md5(p_manifest::text);
  v_projects := p_manifest->'projects';
  v_user := p_manifest->'users'->0;
  v_identity := v_user->'identity';
  v_memberships := v_user->'memberships';
  v_profile_role := v_user->>'profile_role';
  v_identity_mode := v_identity->>'mode';
  IF v_operation_id IS NULL OR jsonb_typeof(v_identity) IS DISTINCT FROM 'object'
     OR v_identity_mode IS NULL OR v_identity_mode NOT IN ('existing','create') THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','explicit_identity_required'));
  END IF;
  IF v_profile_role IS NULL OR v_profile_role NOT IN ('Staff','Read Only') THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','profile_role_not_allowed'));
  END IF;

  SELECT o.id,o.is_active INTO v_tenant_id,v_tenant_active
  FROM public.organizations o WHERE lower(o.slug)=lower(p_manifest->'company'->>'slug');
  IF v_tenant_id IS NOT NULL AND v_tenant_active IS FALSE THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','inactive_target_conflict','entity','company'));
  END IF;
  IF v_actor_role='Admin' AND (v_tenant_id IS NULL OR v_actor_tenant IS DISTINCT FROM v_tenant_id) THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','operator_tenant_mismatch'));
  END IF;

  IF v_identity_mode='existing' THEN
    IF COALESCE(v_identity->>'auth_user_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_auth_user_id'));
    ELSE
      v_target_user_id := (v_identity->>'auth_user_id')::uuid;
      IF v_target_user_id=v_actor_id THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','operator_cannot_assign_self'));
      END IF;
    END IF;
    IF v_identity ? 'email' THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','existing_identity_must_use_selected_auth_id'));
    END IF;
  ELSIF v_identity_mode='create' THEN
    v_email := lower(btrim(COALESCE(v_identity->>'email','')));
    IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_identity_email'));
    ELSE
      SELECT io.auth_user_id INTO v_target_user_id
      FROM provisioning_private.workspace_identity_operations io
      WHERE io.operation_id=v_operation_id AND io.payload_hash=v_payload_hash
        AND io.identity_mode='create' AND io.email_normalized=v_email;
      IF v_target_user_id IS NULL THEN
        SELECT u.id INTO v_target_user_id FROM auth.users u
        WHERE lower(u.email)=v_email
          AND u.raw_app_meta_data->'wamule_workspace_onboarding'->>'operation_id'=v_operation_id::text
          AND u.raw_app_meta_data->'wamule_workspace_onboarding'->>'payload_hash'=v_payload_hash;
      END IF;
      IF EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email)=v_email)
         AND v_target_user_id IS NULL THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','identity_email_already_in_use','email','redacted'));
      END IF;
    END IF;
  END IF;

  IF v_target_user_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=v_target_user_id AND NULLIF(btrim(u.email),'') IS NOT NULL) THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','auth_user_not_found'));
    END IF;
    SELECT ap.role::text,ap.tenant_id INTO v_target_role,v_target_tenant
    FROM public.admin_profiles ap WHERE ap.user_id=v_target_user_id;
    IF FOUND THEN
      IF v_target_tenant IS DISTINCT FROM v_tenant_id THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','user_tenant_conflict','user_reference','redacted'));
      END IF;
      IF v_target_role IS DISTINCT FROM v_profile_role THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','profile_role_conflict','user_reference','redacted'));
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM public.project_memberships pm
               WHERE pm.user_id=v_target_user_id AND (v_tenant_id IS NULL OR pm.tenant_id<>v_tenant_id)) THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','user_tenant_conflict','user_reference','redacted'));
    END IF;
  END IF;

  IF jsonb_typeof(v_memberships) IS DISTINCT FROM 'array' OR jsonb_array_length(CASE WHEN jsonb_typeof(v_memberships)='array' THEN v_memberships ELSE '[]'::jsonb END)=0 THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','memberships_required'));
  ELSE
    FOR v_membership IN SELECT item.value FROM jsonb_array_elements(v_memberships) item(value) LOOP
      v_project_slug := v_membership->>'project_slug';
      IF v_project_slug IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_projects) p(value) WHERE p.value->>'slug'=v_project_slug) THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','membership_project_not_in_manifest'));
        CONTINUE;
      END IF;
      IF v_membership->>'member_role' NOT IN ('staff','read_only')
         OR (v_profile_role='Read Only' AND v_membership->>'member_role'<>'read_only') THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','role_cap_denied'));
      END IF;
      IF v_membership->'all_phases'='true'::jsonb THEN
        v_scope_key := v_project_slug||':ALL';
        IF v_membership->>'confirm_scope' IS DISTINCT FROM 'all_current_and_future_phases_in_this_project' THEN
          v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','all_phase_confirmation_required','project_slug',v_project_slug));
        END IF;
        IF v_scope_key=ANY(v_seen_scopes) OR EXISTS (SELECT 1 FROM unnest(v_seen_scopes) s(scope_key) WHERE s.scope_key LIKE v_project_slug||':%') THEN
          v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','membership_scope_overlap','project_slug',v_project_slug));
        END IF;
        v_seen_scopes := array_append(v_seen_scopes,v_scope_key);
        v_requested_count := v_requested_count+1;
      ELSE
        IF jsonb_typeof(v_membership->'all_phases') IS NOT NULL OR jsonb_typeof(v_membership->'phase_slugs') IS DISTINCT FROM 'array'
           OR jsonb_array_length(CASE WHEN jsonb_typeof(v_membership->'phase_slugs')='array' THEN v_membership->'phase_slugs' ELSE '[]'::jsonb END)=0 THEN
          v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_membership_scope','project_slug',v_project_slug));
          CONTINUE;
        END IF;
        FOR v_phase_slug IN SELECT jsonb_array_elements_text(v_membership->'phase_slugs') LOOP
          v_scope_key := v_project_slug||':'||v_phase_slug;
          IF v_scope_key=ANY(v_seen_scopes) OR v_project_slug||':ALL'=ANY(v_seen_scopes) THEN
            v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','membership_scope_overlap','project_slug',v_project_slug,'phase_slug',v_phase_slug));
          END IF;
          v_seen_scopes := array_append(v_seen_scopes,v_scope_key);
          IF NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_projects) p(value)
            CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.value->'phases')='array' THEN p.value->'phases' ELSE '[]'::jsonb END) ph(value)
            WHERE p.value->>'slug'=v_project_slug AND ph.value->>'slug'=v_phase_slug
          ) THEN
            v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','membership_phase_not_in_project','project_slug',v_project_slug,'phase_slug',v_phase_slug));
          END IF;
          v_requested_count := v_requested_count+1;
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  IF v_target_user_id IS NOT NULL AND v_tenant_id IS NOT NULL AND jsonb_typeof(v_memberships)='array' THEN
    SELECT count(*) INTO v_current_count FROM public.project_memberships pm
    WHERE pm.user_id=v_target_user_id AND pm.tenant_id=v_tenant_id;
    IF v_current_count>0 THEN
      SELECT EXISTS (
        SELECT 1 FROM public.project_memberships pm
        LEFT JOIN public.projects p ON p.id=pm.project_id AND p.tenant_id=pm.tenant_id
        LEFT JOIN public.development_phases ph ON ph.id=pm.phase_id AND ph.project_id=pm.project_id AND ph.tenant_id=pm.tenant_id
        WHERE pm.user_id=v_target_user_id AND pm.tenant_id=v_tenant_id
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_memberships) m(value)
            WHERE m.value->>'project_slug'=p.slug AND m.value->>'member_role'=pm.member_role
              AND ((pm.phase_id IS NULL AND m.value->'all_phases'='true'::jsonb)
                OR (pm.phase_id IS NOT NULL AND jsonb_typeof(m.value->'phase_slugs')='array'
                    AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(m.value->'phase_slugs') s(phase_slug) WHERE s.phase_slug=ph.slug)))
          )
      ) INTO v_existing_scope_mismatch;
      IF v_existing_scope_mismatch OR v_current_count<>v_requested_count THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','existing_membership_set_conflict','user_reference','redacted','detail','Include the complete unchanged scope or resolve existing memberships separately.'));
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('status',CASE WHEN jsonb_array_length(v_conflicts)=0 THEN 'ready' ELSE 'blocked' END,
    'can_apply',(jsonb_array_length(v_conflicts)=0),'writes',0,'operation_id',p_manifest->>'operation_id',
    'operator',jsonb_build_object('id',v_actor_id,'role',v_actor_role),
    'identity',jsonb_build_object('mode',v_identity_mode,'user_id',v_target_user_id,'selected',v_identity_mode='existing','created_by_operation',v_identity_mode='create'),
    'membership_plan',jsonb_build_array(jsonb_build_object('profile_role',v_profile_role,'scope_count',v_requested_count,'already_assigned',(v_current_count>0 AND v_current_count=v_requested_count))),
    'conflicts',v_conflicts);
END;
$function$;
REVOKE ALL ON FUNCTION public.preflight_workspace_member_onboarding_v1(jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.preflight_workspace_member_onboarding_v1(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.prepare_workspace_identity_onboarding_v1(p_manifest jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_operation_id uuid := NULLIF(p_manifest->>'operation_id','')::uuid;
  v_payload_hash text := md5(p_manifest::text);
  v_user jsonb := p_manifest->'users'->0;
  v_identity jsonb := p_manifest->'users'->0->'identity';
  v_mode text := p_manifest->'users'->0->'identity'->>'mode';
  v_email text := lower(btrim(COALESCE(p_manifest->'users'->0->'identity'->>'email','')));
  v_user_id uuid;
  v_row provisioning_private.workspace_identity_operations%ROWTYPE;
  v_marker_count integer;
  v_row_exists boolean := false;
BEGIN
  IF NULLIF(pg_catalog.current_setting('request.jwt.claim.role',true),'') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Identity operation preparation is restricted to the trusted server.' USING ERRCODE='42501';
  END IF;
  IF v_operation_id IS NULL OR jsonb_typeof(v_user) IS DISTINCT FROM 'object' OR v_mode NOT IN ('existing','create') THEN
    RETURN jsonb_build_object('status','blocked','conflicts',jsonb_build_array(jsonb_build_object('code','explicit_identity_required')));
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('workspace-identity:'||v_operation_id::text,0));
  IF v_mode='create' THEN
    IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
      RETURN jsonb_build_object('status','blocked','conflicts',jsonb_build_array(jsonb_build_object('code','invalid_identity_email')));
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('workspace-identity-email:'||v_email,0));
  END IF;
  SELECT * INTO v_row FROM provisioning_private.workspace_identity_operations io
  WHERE io.operation_id=v_operation_id FOR UPDATE;
  v_row_exists := FOUND;
  IF v_row_exists THEN
    IF v_row.payload_hash IS DISTINCT FROM v_payload_hash OR v_row.identity_mode IS DISTINCT FROM v_mode
       OR (v_mode='create' AND v_row.email_normalized IS DISTINCT FROM v_email)
       OR (v_mode='existing' AND v_row.auth_user_id IS DISTINCT FROM NULLIF(v_identity->>'auth_user_id','')::uuid) THEN
      RETURN jsonb_build_object('status','blocked','conflicts',jsonb_build_array(jsonb_build_object('code','identity_operation_payload_conflict')));
    END IF;
    IF v_row.auth_user_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=v_row.auth_user_id) THEN
        RETURN jsonb_build_object('status','blocked','conflicts',jsonb_build_array(jsonb_build_object('code','recorded_auth_identity_missing')));
      END IF;
      RETURN jsonb_build_object('status','ready','identity_mode',v_mode,'auth_user_id',v_row.auth_user_id,
        'created_by_operation',v_row.created_by_operation,'auth_create_required',false,'state',v_row.status,
        'payload_hash',v_payload_hash);
    END IF;
  END IF;

  IF v_mode='existing' THEN
    v_user_id := NULLIF(v_identity->>'auth_user_id','')::uuid;
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=v_user_id AND NULLIF(btrim(u.email),'') IS NOT NULL) THEN
      RETURN jsonb_build_object('status','blocked','conflicts',jsonb_build_array(jsonb_build_object('code','auth_user_not_found')));
    END IF;
    IF NOT v_row_exists THEN
      INSERT INTO provisioning_private.workspace_identity_operations(operation_id,payload_hash,identity_mode,auth_user_id,created_by_operation,status)
      VALUES(v_operation_id,v_payload_hash,'existing',v_user_id,false,'auth_ready');
    END IF;
    RETURN jsonb_build_object('status','ready','identity_mode','existing','auth_user_id',v_user_id,
      'created_by_operation',false,'auth_create_required',false,'state','auth_ready','payload_hash',v_payload_hash);
  END IF;

  SELECT count(*) INTO v_marker_count FROM auth.users u
  WHERE u.raw_app_meta_data->'wamule_workspace_onboarding'->>'operation_id'=v_operation_id::text
    AND u.raw_app_meta_data->'wamule_workspace_onboarding'->>'payload_hash'=v_payload_hash
    AND lower(u.email)=v_email;
  IF v_marker_count>1 THEN
    RETURN jsonb_build_object('status','blocked','conflicts',jsonb_build_array(jsonb_build_object('code','duplicate_auth_identities_for_operation')));
  END IF;
  SELECT u.id INTO v_user_id FROM auth.users u
  WHERE u.raw_app_meta_data->'wamule_workspace_onboarding'->>'operation_id'=v_operation_id::text
    AND u.raw_app_meta_data->'wamule_workspace_onboarding'->>'payload_hash'=v_payload_hash
    AND lower(u.email)=v_email;
  IF v_user_id IS NOT NULL THEN
    IF NOT v_row_exists THEN
      INSERT INTO provisioning_private.workspace_identity_operations(operation_id,payload_hash,identity_mode,email_normalized,auth_user_id,created_by_operation,status)
      VALUES(v_operation_id,v_payload_hash,'create',v_email,v_user_id,true,'auth_ready');
    ELSE
      UPDATE provisioning_private.workspace_identity_operations SET auth_user_id=v_user_id,created_by_operation=true,status='auth_ready',updated_at=now()
      WHERE operation_id=v_operation_id;
    END IF;
    RETURN jsonb_build_object('status','ready','identity_mode','create','auth_user_id',v_user_id,
      'created_by_operation',true,'auth_create_required',false,'state','auth_ready','recovered_from_auth_marker',true,
      'payload_hash',v_payload_hash);
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email)=v_email) THEN
    RETURN jsonb_build_object('status','blocked','conflicts',jsonb_build_array(jsonb_build_object('code','identity_email_already_in_use','email','redacted')));
  END IF;
  IF EXISTS (SELECT 1 FROM provisioning_private.workspace_identity_operations io
             WHERE io.identity_mode='create' AND io.email_normalized=v_email AND io.operation_id<>v_operation_id) THEN
    RETURN jsonb_build_object('status','blocked','conflicts',jsonb_build_array(jsonb_build_object('code','identity_email_reserved_by_another_operation','email','redacted')));
  END IF;
  IF NOT v_row_exists THEN
    INSERT INTO provisioning_private.workspace_identity_operations(operation_id,payload_hash,identity_mode,email_normalized,status)
    VALUES(v_operation_id,v_payload_hash,'create',v_email,'auth_pending');
  END IF;
  RETURN jsonb_build_object('status','ready','identity_mode','create','auth_user_id',NULL,
    'created_by_operation',true,'auth_create_required',true,'state','auth_pending','payload_hash',v_payload_hash);
END;
$function$;
REVOKE ALL ON FUNCTION public.prepare_workspace_identity_onboarding_v1(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_workspace_identity_onboarding_v1(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.record_workspace_identity_onboarding_v1(p_manifest jsonb,p_auth_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_operation_id uuid := NULLIF(p_manifest->>'operation_id','')::uuid;
  v_payload_hash text := md5(p_manifest::text);
  v_email text := lower(btrim(COALESCE(p_manifest->'users'->0->'identity'->>'email','')));
  v_row provisioning_private.workspace_identity_operations%ROWTYPE;
BEGIN
  IF NULLIF(pg_catalog.current_setting('request.jwt.claim.role',true),'') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Identity recording is restricted to the trusted server.' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_row FROM provisioning_private.workspace_identity_operations io WHERE io.operation_id=v_operation_id FOR UPDATE;
  IF NOT FOUND OR v_row.payload_hash IS DISTINCT FROM v_payload_hash OR v_row.identity_mode IS DISTINCT FROM 'create'
     OR v_row.email_normalized IS DISTINCT FROM v_email THEN
    RETURN jsonb_build_object('status','blocked','conflicts',jsonb_build_array(jsonb_build_object('code','identity_intent_mismatch')));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id=p_auth_user_id AND lower(u.email)=v_email
      AND u.raw_app_meta_data->'wamule_workspace_onboarding'->>'operation_id'=v_operation_id::text
      AND u.raw_app_meta_data->'wamule_workspace_onboarding'->>'payload_hash'=v_payload_hash
  ) THEN
    RETURN jsonb_build_object('status','blocked','conflicts',jsonb_build_array(jsonb_build_object('code','auth_identity_marker_mismatch')));
  END IF;
  IF v_row.auth_user_id IS NOT NULL AND v_row.auth_user_id IS DISTINCT FROM p_auth_user_id THEN
    RETURN jsonb_build_object('status','blocked','conflicts',jsonb_build_array(jsonb_build_object('code','auth_identity_recovery_conflict')));
  END IF;
  UPDATE provisioning_private.workspace_identity_operations SET auth_user_id=p_auth_user_id,
    created_by_operation=true,status=CASE WHEN status='assigned' THEN status ELSE 'auth_ready' END,updated_at=now()
  WHERE operation_id=v_operation_id;
  RETURN jsonb_build_object('status','ready','identity_mode','create','auth_user_id',p_auth_user_id,
    'created_by_operation',true,'auth_create_required',false,'state','auth_ready','payload_hash',v_payload_hash);
END;
$function$;
REVOKE ALL ON FUNCTION public.record_workspace_identity_onboarding_v1(jsonb,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_workspace_identity_onboarding_v1(jsonb,uuid) TO service_role;

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
