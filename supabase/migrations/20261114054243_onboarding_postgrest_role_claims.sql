-- CONDITIONAL PROPOSAL ONLY: apply only if the pre-repair PostgREST service-role probe
-- on the exact 72-migration + M1.5 baseline fails with SQLSTATE 42501 at the
-- legacy request.jwt.claim.role guard. Do not apply if the probe returns
-- status=invalid and writes=0.
--
-- PostgREST supplies JWT claims as request.jwt.claims JSON. auth.jwt() reads
-- the signed claim role; the legacy single-claim setting remains a fallback.
-- This changes only onboarding role-claim extraction. CREATE OR REPLACE
-- preserves the existing function ACLs; no grant widening is performed here.

CREATE OR REPLACE FUNCTION public.guard_reservation_workflow_setting_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.key = 'reservation_workflow_settings'
     AND NEW.key <> 'reservation_workflow_settings' THEN
    RAISE EXCEPTION 'The audited reservation settings key cannot be renamed directly.';
  END IF;
  IF NEW.key <> 'reservation_workflow_settings'
     AND NOT (TG_OP = 'UPDATE' AND OLD.key = 'reservation_workflow_settings') THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit_private.verified_operation_context AS c
    WHERE c.backend_pid = pg_catalog.pg_backend_pid()
      AND c.transaction_id = pg_catalog.txid_current()
      AND c.target_tenant_id = NEW.tenant_id
      AND (
        (c.purpose = 'reservation_settings' AND c.actor_id IS NOT NULL AND c.actor_id = auth.uid())
        OR (c.purpose = 'workspace_provisioning' AND c.actor_id IS NULL
            AND COALESCE(NULLIF(auth.jwt()->>'role', ''), NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')) = 'service_role')
      )
  ) THEN
    RAISE EXCEPTION 'Reservation workflow settings must be saved with an audited tenant operation.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.provision_workspace_v1(
  p_manifest jsonb,
  p_apply boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_conflicts jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_public_blockers jsonb := '[]'::jsonb;
  v_project_plan jsonb := '[]'::jsonb;
  v_projects_result jsonb := '[]'::jsonb;
  v_user_result jsonb := '[]'::jsonb;
  v_users_plan jsonb := '[]'::jsonb;
  v_user_membership_plan jsonb;
  v_settings_plan jsonb := '[]'::jsonb;
  v_phase_result jsonb;
  v_project jsonb;
  v_phase jsonb;
  v_user jsonb;
  v_membership jsonb;
  v_membership_result jsonb;
  v_company jsonb;
  v_company_settings jsonb;
  v_company_profile jsonb;
  v_reservation_settings jsonb;
  v_project_settings jsonb;
  v_project_profile jsonb;
  v_theme jsonb;
  v_public_application jsonb;
  v_projects jsonb;
  v_users jsonb;
  v_slug text;
  v_name text;
  v_mode text;
  v_default_project_slug text;
  v_default_phase_slug text;
  v_phase_slug text;
  v_fixture text;
  v_operation_id uuid;
  v_payload_hash text;
  v_tenant_id uuid;
  v_project_id uuid;
  v_phase_id uuid;
  v_user_id uuid;
  v_profile_role text;
  v_member_role text;
  v_auth_email text;
  v_auth_name text;
  v_existing_name text;
  v_existing_mode text;
  v_current_default text;
  v_existing_value jsonb;
  v_existing_role text;
  v_seen_users uuid[] := ARRAY[]::uuid[];
  v_seen_membership_scopes text[] := ARRAY[]::text[];
  v_scope_key text;
  v_exists boolean;
  v_tenant_created boolean := false;
  v_project_created boolean;
  v_phase_created boolean;
  v_profile_created boolean;
  v_membership_created boolean;
  v_can_apply boolean := true;
  v_default_membership boolean := false;
  v_phase_count integer;
  v_count integer;
  v_other_tenant_memberships integer;
  v_project_inventory_count bigint;
  v_key text;
  v_allowed text[];
  v_operation_result jsonb;
  v_operation_row provisioning_private.operation_results%ROWTYPE;
  v_readiness jsonb;
  v_result jsonb;
  v_reservation_input jsonb;
  v_profile_id uuid;
  v_membership_id uuid;
  v_membership_phase_id uuid;
  v_profile_disposition text;
  v_membership_existing_role text;
BEGIN
  IF COALESCE(NULLIF(auth.jwt()->>'role', ''), NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Workspace provisioning is restricted to the trusted service role.' USING ERRCODE = '42501';
  END IF;

  IF p_manifest IS NULL OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('status','invalid','can_apply',false,'writes',0,
      'conflicts',jsonb_build_array(jsonb_build_object('code','invalid_manifest','message','Manifest must be a JSON object.')),
      'missing_prerequisites','[]'::jsonb);
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_manifest) LOOP
    IF v_key <> ALL (ARRAY['schema_version','operation_id','company','projects','users']) THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','unknown_field','field',v_key));
    END IF;
  END LOOP;
  IF p_manifest->>'schema_version' IS DISTINCT FROM '1' THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','unsupported_schema_version'));
  END IF;
  IF COALESCE(p_manifest->>'operation_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_operation_id'));
  ELSE
    v_operation_id := (p_manifest->>'operation_id')::uuid;
  END IF;
  IF jsonb_typeof(p_manifest->'company') IS DISTINCT FROM 'object' THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_company'));
  END IF;
  IF jsonb_typeof(p_manifest->'projects') IS DISTINCT FROM 'array'
     OR jsonb_array_length(CASE WHEN jsonb_typeof(p_manifest->'projects')='array' THEN p_manifest->'projects' ELSE '[]'::jsonb END)=0 THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','projects_required'));
  END IF;
  IF p_manifest ? 'users' AND jsonb_typeof(p_manifest->'users') IS DISTINCT FROM 'array' THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_users'));
  END IF;
  IF jsonb_array_length(v_conflicts) > 0 THEN
    RETURN jsonb_build_object('status','invalid','can_apply',false,'writes',0,
      'conflicts',v_conflicts,'missing_prerequisites',v_missing);
  END IF;

  v_company := p_manifest->'company';
  v_projects := p_manifest->'projects';
  v_users := COALESCE(p_manifest->'users','[]'::jsonb);
  v_slug := v_company->>'slug';
  v_name := NULLIF(btrim(v_company->>'name'),'');
  v_default_project_slug := v_company->>'default_project_slug';
  v_company_settings := COALESCE(v_company->'settings','{}'::jsonb);
  IF jsonb_typeof(v_company_settings) IS DISTINCT FROM 'object' THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_company_settings'));
    v_company_settings := '{}'::jsonb;
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_company) LOOP
    IF v_key <> ALL (ARRAY['slug','name','default_project_slug','settings']) THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','unknown_field','field','company.'||v_key));
    END IF;
  END LOOP;
  FOR v_key IN SELECT jsonb_object_keys(v_company_settings) LOOP
    IF v_key <> ALL (ARRAY['company_profile','reservation_workflow_settings']) THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','unknown_field','field','company.settings.'||v_key));
    END IF;
  END LOOP;
  IF COALESCE(v_slug,'') !~ '^[a-z0-9][a-z0-9-]{0,62}$' OR v_name IS NULL
     OR COALESCE(v_default_project_slug,'') !~ '^[a-z0-9][a-z0-9-]{0,62}$' THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_company_identity'));
  END IF;
  IF jsonb_typeof(COALESCE(v_company_settings->'company_profile','{}'::jsonb)) IS DISTINCT FROM 'object' THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_company_profile'));
  END IF;
  IF jsonb_typeof(COALESCE(v_company_settings->'reservation_workflow_settings','{"use_default":true}'::jsonb)) IS DISTINCT FROM 'object' THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_reservation_workflow_settings'));
  END IF;
  v_reservation_settings := '{"default_reservation_expiry_days":14,"default_deposit_due_days":7,"default_expected_deposit_amount":null,"require_expiry_date":false,"require_expected_deposit_amount":false,"default_reservation_status":"draft","default_deposit_status":"not_requested","prompt_release_alternates_after_deposit_confirmed":true,"prompt_release_alternates_after_contract_started":true,"show_reservation_explanations":true}'::jsonb;
  v_reservation_input := v_company_settings->'reservation_workflow_settings';
  IF v_company_settings ? 'reservation_workflow_settings' THEN
    IF jsonb_typeof(v_reservation_input) IS DISTINCT FROM 'object' THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_reservation_workflow_settings'));
    ELSIF v_reservation_input = '{"use_default":true}'::jsonb THEN
      NULL;
    ELSIF v_reservation_input ? 'use_default' THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_reservation_default_selector','detail','Use {use_default:true}, omit the setting, or provide explicit setting values without a selector.'));
    ELSE
      FOR v_key IN SELECT jsonb_object_keys(v_reservation_input) LOOP
        IF v_key <> ALL (ARRAY['default_reservation_expiry_days','default_deposit_due_days','default_expected_deposit_amount','require_expiry_date','require_expected_deposit_amount','default_reservation_status','default_deposit_status','prompt_release_alternates_after_deposit_confirmed','prompt_release_alternates_after_contract_started','show_reservation_explanations']) THEN
          v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','unknown_field','field','company.settings.reservation_workflow_settings.'||v_key));
        END IF;
      END LOOP;
      IF (v_reservation_input ? 'default_reservation_expiry_days' AND CASE WHEN jsonb_typeof(v_reservation_input->'default_reservation_expiry_days')='number' THEN (v_reservation_input->>'default_reservation_expiry_days')::numeric < 0 OR trunc((v_reservation_input->>'default_reservation_expiry_days')::numeric) <> (v_reservation_input->>'default_reservation_expiry_days')::numeric ELSE true END)
         OR (v_reservation_input ? 'default_deposit_due_days' AND CASE WHEN jsonb_typeof(v_reservation_input->'default_deposit_due_days')='number' THEN (v_reservation_input->>'default_deposit_due_days')::numeric < 0 OR trunc((v_reservation_input->>'default_deposit_due_days')::numeric) <> (v_reservation_input->>'default_deposit_due_days')::numeric ELSE true END)
         OR (v_reservation_input ? 'default_expected_deposit_amount' AND v_reservation_input->'default_expected_deposit_amount' <> 'null'::jsonb AND CASE WHEN jsonb_typeof(v_reservation_input->'default_expected_deposit_amount')='number' THEN (v_reservation_input->>'default_expected_deposit_amount')::numeric < 0 ELSE true END) THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_reservation_numeric_setting'));
      END IF;
      IF (v_reservation_input ? 'require_expiry_date' AND jsonb_typeof(v_reservation_input->'require_expiry_date') IS DISTINCT FROM 'boolean')
         OR (v_reservation_input ? 'require_expected_deposit_amount' AND jsonb_typeof(v_reservation_input->'require_expected_deposit_amount') IS DISTINCT FROM 'boolean')
         OR (v_reservation_input ? 'prompt_release_alternates_after_deposit_confirmed' AND jsonb_typeof(v_reservation_input->'prompt_release_alternates_after_deposit_confirmed') IS DISTINCT FROM 'boolean')
         OR (v_reservation_input ? 'prompt_release_alternates_after_contract_started' AND jsonb_typeof(v_reservation_input->'prompt_release_alternates_after_contract_started') IS DISTINCT FROM 'boolean')
         OR (v_reservation_input ? 'show_reservation_explanations' AND jsonb_typeof(v_reservation_input->'show_reservation_explanations') IS DISTINCT FROM 'boolean') THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_reservation_boolean_setting'));
      END IF;
      IF (v_reservation_input ? 'default_reservation_status' AND (jsonb_typeof(v_reservation_input->'default_reservation_status') IS DISTINCT FROM 'string' OR v_reservation_input->>'default_reservation_status' NOT IN ('draft','reserved','deposit_pending','deposit_submitted','deposit_confirmed','converted_to_application','converted_to_contract','expired','cancelled','released')))
         OR (v_reservation_input ? 'default_deposit_status' AND (jsonb_typeof(v_reservation_input->'default_deposit_status') IS DISTINCT FROM 'string' OR v_reservation_input->>'default_deposit_status' NOT IN ('not_requested','pending','proof_submitted','confirmed','overdue','waived','cancelled'))) THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_reservation_status_setting'));
      END IF;
      v_reservation_settings := v_reservation_settings || v_reservation_input;
    END IF;
  END IF;

  SELECT count(*) INTO v_count
  FROM (SELECT lower(p.value->>'slug') AS slug FROM jsonb_array_elements(v_projects) p(value)
        GROUP BY lower(p.value->>'slug') HAVING count(*) > 1) duplicates;
  IF v_count > 0 THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','duplicate_project_slug'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_projects) p(value) WHERE p.value->>'slug'=v_default_project_slug) THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_default_project','slug',v_default_project_slug));
  END IF;

  IF jsonb_typeof(COALESCE(v_company_settings->'company_profile','{}'::jsonb)) IS DISTINCT FROM 'object' THEN
    v_company_profile := jsonb_build_object('company_name',v_name);
  ELSE
    v_company_profile := COALESCE(v_company_settings->'company_profile','{}'::jsonb)
      || jsonb_build_object('company_name',COALESCE(NULLIF(btrim(COALESCE(v_company_settings->'company_profile'->>'company_name','')),''),v_name));
  END IF;
  -- For apply requests, serialize all preflight reads for this company and
  -- return an existing idempotent result before current-state conflict checks.
  -- This prevents two distinct operations from both passing stale preflight.
  v_payload_hash := md5(p_manifest::text);
  IF p_apply THEN
    PERFORM pg_advisory_xact_lock(hashtext('tenant-onboard:'||lower(COALESCE(v_company->>'slug',''))));
    PERFORM pg_advisory_xact_lock(hashtext('workspace-provision:'||(p_manifest->>'operation_id')));
    SELECT * INTO v_operation_row FROM provisioning_private.operation_results o WHERE o.operation_id=v_operation_id FOR UPDATE;
    IF FOUND THEN
      IF v_operation_row.payload_hash IS DISTINCT FROM v_payload_hash THEN
        RETURN jsonb_build_object('status','blocked','can_apply',false,'writes',0,'operation_id',v_operation_id,
          'conflicts',jsonb_build_array(jsonb_build_object('code','operation_payload_conflict')),'missing_prerequisites',v_missing);
      END IF;
      RETURN v_operation_row.result || jsonb_build_object('status','replayed','idempotent_replay',true,'writes',0);
    END IF;
  END IF;

  SELECT o.id,o.name,o.is_active INTO v_tenant_id,v_existing_name,v_exists
  FROM public.organizations o WHERE lower(o.slug)=lower(v_slug);
  IF FOUND THEN
    IF v_existing_name IS DISTINCT FROM v_name THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','slug_conflict','entity','company','slug',v_slug,'field','name'));
    END IF;
    IF NOT v_exists THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','inactive_target_conflict','entity','company','slug',v_slug));
    END IF;
    IF EXISTS (SELECT 1 FROM public.business_settings b WHERE b.tenant_id=v_tenant_id AND b.key='company_profile' AND b.value IS DISTINCT FROM v_company_profile) THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','settings_conflict','scope','company','key','company_profile'));
    END IF;
    IF EXISTS (SELECT 1 FROM public.business_settings b WHERE b.tenant_id=v_tenant_id AND b.key='reservation_workflow_settings' AND b.value IS DISTINCT FROM v_reservation_settings) THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','settings_conflict','scope','company','key','reservation_workflow_settings'));
    END IF;
    IF EXISTS (SELECT 1 FROM public.business_settings b WHERE b.tenant_id=v_tenant_id AND b.key='public_application'
      AND (b.value->>'applications_open' IS DISTINCT FROM 'false' OR b.value->>'show_lot_prices_publicly' IS DISTINCT FROM 'false' OR b.value->>'show_available_lot_count_publicly' IS DISTINCT FROM 'false')) THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','settings_conflict','scope','company','key','public_application','required','all_public_flags_closed'));
    END IF;
    SELECT p.slug INTO v_current_default FROM public.projects p WHERE p.tenant_id=v_tenant_id AND p.is_default;
    IF v_current_default IS NOT NULL AND v_current_default IS DISTINCT FROM v_default_project_slug THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','default_project_conflict','current',v_current_default,'requested',v_default_project_slug));
    END IF;
  ELSE
    v_tenant_id := NULL;
  END IF;

  FOR v_project IN SELECT p.value FROM jsonb_array_elements(v_projects) p(value) LOOP
    IF jsonb_typeof(v_project) IS DISTINCT FROM 'object' THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_project_object'));
      CONTINUE;
    END IF;
    v_slug := v_project->>'slug';
    v_name := NULLIF(btrim(v_project->>'name'),'');
    v_mode := v_project->>'mode';
    v_default_phase_slug := v_project->>'default_phase_slug';
    v_project_settings := COALESCE(v_project->'settings','{}'::jsonb);
    IF jsonb_typeof(v_project_settings) IS DISTINCT FROM 'object' THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_project_settings','project',v_slug));
      v_project_settings := '{}'::jsonb;
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(v_project) LOOP
      IF v_key <> ALL (ARRAY['slug','name','mode','default_phase_slug','inventory','demo_fixture_bundle','settings','phases']) THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','unknown_field','field','projects[].'||v_key));
      END IF;
    END LOOP;
    FOR v_key IN SELECT jsonb_object_keys(v_project_settings) LOOP
      IF v_key IN ('phase_pricing','lot_phase','phase_settings','phase_inheritance') THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','unsupported_phase_pricing_or_inheritance','project',v_slug,'field',v_key));
      ELSIF v_key <> ALL (ARRAY['company_profile','tenant_theme','public_application']) THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','unknown_field','field','projects[].settings.'||v_key));
      END IF;
    END LOOP;
    IF COALESCE(v_slug,'') !~ '^[a-z0-9][a-z0-9-]{0,62}$' OR v_name IS NULL
       OR COALESCE(v_default_phase_slug,'') !~ '^[a-z0-9][a-z0-9-]{0,62}$' THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_project_identity','project',v_slug));
    END IF;
    IF v_mode IS NULL OR v_mode NOT IN ('sales','demo') THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','mode_required','project',v_slug));
    END IF;
    IF jsonb_typeof(v_project->'phases') IS DISTINCT FROM 'array'
       OR jsonb_array_length(CASE WHEN jsonb_typeof(v_project->'phases')='array' THEN v_project->'phases' ELSE '[]'::jsonb END)=0 THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','phases_required','project',v_slug));
    END IF;
    IF v_mode='sales' AND (jsonb_typeof(v_project->'inventory') IS DISTINCT FROM 'object' OR v_project->'inventory'->>'seed' IS DISTINCT FROM 'empty') THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','sales_inventory_must_start_empty','project',v_slug));
    END IF;
    IF v_mode='demo' AND v_project ? 'inventory' THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','demo_inventory_not_supported','project',v_slug));
    END IF;
    IF v_mode='sales' AND v_project ? 'demo_fixture_bundle' THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','demo_fixture_not_allowed_for_sales','project',v_slug));
    END IF;
    IF v_mode='demo' AND v_project ? 'demo_fixture_bundle' AND jsonb_typeof(v_project->'demo_fixture_bundle') IS DISTINCT FROM 'null' THEN
      v_fixture := v_project->>'demo_fixture_bundle';
      IF NOT EXISTS (SELECT 1 FROM provisioning_private.demo_fixture_registry f WHERE f.fixture_key=v_fixture AND f.enabled) THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','unsupported_demo_fixture','project',v_slug,'fixture',v_fixture));
      ELSE
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','demo_fixture_loader_not_implemented','project',v_slug,'fixture',v_fixture));
      END IF;
    END IF;
    IF v_mode='demo' AND NOT (v_project ? 'demo_fixture_bundle') THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','demo_fixture_bundle_required','project',v_slug,'accepted',NULL));
    END IF;
    IF jsonb_typeof(COALESCE(v_project_settings->'company_profile','{}'::jsonb)) IS DISTINCT FROM 'object'
       OR jsonb_typeof(COALESCE(v_project_settings->'tenant_theme','{}'::jsonb)) IS DISTINCT FROM 'object'
       OR jsonb_typeof(COALESCE(v_project_settings->'public_application','{}'::jsonb)) IS DISTINCT FROM 'object' THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_project_setting_value','project',v_slug));
    END IF;
    IF jsonb_typeof(v_project_settings->'public_application')='object' AND (
       (v_project_settings->'public_application' ? 'applications_open' AND (jsonb_typeof(v_project_settings->'public_application'->'applications_open') IS DISTINCT FROM 'boolean' OR v_project_settings->'public_application'->'applications_open' <> 'false'::jsonb))
       OR (v_project_settings->'public_application' ? 'show_lot_prices_publicly' AND (jsonb_typeof(v_project_settings->'public_application'->'show_lot_prices_publicly') IS DISTINCT FROM 'boolean' OR v_project_settings->'public_application'->'show_lot_prices_publicly' <> 'false'::jsonb))
       OR (v_project_settings->'public_application' ? 'show_available_lot_count_publicly' AND (jsonb_typeof(v_project_settings->'public_application'->'show_available_lot_count_publicly') IS DISTINCT FROM 'boolean' OR v_project_settings->'public_application'->'show_available_lot_count_publicly' <> 'false'::jsonb))
    ) THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','new_project_applications_must_start_closed','project',v_slug,'detail','Application, public price and available-count flags must be JSON false or omitted.'));
    END IF;
    SELECT count(*) INTO v_count
    FROM (SELECT lower(ph.value->>'slug') AS slug FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_project->'phases')='array' THEN v_project->'phases' ELSE '[]'::jsonb END) ph(value)
          GROUP BY lower(ph.value->>'slug') HAVING count(*)>1) duplicates;
    IF v_count > 0 THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','duplicate_phase_slug','project',v_slug));
    END IF;
    SELECT count(*) INTO v_phase_count FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_project->'phases')='array' THEN v_project->'phases' ELSE '[]'::jsonb END) ph(value)
      WHERE ph.value->>'slug'=v_default_phase_slug;
    IF v_phase_count <> 1 THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_default_phase','project',v_slug,'slug',v_default_phase_slug));
    END IF;
    FOR v_phase IN SELECT ph.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_project->'phases')='array' THEN v_project->'phases' ELSE '[]'::jsonb END) ph(value) LOOP
      IF jsonb_typeof(v_phase) IS DISTINCT FROM 'object' THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_phase_object','project',v_slug));
        CONTINUE;
      END IF;
      FOR v_key IN SELECT jsonb_object_keys(v_phase) LOOP
        IF v_key <> ALL (ARRAY['slug','name']) THEN
          v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code',CASE WHEN v_key IN ('settings','pricing','lot_phase','phase_pricing','phase_inheritance','inheritance') THEN 'unsupported_phase_pricing_or_inheritance' ELSE 'unknown_field' END,'project',v_slug,'phase',v_phase->>'slug','field',v_key));
        END IF;
      END LOOP;
      IF COALESCE(v_phase->>'slug','') !~ '^[a-z0-9][a-z0-9-]{0,62}$' OR NULLIF(btrim(v_phase->>'name'),'') IS NULL THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_phase_identity','project',v_slug,'phase',v_phase->>'slug'));
      END IF;
    END LOOP;

    IF v_tenant_id IS NOT NULL THEN
      SELECT p.id,p.name,p.map_experience_mode::text INTO v_project_id,v_existing_name,v_existing_mode
      FROM public.projects p WHERE p.tenant_id=v_tenant_id AND lower(p.slug)=lower(v_slug);
      IF FOUND THEN
        IF v_existing_name IS DISTINCT FROM v_name OR v_existing_mode IS DISTINCT FROM v_mode THEN
          v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','slug_conflict','entity','project','slug',v_slug,'field','name_or_mode'));
        END IF;
        SELECT p.slug INTO v_current_default FROM public.projects p WHERE p.tenant_id=v_tenant_id AND p.is_default;
        IF v_current_default IS NOT NULL AND v_current_default IS DISTINCT FROM v_default_project_slug THEN
          v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','default_project_conflict','current',v_current_default,'requested',v_default_project_slug));
        END IF;
        FOR v_phase IN SELECT ph.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_project->'phases')='array' THEN v_project->'phases' ELSE '[]'::jsonb END) ph(value) LOOP
          SELECT ph.id,ph.name,ph.is_active INTO v_phase_id,v_existing_name,v_exists
          FROM public.development_phases ph WHERE ph.project_id=v_project_id AND lower(ph.slug)=lower(v_phase->>'slug');
          IF FOUND THEN
            IF v_existing_name IS DISTINCT FROM btrim(v_phase->>'name') THEN
              v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','slug_conflict','entity','phase','project',v_slug,'slug',v_phase->>'slug','field','name'));
            END IF;
            IF NOT v_exists THEN
              v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','inactive_target_conflict','entity','phase','project',v_slug,'slug',v_phase->>'slug'));
            END IF;
          END IF;
        END LOOP;
        SELECT ph.slug INTO v_current_default FROM public.development_phases ph WHERE ph.project_id=v_project_id AND ph.is_default;
        IF v_current_default IS NOT NULL AND v_current_default IS DISTINCT FROM v_default_phase_slug THEN
          v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','default_phase_conflict','project',v_slug,'current',v_current_default,'requested',v_default_phase_slug));
        END IF;
        v_project_profile := v_company_profile || COALESCE(v_project_settings->'company_profile','{}'::jsonb);
        v_theme := COALESCE(v_project_settings->'tenant_theme','{"site_experience":{"templateId":"wamule-classic","enabledModules":{"map":false,"inquiry":false,"application":false,"pricing":false}}}'::jsonb);
        v_public_application := '{"applications_open":false,"show_lot_prices_publicly":false,"show_available_lot_count_publicly":false}'::jsonb || COALESCE(v_project_settings->'public_application','{}'::jsonb);
        FOR v_key, v_existing_value IN SELECT 'company_profile',ps.value FROM public.project_settings ps WHERE ps.project_id=v_project_id AND ps.key='company_profile' LOOP
          IF v_existing_value IS DISTINCT FROM v_project_profile THEN v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','settings_conflict','scope','project','project_slug',v_slug,'key',v_key)); END IF;
        END LOOP;
        FOR v_key, v_existing_value IN SELECT 'tenant_theme',ps.value FROM public.project_settings ps WHERE ps.project_id=v_project_id AND ps.key='tenant_theme' LOOP
          IF v_existing_value IS DISTINCT FROM v_theme THEN v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','settings_conflict','scope','project','project_slug',v_slug,'key',v_key)); END IF;
        END LOOP;
        FOR v_key, v_existing_value IN SELECT 'public_application',ps.value FROM public.project_settings ps WHERE ps.project_id=v_project_id AND ps.key='public_application' LOOP
          IF v_existing_value IS DISTINCT FROM v_public_application THEN v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','settings_conflict','scope','project','project_slug',v_slug,'key',v_key)); END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;

  -- The legacy ApplicationPage reads business_settings without tenant/project
  -- scope and falls back to applications_open=true. Keep public readiness
  -- blocked until M6/M7 route resolution is unified; private apply can proceed.
  v_public_blockers := jsonb_build_array(jsonb_build_object(
    'code','APPLICATION_SETTINGS_PRECEDENCE_UNRESOLVED',
    'scope','public_readiness',
    'detail','ApplicationPage reads tenant business_settings without a tenant/project filter and defaults applications_open to true; project-scoped false is not a universal UI guarantee.'
  ));

  -- Existing identity/profile/membership preflight. Auth account creation and
  -- recovery across Auth/DB remain M4.3; this RPC only reuses existing Auth.
  v_default_membership := false;
  FOR v_user IN SELECT u.value FROM jsonb_array_elements(v_users) u(value) LOOP
    IF jsonb_typeof(v_user) IS DISTINCT FROM 'object' THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_user_object'));
      CONTINUE;
    END IF;
    IF COALESCE(v_user->>'auth_user_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_auth_user_id'));
      CONTINUE;
    END IF;
    v_user_id := (v_user->>'auth_user_id')::uuid;
    IF v_user_id = ANY(v_seen_users) THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','duplicate_user_assignment','user_reference','redacted'));
      CONTINUE;
    END IF;
    v_seen_users := array_append(v_seen_users,v_user_id);
    v_seen_membership_scopes := ARRAY[]::text[];
    v_user_membership_plan := '[]'::jsonb;
    v_profile_role := v_user->>'profile_role';
    IF v_profile_role IS NULL OR v_profile_role NOT IN ('Staff','Read Only') THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','role_cap_denied','user_reference','redacted','requested',v_profile_role));
    END IF;
    IF jsonb_typeof(v_user->'memberships') IS DISTINCT FROM 'array' OR jsonb_array_length(CASE WHEN jsonb_typeof(v_user->'memberships')='array' THEN v_user->'memberships' ELSE '[]'::jsonb END)=0 THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','memberships_required_for_assignment','user_reference','redacted'));
    END IF;
    SELECT u.email, COALESCE(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name','') INTO v_auth_email,v_auth_name FROM auth.users u WHERE u.id=v_user_id;
    IF NOT FOUND THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','auth_user_not_found','user_reference','redacted'));
      CONTINUE;
    END IF;
    IF NULLIF(btrim(v_auth_email),'') IS NULL THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','auth_user_email_missing','user_reference','redacted'));
    END IF;
    v_profile_id:=v_user_id;
    SELECT ap.role::text INTO v_existing_role FROM public.admin_profiles ap WHERE ap.user_id=v_user_id;
    IF FOUND THEN
      v_profile_disposition:='reuse';
      IF v_existing_role IN ('Super Admin','Admin') OR v_existing_role IS DISTINCT FROM v_profile_role THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','profile_role_conflict','user_reference','redacted','existing',v_existing_role,'requested',v_profile_role));
      END IF;
      IF EXISTS (SELECT 1 FROM public.admin_profiles ap WHERE ap.user_id=v_user_id AND ap.tenant_id IS DISTINCT FROM v_tenant_id) THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','user_tenant_conflict','user_reference','redacted'));
      END IF;
    ELSE
      v_existing_role:=NULL;
      v_profile_disposition:='create';
    END IF;
    SELECT count(*) INTO v_other_tenant_memberships FROM public.project_memberships pm
    WHERE pm.user_id=v_user_id AND (v_tenant_id IS NULL OR pm.tenant_id<>v_tenant_id);
    IF v_other_tenant_memberships>0 THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','user_tenant_conflict','user_reference','redacted'));
    END IF;
    FOR v_membership IN SELECT m.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_user->'memberships')='array' THEN v_user->'memberships' ELSE '[]'::jsonb END) m(value) LOOP
      IF jsonb_typeof(v_membership) IS DISTINCT FROM 'object' THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_membership_object','user_reference','redacted'));
        CONTINUE;
      END IF;
      IF v_membership->>'member_role' IS NULL OR v_membership->>'member_role' NOT IN ('staff','read_only')
         OR (v_profile_role='Read Only' AND v_membership->>'member_role'<>'read_only') THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','role_cap_denied','user_reference','redacted','membership_role',v_membership->>'member_role'));
      END IF;
      IF (v_membership ? 'all_phases')=(v_membership ? 'phase_slugs')
         OR (v_membership ? 'all_phases' AND v_membership->>'all_phases' IS DISTINCT FROM 'true') THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_membership_scope','user_reference','redacted'));
      END IF;
      IF v_membership->>'project_slug' IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_projects) p(value) WHERE p.value->>'slug'=v_membership->>'project_slug') THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','membership_project_not_in_manifest','user_reference','redacted','project_slug',v_membership->>'project_slug'));
        CONTINUE;
      END IF;
      IF v_membership->>'all_phases'='true' THEN
        IF v_membership->>'project_slug'||':ALL'=ANY(v_seen_membership_scopes)
           OR EXISTS (SELECT 1 FROM unnest(v_seen_membership_scopes) seen(scope_key) WHERE seen.scope_key LIKE v_membership->>'project_slug'||':%') THEN
          v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','duplicate_or_overlapping_membership_input','user_reference','redacted','project_slug',v_membership->>'project_slug'));
        END IF;
        v_seen_membership_scopes:=array_append(v_seen_membership_scopes,v_membership->>'project_slug'||':ALL');
        IF v_membership->>'confirm_scope' IS DISTINCT FROM 'all_current_and_future_phases_in_this_project' THEN
          v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','all_phase_confirmation_required','user_reference','redacted','project_slug',v_membership->>'project_slug'));
        END IF;
        IF v_tenant_id IS NOT NULL THEN
          SELECT p.id INTO v_project_id FROM public.projects p WHERE p.tenant_id=v_tenant_id AND p.slug=v_membership->>'project_slug';
          IF v_project_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.project_memberships pm WHERE pm.user_id=v_user_id AND pm.project_id=v_project_id AND pm.phase_id IS NOT NULL) THEN
            v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','membership_overlap','user_reference','redacted','project_slug',v_membership->>'project_slug'));
          END IF;
          IF v_project_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.project_memberships pm WHERE pm.user_id=v_user_id AND pm.project_id=v_project_id AND pm.phase_id IS NULL AND pm.member_role<>v_membership->>'member_role') THEN
            v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','membership_role_conflict','user_reference','redacted','project_slug',v_membership->>'project_slug'));
          END IF;
        END IF;
        v_membership_id:=NULL;
        v_membership_existing_role:=NULL;
        IF v_project_id IS NOT NULL THEN
          SELECT pm.id,pm.member_role INTO v_membership_id,v_membership_existing_role
          FROM public.project_memberships pm WHERE pm.user_id=v_user_id AND pm.project_id=v_project_id AND pm.phase_id IS NULL;
        END IF;
        v_user_membership_plan:=COALESCE(v_user_membership_plan,'[]'::jsonb) || jsonb_build_array(jsonb_build_object(
          'project_slug',v_membership->>'project_slug','project_id',v_project_id,'all_phases',true,'member_role',v_membership->>'member_role',
          'id',v_membership_id,'disposition',CASE WHEN v_membership_id IS NULL THEN 'create' WHEN v_membership_existing_role=v_membership->>'member_role' THEN 'reuse' ELSE 'conflict' END));
        IF v_membership->>'project_slug'=v_default_project_slug THEN v_default_membership:=true; END IF;
      ELSE
        IF jsonb_typeof(v_membership->'phase_slugs') IS DISTINCT FROM 'array' OR jsonb_array_length(CASE WHEN jsonb_typeof(v_membership->'phase_slugs')='array' THEN v_membership->'phase_slugs' ELSE '[]'::jsonb END)=0 THEN
          v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_membership_scope','user_reference','redacted'));
          CONTINUE;
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_membership->'phase_slugs') phase(value) WHERE jsonb_typeof(phase.value) IS DISTINCT FROM 'string') THEN
          v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','invalid_membership_phase_values','user_reference','redacted'));
          CONTINUE;
        END IF;
        SELECT count(*) INTO v_count FROM (SELECT jsonb_array_elements_text(v_membership->'phase_slugs') AS phase_slug GROUP BY phase_slug HAVING count(*)>1) dupes;
        IF v_count>0 THEN v_conflicts:=v_conflicts || jsonb_build_array(jsonb_build_object('code','duplicate_membership_phase','user_reference','redacted','project_slug',v_membership->>'project_slug')); END IF;
        FOR v_phase_slug IN SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(v_membership->'phase_slugs')='array' THEN v_membership->'phase_slugs' ELSE '[]'::jsonb END) LOOP
          v_scope_key:=v_membership->>'project_slug'||':'||v_phase_slug;
          IF v_scope_key=ANY(v_seen_membership_scopes) OR v_membership->>'project_slug'||':ALL'=ANY(v_seen_membership_scopes) THEN
            v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','duplicate_or_overlapping_membership_input','user_reference','redacted','project_slug',v_membership->>'project_slug','phase_slug',v_phase_slug));
          END IF;
          v_seen_membership_scopes:=array_append(v_seen_membership_scopes,v_scope_key);
          IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_projects) p(value) CROSS JOIN LATERAL jsonb_array_elements(p.value->'phases') ph(value)
                         WHERE p.value->>'slug'=v_membership->>'project_slug' AND ph.value->>'slug'=v_phase_slug) THEN
            v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','membership_phase_not_in_project','user_reference','redacted','project_slug',v_membership->>'project_slug','phase_slug',v_phase_slug));
          END IF;
          IF v_tenant_id IS NOT NULL THEN
            SELECT p.id INTO v_project_id FROM public.projects p WHERE p.tenant_id=v_tenant_id AND p.slug=v_membership->>'project_slug';
            SELECT ph.id INTO v_membership_phase_id FROM public.development_phases ph WHERE ph.project_id=v_project_id AND ph.slug=v_phase_slug;
            IF v_membership_phase_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.project_memberships pm WHERE pm.user_id=v_user_id AND pm.project_id=v_project_id AND pm.phase_id IS NULL) THEN
              v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','membership_overlap','user_reference','redacted','project_slug',v_membership->>'project_slug'));
            END IF;
            IF v_membership_phase_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.project_memberships pm WHERE pm.user_id=v_user_id AND pm.project_id=v_project_id AND pm.phase_id=v_membership_phase_id AND pm.member_role<>v_membership->>'member_role') THEN
              v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('code','membership_role_conflict','user_reference','redacted','project_slug',v_membership->>'project_slug','phase_slug',v_phase_slug));
            END IF;
          ELSE
            v_membership_phase_id:=NULL;
          END IF;
          v_membership_id:=NULL;
          v_membership_existing_role:=NULL;
          IF v_membership_phase_id IS NOT NULL THEN
            SELECT pm.id,pm.member_role INTO v_membership_id,v_membership_existing_role
            FROM public.project_memberships pm WHERE pm.user_id=v_user_id AND pm.project_id=v_project_id AND pm.phase_id=v_membership_phase_id;
          END IF;
          v_user_membership_plan:=COALESCE(v_user_membership_plan,'[]'::jsonb) || jsonb_build_array(jsonb_build_object(
            'project_slug',v_membership->>'project_slug','project_id',v_project_id,'phase_slug',v_phase_slug,'phase_id',v_membership_phase_id,
            'member_role',v_membership->>'member_role','id',v_membership_id,
            'disposition',CASE WHEN v_membership_id IS NULL THEN 'create' WHEN v_membership_existing_role=v_membership->>'member_role' THEN 'reuse' ELSE 'conflict' END));
          IF v_membership->>'project_slug'=v_default_project_slug AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_projects) p(value)
            WHERE p.value->>'slug'=v_default_project_slug AND p.value->>'default_phase_slug'=v_phase_slug
          ) THEN v_default_membership:=true; END IF;
        END LOOP;
      END IF;
    END LOOP;
    v_users_plan:=v_users_plan || jsonb_build_array(jsonb_build_object('auth_user_id',v_user_id,'profile_id',v_profile_id,'profile_role',v_profile_role,
      'profile_disposition',v_profile_disposition,'memberships',COALESCE(v_user_membership_plan,'[]'::jsonb)));
  END LOOP;
  IF NOT v_default_membership THEN
    v_missing := v_missing || jsonb_build_array(jsonb_build_object('code','NO_USABLE_MEMBER','scope',v_default_project_slug||'/'||COALESCE((SELECT p.value->>'default_phase_slug' FROM jsonb_array_elements(v_projects) p(value) WHERE p.value->>'slug'=v_default_project_slug LIMIT 1),'unknown')));
  END IF;

  -- Settings resolution is deliberately checked against both tenant and exact
  -- project rows. The generic legacy ApplicationPage remains a public blocker.
  v_can_apply := jsonb_array_length(v_conflicts)=0;
  IF NOT v_can_apply AND p_apply THEN
    RETURN jsonb_build_object('status','blocked','can_apply',false,'writes',0,'operation_id',p_manifest->>'operation_id',
      'conflicts',v_conflicts,'missing_prerequisites',v_missing,
      'readiness',jsonb_build_object('workspace_creation',false,'membership_ready',v_default_membership,'usable_workspace_ready',false,
        'map_publication_ready',false,'domain_ready',false,'public_blockers',v_public_blockers));
  END IF;

  -- Read-only plan: status is descriptive and this branch performs no DML.
  IF NOT p_apply THEN
    SELECT o.id,o.name,o.is_active INTO v_tenant_id,v_existing_name,v_exists FROM public.organizations o WHERE lower(o.slug)=lower(v_company->>'slug');
    RETURN jsonb_build_object('status','dry_run','can_apply',v_can_apply,'writes',0,'operation_id',v_operation_id,
      'company',jsonb_build_object('slug',v_company->>'slug','name',v_company->>'name','id',v_tenant_id,'disposition',CASE WHEN v_tenant_id IS NULL THEN 'create' ELSE 'reuse' END),
      'projects',(SELECT COALESCE(jsonb_agg(jsonb_build_object('slug',p.value->>'slug','mode',p.value->>'mode','default_phase_slug',p.value->>'default_phase_slug',
        'id',pr.id,'disposition',CASE WHEN pr.id IS NULL THEN 'create' ELSE 'reuse' END,
        'is_default',(p.value->>'slug'=v_company->>'default_project_slug'),
        'settings',jsonb_build_object(
          'company_profile',jsonb_build_object('value',v_company_profile || COALESCE(p.value->'settings'->'company_profile','{}'::jsonb),'disposition',CASE WHEN EXISTS(SELECT 1 FROM public.project_settings ps WHERE ps.project_id=pr.id AND ps.key='company_profile') THEN 'reuse' ELSE 'create' END),
          'tenant_theme',jsonb_build_object('value',COALESCE(p.value->'settings'->'tenant_theme','{"site_experience":{"templateId":"wamule-classic","enabledModules":{"map":false,"inquiry":false,"application":false,"pricing":false}}}'::jsonb),'disposition',CASE WHEN EXISTS(SELECT 1 FROM public.project_settings ps WHERE ps.project_id=pr.id AND ps.key='tenant_theme') THEN 'reuse' ELSE 'create' END),
          'public_application',jsonb_build_object('value','{"applications_open":false,"show_lot_prices_publicly":false,"show_available_lot_count_publicly":false}'::jsonb || COALESCE(p.value->'settings'->'public_application','{}'::jsonb),'disposition',CASE WHEN EXISTS(SELECT 1 FROM public.project_settings ps WHERE ps.project_id=pr.id AND ps.key='public_application') THEN 'reuse' ELSE 'create' END)),
        'phases',(SELECT COALESCE(jsonb_agg(jsonb_build_object('slug',ph.value->>'slug','name',ph.value->>'name','id',dbph.id,'is_default',(ph.value->>'slug'=p.value->>'default_phase_slug'),
          'disposition',CASE WHEN dbph.id IS NULL THEN 'create' ELSE 'reuse' END) ORDER BY ph.value->>'slug'),'[]'::jsonb)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.value->'phases')='array' THEN p.value->'phases' ELSE '[]'::jsonb END) ph(value)
          LEFT JOIN public.development_phases dbph ON dbph.project_id=pr.id AND lower(dbph.slug)=lower(ph.value->>'slug')))
        ORDER BY p.value->>'slug'),'[]'::jsonb)
        FROM jsonb_array_elements(v_projects) p(value)
        LEFT JOIN public.projects pr ON pr.tenant_id=v_tenant_id AND lower(pr.slug)=lower(p.value->>'slug')),
      'company_settings',jsonb_build_object(
        'company_profile',jsonb_build_object('value',v_company_profile,'disposition',CASE WHEN EXISTS(SELECT 1 FROM public.business_settings b WHERE b.tenant_id=v_tenant_id AND b.key='company_profile') THEN 'reuse' ELSE 'create' END),
        'reservation_workflow_settings',jsonb_build_object('value',v_reservation_settings,'disposition',CASE WHEN EXISTS(SELECT 1 FROM public.business_settings b WHERE b.tenant_id=v_tenant_id AND b.key='reservation_workflow_settings') THEN 'reuse' ELSE 'create' END),
        'public_application',jsonb_build_object('value','{"applications_open":false,"show_lot_prices_publicly":false,"show_available_lot_count_publicly":false}'::jsonb,'disposition',CASE WHEN EXISTS(SELECT 1 FROM public.business_settings b WHERE b.tenant_id=v_tenant_id AND b.key='public_application') THEN 'reuse' ELSE 'create' END)),
      'users',v_users_plan,
      'settings',jsonb_build_object('tenant_applications_open',false,'project_applications_open',false,'legacy_application_page_guaranteed_closed',false),
      'conflicts',v_conflicts,'missing_prerequisites',v_missing,
      'readiness',jsonb_build_object('workspace_creation',v_can_apply,'membership_ready',v_default_membership,'usable_workspace_ready',false,
        'usable_workspace_blockers',CASE WHEN v_default_membership THEN jsonb_build_array(jsonb_build_object('code','SIGN_IN_VERIFICATION_PENDING_M4_3')) ELSE v_missing END,
        'sales_setup_ready',false,'sales_setup_blockers',jsonb_build_array(jsonb_build_object('code','EMPTY_INVENTORY_BY_DESIGN'),jsonb_build_object('code','PAYMENT_AND_PRICING_SETUP_REQUIRES_REVIEW')),
        'map_publication_ready',false,'map_publication_blockers',v_public_blockers || jsonb_build_array(jsonb_build_object('code','NO_PUBLISHED_MAP_PACKAGE')),
        'domain_ready',false,'domain_blockers',jsonb_build_array(jsonb_build_object('code','DOMAIN_WORK_IS_OUT_OF_SCOPE')),
        'public_blockers',v_public_blockers,'sales_note','Sales creates no inventory; configure inventory and pricing in later reviewed workflows.'));
  END IF;

  -- Transactional apply. Every input and conflict was checked above before the
  -- first write. Any later constraint/trigger failure aborts this whole RPC.
  SELECT o.id INTO v_tenant_id FROM public.organizations o WHERE lower(o.slug)=lower(v_company->>'slug') FOR UPDATE;
  IF v_tenant_id IS NULL THEN
    INSERT INTO public.organizations(name,slug,is_active) VALUES (btrim(v_company->>'name'),v_company->>'slug',true) RETURNING id INTO v_tenant_id;
    v_tenant_created:=true;
  END IF;

  INSERT INTO public.business_settings(tenant_id,key,value)
  VALUES (v_tenant_id,'company_profile',v_company_profile) ON CONFLICT (tenant_id,key) DO NOTHING;
  INSERT INTO audit_private.verified_operation_context(backend_pid,transaction_id,purpose,actor_id,target_tenant_id)
  VALUES(pg_catalog.pg_backend_pid(),pg_catalog.txid_current(),'workspace_provisioning',NULL,v_tenant_id);
  INSERT INTO public.business_settings(tenant_id,key,value)
  VALUES (v_tenant_id,'reservation_workflow_settings',v_reservation_settings) ON CONFLICT (tenant_id,key) DO NOTHING;
  DELETE FROM audit_private.verified_operation_context
  WHERE backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.txid_current() AND purpose='workspace_provisioning';
  INSERT INTO public.business_settings(tenant_id,key,value)
  VALUES (v_tenant_id,'public_application','{"applications_open":false,"show_lot_prices_publicly":false,"show_available_lot_count_publicly":false}'::jsonb)
  ON CONFLICT (tenant_id,key) DO NOTHING;
  IF EXISTS (SELECT 1 FROM public.business_settings b WHERE b.tenant_id=v_tenant_id AND b.key='company_profile' AND b.value IS DISTINCT FROM v_company_profile)
     OR EXISTS (SELECT 1 FROM public.business_settings b WHERE b.tenant_id=v_tenant_id AND b.key='reservation_workflow_settings' AND b.value IS DISTINCT FROM v_reservation_settings)
     OR EXISTS (SELECT 1 FROM public.business_settings b WHERE b.tenant_id=v_tenant_id AND b.key='public_application'
       AND (b.value->>'applications_open' IS DISTINCT FROM 'false' OR b.value->>'show_lot_prices_publicly' IS DISTINCT FROM 'false' OR b.value->>'show_available_lot_count_publicly' IS DISTINCT FROM 'false')) THEN
    RAISE EXCEPTION 'Provisioning settings changed during apply; transaction rolled back.' USING ERRCODE='40001';
  END IF;

  FOR v_project IN SELECT p.value FROM jsonb_array_elements(v_projects) p(value) ORDER BY (p.value->>'slug'=v_company->>'default_project_slug') DESC, p.value->>'slug' LOOP
    v_slug:=v_project->>'slug';
    v_project_created:=false;
    v_project_id:=NULL;
    SELECT p.id INTO v_project_id FROM public.projects p WHERE p.tenant_id=v_tenant_id AND lower(p.slug)=lower(v_slug) FOR UPDATE;
    IF v_project_id IS NULL THEN
      INSERT INTO public.projects(tenant_id,slug,name,is_default,map_experience_mode)
      VALUES(v_tenant_id,v_slug,btrim(v_project->>'name'),(v_slug=v_company->>'default_project_slug'),v_project->>'mode')
      RETURNING id INTO v_project_id;
      v_project_created:=true;
    ELSIF v_slug=v_company->>'default_project_slug' AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.tenant_id=v_tenant_id AND p.is_default) THEN
      UPDATE public.projects SET is_default=true WHERE id=v_project_id;
    END IF;

    v_project_settings:=COALESCE(v_project->'settings','{}'::jsonb);
    v_project_profile:=v_company_profile || COALESCE(v_project_settings->'company_profile','{}'::jsonb);
    v_theme:=COALESCE(v_project_settings->'tenant_theme','{"site_experience":{"templateId":"wamule-classic","enabledModules":{"map":false,"inquiry":false,"application":false,"pricing":false}}}'::jsonb);
    v_public_application:='{"applications_open":false,"show_lot_prices_publicly":false,"show_available_lot_count_publicly":false}'::jsonb || COALESCE(v_project_settings->'public_application','{}'::jsonb);
    INSERT INTO public.project_settings(tenant_id,project_id,key,value) VALUES(v_tenant_id,v_project_id,'company_profile',v_project_profile) ON CONFLICT(project_id,key) DO NOTHING;
    INSERT INTO public.project_settings(tenant_id,project_id,key,value) VALUES(v_tenant_id,v_project_id,'tenant_theme',v_theme) ON CONFLICT(project_id,key) DO NOTHING;
    INSERT INTO public.project_settings(tenant_id,project_id,key,value) VALUES(v_tenant_id,v_project_id,'public_application',v_public_application) ON CONFLICT(project_id,key) DO NOTHING;
    IF EXISTS (SELECT 1 FROM public.project_settings ps WHERE ps.project_id=v_project_id AND ps.key='company_profile' AND ps.value IS DISTINCT FROM v_project_profile)
       OR EXISTS (SELECT 1 FROM public.project_settings ps WHERE ps.project_id=v_project_id AND ps.key='tenant_theme' AND ps.value IS DISTINCT FROM v_theme)
       OR EXISTS (SELECT 1 FROM public.project_settings ps WHERE ps.project_id=v_project_id AND ps.key='public_application' AND ps.value IS DISTINCT FROM v_public_application) THEN
      RAISE EXCEPTION 'Project settings changed during apply; transaction rolled back.' USING ERRCODE='40001';
    END IF;

    v_phase_result:='[]'::jsonb;
    FOR v_phase IN SELECT ph.value FROM jsonb_array_elements(v_project->'phases') ph(value) ORDER BY (ph.value->>'slug'=v_project->>'default_phase_slug') DESC, ph.value->>'slug' LOOP
      v_phase_slug:=v_phase->>'slug';
      v_phase_created:=false;
      v_phase_id:=NULL;
      SELECT ph.id INTO v_phase_id FROM public.development_phases ph WHERE ph.tenant_id=v_tenant_id AND ph.project_id=v_project_id AND lower(ph.slug)=lower(v_phase_slug) FOR UPDATE;
      IF v_phase_id IS NULL THEN
        INSERT INTO public.development_phases(tenant_id,project_id,slug,name,is_default,is_active)
        VALUES(v_tenant_id,v_project_id,v_phase_slug,btrim(v_phase->>'name'),(v_phase_slug=v_project->>'default_phase_slug'),true)
        RETURNING id INTO v_phase_id;
        v_phase_created:=true;
      ELSIF v_phase_slug=v_project->>'default_phase_slug' AND NOT EXISTS (SELECT 1 FROM public.development_phases ph WHERE ph.project_id=v_project_id AND ph.is_default) THEN
        UPDATE public.development_phases SET is_default=true WHERE id=v_phase_id;
      END IF;
      v_phase_result:=v_phase_result || jsonb_build_array(jsonb_build_object('slug',v_phase_slug,'name',v_phase->>'name','id',v_phase_id,
        'is_default',(v_phase_slug=v_project->>'default_phase_slug'),'disposition',CASE WHEN v_phase_created THEN 'created' ELSE 'reused' END));
    END LOOP;
    v_projects_result:=v_projects_result || jsonb_build_array(jsonb_build_object('slug',v_slug,'name',v_project->>'name','mode',v_project->>'mode','id',v_project_id,
      'is_default',(v_slug=v_company->>'default_project_slug'),'disposition',CASE WHEN v_project_created THEN 'created' ELSE 'reused' END,'phases',v_phase_result));
  END LOOP;

  -- Existing Auth accounts only. Auth user creation/invites and sign-in
  -- verification are intentionally deferred to M4.3.
  FOR v_user IN SELECT u.value FROM jsonb_array_elements(v_users) u(value) LOOP
    v_user_id:=(v_user->>'auth_user_id')::uuid;
    v_profile_role:=v_user->>'profile_role';
    SELECT ap.role::text INTO v_existing_role FROM public.admin_profiles ap WHERE ap.user_id=v_user_id FOR UPDATE;
    v_profile_created:=false;
    IF NOT FOUND THEN
      SELECT u.email,COALESCE(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name','') INTO v_auth_email,v_auth_name FROM auth.users u WHERE u.id=v_user_id;
      IF v_profile_role='Read Only' THEN
        INSERT INTO public.admin_profiles(user_id,email,full_name,role,tenant_id) VALUES(v_user_id,lower(btrim(v_auth_email)),COALESCE(NULLIF(btrim(v_auth_name),''),btrim(v_auth_email)),'Read Only',v_tenant_id);
      ELSE
        INSERT INTO public.admin_profiles(user_id,email,full_name,role,tenant_id) VALUES(v_user_id,lower(btrim(v_auth_email)),COALESCE(NULLIF(btrim(v_auth_name),''),btrim(v_auth_email)),'Staff',v_tenant_id);
      END IF;
      v_profile_created:=true;
    END IF;
    v_membership_result:='[]'::jsonb;
    FOR v_membership IN SELECT m.value FROM jsonb_array_elements(v_user->'memberships') m(value) LOOP
      v_member_role:=v_membership->>'member_role';
      SELECT p.id INTO v_project_id FROM public.projects p WHERE p.tenant_id=v_tenant_id AND p.slug=v_membership->>'project_slug';
      IF v_membership->>'all_phases'='true' THEN
        SELECT pm.id INTO v_phase_id FROM public.project_memberships pm WHERE pm.tenant_id=v_tenant_id AND pm.project_id=v_project_id AND pm.user_id=v_user_id AND pm.phase_id IS NULL AND pm.member_role=v_member_role;
        v_membership_created:=false;
        IF v_phase_id IS NULL THEN
          INSERT INTO public.project_memberships(tenant_id,project_id,phase_id,user_id,member_role)
          VALUES(v_tenant_id,v_project_id,NULL,v_user_id,v_member_role) RETURNING id INTO v_phase_id;
          v_membership_created:=true;
        END IF;
        v_membership_result:=v_membership_result || jsonb_build_array(jsonb_build_object('project_slug',v_membership->>'project_slug','project_id',v_project_id,'all_phases',true,'member_role',v_member_role,'id',v_phase_id,'disposition',CASE WHEN v_membership_created THEN 'created' ELSE 'reused' END));
      ELSE
        FOR v_phase_slug IN SELECT jsonb_array_elements_text(v_membership->'phase_slugs') LOOP
          SELECT ph.id INTO v_membership_phase_id FROM public.development_phases ph WHERE ph.project_id=v_project_id AND ph.slug=v_phase_slug;
          SELECT pm.id INTO v_phase_id FROM public.project_memberships pm WHERE pm.tenant_id=v_tenant_id AND pm.project_id=v_project_id AND pm.phase_id=v_membership_phase_id AND pm.user_id=v_user_id AND pm.member_role=v_member_role;
          v_membership_created:=false;
          IF v_phase_id IS NULL THEN
            INSERT INTO public.project_memberships(tenant_id,project_id,phase_id,user_id,member_role)
            VALUES(v_tenant_id,v_project_id,v_membership_phase_id,v_user_id,v_member_role)
            RETURNING id INTO v_phase_id;
            v_membership_created:=true;
          END IF;
          v_membership_result:=v_membership_result || jsonb_build_array(jsonb_build_object('project_slug',v_membership->>'project_slug','project_id',v_project_id,'phase_slug',v_phase_slug,'phase_id',v_membership_phase_id,'member_role',v_member_role,'id',v_phase_id,'disposition',CASE WHEN v_membership_created THEN 'created' ELSE 'reused' END));
        END LOOP;
      END IF;
    END LOOP;
    v_user_result:=v_user_result || jsonb_build_array(jsonb_build_object('auth_user_id',v_user_id,'profile_id',v_user_id,'profile_role',v_profile_role,'profile_disposition',CASE WHEN v_profile_created THEN 'created' ELSE 'reused' END,'memberships',v_membership_result));
  END LOOP;

  SELECT o.id INTO v_tenant_id FROM public.organizations o WHERE lower(o.slug)=lower(v_company->>'slug');
  v_readiness:=jsonb_build_object(
    'workspace_creation',true,
    'membership_ready',v_default_membership,
    'usable_workspace_ready',false,
    'usable_workspace_blockers',CASE WHEN v_default_membership THEN jsonb_build_array(jsonb_build_object('code','SIGN_IN_VERIFICATION_PENDING_M4_3')) ELSE v_missing END,
    'sales_setup_ready',false,
    'sales_setup_blockers',jsonb_build_array(jsonb_build_object('code','EMPTY_INVENTORY_BY_DESIGN'),jsonb_build_object('code','PAYMENT_AND_PRICING_SETUP_REQUIRES_REVIEW')),
    'map_publication_ready',false,
    'map_publication_blockers',v_public_blockers || jsonb_build_array(jsonb_build_object('code','NO_PUBLISHED_MAP_PACKAGE')),
    'domain_ready',false,
    'domain_blockers',jsonb_build_array(jsonb_build_object('code','DOMAIN_WORK_IS_OUT_OF_SCOPE'))
  );
  v_result:=jsonb_build_object(
    'status','applied','can_apply',true,'writes',1,'operation_id',v_operation_id,
    'company',jsonb_build_object('id',v_tenant_id,'slug',v_company->>'slug','name',v_company->>'name','disposition',CASE WHEN v_tenant_created THEN 'created' ELSE 'reused' END),
    'projects',v_projects_result,'users',v_user_result,
    'settings',jsonb_build_object('tenant_applications_open',false,'project_applications_open',false,'project_application_source','project_settings','legacy_application_page_guaranteed_closed',false),
    'conflicts','[]'::jsonb,'missing_prerequisites',v_missing,'readiness',v_readiness
  );
  INSERT INTO public.audit_events(tenant_id,target_tenant_id,target_project_id,target_phase_id,entity_type,action,title,summary,metadata,actor_kind)
  VALUES(v_tenant_id,v_tenant_id,NULL,NULL,'system','created','Workspace provisioned','A verified service operation created or reused a company workspace.',
    jsonb_build_object('event_code','tenant_workspace_provisioned','source','tenant_provisioning','operation_id',v_operation_id,'project_count',jsonb_array_length(v_projects),'user_assignment_count',jsonb_array_length(v_users)),'service');
  INSERT INTO provisioning_private.operation_results(operation_id,payload_hash,tenant_id,result)
  VALUES(v_operation_id,v_payload_hash,v_tenant_id,v_result);
  RETURN v_result;
END;
$function$;

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
  v_request_role text := COALESCE(NULLIF(auth.jwt()->>'role', ''), NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''));
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
  IF COALESCE(NULLIF(auth.jwt()->>'role', ''), NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')) IS DISTINCT FROM 'service_role' THEN
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
  IF COALESCE(NULLIF(auth.jwt()->>'role', ''), NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')) IS DISTINCT FROM 'service_role' THEN
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
  v_request_role text := COALESCE(NULLIF(auth.jwt()->>'role', ''), NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''));
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

CREATE OR REPLACE FUNCTION public.manage_workspace_member(
  p_target_user_id uuid,
  p_tenant_id uuid,
  p_profile_role text,
  p_memberships jsonb,
  p_email text DEFAULT NULL,
  p_full_name text DEFAULT NULL,
  p_actor_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_request_role text := COALESCE(NULLIF(auth.jwt()->>'role', ''), NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''));
  v_actor_id uuid;
  v_result jsonb;
  v_previous_role text;
  v_membership_count integer;
BEGIN
  IF v_request_role = 'authenticated' THEN
    v_actor_id := auth.uid();
    IF v_actor_id IS NULL OR (p_actor_id IS NOT NULL AND p_actor_id IS DISTINCT FROM v_actor_id) THEN
      RAISE EXCEPTION 'The authenticated actor cannot be supplied or overridden by the caller.';
    END IF;
  ELSIF v_request_role = 'service_role' THEN
    v_actor_id := p_actor_id;
    IF v_actor_id IS NULL THEN
      RAISE EXCEPTION 'A trusted server call must identify the human actor verified from its bearer token.';
    END IF;
  ELSE
    RAISE EXCEPTION 'Only an authenticated administrator may manage workspace access.';
  END IF;

  SELECT ap.role::text INTO v_previous_role FROM public.admin_profiles AS ap
  WHERE ap.user_id = p_target_user_id;
  SELECT count(*) INTO v_membership_count FROM public.project_memberships AS pm
  WHERE pm.user_id = p_target_user_id AND pm.tenant_id = p_tenant_id;

  v_result := public.manage_workspace_member_unlogged(
    p_target_user_id, p_tenant_id, p_profile_role, p_memberships,
    p_email, p_full_name, p_actor_id
  );

  INSERT INTO audit_private.verified_operation_context(
    backend_pid, transaction_id, purpose, actor_id, target_tenant_id
  ) VALUES (
    pg_catalog.pg_backend_pid(), pg_catalog.txid_current(), 'workspace_member', v_actor_id, p_tenant_id
  );

  INSERT INTO public.audit_events(
    tenant_id, target_tenant_id, entity_type, entity_id, action, title, summary,
    before_data, after_data, metadata, actor_user_id
  ) VALUES (
    p_tenant_id, p_tenant_id, 'user', p_target_user_id::text, 'updated',
    'Workspace membership changed',
    'A workspace profile role and its project memberships were updated atomically.',
    CASE WHEN v_previous_role IS NULL THEN NULL ELSE jsonb_build_object('role', v_previous_role) END,
    jsonb_build_object('role', p_profile_role),
    jsonb_build_object('membership_count', jsonb_array_length(COALESCE(p_memberships, '[]'::jsonb))),
    v_actor_id
  );
  RETURN v_result;
END;
$function$;


-- The authenticated assignment wrapper calls this internal routine.
CREATE OR REPLACE FUNCTION public.manage_workspace_member_unlogged(
  p_target_user_id uuid,
  p_tenant_id uuid,
  p_profile_role text,
  p_memberships jsonb,
  p_email text DEFAULT NULL,
  p_full_name text DEFAULT NULL,
  p_actor_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor_id uuid;
  v_request_role text;
  v_actor_role text;
  v_actor_tenant uuid;
  v_target_role text;
  v_target_tenant uuid;
  v_profile_exists boolean := false;
  v_auth_email text;
  v_auth_full_name text;
  v_tenant_active boolean;
  v_membership jsonb;
  v_project_id uuid;
  v_phase_id uuid;
  v_member_role text;
  v_input_member_role text;
  v_all_phase_confirmed boolean;
  v_phase_active boolean;
  v_profile_row public.admin_profiles%ROWTYPE;
  v_return_memberships jsonb;
BEGIN
  IF p_target_user_id IS NULL OR p_tenant_id IS NULL OR p_profile_role IS NULL
     OR p_profile_role NOT IN ('Super Admin', 'Admin', 'Staff', 'Read Only')
     OR jsonb_typeof(COALESCE(p_memberships, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'A target user, verified tenant, valid profile role, and membership array are required.';
  END IF;

  v_request_role := COALESCE(NULLIF(auth.jwt()->>'role', ''), NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''));
  IF v_request_role = 'authenticated' THEN
    v_actor_id := auth.uid();
    IF v_actor_id IS NULL OR (p_actor_id IS NOT NULL AND p_actor_id IS DISTINCT FROM v_actor_id) THEN
      RAISE EXCEPTION 'The authenticated actor cannot be supplied or overridden by the caller.';
    END IF;
  ELSIF v_request_role = 'service_role' THEN
    v_actor_id := p_actor_id;
    IF v_actor_id IS NULL THEN
      RAISE EXCEPTION 'A trusted server call must identify the human actor verified from its bearer token.';
    END IF;
  ELSE
    RAISE EXCEPTION 'Only an authenticated administrator may manage workspace access.';
  END IF;

  -- Serialize access updates for one target and protect authorization against
  -- a concurrent role demotion of the actor.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('workspace-member:' || p_target_user_id::text, 0)
  );

  SELECT ap.role::text, ap.tenant_id
    INTO v_actor_role, v_actor_tenant
  FROM public.admin_profiles ap
  WHERE ap.user_id = v_actor_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The acting account has no active Wamule administrator profile.';
  END IF;
  IF v_actor_id = p_target_user_id THEN
    RAISE EXCEPTION 'Administrators cannot change their own profile role or memberships.';
  END IF;

  SELECT o.is_active INTO v_tenant_active
  FROM public.organizations o
  WHERE o.id = p_tenant_id
  FOR SHARE;
  IF NOT FOUND OR NOT v_tenant_active THEN
    RAISE EXCEPTION 'The target tenant does not exist or is inactive.';
  END IF;

  IF v_actor_role = 'Super Admin' THEN
    NULL;
  ELSIF v_actor_role = 'Admin' AND v_actor_tenant = p_tenant_id THEN
    IF p_profile_role NOT IN ('Staff', 'Read Only') THEN
      RAISE EXCEPTION 'A Tenant Admin may assign only Staff or Read Only profiles in its own tenant.';
    END IF;
  ELSE
    RAISE EXCEPTION 'The actor is not authorized to administer this tenant.';
  END IF;

  SELECT ap.role::text, ap.tenant_id
    INTO v_target_role, v_target_tenant
  FROM public.admin_profiles ap
  WHERE ap.user_id = p_target_user_id
  FOR UPDATE;
  v_profile_exists := FOUND;

  IF v_profile_exists THEN
    IF v_target_tenant IS NOT NULL
       AND v_target_tenant IS DISTINCT FROM p_tenant_id
       AND p_profile_role <> 'Super Admin' THEN
      RAISE EXCEPTION 'An ordinary account cannot be transferred between tenants.';
    END IF;
    IF v_actor_role = 'Admin' AND v_target_role NOT IN ('Staff', 'Read Only') THEN
      RAISE EXCEPTION 'A Tenant Admin may not change an existing Admin or Super Admin profile.';
    END IF;
  END IF;

  IF p_profile_role = 'Super Admin' AND v_actor_role <> 'Super Admin' THEN
    RAISE EXCEPTION 'Only a Super Admin may appoint a Super Admin.';
  END IF;
  IF p_profile_role = 'Admin' AND v_actor_role <> 'Super Admin' THEN
    RAISE EXCEPTION 'Only a Super Admin may appoint a Tenant Admin.';
  END IF;
  IF p_profile_role = 'Super Admin' AND jsonb_array_length(COALESCE(p_memberships, '[]'::jsonb)) <> 0 THEN
    RAISE EXCEPTION 'A Super Admin profile does not receive tenant project memberships.';
  END IF;

  IF v_target_role = 'Super Admin'
     AND p_profile_role <> 'Super Admin'
     AND NOT EXISTS (
       SELECT 1 FROM public.admin_profiles ap
       WHERE ap.role::text = 'Super Admin' AND ap.user_id <> p_target_user_id
     ) THEN
    RAISE EXCEPTION 'The last Super Admin cannot be demoted.';
  END IF;

  SELECT lower(u.email),
         COALESCE(NULLIF(btrim(u.raw_user_meta_data->>'full_name'), ''),
                  NULLIF(btrim(u.raw_user_meta_data->>'name'), ''), '')
    INTO v_auth_email, v_auth_full_name
  FROM auth.users u
  WHERE u.id = p_target_user_id;
  IF NOT FOUND OR NULLIF(btrim(v_auth_email), '') IS NULL THEN
    RAISE EXCEPTION 'The target account must already exist in Auth and have an email.';
  END IF;
  IF p_email IS NOT NULL AND lower(btrim(p_email)) IS DISTINCT FROM v_auth_email THEN
    RAISE EXCEPTION 'The supplied email must match the target Auth account.';
  END IF;

  IF p_profile_role <> 'Super Admin'
     AND EXISTS (
       SELECT 1 FROM public.project_memberships m
       WHERE m.user_id = p_target_user_id AND m.tenant_id <> p_tenant_id
     ) THEN
    RAISE EXCEPTION 'The account has memberships outside its profile tenant; review those assignments before changing access.';
  END IF;

  -- Validate the entire replacement set before any profile or membership row
  -- changes. Multiple exact phase rows are valid; all-phase + exact overlap is
  -- not. Existing all-phase grants may be retained without silently creating
  -- a new broad grant.
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(COALESCE(p_memberships, '[]'::jsonb))
      AS requested(project_id uuid, phase_id uuid, member_role text)
    GROUP BY requested.project_id
    HAVING count(*) FILTER (WHERE requested.phase_id IS NULL) > 0
       AND count(*) FILTER (WHERE requested.phase_id IS NOT NULL) > 0
  ) THEN
    RAISE EXCEPTION 'A project cannot combine an all-phase assignment with phase-specific assignments.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(COALESCE(p_memberships, '[]'::jsonb))
      AS requested(project_id uuid, phase_id uuid, member_role text)
    GROUP BY requested.project_id, requested.phase_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'The membership list contains a duplicate project/phase assignment.';
  END IF;

  FOR v_membership IN
    SELECT item.value FROM jsonb_array_elements(COALESCE(p_memberships, '[]'::jsonb)) item(value)
  LOOP
    v_project_id := NULLIF(v_membership->>'project_id', '')::uuid;
    v_phase_id := NULLIF(v_membership->>'phase_id', '')::uuid;
    v_input_member_role := lower(COALESCE(v_membership->>'member_role', ''));
    v_all_phase_confirmed := COALESCE((v_membership->>'all_phases_confirmed')::boolean, false);

    IF v_project_id IS NULL OR v_input_member_role NOT IN ('owner', 'admin', 'staff', 'read_only') THEN
      RAISE EXCEPTION 'Each assignment requires a project and a valid membership role.';
    END IF;
    IF p_profile_role = 'Read Only' THEN
      v_member_role := 'read_only';
    ELSIF p_profile_role = 'Staff' AND v_input_member_role IN ('owner', 'admin') THEN
      -- Strip stale project-manager labels on demotion. A Staff profile may
      -- still do Staff operations in this assigned scope, never project admin.
      v_member_role := 'staff';
    ELSE
      v_member_role := v_input_member_role;
    END IF;
    IF v_actor_role = 'Admin' AND v_member_role NOT IN ('staff', 'read_only') THEN
      RAISE EXCEPTION 'A Tenant Admin may assign only Staff or Read Only membership roles.';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = v_project_id AND p.tenant_id = p_tenant_id
    ) THEN
      RAISE EXCEPTION 'Every project assignment must belong to the selected tenant.';
    END IF;

    IF v_phase_id IS NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.project_memberships existing
        WHERE existing.user_id = p_target_user_id
          AND existing.tenant_id = p_tenant_id
          AND existing.project_id = v_project_id
          AND existing.phase_id IS NULL
      ) AND NOT v_all_phase_confirmed THEN
        RAISE EXCEPTION 'Granting all current and future phases requires explicit confirmation.';
      END IF;
    ELSE
      SELECT ph.is_active INTO v_phase_active
      FROM public.development_phases ph
      WHERE ph.id = v_phase_id
        AND ph.project_id = v_project_id
        AND ph.tenant_id = p_tenant_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Every phase assignment must belong to the selected project and tenant.';
      END IF;
      IF NOT v_phase_active AND NOT EXISTS (
        SELECT 1 FROM public.project_memberships existing
        WHERE existing.user_id = p_target_user_id
          AND existing.tenant_id = p_tenant_id
          AND existing.project_id = v_project_id
          AND existing.phase_id = v_phase_id
      ) THEN
        RAISE EXCEPTION 'New assignments can be made only to an active phase.';
      END IF;
    END IF;
  END LOOP;

  IF v_profile_exists THEN
    UPDATE public.admin_profiles
    SET email = v_auth_email,
        full_name = COALESCE(NULLIF(btrim(p_full_name), ''), full_name, NULLIF(v_auth_full_name, ''), ''),
        role = p_profile_role::public.app_role,
        tenant_id = CASE WHEN p_profile_role = 'Super Admin' THEN NULL ELSE p_tenant_id END,
        updated_at = pg_catalog.now()
    WHERE user_id = p_target_user_id
    RETURNING * INTO v_profile_row;
  ELSE
    INSERT INTO public.admin_profiles(user_id, email, full_name, role, tenant_id)
    VALUES (
      p_target_user_id,
      v_auth_email,
      COALESCE(NULLIF(btrim(p_full_name), ''), NULLIF(v_auth_full_name, ''), ''),
      p_profile_role::public.app_role,
      CASE WHEN p_profile_role = 'Super Admin' THEN NULL ELSE p_tenant_id END
    )
    RETURNING * INTO v_profile_row;
  END IF;

  DELETE FROM public.project_memberships
  WHERE user_id = p_target_user_id;

  FOR v_membership IN
    SELECT item.value FROM jsonb_array_elements(COALESCE(p_memberships, '[]'::jsonb)) item(value)
  LOOP
    v_project_id := NULLIF(v_membership->>'project_id', '')::uuid;
    v_phase_id := NULLIF(v_membership->>'phase_id', '')::uuid;
    v_input_member_role := lower(COALESCE(v_membership->>'member_role', ''));
    IF p_profile_role = 'Read Only' THEN
      v_member_role := 'read_only';
    ELSIF p_profile_role = 'Staff' AND v_input_member_role IN ('owner', 'admin') THEN
      v_member_role := 'staff';
    ELSE
      v_member_role := v_input_member_role;
    END IF;
    INSERT INTO public.project_memberships(tenant_id, project_id, phase_id, user_id, member_role, created_by)
    VALUES (p_tenant_id, v_project_id, v_phase_id, p_target_user_id, v_member_role, v_actor_id);
  END LOOP;

  SELECT COALESCE(
    jsonb_agg(jsonb_build_object(
      'tenant_id', m.tenant_id,
      'project_id', m.project_id,
      'phase_id', m.phase_id,
      'member_role', m.member_role
    ) ORDER BY m.project_id, m.phase_id NULLS FIRST),
    '[]'::jsonb
  ) INTO v_return_memberships
  FROM public.project_memberships m
  WHERE m.user_id = p_target_user_id;

  RETURN jsonb_build_object(
    'profile', jsonb_build_object(
      'user_id', v_profile_row.user_id,
      'tenant_id', v_profile_row.tenant_id,
      'role', v_profile_row.role::text,
      'email', v_profile_row.email,
      'full_name', v_profile_row.full_name
    ),
    'memberships', v_return_memberships
  );
END;
$function$;
