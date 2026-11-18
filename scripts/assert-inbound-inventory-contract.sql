-- Run only on the disposable schema replay.
BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO public.organizations(id, name, slug, is_active) VALUES
  ('d8100000-0000-4000-8000-000000000001', 'Inventory Fixture Tenant', 'inventory-fixture', true),
  ('d8100000-0000-4000-8000-000000000002', 'Second Fixture Tenant', 'second-inventory-fixture', true);

INSERT INTO public.organization_secret_refs(tenant_id, purpose, vault_secret_id)
VALUES (
  'd8100000-0000-4000-8000-000000000001',
  'gemini_api_key',
  vault.create_secret('test-only-credential', 'wamule-schema-contract-local-fixture', 'Disposable RPC contract fixture')
);

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.get_organization_gemini_api_key(uuid)', 'execute')
    OR has_function_privilege('authenticated', 'public.get_organization_gemini_api_key(uuid)', 'execute') THEN
    RAISE EXCEPTION 'A public or browser role can execute the tenant credential lookup';
  END IF;
END;
$$;

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
DO $$
BEGIN
  IF public.get_organization_gemini_api_key('d8100000-0000-4000-8000-000000000001') IS DISTINCT FROM 'test-only-credential'
    OR public.get_organization_gemini_api_key('d8100000-0000-4000-8000-000000000002') IS NOT NULL THEN
    RAISE EXCEPTION 'Service lookup did not return the credential for only the requested tenant';
  END IF;
END;
$$;
RESET ROLE;

INSERT INTO public.projects(id, tenant_id, slug, name, is_default, map_experience_mode) VALUES
  ('d8200000-0000-4000-8000-000000000001', 'd8100000-0000-4000-8000-000000000001', 'inventory-project', 'Inventory Project', true, 'sales');
INSERT INTO public.development_phases(id, tenant_id, project_id, slug, name, is_default, is_active) VALUES
  ('d8300000-0000-4000-8000-000000000001', 'd8100000-0000-4000-8000-000000000001', 'd8200000-0000-4000-8000-000000000001', 'default', 'Default', true, true);
INSERT INTO auth.users(id, email) VALUES
  ('d8400000-0000-4000-8000-000000000001', 'inventory-admin@example.invalid');
INSERT INTO public.admin_profiles(user_id, email, full_name, role, tenant_id) VALUES
  ('d8400000-0000-4000-8000-000000000001', 'inventory-admin@example.invalid', 'Inventory Fixture Admin', 'Admin', 'd8100000-0000-4000-8000-000000000001');

INSERT INTO public.parcels(id, lot_number, status, base_price, tenant_id, project_id, phase_id, geometry_source, needs_review)
OVERRIDING SYSTEM VALUE VALUES
  (981000001, 'FIXTURE-RASTER', 'Available', 25000, 'd8100000-0000-4000-8000-000000000001', 'd8200000-0000-4000-8000-000000000001', 'd8300000-0000-4000-8000-000000000001', 'raster-auto', false),
  (981000002, 'FIXTURE-REVIEW', 'Available', 25000, 'd8100000-0000-4000-8000-000000000001', 'd8200000-0000-4000-8000-000000000001', 'd8300000-0000-4000-8000-000000000001', 'manual', true),
  (981000003, 'FIXTURE-INVENTORY', 'Available', 25000, 'd8100000-0000-4000-8000-000000000001', 'd8200000-0000-4000-8000-000000000001', 'd8300000-0000-4000-8000-000000000001', 'manual', false);

-- Seed an existing application for approval without starting the lead workflow.
ALTER TABLE public.applications DISABLE TRIGGER trg_create_lead_from_application;
INSERT INTO public.applications(id, first_name, last_name, phone, tenant_id, project_id, phase_id, application_kind)
OVERRIDING SYSTEM VALUE VALUES
  (981000101, 'Synthetic', 'Applicant', '555-0101', 'd8100000-0000-4000-8000-000000000001', 'd8200000-0000-4000-8000-000000000001', 'd8300000-0000-4000-8000-000000000001', 'land_purchase');
ALTER TABLE public.applications ENABLE TRIGGER trg_create_lead_from_application;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'd8400000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"d8400000-0000-4000-8000-000000000001","role":"authenticated"}', true);
DO $$
DECLARE
  parcel_id bigint;
BEGIN
  FOREACH parcel_id IN ARRAY ARRAY[981000001, 981000002]::bigint[] LOOP
    BEGIN
      PERFORM public.approve_application(981000101, parcel_id);
      RAISE EXCEPTION 'Approval accepted a raster or review-pending parcel';
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM <> 'Only existing manual inventory records with a clear review flag can be selected.' THEN RAISE; END IF;
    END;
  END LOOP;
  PERFORM public.approve_application(981000101, 981000003);
END;
$$;

RESET ROLE;
DO $$
BEGIN
  IF (SELECT parcel_id FROM public.applications WHERE id = 981000101 AND status = 'Approved') IS DISTINCT FROM 981000003
    OR (SELECT status FROM public.parcels WHERE id = 981000003) IS DISTINCT FROM 'Reserved' THEN
    RAISE EXCEPTION 'A manual, reviewed inventory parcel did not complete approval';
  END IF;
END;
$$;
ROLLBACK;
