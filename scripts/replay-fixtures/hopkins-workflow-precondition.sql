-- Local-only fixture for the historical data precondition in migration
-- 20261016054341. It is deliberately not a numbered migration and is not
-- included in the captured 69-entry staging ledger.
BEGIN;

INSERT INTO public.organizations (id, name, slug, is_active)
VALUES (
  'd0000000-0000-4000-8000-000000000001',
  'Hopkins Grove (Local Replay Fixture)',
  'hopkins-grove',
  true
);

INSERT INTO public.projects (id, tenant_id, slug, name, is_default, map_experience_mode)
VALUES (
  'd0000000-0000-4000-8000-000000000002',
  'd0000000-0000-4000-8000-000000000001',
  'hopkins-grove',
  'Hopkins Grove project (Local Replay Fixture)',
  true,
  'sales'
);

INSERT INTO public.development_phases (id, tenant_id, project_id, slug, name, is_default, is_active)
VALUES (
  'd0000000-0000-4000-8000-000000000003',
  'd0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000002',
  'initial',
  'Initial phase (Local Replay Fixture)',
  true,
  true
);

COMMIT;
