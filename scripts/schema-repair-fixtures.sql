-- Synthetic, disposable PostgreSQL fixture. The caller must use the local
-- Supabase database emitted by supabase status; this file must never run on a
-- hosted connection.
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.jwt.claim.sub', 'e4000000-0000-4000-8000-000000000002', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

INSERT INTO public.organizations(id, name, slug, is_active) VALUES
  ('e1000000-0000-4000-8000-000000000001', 'Schema Repair Synthetic A', 'schema-repair-a', true),
  ('e1000000-0000-4000-8000-000000000002', 'Schema Repair Synthetic B', 'schema-repair-b', true);

INSERT INTO public.projects(id, tenant_id, slug, name, is_default, map_experience_mode) VALUES
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'repair-project', 'Repair Project', true, 'sales');
INSERT INTO public.development_phases(id, tenant_id, project_id, slug, name, is_default, is_active) VALUES
  ('e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'north', 'North', true, true),
  ('e3000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'south', 'South', false, true);

INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
  ('e4000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'schema-repair-staff@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('e4000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'schema-repair-admin@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('e4000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'schema-repair-other-admin@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now());
INSERT INTO public.admin_profiles(user_id, email, full_name, role, tenant_id) VALUES
  ('e4000000-0000-4000-8000-000000000001', 'schema-repair-staff@example.invalid', 'Synthetic Phase Staff', 'Staff', 'e1000000-0000-4000-8000-000000000001'),
  ('e4000000-0000-4000-8000-000000000002', 'schema-repair-admin@example.invalid', 'Synthetic Tenant Admin', 'Admin', 'e1000000-0000-4000-8000-000000000001'),
  ('e4000000-0000-4000-8000-000000000003', 'schema-repair-other-admin@example.invalid', 'Synthetic Other Admin', 'Admin', 'e1000000-0000-4000-8000-000000000002');
INSERT INTO public.project_memberships(tenant_id, project_id, phase_id, user_id, member_role, created_by) VALUES
  ('e1000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'staff', 'e4000000-0000-4000-8000-000000000002');

INSERT INTO public.community_fee_settings(tenant_id, id, garbage_fee_amount, road_maintenance_amount, due_day) VALUES
  ('e1000000-0000-4000-8000-000000000001', true, 500, 200, 1),
  ('e1000000-0000-4000-8000-000000000002', true, 999, 888, 1);

INSERT INTO public.parcels(id, lot_number, status, base_price, tenant_id, project_id, phase_id)
OVERRIDING SYSTEM VALUE
VALUES (990000001, 'REPAIR-LOT-990000001', 'Available', 25000, 'e1000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001');
SELECT setval(pg_get_serial_sequence('public.parcels', 'id'), 990000001, true);

-- Model already-existing legacy application rows without creating live
-- lead/follow-up/email side effects for the seed records. All authorization,
-- tenant-defaulting, and application scope guards remain enabled.
ALTER TABLE public.applications DISABLE TRIGGER trg_create_lead_from_application;
INSERT INTO public.applications(id, first_name, last_name, phone, status, tenant_id, project_id, phase_id, application_kind)
OVERRIDING SYSTEM VALUE
VALUES
  (990000101, 'North', 'Applicant', '555-0101', 'Pending Review', 'e1000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'land_purchase'),
  (990000102, 'South', 'Applicant', '555-0102', 'Pending Review', 'e1000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002', 'land_purchase'),
  (990000103, 'Legacy', 'Applicant', '555-0103', 'Pending Review', 'e1000000-0000-4000-8000-000000000001', NULL, NULL, 'land_purchase'),
  (990000104, 'Fee', 'Customer', '555-0104', 'Pending Review', 'e1000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'land_purchase');
ALTER TABLE public.applications ENABLE TRIGGER trg_create_lead_from_application;
SELECT setval(pg_get_serial_sequence('public.applications', 'id'), 990000104, true);

-- The view fixture needs a contract-backed customer. Use the real authorized
-- approval operation so application/parcel/phase and customer provenance are
-- valid under M3.3/M7.4; this is synthetic local database state only.
SELECT setval(pg_get_serial_sequence('public.customers', 'id'), 990000000, true);
SELECT public.approve_application(990000104, 990000001);

INSERT INTO public.contracts(id, customer_id, parcel_id, final_purchase_price, initial_deposit, term_months, start_date, payment_due_day, is_active, status, tenant_id, project_id, phase_id, application_id, currency)
OVERRIDING SYSTEM VALUE
VALUES (990000001, 990000001, 990000001, 25000, 0, 24, current_date, 1, true, 'active', 'e1000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 990000104, 'BZD');
SELECT setval(pg_get_serial_sequence('public.contracts', 'id'), 990000001, true);

-- Complete and unscoped legacy records, plus deliberately conflicting parents
-- used to prove that the migration's conflict preflight rolls back atomically.
INSERT INTO public.leads(id, full_name, tenant_id, project_id, phase_id)
VALUES ('e6000000-0000-4000-8000-000000000002', 'Synthetic South Parent', 'e1000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002');
INSERT INTO public.post_sales_tasks(id, tenant_id, application_id, title, lead_id) VALUES
  ('e5000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 990000101, 'North task', NULL),
  ('e5000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 990000102, 'South task', NULL),
  ('e5000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000001', 990000103, 'Unscoped legacy task', NULL),
  ('e5000000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000001', 990000101, 'Conflicting task', 'e6000000-0000-4000-8000-000000000002');
INSERT INTO public.post_sales_checklists(id, tenant_id, application_id, status) VALUES
  ('e7000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 990000101, 'not_started'),
  ('e7000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 990000102, 'not_started'),
  ('e7000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000001', 990000103, 'not_started'),
  ('e7000000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000001', 990000101, 'in_progress');
UPDATE public.post_sales_checklists
SET lead_id = 'e6000000-0000-4000-8000-000000000002'
WHERE id = 'e7000000-0000-4000-8000-000000000004';

COMMIT;
