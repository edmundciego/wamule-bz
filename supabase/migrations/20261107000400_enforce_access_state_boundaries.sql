-- Apply tenant/phase lifecycle state at every database authorization boundary.
-- This is forward-only; it does not change tenant, project, phase, inventory,
-- package, or audit data. Projects deliberately have no independent is_active.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.organizations') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.development_phases') IS NULL
     OR to_regclass('public.project_memberships') IS NULL
     OR to_regclass('public.admin_profiles') IS NULL THEN
    RAISE EXCEPTION 'M3.6 requires the reconciled tenant/project/phase schema.';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.workspace_scope_exists(
  p_tenant_id uuid,
  p_project_id uuid DEFAULT NULL,
  p_phase_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT p_tenant_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_tenant_id)
    AND (p_project_id IS NULL OR EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = p_project_id AND p.tenant_id = p_tenant_id
    ))
    AND (p_phase_id IS NULL OR (p_project_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.development_phases ph
      WHERE ph.id = p_phase_id AND ph.project_id = p_project_id AND ph.tenant_id = p_tenant_id
    )));
$function$;

CREATE OR REPLACE FUNCTION public.workspace_scope_is_active(
  p_tenant_id uuid,
  p_project_id uuid DEFAULT NULL,
  p_phase_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.workspace_scope_exists(p_tenant_id, p_project_id, p_phase_id)
    AND EXISTS (
      SELECT 1 FROM public.organizations o WHERE o.id = p_tenant_id AND o.is_active
    )
    AND (p_phase_id IS NULL OR EXISTS (
      SELECT 1 FROM public.development_phases ph
      WHERE ph.id = p_phase_id AND ph.project_id = p_project_id
        AND ph.tenant_id = p_tenant_id AND ph.is_active
    ));
$function$;

COMMENT ON FUNCTION public.workspace_scope_exists(uuid, uuid, uuid) IS
  'True only for an existing tenant and, when supplied, its exact project and phase. Projects have no independent lifecycle flag.';
COMMENT ON FUNCTION public.workspace_scope_is_active(uuid, uuid, uuid) IS
  'True only for an existing active tenant/project scope and, when supplied, an active exact phase.';

REVOKE ALL ON FUNCTION public.workspace_scope_exists(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workspace_scope_is_active(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workspace_scope_exists(uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workspace_scope_is_active(uuid, uuid, uuid) TO authenticated, service_role;

-- A non-Super-Admin's tenant is unavailable once suspended. Super Admin may
-- still resolve an existing inactive tenant for explicit recovery/audit.
CREATE OR REPLACE FUNCTION public.user_has_tenant_access(row_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    public.workspace_scope_exists(row_tenant_id)
    AND (
      ap.role::text = 'Super Admin'
      OR (ap.tenant_id = row_tenant_id AND o.is_active
          AND ap.role::text IN ('Admin', 'Staff', 'Read Only'))
    ),
    false
  )
  FROM public.admin_profiles ap
  LEFT JOIN public.organizations o ON o.id = row_tenant_id
  WHERE ap.user_id = auth.uid();
$function$;

-- Admin may read historical rows from an inactive phase in an active tenant.
-- Staff/Read Only require one exact, active phase membership. A phase-less
-- sales row is ambiguous to those roles and fails closed. Super Admin may
-- inspect any existing target scope for recovery.
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
    p_project_id IS NOT NULL
    AND public.workspace_scope_exists(p_tenant_id, p_project_id, p_phase_id)
    AND (
      ap.role::text = 'Super Admin'
      OR (
        ap.tenant_id = p_tenant_id
        AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_tenant_id AND o.is_active)
        AND ap.role::text = 'Admin'
      )
      OR (
        p_phase_id IS NOT NULL
        AND public.workspace_scope_is_active(p_tenant_id, p_project_id, p_phase_id)
        AND ap.tenant_id = p_tenant_id
        AND ap.role::text IN ('Staff', 'Read Only')
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
        AND (SELECT count(*) = 1
          FROM public.project_memberships m
          WHERE m.tenant_id = p_tenant_id
            AND m.project_id = p_project_id
            AND m.user_id = ap.user_id
            AND (m.phase_id IS NULL OR m.phase_id = p_phase_id))
      )
    ),
    false
  )
  FROM public.admin_profiles ap
  WHERE ap.user_id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.user_can_manage_project(p_tenant_id uuid, p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    public.workspace_scope_exists(p_tenant_id, p_project_id, NULL)
    AND (
      ap.role::text = 'Super Admin'
      OR (ap.role::text = 'Admin' AND ap.tenant_id = p_tenant_id
          AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_tenant_id AND o.is_active))
    ),
    false
  )
  FROM public.admin_profiles ap
  WHERE ap.user_id = auth.uid();
$function$;

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
    p_project_id IS NOT NULL
    AND public.workspace_scope_exists(p_tenant_id, p_project_id, p_phase_id)
    AND (
      -- Super Admin's broad target access is for verified recovery/admin work.
      -- Sales approval/decline has its own stricter active-scope guard.
      ap.role::text = 'Super Admin'
      OR (
        ap.role::text = 'Admin'
        AND ap.tenant_id = p_tenant_id
        AND public.workspace_scope_is_active(p_tenant_id, p_project_id, p_phase_id)
      )
      OR (
        ap.role::text = 'Staff'
        AND ap.tenant_id = p_tenant_id
        AND p_phase_id IS NOT NULL
        AND public.workspace_scope_is_active(p_tenant_id, p_project_id, p_phase_id)
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
        AND (SELECT count(*) = 1 AND bool_and(m.member_role IN ('owner', 'admin', 'staff'))
          FROM public.project_memberships m
          WHERE m.tenant_id = p_tenant_id
            AND m.project_id = p_project_id
            AND m.user_id = ap.user_id
            AND (m.phase_id IS NULL OR m.phase_id = p_phase_id))
      )
    ),
    false
  )
  FROM public.admin_profiles ap
  WHERE ap.user_id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.user_can_manage_tenant_workspace(p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    public.workspace_scope_exists(p_tenant_id)
    AND (ap.role::text = 'Super Admin'
      OR (ap.role::text = 'Admin' AND ap.tenant_id = p_tenant_id
          AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_tenant_id AND o.is_active))),
    false
  )
  FROM public.admin_profiles ap
  WHERE ap.user_id = auth.uid();
$function$;

-- Project names/IDs are workspace navigation metadata. Keep them readable to
-- an assigned Staff/Read Only account without granting phase-less access to
-- project sales records.
CREATE OR REPLACE FUNCTION public.user_can_read_project_metadata(p_tenant_id uuid, p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    public.workspace_scope_exists(p_tenant_id, p_project_id, NULL)
    AND (
      ap.role::text = 'Super Admin'
      OR (ap.role::text = 'Admin' AND ap.tenant_id = p_tenant_id
          AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_tenant_id AND o.is_active))
      OR (ap.role::text IN ('Staff', 'Read Only') AND ap.tenant_id = p_tenant_id
          AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_tenant_id AND o.is_active)
          AND EXISTS (
            SELECT 1 FROM public.project_memberships m
            WHERE m.tenant_id = p_tenant_id AND m.project_id = p_project_id AND m.user_id = ap.user_id
              AND (m.phase_id IS NULL OR EXISTS (
                SELECT 1 FROM public.development_phases ph
                WHERE ph.id = m.phase_id AND ph.tenant_id = p_tenant_id
                  AND ph.project_id = p_project_id AND ph.is_active
              ))
          ))
    ),
    false
  )
  FROM public.admin_profiles ap
  WHERE ap.user_id = auth.uid();
$function$;

REVOKE ALL ON FUNCTION public.user_has_tenant_access(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.user_has_project_access(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.user_can_manage_project(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.user_can_write_project(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.user_can_manage_tenant_workspace(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.user_can_read_project_metadata(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_has_tenant_access(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_has_project_access(uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_manage_project(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_write_project(uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_manage_tenant_workspace(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_read_project_metadata(uuid, uuid) TO authenticated, service_role;

-- Reuse the M3.5 parent-graph resolver for the global service-role post-sales
-- summarizer. It returns only a verified active scope for the selected
-- checklist and never trusts tenant/project/phase values from the request.
CREATE OR REPLACE FUNCTION public.active_post_sales_checklist_scope(
  p_checklist_id uuid,
  p_expected_tenant_id uuid
)
RETURNS TABLE (tenant_id uuid, project_id uuid, phase_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_scope record;
BEGIN
  SELECT s.* INTO v_scope
  FROM audit_private.resolve_audit_scope('post_sales_checklist', p_checklist_id::text) AS s;
  IF NOT FOUND OR v_scope.tenant_id IS DISTINCT FROM p_expected_tenant_id THEN
    RETURN;
  END IF;
  IF NOT public.workspace_scope_is_active(v_scope.tenant_id, v_scope.project_id, v_scope.phase_id) THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT v_scope.tenant_id, v_scope.project_id, v_scope.phase_id;
END;
$function$;
COMMENT ON FUNCTION public.active_post_sales_checklist_scope(uuid, uuid) IS
  'Service-only: derive the post-sales checklist parent scope through M3.5 and return it only while its tenant/project/phase is active.';
REVOKE ALL ON FUNCTION public.active_post_sales_checklist_scope(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.active_post_sales_checklist_scope(uuid, uuid) TO service_role;

DROP POLICY IF EXISTS projects_member_read ON public.projects;
CREATE POLICY projects_member_read ON public.projects
  FOR SELECT TO authenticated
  USING (public.user_can_read_project_metadata(tenant_id, id));

-- A null project/phase is tenant-shared. Only the tenant Admin and Super
-- Admin can read or mutate those company-wide records; scoped Staff/Read Only
-- do not inherit an arbitrary project membership into unassigned sales rows.
DO $policies$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'parcels','masterplan_versions','leads','lead_activities','follow_up_tasks',
    'information_requests','information_request_topics','information_packs','site_visits'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP POLICY IF EXISTS project_phase_read_scope ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS project_phase_insert_scope ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS project_phase_update_scope ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS project_phase_delete_scope ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY project_phase_read_scope ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (' ||
      '(project_id IS NOT NULL AND public.user_has_project_access(tenant_id, project_id, phase_id)) OR ' ||
      '(project_id IS NULL AND phase_id IS NULL AND public.user_can_manage_tenant_workspace(tenant_id)))', t);
    EXECUTE format(
      'CREATE POLICY project_phase_insert_scope ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (' ||
      '(project_id IS NOT NULL AND public.user_can_write_project(tenant_id, project_id, phase_id)) OR ' ||
      '(project_id IS NULL AND phase_id IS NULL AND public.user_can_manage_tenant_workspace(tenant_id)))', t);
    EXECUTE format(
      'CREATE POLICY project_phase_update_scope ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (' ||
      '(project_id IS NOT NULL AND public.user_can_write_project(tenant_id, project_id, phase_id)) OR ' ||
      '(project_id IS NULL AND phase_id IS NULL AND public.user_can_manage_tenant_workspace(tenant_id))) ' ||
      'WITH CHECK (project_id IS NOT NULL AND public.user_can_write_project(tenant_id, project_id, phase_id) OR ' ||
      '(project_id IS NULL AND phase_id IS NULL AND public.user_can_manage_tenant_workspace(tenant_id)))', t);
    EXECUTE format(
      'CREATE POLICY project_phase_delete_scope ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (' ||
      '(project_id IS NOT NULL AND public.user_can_write_project(tenant_id, project_id, phase_id)) OR ' ||
      '(project_id IS NULL AND phase_id IS NULL AND public.user_can_manage_tenant_workspace(tenant_id)))', t);
  END LOOP;
END;
$policies$;

-- Map Studio tables are deployed-only in the captured baseline. Keep active
-- phase drafts available to assigned internal viewers, but close them when
-- their tenant/phase is inactive. Publication is enforced by the public RPC.
DO $map_policies$
BEGIN
  IF to_regclass('public.project_map_packages') IS NOT NULL THEN
    DROP POLICY IF EXISTS project_map_packages_read ON public.project_map_packages;
    CREATE POLICY project_map_packages_read ON public.project_map_packages
      FOR SELECT TO authenticated
      USING (public.user_has_project_access(tenant_id, project_id, phase_id));
  END IF;
  IF to_regclass('public.project_plot_content') IS NOT NULL THEN
    DROP POLICY IF EXISTS project_plot_content_read ON public.project_plot_content;
    CREATE POLICY project_plot_content_read ON public.project_plot_content
      FOR SELECT TO authenticated
      USING (public.user_has_project_access(tenant_id, project_id, phase_id));
  END IF;
END;
$map_policies$;

-- A public inquiry tied to a parcel/outline must still point into the exact
-- published active package at insert time. General project inquiries remain
-- available for an active phase and do not depend on a map module switch.
CREATE OR REPLACE FUNCTION public.guard_public_inquiry_publication_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.source = 'public_inquiry'
     AND (NEW.parcel_id IS NOT NULL OR NEW.map_feature_id IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1
       FROM public.map_feature_snapshots s
       JOIN public.project_map_packages pkg
         ON pkg.snapshot_id = s.id
        AND pkg.tenant_id = s.tenant_id
        AND pkg.project_id = s.project_id
        AND pkg.phase_id = s.phase_id
        AND pkg.published_at IS NOT NULL
       JOIN public.map_features f
         ON f.snapshot_id = s.id
        AND f.tenant_id = s.tenant_id
        AND f.project_id = s.project_id
        AND f.phase_id = s.phase_id
        AND f.is_active
        AND f.public_visible
       JOIN public.project_plot_content pc
         ON pc.identity_id = f.identity_id
        AND pc.tenant_id = f.tenant_id
        AND pc.project_id = f.project_id
        AND pc.phase_id = f.phase_id
        AND pc.public_visible
       WHERE s.tenant_id = NEW.tenant_id
         AND s.project_id = NEW.project_id
         AND s.phase_id = NEW.phase_id
         AND s.is_active
         AND public.workspace_scope_is_active(NEW.tenant_id, NEW.project_id, NEW.phase_id)
         AND ((NEW.parcel_id IS NOT NULL AND pc.parcel_id = NEW.parcel_id)
           OR (NEW.map_feature_id IS NOT NULL AND f.identity_id = NEW.map_feature_id))
     ) THEN
    RAISE EXCEPTION 'The selected public map reference is not visible in the active published package.'
      USING errcode = '42501';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_public_inquiry_publication_state() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_public_inquiry_publication_state ON public.leads;
CREATE TRIGGER guard_public_inquiry_publication_state
  BEFORE INSERT OR UPDATE OF tenant_id, project_id, phase_id, parcel_id, map_feature_id, source
  ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.guard_public_inquiry_publication_state();

-- Storage policies use the path's exact tenant/project/phase. Super Admin may
-- manage recovery assets in inactive scopes; ordinary project managers must
-- use active scopes. A public bucket's object-download URL itself remains
-- public and is not made private by these mutation policies.
DROP POLICY IF EXISTS m36_project_map_asset_insert_state ON storage.objects;
CREATE POLICY m36_project_map_asset_insert_state ON storage.objects
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id <> 'project-map-public'
    OR CASE WHEN name ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/maps/[a-z0-9_-]+\.(webp|avif|png|jpe?g)$'
      THEN public.is_super_admin_user()
        OR public.workspace_scope_is_active(
          (storage.foldername(name))[1]::uuid,
          (storage.foldername(name))[2]::uuid,
          (storage.foldername(name))[3]::uuid
        )
      ELSE false END
  );
DROP POLICY IF EXISTS m36_project_map_asset_update_state ON storage.objects;
CREATE POLICY m36_project_map_asset_update_state ON storage.objects
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    bucket_id <> 'project-map-public'
    OR CASE WHEN name ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/maps/[a-z0-9_-]+\.(webp|avif|png|jpe?g)$'
      THEN public.is_super_admin_user()
        OR public.workspace_scope_is_active(
          (storage.foldername(name))[1]::uuid,
          (storage.foldername(name))[2]::uuid,
          (storage.foldername(name))[3]::uuid
        )
      ELSE false END
  )
  WITH CHECK (
    bucket_id <> 'project-map-public'
    OR CASE WHEN name ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/maps/[a-z0-9_-]+\.(webp|avif|png|jpe?g)$'
      THEN public.is_super_admin_user()
        OR public.workspace_scope_is_active(
          (storage.foldername(name))[1]::uuid,
          (storage.foldername(name))[2]::uuid,
          (storage.foldername(name))[3]::uuid
        )
      ELSE false END
  );
DROP POLICY IF EXISTS m36_project_map_asset_delete_state ON storage.objects;
CREATE POLICY m36_project_map_asset_delete_state ON storage.objects
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (
    bucket_id <> 'project-map-public'
    OR CASE WHEN name ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/maps/[a-z0-9_-]+\.(webp|avif|png|jpe?g)$'
      THEN public.is_super_admin_user()
        OR public.workspace_scope_is_active(
          (storage.foldername(name))[1]::uuid,
          (storage.foldername(name))[2]::uuid,
          (storage.foldername(name))[3]::uuid
        )
      ELSE false END
  );

DROP POLICY IF EXISTS m36_business_asset_insert_state ON storage.objects;
CREATE POLICY m36_business_asset_insert_state ON storage.objects
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id <> 'business-assets'
    OR public.is_super_admin_user()
    OR CASE
      WHEN (storage.foldername(name))[1] = 'company'
        THEN public.user_can_manage_tenant_workspace(public.get_current_user_tenant_id())
      WHEN (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
        THEN public.user_can_manage_tenant_workspace((storage.foldername(name))[1]::uuid)
      ELSE false
    END
  );
DROP POLICY IF EXISTS m36_business_asset_update_state ON storage.objects;
CREATE POLICY m36_business_asset_update_state ON storage.objects
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    bucket_id <> 'business-assets'
    OR public.is_super_admin_user()
    OR CASE
      WHEN (storage.foldername(name))[1] = 'company'
        THEN public.user_can_manage_tenant_workspace(public.get_current_user_tenant_id())
      WHEN (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
        THEN public.user_can_manage_tenant_workspace((storage.foldername(name))[1]::uuid)
      ELSE false
    END
  )
  WITH CHECK (
    bucket_id <> 'business-assets'
    OR public.is_super_admin_user()
    OR CASE
      WHEN (storage.foldername(name))[1] = 'company'
        THEN public.user_can_manage_tenant_workspace(public.get_current_user_tenant_id())
      WHEN (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
        THEN public.user_can_manage_tenant_workspace((storage.foldername(name))[1]::uuid)
      ELSE false
    END
  );
DROP POLICY IF EXISTS m36_business_asset_delete_state ON storage.objects;
CREATE POLICY m36_business_asset_delete_state ON storage.objects
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (
    bucket_id <> 'business-assets'
    OR public.is_super_admin_user()
    OR CASE
      WHEN (storage.foldername(name))[1] = 'company'
        THEN public.user_can_manage_tenant_workspace(public.get_current_user_tenant_id())
      WHEN (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
        THEN public.user_can_manage_tenant_workspace((storage.foldername(name))[1]::uuid)
      ELSE false
    END
  );

-- Business and finance documents are not Staff/Read Only previews. Existing
-- tenant and path linkage remains required by the older restrictive policy.
DROP POLICY IF EXISTS "Tenant staff read linked private files" ON storage.objects;
CREATE POLICY "Tenant admins read linked private files" ON storage.objects
  FOR SELECT TO authenticated USING (
    public.is_admin_user()
    AND (
      (bucket_id = 'contracts' AND EXISTS (
        SELECT 1 FROM public.contracts c
        WHERE public.user_has_tenant_access(c.tenant_id)
          AND c.signed_contract_file_path = storage.objects.name
      ))
      OR (bucket_id = 'receipts' AND EXISTS (
        SELECT 1 FROM public.transactions t
        WHERE public.user_has_tenant_access(t.tenant_id)
          AND (t.customer_id::text || '/' || t.receipt_number || '.pdf') = storage.objects.name
      ))
      OR (bucket_id = 'payment-documents' AND EXISTS (
        SELECT 1 FROM public.payment_documents d
        WHERE public.user_has_tenant_access(d.tenant_id)
          AND d.file_path = storage.objects.name
      ))
    )
  );

-- Private package objects remain available as authorized previews while a
-- phase is active. Existing Admin/Super Admin historical review remains
-- available, but all mutations and new package uploads require an active phase.
CREATE OR REPLACE FUNCTION public.can_access_map_package_asset(object_name text, manage boolean)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  parts text[];
  v_tenant uuid;
  v_project uuid;
  v_phase uuid;
BEGIN
  parts := string_to_array(object_name, '/');
  IF cardinality(parts) <> 4 OR parts[4] !~ '^[a-f0-9]{64}\.(png|jpg|webp)$'
     OR parts[1] !~* '^[0-9a-f-]{36}$'
     OR parts[2] !~* '^[0-9a-f-]{36}$'
     OR parts[3] !~* '^[0-9a-f-]{36}$' THEN
    RETURN false;
  END IF;
  v_tenant := parts[1]::uuid;
  v_project := parts[2]::uuid;
  v_phase := parts[3]::uuid;
  IF NOT public.workspace_scope_exists(v_tenant, v_project, v_phase)
     OR NOT public.user_has_project_access(v_tenant, v_project, v_phase) THEN
    RETURN false;
  END IF;
  RETURN NOT manage OR (
    public.is_admin_user()
    AND public.user_can_manage_project(v_tenant, v_project)
    AND public.workspace_scope_is_active(v_tenant, v_project, v_phase)
  );
EXCEPTION WHEN invalid_text_representation THEN
  RETURN false;
END;
$function$;
REVOKE ALL ON FUNCTION public.can_access_map_package_asset(text, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_map_package_asset(text, boolean) TO authenticated;

-- Every map-package mutation RPC funnels through this assertion. It confirms
-- current tenant, project, phase, role and active lifecycle immediately before
-- the routine changes package/inventory state.
CREATE OR REPLACE FUNCTION public.assert_map_package_scope(t uuid, p uuid, ph uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.is_admin_user()
     OR NOT public.user_can_manage_project(t, p)
     OR NOT public.user_has_project_access(t, p, ph)
     OR NOT public.workspace_scope_is_active(t, p, ph) THEN
    RAISE EXCEPTION 'An Admin with access to this active tenant, project and phase is required.'
      USING errcode = '42501';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.assert_map_package_scope(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_map_package_scope(uuid, uuid, uuid) TO authenticated, service_role;

-- Preserve the reviewed projection body but wrap it with a fresh active-scope,
-- active-snapshot, and explicit publication check. The previous implementation
-- exposed any active snapshot even when its package had never been published.
DO $rename_projection$
BEGIN
  IF to_regprocedure('public.get_published_project_map_package(uuid,uuid,uuid)') IS NOT NULL
     AND to_regprocedure('public.get_published_project_map_package_pre_m36(uuid,uuid,uuid)') IS NULL THEN
    ALTER FUNCTION public.get_published_project_map_package(uuid, uuid, uuid)
      RENAME TO get_published_project_map_package_pre_m36;
  END IF;
END;
$rename_projection$;
REVOKE ALL ON FUNCTION public.get_published_project_map_package_pre_m36(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.get_published_project_map_package(p_tenant_id uuid, p_project_id uuid, p_phase_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.get_published_project_map_package_pre_m36(p_tenant_id, p_project_id, p_phase_id)
  WHERE public.workspace_scope_is_active(p_tenant_id, p_project_id, p_phase_id)
    AND EXISTS (
      SELECT 1
      FROM public.project_map_packages pkg
      JOIN public.map_feature_snapshots snap
        ON snap.id = pkg.snapshot_id
       AND snap.tenant_id = pkg.tenant_id
       AND snap.project_id = pkg.project_id
       AND snap.phase_id = pkg.phase_id
       AND snap.is_active
      WHERE pkg.tenant_id = p_tenant_id
        AND pkg.project_id = p_project_id
        AND pkg.phase_id = p_phase_id
        AND pkg.published_at IS NOT NULL
    );
$function$;
REVOKE ALL ON FUNCTION public.get_published_project_map_package(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_published_project_map_package(uuid, uuid, uuid) TO service_role;

-- The service-only demo snapshot activator also needs a current active scope;
-- RLS cannot constrain a trusted service credential.
DO $rename_demo_activator$
BEGIN
  IF to_regprocedure('public.activate_project_demo_map_snapshot(uuid,uuid)') IS NOT NULL
     AND to_regprocedure('public.activate_project_demo_map_snapshot_pre_m36(uuid,uuid)') IS NULL THEN
    ALTER FUNCTION public.activate_project_demo_map_snapshot(uuid, uuid)
      RENAME TO activate_project_demo_map_snapshot_pre_m36;
  END IF;
END;
$rename_demo_activator$;
REVOKE ALL ON FUNCTION public.activate_project_demo_map_snapshot_pre_m36(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.activate_project_demo_map_snapshot(p_snapshot_id uuid, p_masterplan_version_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_tenant uuid;
  v_project uuid;
  v_phase uuid;
BEGIN
  SELECT s.tenant_id, s.project_id, s.phase_id
    INTO v_tenant, v_project, v_phase
  FROM public.map_feature_snapshots s
  WHERE s.id = p_snapshot_id;
  IF v_tenant IS NULL OR NOT public.workspace_scope_is_active(v_tenant, v_project, v_phase) THEN
    RAISE EXCEPTION 'Demo map activation requires an active, verified tenant/project/phase.'
      USING errcode = '42501';
  END IF;
  RETURN public.activate_project_demo_map_snapshot_pre_m36(p_snapshot_id, p_masterplan_version_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.activate_project_demo_map_snapshot(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_project_demo_map_snapshot(uuid, uuid) TO service_role;

COMMIT;
