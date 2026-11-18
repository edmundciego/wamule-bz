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
  VALUES ('c8100000-0000-4000-8000-000000000001', 'c8200000-0000-4000-8000-000000000002', 'tenant_theme',
    '{"primaryColor":"#446655","site_experience":{"uiRestrictedAccess":true}}');

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

  regular_experience := public.save_project_site_experience(tenant_id, regular_id, 'wamule-classic', '{"map":true,"inquiry":false}');
  showcase_experience := public.save_project_site_experience(
    p_tenant_id => tenant_id, p_project_id => showcase_id, p_template_id => 'hopkins-project',
    p_enabled_modules => '{"map":false,"inquiry":true}', p_headline => '  A   local project headline.  '
  );
  IF regular_experience IS DISTINCT FROM '{"templateId":"wamule-classic","headline":null,"uiRestrictedAccess":false,"enabledModules":{"map":true,"inquiry":false,"application":true,"pricing":true}}'::jsonb
    OR showcase_experience IS DISTINCT FROM '{"templateId":"hopkins-project","headline":"A local project headline.","uiRestrictedAccess":true,"enabledModules":{"map":false,"inquiry":true,"application":true,"pricing":true}}'::jsonb
    OR regular_experience IS DISTINCT FROM public.get_project_site_experience(tenant_id, regular_id)
    OR showcase_experience IS DISTINCT FROM public.get_project_site_experience(tenant_id, showcase_id) THEN
    RAISE EXCEPTION 'Project homepage settings did not save and reload independently';
  END IF;
  IF public.save_project_site_experience(tenant_id, showcase_id, 'hopkins-project', '{"map":false}', false)
      ->> 'headline' IS DISTINCT FROM 'A local project headline.' THEN
    RAISE EXCEPTION 'Saving from a legacy caller cleared the headline';
  END IF;
  IF public.save_project_site_experience(tenant_id, showcase_id, 'hopkins-project', '{"map":false}', p_headline => ' ')
      -> 'headline' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'Clearing the headline did not restore the default';
  END IF;
  BEGIN
    PERFORM public.save_project_site_experience(tenant_id, showcase_id, 'hopkins-project', '{}', p_headline => repeat('a', 121));
    RAISE EXCEPTION 'An oversized homepage headline was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

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
    OR has_function_privilege('anon', 'public.save_project_site_experience(uuid,uuid,text,jsonb,boolean,text)', 'execute') THEN
    RAISE EXCEPTION 'Anonymous access to the homepage settings RPCs is enabled';
  END IF;
  IF to_regprocedure('public.save_project_site_experience(uuid,uuid,text,jsonb)') IS NOT NULL
    OR to_regprocedure('public.save_project_site_experience(uuid,uuid,text,jsonb,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'Legacy homepage save overloads still exist';
  END IF;
END;
$$;
ROLLBACK;
