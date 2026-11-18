-- M4.2: service-role-only multi-project onboarding, full preflight, and replay-safe apply.
-- This forward migration does not alter the existing Hopkins onboarding RPC or history.

BEGIN;

CREATE SCHEMA IF NOT EXISTS provisioning_private;
REVOKE ALL ON SCHEMA provisioning_private FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE provisioning_private.operation_results (
  operation_id uuid PRIMARY KEY,
  payload_hash text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE provisioning_private.operation_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE provisioning_private.operation_results FROM PUBLIC, anon, authenticated, service_role;

-- Deliberately empty until a versioned synthetic fixture pack has an approved
-- implementation and tests. A row alone never enables fixture loading.
CREATE TABLE provisioning_private.demo_fixture_registry (
  fixture_key text PRIMARY KEY,
  fixture_version integer NOT NULL CHECK (fixture_version > 0),
  enabled boolean NOT NULL DEFAULT false,
  CHECK (fixture_key ~ '^[a-z0-9][a-z0-9-]{0,62}$')
);
ALTER TABLE provisioning_private.demo_fixture_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE provisioning_private.demo_fixture_registry FROM PUBLIC, anon, authenticated, service_role;

-- Extend M3.5's private audit context only for this trusted provisioning
-- transaction. Human settings writes retain their verified user actor; this
-- new path explicitly records the provisioner as a service operation.
ALTER TABLE audit_private.verified_operation_context ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE audit_private.verified_operation_context DROP CONSTRAINT IF EXISTS verified_operation_context_purpose_check;
ALTER TABLE audit_private.verified_operation_context
  ADD CONSTRAINT verified_operation_context_purpose_check
  CHECK (purpose IN ('workspace_member','reservation_settings','workspace_provisioning'));

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
            AND NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '') = 'service_role')
      )
  ) THEN
    RAISE EXCEPTION 'Reservation workflow settings must be saved with an audited tenant operation.';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_reservation_workflow_setting_write() FROM PUBLIC, anon, authenticated, service_role;

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
  IF NULLIF(current_setting('request.jwt.claim.role', true), '') IS DISTINCT FROM 'service_role' THEN
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

REVOKE ALL ON FUNCTION public.provision_workspace_v1(jsonb,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_workspace_v1(jsonb,boolean) TO service_role;

COMMENT ON FUNCTION public.provision_workspace_v1(jsonb,boolean) IS
  'Service-role-only atomic company/project/phase provisioning. Dry-run is read-only; apply is all-or-nothing and operation-id replay-safe. Auth account creation and public publication are out of scope.';

COMMIT;
