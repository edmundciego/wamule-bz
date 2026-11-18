-- Run after the migration replay in a disposable local database.
BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO public.organizations(id, name, slug, is_active) VALUES
  ('c8100000-0000-4000-8000-000000000001', 'Homepage Test Tenant', 'homepage-test-tenant', true),
  ('c8100000-0000-4000-8000-000000000002', 'Homepage Other Tenant', 'homepage-other-tenant', true);
INSERT INTO public.projects(id, tenant_id, slug, name, is_default, map_experience_mode) VALUES
  ('c8200000-0000-4000-8000-000000000001', 'c8100000-0000-4000-8000-000000000001', 'regular-test', 'Regular Test', true, 'sales'),
  ('c8200000-0000-4000-8000-000000000002', 'c8100000-0000-4000-8000-000000000001', 'hopkins-grove', 'Showcase Test', false, 'sales'),
  ('c8200000-0000-4000-8000-000000000003', 'c8100000-0000-4000-8000-000000000002', 'other-project', 'Other Project', true, 'sales');
INSERT INTO auth.users(id, email)
  VALUES ('c8300000-0000-4000-8000-000000000001', 'homepage-admin@example.invalid');
INSERT INTO public.admin_profiles(user_id, email, full_name, role, tenant_id)
  VALUES ('c8300000-0000-4000-8000-000000000001', 'homepage-admin@example.invalid', 'Homepage Test Admin', 'Admin', 'c8100000-0000-4000-8000-000000000001');
INSERT INTO public.project_settings(tenant_id, project_id, key, value)
  VALUES ('c8100000-0000-4000-8000-000000000001', 'c8200000-0000-4000-8000-000000000002', 'tenant_theme', '{"primaryColor":"#446655"}');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c8300000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"c8300000-0000-4000-8000-000000000001","role":"authenticated"}', true);

DO $$
DECLARE
  tenant_id constant uuid := 'c8100000-0000-4000-8000-000000000001';
  other_tenant_id constant uuid := 'c8100000-0000-4000-8000-000000000002';
  regular_id constant uuid := 'c8200000-0000-4000-8000-000000000001';
  showcase_id constant uuid := 'c8200000-0000-4000-8000-000000000002';
  other_project_id constant uuid := 'c8200000-0000-4000-8000-000000000003';
  regular_experience jsonb;
  showcase_experience jsonb;
BEGIN
  IF public.get_project_site_experience(tenant_id, showcase_id)->>'templateId' IS DISTINCT FROM 'wamule-classic' THEN
    RAISE EXCEPTION 'An unset template must use Regular regardless of the project slug';
  END IF;

  PERFORM public.save_project_site_experience(tenant_id, regular_id, 'wamule-classic', '{"map":true,"inquiry":false}');
  PERFORM public.save_project_site_experience(tenant_id, showcase_id, 'hopkins-project', '{"map":false,"inquiry":true}');
  regular_experience := public.get_project_site_experience(tenant_id, regular_id);
  showcase_experience := public.get_project_site_experience(tenant_id, showcase_id);
  IF regular_experience IS DISTINCT FROM '{"templateId":"wamule-classic","enabledModules":{"map":true,"inquiry":false,"application":true,"pricing":true}}'::jsonb
    OR showcase_experience IS DISTINCT FROM '{"templateId":"hopkins-project","enabledModules":{"map":false,"inquiry":true,"application":true,"pricing":true}}'::jsonb THEN
    RAISE EXCEPTION 'Project homepage choices and module flags did not reload independently';
  END IF;

  BEGIN
    PERFORM public.get_project_site_experience(other_tenant_id, other_project_id);
    RAISE EXCEPTION 'An admin was able to read another tenant''s homepage settings';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.save_project_site_experience(other_tenant_id, other_project_id, 'hopkins-project', '{}');
    RAISE EXCEPTION 'An admin was able to save another tenant''s homepage settings';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

RESET ROLE;
DO $$
BEGIN
  IF (SELECT value->>'primaryColor' FROM public.project_settings
       WHERE project_id = 'c8200000-0000-4000-8000-000000000002' AND key = 'tenant_theme') IS DISTINCT FROM '#446655' THEN
    RAISE EXCEPTION 'Saving a homepage replaced unrelated project theme settings';
  END IF;
  IF has_function_privilege('anon', 'public.get_project_site_experience(uuid,uuid)', 'execute')
    OR has_function_privilege('anon', 'public.save_project_site_experience(uuid,uuid,text,jsonb)', 'execute') THEN
    RAISE EXCEPTION 'Anonymous access to the homepage settings RPCs is enabled';
  END IF;
END;
$$;
ROLLBACK;
