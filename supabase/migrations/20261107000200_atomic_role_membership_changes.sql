-- M3.4: role and project/phase membership changes are one authorized operation.
-- All authorization is re-read from current database rows on every request.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- The old partial unique indexes allow a project-wide NULL-phase assignment to
-- overlap one or more phase-specific assignments. Fail closed until any such
-- legacy ambiguity is reviewed, then prevent new overlaps at every write path.
DO $preflight$
DECLARE
  v_overlap_groups bigint;
BEGIN
  SELECT count(*) INTO v_overlap_groups
  FROM (
    SELECT tenant_id, project_id, user_id
    FROM public.project_memberships
    GROUP BY tenant_id, project_id, user_id
    HAVING count(*) FILTER (WHERE phase_id IS NULL) > 0
       AND count(*) FILTER (WHERE phase_id IS NOT NULL) > 0
  ) conflicts;

  IF v_overlap_groups > 0 THEN
    RAISE EXCEPTION 'M3.4 stopped: % ambiguous project membership group(s) need review before applying the permission migration.', v_overlap_groups;
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.guard_project_membership_scope_overlap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      NEW.tenant_id::text || ':' || NEW.project_id::text || ':' || NEW.user_id::text,
      0
    )
  );

  IF EXISTS (
    SELECT 1
    FROM public.project_memberships existing
    WHERE existing.tenant_id = NEW.tenant_id
      AND existing.project_id = NEW.project_id
      AND existing.user_id = NEW.user_id
      AND existing.id IS DISTINCT FROM NEW.id
      AND (
        NEW.phase_id IS NULL
        OR existing.phase_id IS NULL
        OR existing.phase_id = NEW.phase_id
      )
  ) THEN
    RAISE EXCEPTION 'This user already has an overlapping assignment for the selected project and phase.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS project_memberships_scope_overlap_guard ON public.project_memberships;
CREATE TRIGGER project_memberships_scope_overlap_guard
BEFORE INSERT OR UPDATE OF tenant_id, project_id, phase_id, user_id
ON public.project_memberships
FOR EACH ROW
EXECUTE FUNCTION public.guard_project_membership_scope_overlap();

REVOKE ALL ON FUNCTION public.guard_project_membership_scope_overlap() FROM PUBLIC, anon, authenticated, service_role;

-- A Tenant Admin has company-wide authority only inside its own profile tenant.
-- Staff and Read Only require exactly one unambiguous membership for the row's
-- phase. Project-level reads allow multiple distinct phase assignments, but
-- never an overlapping all-phase + phase-specific pair.
CREATE OR REPLACE FUNCTION public.user_has_project_access(
  p_tenant_id uuid,
  p_project_id uuid,
  p_phase_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    ap.role::text = 'Super Admin'
    OR (
      ap.tenant_id = p_tenant_id
      AND (
        ap.role::text = 'Admin'
        OR (
          ap.role::text IN ('Staff', 'Read Only')
          AND NOT EXISTS (
            SELECT 1
            FROM public.project_memberships all_phase
            JOIN public.project_memberships exact_phase
              ON exact_phase.tenant_id = all_phase.tenant_id
             AND exact_phase.project_id = all_phase.project_id
             AND exact_phase.user_id = all_phase.user_id
             AND exact_phase.phase_id IS NOT NULL
            WHERE all_phase.tenant_id = p_tenant_id
              AND all_phase.project_id = p_project_id
              AND all_phase.user_id = ap.user_id
              AND all_phase.phase_id IS NULL
          )
          AND CASE WHEN p_phase_id IS NULL THEN
            EXISTS (
              SELECT 1 FROM public.project_memberships m
              WHERE m.tenant_id = p_tenant_id
                AND m.project_id = p_project_id
                AND m.user_id = ap.user_id
            )
          ELSE (
            SELECT count(*) = 1
            FROM public.project_memberships m
            WHERE m.tenant_id = p_tenant_id
              AND m.project_id = p_project_id
              AND m.user_id = ap.user_id
              AND (m.phase_id IS NULL OR m.phase_id = p_phase_id)
          ) END
        )
      )
    ),
    false
  )
  FROM public.admin_profiles ap
  WHERE ap.user_id = auth.uid();
$function$;

-- Tenant Admin/SA manage projects. A membership role of owner/admin cannot
-- elevate a Staff or Read Only profile into project administration.
CREATE OR REPLACE FUNCTION public.user_can_manage_project(p_tenant_id uuid, p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    ap.role::text = 'Super Admin'
    OR (ap.role::text = 'Admin' AND ap.tenant_id = p_tenant_id),
    false
  )
  FROM public.admin_profiles ap
  WHERE ap.user_id = auth.uid();
$function$;

-- Membership roles narrow a Staff profile; they never raise it. Read Only can
-- never write, including with a stale owner/admin membership row.
CREATE OR REPLACE FUNCTION public.user_can_write_project(
  p_tenant_id uuid,
  p_project_id uuid,
  p_phase_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    ap.role::text = 'Super Admin'
    OR (
      ap.role::text = 'Admin'
      AND ap.tenant_id = p_tenant_id
    )
    OR (
      ap.role::text = 'Staff'
      AND ap.tenant_id = p_tenant_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.project_memberships all_phase
        JOIN public.project_memberships exact_phase
          ON exact_phase.tenant_id = all_phase.tenant_id
         AND exact_phase.project_id = all_phase.project_id
         AND exact_phase.user_id = all_phase.user_id
         AND exact_phase.phase_id IS NOT NULL
        WHERE all_phase.tenant_id = p_tenant_id
          AND all_phase.project_id = p_project_id
          AND all_phase.user_id = ap.user_id
          AND all_phase.phase_id IS NULL
      )
      AND CASE WHEN p_phase_id IS NULL THEN
        (
          SELECT count(*) = 1 AND bool_and(m.member_role IN ('owner', 'admin', 'staff'))
          FROM public.project_memberships m
          WHERE m.tenant_id = p_tenant_id
            AND m.project_id = p_project_id
            AND m.user_id = ap.user_id
            AND m.phase_id IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.project_memberships exact_phase
          WHERE exact_phase.tenant_id = p_tenant_id
            AND exact_phase.project_id = p_project_id
            AND exact_phase.user_id = ap.user_id
            AND exact_phase.phase_id IS NOT NULL
        )
      ELSE (
        SELECT count(*) = 1 AND bool_and(m.member_role IN ('owner', 'admin', 'staff'))
        FROM public.project_memberships m
        WHERE m.tenant_id = p_tenant_id
          AND m.project_id = p_project_id
          AND m.user_id = ap.user_id
          AND (m.phase_id IS NULL OR m.phase_id = p_phase_id)
      ) END
    ),
    false
  )
  FROM public.admin_profiles ap
  WHERE ap.user_id = auth.uid();
$function$;

REVOKE ALL ON FUNCTION public.user_has_project_access(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_has_project_access(uuid, uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.user_can_manage_project(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_manage_project(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.user_can_write_project(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_write_project(uuid, uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS project_memberships_scoped_read ON public.project_memberships;
CREATE POLICY project_memberships_scoped_read ON public.project_memberships
FOR SELECT TO authenticated USING (
  user_id = auth.uid()
  OR public.is_super_admin_user()
  OR EXISTS (
    SELECT 1 FROM public.admin_profiles actor
    WHERE actor.user_id = auth.uid()
      AND actor.role::text = 'Admin'
      AND actor.tenant_id = project_memberships.tenant_id
  )
);

-- Role and membership changes must go through the atomic SECURITY DEFINER RPC.
-- Service credentials remain server-side; authenticated users retain read access.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.admin_profiles FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.project_memberships FROM PUBLIC, anon, authenticated;

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

  v_request_role := NULLIF(current_setting('request.jwt.claim.role', true), '');
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

REVOKE ALL ON FUNCTION public.manage_workspace_member(uuid, uuid, text, jsonb, text, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_workspace_member(uuid, uuid, text, jsonb, text, text, uuid)
  TO authenticated, service_role;

-- Keep onboarding's service-role provisioning path atomic and avoid adding an
-- exact-phase row when an existing all-phase membership already covers it.
CREATE OR REPLACE FUNCTION public.onboard_project_tenant(
  p_tenant_slug text,
  p_tenant_name text,
  p_project_slug text,
  p_project_name text,
  p_phase_slug text,
  p_phase_name text,
  p_theme jsonb,
  p_company_profile jsonb,
  p_staff_user_id uuid,
  p_member_role text DEFAULT 'owner',
  p_demo_mode boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $function$
DECLARE
  v_tenant public.organizations%ROWTYPE;
  v_project public.projects%ROWTYPE;
  v_phase public.development_phases%ROWTYPE;
  v_profile public.admin_profiles%ROWTYPE;
  v_existing_role text;
  v_existing_count integer;
  v_user_email text;
  v_user_name text;
  v_is_default boolean;
BEGIN
  IF p_tenant_slug !~ '^[a-z0-9][a-z0-9-]{0,62}$'
    OR p_project_slug !~ '^[a-z0-9][a-z0-9-]{0,62}$'
    OR p_phase_slug !~ '^[a-z0-9][a-z0-9-]{0,62}$'
    OR NULLIF(trim(p_tenant_name), '') IS NULL
    OR NULLIF(trim(p_project_name), '') IS NULL
    OR NULLIF(trim(p_phase_name), '') IS NULL
    OR p_staff_user_id IS NULL
    OR p_member_role NOT IN ('owner', 'admin', 'staff', 'read_only')
    OR jsonb_typeof(COALESCE(p_theme, '{}'::jsonb)) <> 'object'
    OR jsonb_typeof(COALESCE(p_company_profile, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'Tenant onboarding payload is incomplete or invalid.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tenant-onboard:' || p_tenant_slug));
  SELECT * INTO v_tenant FROM public.organizations WHERE lower(slug) = lower(p_tenant_slug) FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.organizations(name, slug, is_active)
    VALUES (trim(p_tenant_name), p_tenant_slug, true) RETURNING * INTO v_tenant;
  ELSIF NOT v_tenant.is_active THEN
    RAISE EXCEPTION 'Tenant slug already exists but is inactive; onboarding will not reactivate it.';
  ELSIF v_tenant.name <> trim(p_tenant_name) THEN
    RAISE EXCEPTION 'Existing tenant name differs from onboarding config; review it rather than overwriting.';
  END IF;

  SELECT * INTO v_profile FROM public.admin_profiles WHERE user_id = p_staff_user_id FOR UPDATE;
  IF FOUND THEN
    IF v_profile.role::text = 'Super Admin' THEN
      RAISE EXCEPTION 'A Super Admin account cannot receive tenant project memberships; select a tenant staff account.';
    END IF;
    IF v_profile.role::text <> 'Super Admin' AND v_profile.tenant_id IS DISTINCT FROM v_tenant.id THEN
      RAISE EXCEPTION 'The selected account already belongs to another tenant; it was not reassigned.';
    END IF;
    IF v_profile.role::text = 'Read Only' AND p_member_role <> 'read_only' THEN
      RAISE EXCEPTION 'A Read Only profile cannot receive a writable membership.';
    END IF;
  ELSE
    SELECT email, COALESCE(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', '')
      INTO v_user_email, v_user_name FROM auth.users WHERE id = p_staff_user_id;
    IF NOT FOUND OR NULLIF(trim(v_user_email), '') IS NULL THEN
      RAISE EXCEPTION 'The selected staff account must already exist in Auth and have an email; no invitation was sent.';
    END IF;
    INSERT INTO public.admin_profiles(user_id, email, full_name, role, tenant_id)
    VALUES (p_staff_user_id, lower(trim(v_user_email)), COALESCE(NULLIF(trim(v_user_name), ''), trim(v_user_email)), 'Staff', v_tenant.id)
    RETURNING * INTO v_profile;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.project_memberships m
    WHERE m.user_id = p_staff_user_id AND m.tenant_id <> v_tenant.id
  ) THEN
    RAISE EXCEPTION 'The selected account has project memberships in another tenant; review the assignments before onboarding.';
  END IF;

  SELECT * INTO v_project FROM public.projects
  WHERE tenant_id = v_tenant.id AND lower(slug) = lower(p_project_slug) FOR UPDATE;
  IF NOT FOUND THEN
    SELECT NOT EXISTS (SELECT 1 FROM public.projects WHERE tenant_id = v_tenant.id AND is_default) INTO v_is_default;
    INSERT INTO public.projects(tenant_id, slug, name, is_default, map_experience_mode)
    VALUES (v_tenant.id, p_project_slug, trim(p_project_name), v_is_default, CASE WHEN p_demo_mode THEN 'demo' ELSE 'sales' END)
    RETURNING * INTO v_project;
  ELSIF v_project.name <> trim(p_project_name)
    OR v_project.map_experience_mode <> (CASE WHEN p_demo_mode THEN 'demo' ELSE 'sales' END) THEN
    RAISE EXCEPTION 'Existing project settings differ from this onboarding config; review them rather than overwriting.';
  END IF;

  SELECT * INTO v_phase FROM public.development_phases
  WHERE tenant_id = v_tenant.id AND project_id = v_project.id AND lower(slug) = lower(p_phase_slug) FOR UPDATE;
  IF NOT FOUND THEN
    SELECT NOT EXISTS (SELECT 1 FROM public.development_phases WHERE project_id = v_project.id AND is_default) INTO v_is_default;
    INSERT INTO public.development_phases(tenant_id, project_id, slug, name, is_default)
    VALUES (v_tenant.id, v_project.id, p_phase_slug, trim(p_phase_name), v_is_default)
    RETURNING * INTO v_phase;
  ELSIF v_phase.name <> trim(p_phase_name) OR NOT v_phase.is_active THEN
    RAISE EXCEPTION 'Existing project phase differs from this onboarding config; review it rather than overwriting.';
  END IF;

  PERFORM 1
  FROM public.project_memberships
  WHERE tenant_id = v_tenant.id AND project_id = v_project.id
    AND user_id = p_staff_user_id AND (phase_id = v_phase.id OR phase_id IS NULL)
  FOR UPDATE;
  SELECT count(*), min(member_role) INTO v_existing_count, v_existing_role
  FROM public.project_memberships
  WHERE tenant_id = v_tenant.id AND project_id = v_project.id
    AND user_id = p_staff_user_id AND (phase_id = v_phase.id OR phase_id IS NULL);
  IF v_existing_count > 1 THEN
    RAISE EXCEPTION 'The account has ambiguous overlapping project membership; review it before onboarding.';
  ELSIF v_existing_count = 1 AND v_existing_role <> p_member_role THEN
    RAISE EXCEPTION 'The account already has a different project role; review that assignment instead of changing it implicitly.';
  ELSIF v_existing_count = 0 THEN
    INSERT INTO public.project_memberships(tenant_id, project_id, phase_id, user_id, member_role)
    VALUES (v_tenant.id, v_project.id, v_phase.id, p_staff_user_id, p_member_role);
  END IF;

  INSERT INTO public.project_settings(tenant_id, project_id, key, value)
  VALUES (v_tenant.id, v_project.id, 'tenant_theme', COALESCE(p_theme, '{}'::jsonb))
  ON CONFLICT(project_id, key) DO NOTHING;
  INSERT INTO public.project_settings(tenant_id, project_id, key, value)
  VALUES (v_tenant.id, v_project.id, 'company_profile', COALESCE(p_company_profile, '{}'::jsonb))
  ON CONFLICT(project_id, key) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.project_settings WHERE tenant_id = v_tenant.id AND project_id = v_project.id
      AND key = 'tenant_theme' AND value = COALESCE(p_theme, '{}'::jsonb))
    OR NOT EXISTS (SELECT 1 FROM public.project_settings WHERE tenant_id = v_tenant.id AND project_id = v_project.id
      AND key = 'company_profile' AND value = COALESCE(p_company_profile, '{}'::jsonb)) THEN
    RAISE EXCEPTION 'Existing project branding differs from this onboarding config; review it rather than overwriting.';
  END IF;

  RETURN jsonb_build_object('tenant_id', v_tenant.id, 'project_id', v_project.id, 'phase_id', v_phase.id,
    'staff_user_id', p_staff_user_id, 'member_role', p_member_role, 'created_or_reused', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.onboard_project_tenant(text, text, text, text, text, text, jsonb, jsonb, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.onboard_project_tenant(text, text, text, text, text, text, jsonb, jsonb, uuid, text, boolean)
  TO service_role;

COMMIT;
