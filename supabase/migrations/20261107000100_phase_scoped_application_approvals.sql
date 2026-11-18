-- M3.3: authorize application decisions against the live actor and verified
-- tenant/project/phase scope, for both RPC overloads and direct table writes.
-- Forward-only: retain the applied staging migration sources and ledger.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public._assert_application_decision_scope(
  p_application_id bigint,
  p_parcel_id bigint,
  p_require_parcel boolean,
  p_allow_staff boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_actor_tenant_id uuid;
  v_application record;
  v_project_id uuid;
  v_phase_id uuid;
  v_tenant_active boolean;
  v_phase_active boolean;
  v_default_count integer;
  v_membership_count integer := 0;
  v_membership_role text;
  v_membership record;
  v_old_parcel_id bigint;
  v_checked_parcel_id bigint;
BEGIN
  IF v_actor_id IS NULL
     OR coalesce(current_setting('request.jwt.claim.role', true), '') IN ('anon', 'service_role') THEN
    RAISE EXCEPTION 'An authenticated Wamule user must perform this application decision.'
      USING ERRCODE = '42501';
  END IF;

  SELECT ap.role::text, ap.tenant_id
    INTO v_actor_role, v_actor_tenant_id
  FROM public.admin_profiles ap
  WHERE ap.user_id = v_actor_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The caller has no current Wamule profile.'
      USING ERRCODE = '42501';
  END IF;

  IF (p_allow_staff AND v_actor_role NOT IN ('Admin', 'Staff', 'Super Admin'))
     OR (NOT p_allow_staff AND v_actor_role NOT IN ('Admin', 'Super Admin')) THEN
    RAISE EXCEPTION 'The caller role cannot perform this application decision.'
      USING ERRCODE = '42501';
  END IF;

  SELECT a.id, a.tenant_id, a.project_id, a.phase_id, a.application_kind, a.parcel_id
    INTO v_application
  FROM public.applications a
  WHERE a.id = p_application_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Application not found.';
  END IF;

  IF v_application.tenant_id IS NULL
     OR v_application.application_kind IS DISTINCT FROM 'land_purchase'
     OR ((v_application.project_id IS NULL) <> (v_application.phase_id IS NULL)) THEN
    RAISE EXCEPTION 'The application has no valid parcel-purchase workspace scope.'
      USING ERRCODE = '23514';
  END IF;

  IF v_application.project_id IS NULL THEN
    -- Legacy unscoped sales applications may only be resolved by a tenant
    -- Admin or Super Admin, and only to the tenant's unique default workspace.
    IF v_actor_role NOT IN ('Admin', 'Super Admin') THEN
      RAISE EXCEPTION 'A phase-scoped user cannot approve an unscoped legacy application.'
        USING ERRCODE = '42501';
    END IF;

    SELECT count(*)
      INTO v_default_count
    FROM public.projects p
    JOIN public.organizations t ON t.id = p.tenant_id
    JOIN public.development_phases ph
      ON ph.tenant_id = p.tenant_id
     AND ph.project_id = p.id
    WHERE p.tenant_id = v_application.tenant_id
      AND p.is_default
      AND ph.is_default;

    IF v_default_count <> 1 THEN
      RAISE EXCEPTION 'The tenant default project/phase is missing or ambiguous.'
        USING ERRCODE = '23514';
    END IF;

    SELECT p.id, ph.id, t.is_active, ph.is_active
      INTO v_project_id, v_phase_id, v_tenant_active, v_phase_active
    FROM public.projects p
    JOIN public.organizations t ON t.id = p.tenant_id
    JOIN public.development_phases ph
      ON ph.tenant_id = p.tenant_id
     AND ph.project_id = p.id
    WHERE p.tenant_id = v_application.tenant_id
      AND p.is_default
      AND ph.is_default
    FOR SHARE OF p, t, ph;
  ELSE
    SELECT p.id, ph.id, t.is_active, ph.is_active
      INTO v_project_id, v_phase_id, v_tenant_active, v_phase_active
    FROM public.projects p
    JOIN public.organizations t ON t.id = p.tenant_id
    JOIN public.development_phases ph
      ON ph.tenant_id = p.tenant_id
     AND ph.project_id = p.id
    WHERE p.id = v_application.project_id
      AND p.tenant_id = v_application.tenant_id
      AND ph.id = v_application.phase_id
    FOR SHARE OF p, t, ph;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'The application project and phase do not resolve to one workspace.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_tenant_active IS DISTINCT FROM true OR v_phase_active IS DISTINCT FROM true THEN
    -- Approving/declining is a live sales decision, not an inactive-workspace
    -- recovery action. Super Admin must reactivate the verified scope first.
    RAISE EXCEPTION 'Application decisions require an active tenant and phase.'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor_role <> 'Super Admin'
     AND v_actor_tenant_id IS DISTINCT FROM v_application.tenant_id THEN
    RAISE EXCEPTION 'The application is outside the caller tenant.'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor_role = 'Staff' THEN
    IF NOT p_allow_staff OR v_application.project_id IS NULL THEN
      RAISE EXCEPTION 'A phase-scoped Staff user cannot decide this legacy application.'
        USING ERRCODE = '42501';
    END IF;

    FOR v_membership IN
      SELECT m.member_role
      FROM public.project_memberships m
      WHERE m.tenant_id = v_application.tenant_id
        AND m.project_id = v_project_id
        AND m.user_id = v_actor_id
        AND (m.phase_id IS NULL OR m.phase_id = v_phase_id)
      FOR SHARE
    LOOP
      v_membership_count := v_membership_count + 1;
      v_membership_role := v_membership.member_role;
    END LOOP;

    IF v_membership_count <> 1
       OR v_membership_role NOT IN ('owner', 'admin', 'staff') THEN
      RAISE EXCEPTION 'Staff approval requires one current writable membership in this project and phase.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_actor_role = 'Admin' THEN
    IF v_actor_tenant_id IS DISTINCT FROM v_application.tenant_id THEN
      RAISE EXCEPTION 'The application belongs to a different tenant.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_actor_role <> 'Super Admin' THEN
    RAISE EXCEPTION 'The caller role cannot perform this application decision.'
      USING ERRCODE = '42501';
  END IF;

  -- Validate the persisted parcel link as well as any parcel supplied for this
  -- decision. A mismatched old link cannot be silently repaired by approval.
  v_old_parcel_id := v_application.parcel_id;
  IF v_old_parcel_id IS NOT NULL THEN
    SELECT p.id
      INTO v_checked_parcel_id
    FROM public.parcels p
    WHERE p.id = v_old_parcel_id
      AND p.tenant_id = v_application.tenant_id
      AND p.project_id = v_project_id
      AND p.phase_id = v_phase_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'The application parcel does not match its verified workspace.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF p_require_parcel AND p_parcel_id IS NULL THEN
    RAISE EXCEPTION 'Select a lot before approving this application.';
  END IF;

  IF p_parcel_id IS NOT NULL THEN
    SELECT p.id
      INTO v_checked_parcel_id
    FROM public.parcels p
    WHERE p.id = p_parcel_id
      AND p.tenant_id = v_application.tenant_id
      AND p.project_id = v_project_id
      AND p.phase_id = v_phase_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'The selected parcel does not match the application workspace.'
        USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$$;

COMMENT ON FUNCTION public._assert_application_decision_scope(bigint, bigint, boolean, boolean) IS
  'Private approval/decline guard. Derives workspace from the application and live records; Staff approval requires one exact or explicit all-phase membership.';

CREATE OR REPLACE FUNCTION public.guard_application_decision_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project_id uuid;
  v_phase_id uuid;
  v_default_count integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'Pending Review'::public.application_status THEN
      RAISE EXCEPTION 'Create applications as pending, then record a decision through an authorized operation.'
        USING ERRCODE = '42501';
    END IF;

    -- Public intake may create pending rows, but any supplied parcel must
    -- resolve to the application's exact workspace before related triggers run.
    IF NEW.parcel_id IS NOT NULL THEN
      IF NEW.tenant_id IS NULL
         OR ((NEW.project_id IS NULL) <> (NEW.phase_id IS NULL))
         OR NEW.application_kind IS DISTINCT FROM 'land_purchase' THEN
        RAISE EXCEPTION 'A parcel selection requires a valid parcel-purchase workspace.'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.project_id IS NULL THEN
        SELECT count(*)
          INTO v_default_count
        FROM public.projects p
        JOIN public.development_phases ph
          ON ph.tenant_id = p.tenant_id
         AND ph.project_id = p.id
        WHERE p.tenant_id = NEW.tenant_id
          AND p.is_default
          AND ph.is_default;

        IF v_default_count <> 1 THEN
          RAISE EXCEPTION 'The tenant default project/phase is missing or ambiguous.'
            USING ERRCODE = '23514';
        END IF;

        SELECT p.id, ph.id
          INTO v_project_id, v_phase_id
        FROM public.projects p
        JOIN public.development_phases ph
          ON ph.tenant_id = p.tenant_id
         AND ph.project_id = p.id
        WHERE p.tenant_id = NEW.tenant_id
          AND p.is_default
          AND ph.is_default;
      ELSE
        SELECT p.id, ph.id
          INTO v_project_id, v_phase_id
        FROM public.projects p
        JOIN public.development_phases ph
          ON ph.tenant_id = p.tenant_id
         AND ph.project_id = p.id
        WHERE p.id = NEW.project_id
          AND p.tenant_id = NEW.tenant_id
          AND ph.id = NEW.phase_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'The new application project and phase do not resolve to one workspace.'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM public.parcels p
        WHERE p.id = NEW.parcel_id
          AND p.tenant_id = NEW.tenant_id
          AND p.project_id = v_project_id
          AND p.phase_id = v_phase_id
      ) THEN
        RAISE EXCEPTION 'The new application parcel does not match its workspace.'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.phase_id IS DISTINCT FROM NEW.phase_id
     OR OLD.application_kind IS DISTINCT FROM NEW.application_kind THEN
    RAISE EXCEPTION 'An application tenant, project, phase, and kind are immutable.'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'Approved'::public.application_status
     AND OLD.parcel_id IS DISTINCT FROM NEW.parcel_id THEN
    RAISE EXCEPTION 'An approved application cannot be moved to a different parcel.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'Approved'::public.application_status THEN
    PERFORM public._assert_application_decision_scope(NEW.id, NEW.parcel_id, true, true);
  ELSIF NEW.status = 'Declined'::public.application_status
        AND (
          OLD.status IS DISTINCT FROM NEW.status
          OR OLD.parcel_id IS DISTINCT FROM NEW.parcel_id
        ) THEN
    -- M3.1 keeps Staff intake work separate from final rejection decisions.
    PERFORM public._assert_application_decision_scope(NEW.id, NEW.parcel_id, false, false);
  ELSIF NEW.status = 'Pending Review'::public.application_status
        AND OLD.parcel_id IS DISTINCT FROM NEW.parcel_id THEN
    -- Pending parcel selections are operational writes too; validate their
    -- tenant/project/phase link before it can be retained for a later decision.
    PERFORM public._assert_application_decision_scope(NEW.id, NEW.parcel_id, false, true);
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_application_decision_scope()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS applications_approval_scope_guard ON public.applications;
CREATE TRIGGER applications_approval_scope_guard
BEFORE INSERT OR UPDATE OF status, tenant_id, project_id, phase_id, application_kind, parcel_id
ON public.applications
FOR EACH ROW
EXECUTE FUNCTION public.guard_application_decision_scope();

CREATE OR REPLACE FUNCTION public.handle_application_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_parcel_status public.parcel_status;
BEGIN
  IF NEW.status = 'Approved'::public.application_status
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public._assert_application_decision_scope(NEW.id, NEW.parcel_id, true, true);

    SELECT p.status
      INTO v_parcel_status
    FROM public.parcels p
    WHERE p.id = NEW.parcel_id
      AND p.tenant_id = NEW.tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cannot approve application %. Its parcel does not exist in the same tenant.', NEW.id
        USING ERRCODE = '23503';
    END IF;

    IF v_parcel_status IS DISTINCT FROM 'Available'::public.parcel_status THEN
      RAISE EXCEPTION 'Cannot approve application %. Its parcel is not available.', NEW.id
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.customers (
      tenant_id, application_id, first_name, last_name, phone, email, address
    )
    VALUES (
      NEW.tenant_id, NEW.id, NEW.first_name, NEW.last_name, NEW.phone, NEW.email, NEW.applicant_address
    )
    ON CONFLICT (application_id) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      phone = EXCLUDED.phone,
      email = EXCLUDED.email,
      address = EXCLUDED.address,
      updated_at = now();

    UPDATE public.parcels
    SET status = 'Reserved'::public.parcel_status,
        updated_at = now()
    WHERE id = NEW.parcel_id
      AND tenant_id = NEW.tenant_id;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.handle_application_approval()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_application_approval ON public.applications;
CREATE TRIGGER trg_application_approval
BEFORE INSERT OR UPDATE OF status ON public.applications
FOR EACH ROW
EXECUTE FUNCTION public.handle_application_approval();

CREATE OR REPLACE FUNCTION public.approve_application(
  p_application_id bigint,
  p_parcel_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_application public.applications%ROWTYPE;
  v_parcel public.parcels%ROWTYPE;
BEGIN
  SELECT *
    INTO v_application
  FROM public.applications a
  WHERE a.id = p_application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Application not found.';
  END IF;

  PERFORM public._assert_application_decision_scope(p_application_id, p_parcel_id, true, true);

  SELECT *
    INTO v_parcel
  FROM public.parcels p
  WHERE p.id = p_parcel_id
    AND p.tenant_id = v_application.tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected lot does not exist in the application tenant.';
  END IF;

  IF v_parcel.status IS DISTINCT FROM 'Available'::public.parcel_status THEN
    RAISE EXCEPTION 'Selected lot is not available.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.customers c
    WHERE c.application_id = v_application.id
      AND c.tenant_id IS DISTINCT FROM v_application.tenant_id
  ) THEN
    RAISE EXCEPTION 'Existing customer record for this application belongs to a different tenant.';
  END IF;

  UPDATE public.applications
  SET status = 'Approved'::public.application_status,
      parcel_id = p_parcel_id,
      updated_at = now()
  WHERE id = v_application.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_application(p_application_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_parcel_id bigint;
BEGIN
  SELECT a.parcel_id
    INTO v_parcel_id
  FROM public.applications a
  WHERE a.id = p_application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Application not found.';
  END IF;
  IF v_parcel_id IS NULL THEN
    RAISE EXCEPTION 'Select a lot before approving this application.';
  END IF;

  PERFORM public.approve_application(p_application_id, v_parcel_id);
END;
$$;

REVOKE ALL ON FUNCTION public._assert_application_decision_scope(bigint, bigint, boolean, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.approve_application(bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.approve_application(bigint, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approve_application(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_application(bigint, bigint) TO authenticated;

COMMENT ON FUNCTION public.approve_application(bigint) IS
  'Approves a parcel-purchase application only after verifying its live actor, tenant, project, phase, and stored parcel.';
COMMENT ON FUNCTION public.approve_application(bigint, bigint) IS
  'Approves a parcel-purchase application only after verifying its live actor, tenant, project, phase, stored parcel, and selected parcel.';

COMMIT;
