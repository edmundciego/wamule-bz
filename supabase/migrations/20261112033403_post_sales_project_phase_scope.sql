-- Add verified project/phase ownership to post-sales tasks and checklists.
-- This is forward-only. Customers remain company-wide; sale references derive
-- the exact scope when one or more linked sale records agree.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_conflicts bigint;
BEGIN
  IF to_regclass('public.post_sales_tasks') IS NULL
     OR to_regclass('public.post_sales_checklists') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.development_phases') IS NULL
     OR to_regclass('public.customer_applications') IS NULL THEN
    RAISE EXCEPTION 'Post-sales project/phase repair requires the reconciled M3.6/M7.4 schema.';
  END IF;

  -- Do not silently choose among conflicting or cross-tenant sale parents.
  WITH linked_scopes AS (
    SELECT 'checklist'::text AS row_kind, c.id AS row_id, c.tenant_id AS row_tenant_id,
           a.tenant_id AS parent_tenant_id, a.project_id, a.phase_id
    FROM public.post_sales_checklists c JOIN public.applications a ON a.id = c.application_id
    UNION ALL
    SELECT 'checklist', c.id, c.tenant_id, x.tenant_id, x.project_id, x.phase_id
    FROM public.post_sales_checklists c JOIN public.contracts x ON x.id = c.contract_id
    UNION ALL
    SELECT 'checklist', c.id, c.tenant_id, l.tenant_id, l.project_id, l.phase_id
    FROM public.post_sales_checklists c JOIN public.leads l ON l.id = c.lead_id
    UNION ALL
    SELECT 'checklist', c.id, c.tenant_id, r.tenant_id, r.project_id, r.phase_id
    FROM public.post_sales_checklists c JOIN public.lot_reservations r ON r.id = c.reservation_id
    UNION ALL
    SELECT 'task', t.id, t.tenant_id, a.tenant_id, a.project_id, a.phase_id
    FROM public.post_sales_tasks t JOIN public.applications a ON a.id = t.application_id
    UNION ALL
    SELECT 'task', t.id, t.tenant_id, x.tenant_id, x.project_id, x.phase_id
    FROM public.post_sales_tasks t JOIN public.contracts x ON x.id = t.contract_id
    UNION ALL
    SELECT 'task', t.id, t.tenant_id, l.tenant_id, l.project_id, l.phase_id
    FROM public.post_sales_tasks t JOIN public.leads l ON l.id = t.lead_id
    UNION ALL
    SELECT 'task', t.id, t.tenant_id, r.tenant_id, r.project_id, r.phase_id
    FROM public.post_sales_tasks t JOIN public.lot_reservations r ON r.id = t.reservation_id
  ), conflicts AS (
    SELECT row_kind, row_id
    FROM linked_scopes
    GROUP BY row_kind, row_id
    HAVING bool_or(parent_tenant_id IS DISTINCT FROM row_tenant_id)
       OR count(DISTINCT (project_id, phase_id)) > 1
  )
  SELECT count(*) INTO v_conflicts FROM conflicts;

  IF v_conflicts > 0 THEN
    RAISE EXCEPTION 'Post-sales scope preflight found % rows with conflicting sale-parent scope; review count-only findings before retrying.', v_conflicts;
  END IF;
END;
$preflight$;

DO $customer_preflight$
DECLARE
  v_conflicts bigint;
BEGIN
  -- Keep an explicit post-sales customer aligned with every linked sale record.
  -- The application/customer association is represented by M7.4's verified
  -- customer_applications relation; other sale parents carry customer_id.
  WITH bad_refs AS (
    SELECT 'checklist'::text AS row_kind, c.id::text AS row_id
    FROM public.post_sales_checklists c
    JOIN public.applications a ON a.id = c.application_id AND a.tenant_id = c.tenant_id
    WHERE c.customer_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.customer_applications ca
      WHERE ca.tenant_id = c.tenant_id AND ca.customer_id = c.customer_id AND ca.application_id = a.id
    )
    UNION ALL
    SELECT 'checklist', c.id::text FROM public.post_sales_checklists c
    JOIN public.contracts x ON x.id = c.contract_id AND x.tenant_id = c.tenant_id
    WHERE c.customer_id IS NOT NULL AND x.customer_id IS DISTINCT FROM c.customer_id
    UNION ALL
    SELECT 'checklist', c.id::text FROM public.post_sales_checklists c
    JOIN public.leads l ON l.id = c.lead_id AND l.tenant_id = c.tenant_id
    WHERE c.customer_id IS NOT NULL AND l.customer_id IS DISTINCT FROM c.customer_id
    UNION ALL
    SELECT 'checklist', c.id::text FROM public.post_sales_checklists c
    JOIN public.lot_reservations r ON r.id = c.reservation_id AND r.tenant_id = c.tenant_id
    WHERE c.customer_id IS NOT NULL AND r.customer_id IS DISTINCT FROM c.customer_id
    UNION ALL
    SELECT 'task', t.id::text FROM public.post_sales_tasks t
    JOIN public.applications a ON a.id = t.application_id AND a.tenant_id = t.tenant_id
    WHERE t.customer_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.customer_applications ca
      WHERE ca.tenant_id = t.tenant_id AND ca.customer_id = t.customer_id AND ca.application_id = a.id
    )
    UNION ALL
    SELECT 'task', t.id::text FROM public.post_sales_tasks t
    JOIN public.contracts x ON x.id = t.contract_id AND x.tenant_id = t.tenant_id
    WHERE t.customer_id IS NOT NULL AND x.customer_id IS DISTINCT FROM t.customer_id
    UNION ALL
    SELECT 'task', t.id::text FROM public.post_sales_tasks t
    JOIN public.leads l ON l.id = t.lead_id AND l.tenant_id = t.tenant_id
    WHERE t.customer_id IS NOT NULL AND l.customer_id IS DISTINCT FROM t.customer_id
    UNION ALL
    SELECT 'task', t.id::text FROM public.post_sales_tasks t
    JOIN public.lot_reservations r ON r.id = t.reservation_id AND r.tenant_id = t.tenant_id
    WHERE t.customer_id IS NOT NULL AND r.customer_id IS DISTINCT FROM t.customer_id
  )
  SELECT count(*) INTO v_conflicts FROM (SELECT DISTINCT row_kind, row_id FROM bad_refs) conflicts;

  IF v_conflicts > 0 THEN
    RAISE EXCEPTION 'Post-sales customer preflight found % rows whose customer does not match a linked sale; review count-only findings before retrying.', v_conflicts;
  END IF;
END;
$customer_preflight$;

ALTER TABLE public.post_sales_checklists
  ADD COLUMN IF NOT EXISTS project_id uuid,
  ADD COLUMN IF NOT EXISTS phase_id uuid;
ALTER TABLE public.post_sales_tasks
  ADD COLUMN IF NOT EXISTS project_id uuid,
  ADD COLUMN IF NOT EXISTS phase_id uuid;

-- Backfill only when every linked sale parent has the same complete scope.
-- Customer-only, unscoped-parent, and ambiguous legacy rows remain NULL.
WITH source_scopes AS (
  SELECT c.id AS row_id, a.project_id, a.phase_id FROM public.post_sales_checklists c JOIN public.applications a ON a.id=c.application_id
  UNION ALL SELECT c.id, x.project_id, x.phase_id FROM public.post_sales_checklists c JOIN public.contracts x ON x.id=c.contract_id
  UNION ALL SELECT c.id, l.project_id, l.phase_id FROM public.post_sales_checklists c JOIN public.leads l ON l.id=c.lead_id
  UNION ALL SELECT c.id, r.project_id, r.phase_id FROM public.post_sales_checklists c JOIN public.lot_reservations r ON r.id=c.reservation_id
), one_scope AS (
  SELECT row_id, min(project_id::text)::uuid AS project_id, min(phase_id::text)::uuid AS phase_id
  FROM source_scopes
  GROUP BY row_id
  HAVING bool_and(project_id IS NOT NULL AND phase_id IS NOT NULL)
     AND count(DISTINCT project_id)=1 AND count(DISTINCT phase_id)=1
)
UPDATE public.post_sales_checklists c
SET project_id=s.project_id, phase_id=s.phase_id
FROM one_scope s
WHERE c.id=s.row_id AND c.project_id IS NULL AND c.phase_id IS NULL;

WITH source_scopes AS (
  SELECT t.id AS row_id, a.project_id, a.phase_id FROM public.post_sales_tasks t JOIN public.applications a ON a.id=t.application_id
  UNION ALL SELECT t.id, x.project_id, x.phase_id FROM public.post_sales_tasks t JOIN public.contracts x ON x.id=t.contract_id
  UNION ALL SELECT t.id, l.project_id, l.phase_id FROM public.post_sales_tasks t JOIN public.leads l ON l.id=t.lead_id
  UNION ALL SELECT t.id, r.project_id, r.phase_id FROM public.post_sales_tasks t JOIN public.lot_reservations r ON r.id=t.reservation_id
), one_scope AS (
  SELECT row_id, min(project_id::text)::uuid AS project_id, min(phase_id::text)::uuid AS phase_id
  FROM source_scopes
  GROUP BY row_id
  HAVING bool_and(project_id IS NOT NULL AND phase_id IS NOT NULL)
     AND count(DISTINCT project_id)=1 AND count(DISTINCT phase_id)=1
)
UPDATE public.post_sales_tasks t
SET project_id=s.project_id, phase_id=s.phase_id
FROM one_scope s
WHERE t.id=s.row_id AND t.project_id IS NULL AND t.phase_id IS NULL;

ALTER TABLE public.post_sales_checklists
  ADD CONSTRAINT post_sales_checklists_scope_pair_check
    CHECK ((project_id IS NULL) = (phase_id IS NULL)) NOT VALID,
  ADD CONSTRAINT post_sales_checklists_project_tenant_fkey
    FOREIGN KEY (project_id, tenant_id) REFERENCES public.projects(id, tenant_id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT post_sales_checklists_phase_scope_fkey
    FOREIGN KEY (phase_id, project_id, tenant_id) REFERENCES public.development_phases(id, project_id, tenant_id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.post_sales_tasks
  ADD CONSTRAINT post_sales_tasks_scope_pair_check
    CHECK ((project_id IS NULL) = (phase_id IS NULL)) NOT VALID,
  ADD CONSTRAINT post_sales_tasks_project_tenant_fkey
    FOREIGN KEY (project_id, tenant_id) REFERENCES public.projects(id, tenant_id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT post_sales_tasks_phase_scope_fkey
    FOREIGN KEY (phase_id, project_id, tenant_id) REFERENCES public.development_phases(id, project_id, tenant_id) ON DELETE RESTRICT NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS post_sales_checklists_id_scope_uq
  ON public.post_sales_checklists(id, tenant_id, project_id, phase_id);
CREATE UNIQUE INDEX IF NOT EXISTS post_sales_tasks_id_scope_uq
  ON public.post_sales_tasks(id, tenant_id, project_id, phase_id);
CREATE UNIQUE INDEX IF NOT EXISTS contracts_id_tenant_project_phase_customer_uq
  ON public.contracts(id, tenant_id, project_id, phase_id, customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS leads_id_tenant_project_phase_customer_uq
  ON public.leads(id, tenant_id, project_id, phase_id, customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS lot_reservations_id_tenant_project_phase_customer_uq
  ON public.lot_reservations(id, tenant_id, project_id, phase_id, customer_id);

ALTER TABLE public.post_sales_checklists
  ADD CONSTRAINT post_sales_checklists_application_phase_fkey
    FOREIGN KEY (application_id, tenant_id, project_id, phase_id)
    REFERENCES public.applications(id, tenant_id, project_id, phase_id) ON DELETE SET NULL (application_id) NOT VALID,
  ADD CONSTRAINT post_sales_checklists_contract_phase_fkey
    FOREIGN KEY (contract_id, tenant_id, project_id, phase_id)
    REFERENCES public.contracts(id, tenant_id, project_id, phase_id) ON DELETE SET NULL (contract_id) NOT VALID,
  ADD CONSTRAINT post_sales_checklists_lead_phase_fkey
    FOREIGN KEY (lead_id, tenant_id, project_id, phase_id)
    REFERENCES public.leads(id, tenant_id, project_id, phase_id) ON DELETE SET NULL (lead_id) NOT VALID,
  ADD CONSTRAINT post_sales_checklists_reservation_phase_fkey
    FOREIGN KEY (reservation_id, tenant_id, project_id, phase_id)
    REFERENCES public.lot_reservations(id, tenant_id, project_id, phase_id) ON DELETE SET NULL (reservation_id) NOT VALID,
  ADD CONSTRAINT post_sales_checklists_application_customer_fkey
    FOREIGN KEY (tenant_id, customer_id, application_id)
    REFERENCES public.customer_applications(tenant_id, customer_id, application_id) ON DELETE SET NULL (application_id) NOT VALID,
  ADD CONSTRAINT post_sales_checklists_contract_customer_fkey
    FOREIGN KEY (contract_id, tenant_id, project_id, phase_id, customer_id)
    REFERENCES public.contracts(id, tenant_id, project_id, phase_id, customer_id) ON DELETE SET NULL (contract_id) NOT VALID,
  ADD CONSTRAINT post_sales_checklists_lead_customer_fkey
    FOREIGN KEY (lead_id, tenant_id, project_id, phase_id, customer_id)
    REFERENCES public.leads(id, tenant_id, project_id, phase_id, customer_id) ON DELETE SET NULL (lead_id) NOT VALID,
  ADD CONSTRAINT post_sales_checklists_reservation_customer_fkey
    FOREIGN KEY (reservation_id, tenant_id, project_id, phase_id, customer_id)
    REFERENCES public.lot_reservations(id, tenant_id, project_id, phase_id, customer_id) ON DELETE SET NULL (reservation_id) NOT VALID;
ALTER TABLE public.post_sales_tasks
  ADD CONSTRAINT post_sales_tasks_application_phase_fkey
    FOREIGN KEY (application_id, tenant_id, project_id, phase_id)
    REFERENCES public.applications(id, tenant_id, project_id, phase_id) ON DELETE SET NULL (application_id) NOT VALID,
  ADD CONSTRAINT post_sales_tasks_contract_phase_fkey
    FOREIGN KEY (contract_id, tenant_id, project_id, phase_id)
    REFERENCES public.contracts(id, tenant_id, project_id, phase_id) ON DELETE SET NULL (contract_id) NOT VALID,
  ADD CONSTRAINT post_sales_tasks_lead_phase_fkey
    FOREIGN KEY (lead_id, tenant_id, project_id, phase_id)
    REFERENCES public.leads(id, tenant_id, project_id, phase_id) ON DELETE SET NULL (lead_id) NOT VALID,
  ADD CONSTRAINT post_sales_tasks_reservation_phase_fkey
    FOREIGN KEY (reservation_id, tenant_id, project_id, phase_id)
    REFERENCES public.lot_reservations(id, tenant_id, project_id, phase_id) ON DELETE SET NULL (reservation_id) NOT VALID,
  ADD CONSTRAINT post_sales_tasks_application_customer_fkey
    FOREIGN KEY (tenant_id, customer_id, application_id)
    REFERENCES public.customer_applications(tenant_id, customer_id, application_id) ON DELETE SET NULL (application_id) NOT VALID,
  ADD CONSTRAINT post_sales_tasks_contract_customer_fkey
    FOREIGN KEY (contract_id, tenant_id, project_id, phase_id, customer_id)
    REFERENCES public.contracts(id, tenant_id, project_id, phase_id, customer_id) ON DELETE SET NULL (contract_id) NOT VALID,
  ADD CONSTRAINT post_sales_tasks_lead_customer_fkey
    FOREIGN KEY (lead_id, tenant_id, project_id, phase_id, customer_id)
    REFERENCES public.leads(id, tenant_id, project_id, phase_id, customer_id) ON DELETE SET NULL (lead_id) NOT VALID,
  ADD CONSTRAINT post_sales_tasks_reservation_customer_fkey
    FOREIGN KEY (reservation_id, tenant_id, project_id, phase_id, customer_id)
    REFERENCES public.lot_reservations(id, tenant_id, project_id, phase_id, customer_id) ON DELETE SET NULL (reservation_id) NOT VALID;

ALTER TABLE public.post_sales_checklists
  VALIDATE CONSTRAINT post_sales_checklists_scope_pair_check,
  VALIDATE CONSTRAINT post_sales_checklists_project_tenant_fkey,
  VALIDATE CONSTRAINT post_sales_checklists_phase_scope_fkey,
  VALIDATE CONSTRAINT post_sales_checklists_application_phase_fkey,
  VALIDATE CONSTRAINT post_sales_checklists_contract_phase_fkey,
  VALIDATE CONSTRAINT post_sales_checklists_lead_phase_fkey,
  VALIDATE CONSTRAINT post_sales_checklists_reservation_phase_fkey,
  VALIDATE CONSTRAINT post_sales_checklists_application_customer_fkey,
  VALIDATE CONSTRAINT post_sales_checklists_contract_customer_fkey,
  VALIDATE CONSTRAINT post_sales_checklists_lead_customer_fkey,
  VALIDATE CONSTRAINT post_sales_checklists_reservation_customer_fkey;
ALTER TABLE public.post_sales_tasks
  VALIDATE CONSTRAINT post_sales_tasks_scope_pair_check,
  VALIDATE CONSTRAINT post_sales_tasks_project_tenant_fkey,
  VALIDATE CONSTRAINT post_sales_tasks_phase_scope_fkey,
  VALIDATE CONSTRAINT post_sales_tasks_application_phase_fkey,
  VALIDATE CONSTRAINT post_sales_tasks_contract_phase_fkey,
  VALIDATE CONSTRAINT post_sales_tasks_lead_phase_fkey,
  VALIDATE CONSTRAINT post_sales_tasks_reservation_phase_fkey,
  VALIDATE CONSTRAINT post_sales_tasks_application_customer_fkey,
  VALIDATE CONSTRAINT post_sales_tasks_contract_customer_fkey,
  VALIDATE CONSTRAINT post_sales_tasks_lead_customer_fkey,
  VALIDATE CONSTRAINT post_sales_tasks_reservation_customer_fkey;

CREATE INDEX IF NOT EXISTS post_sales_checklists_scope_updated_idx
  ON public.post_sales_checklists(tenant_id, project_id, phase_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS post_sales_tasks_scope_due_idx
  ON public.post_sales_tasks(tenant_id, project_id, phase_id, due_at);

CREATE OR REPLACE FUNCTION public.derive_post_sales_scope_from_sale_parents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_parent record;
  v_parent_count integer := 0;
  v_unscoped_parent boolean := false;
  v_project_id uuid;
  v_phase_id uuid;
BEGIN
  -- Scope-only changes and tenant reassignment are checked below; an unrelated
  -- status/notes update need not re-read linked rows. Composite FKs protect a
  -- changed sale reference even when the project/phase tuple is unchanged.
  IF TG_OP = 'UPDATE'
     AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
     AND NEW.phase_id IS NOT DISTINCT FROM OLD.phase_id THEN
    RETURN NEW;
  END IF;

  FOR v_parent IN
    SELECT a.tenant_id, a.project_id, a.phase_id FROM public.applications a
      WHERE a.id = NEW.application_id
    UNION ALL
    SELECT c.tenant_id, c.project_id, c.phase_id FROM public.contracts c
      WHERE c.id = NEW.contract_id
    UNION ALL
    SELECT l.tenant_id, l.project_id, l.phase_id FROM public.leads l
      WHERE l.id = NEW.lead_id
    UNION ALL
    SELECT r.tenant_id, r.project_id, r.phase_id FROM public.lot_reservations r
      WHERE r.id = NEW.reservation_id
  LOOP
    v_parent_count := v_parent_count + 1;
    IF v_parent.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Post-sales item and linked sale must belong to the same tenant.' USING ERRCODE = '23514';
    END IF;
    IF v_parent.project_id IS NULL OR v_parent.phase_id IS NULL THEN
      v_unscoped_parent := true;
    ELSIF v_project_id IS NULL THEN
      v_project_id := v_parent.project_id;
      v_phase_id := v_parent.phase_id;
    ELSIF v_project_id IS DISTINCT FROM v_parent.project_id
       OR v_phase_id IS DISTINCT FROM v_parent.phase_id THEN
      RAISE EXCEPTION 'Linked sale records have conflicting project or phase scope.' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF v_unscoped_parent THEN
    IF NEW.project_id IS NOT NULL OR NEW.phase_id IS NOT NULL THEN
      RAISE EXCEPTION 'A legacy sale parent without verified phase scope cannot be assigned to a workspace.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF v_parent_count > 0 THEN
    IF v_project_id IS NULL OR v_phase_id IS NULL THEN
      IF NEW.project_id IS NOT NULL OR NEW.phase_id IS NOT NULL THEN
        RAISE EXCEPTION 'Sale scope could not be verified from the linked parent.' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.project_id IS NULL AND NEW.phase_id IS NULL THEN
      NEW.project_id := v_project_id;
      NEW.phase_id := v_phase_id;
    ELSIF NEW.project_id IS DISTINCT FROM v_project_id
       OR NEW.phase_id IS DISTINCT FROM v_phase_id THEN
      RAISE EXCEPTION 'Post-sales item scope must match every linked sale parent.' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.project_id IS NOT NULL OR NEW.phase_id IS NOT NULL THEN
    RAISE EXCEPTION 'Project/phase scope requires at least one verified application, contract, lead, or reservation.' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;
COMMENT ON FUNCTION public.derive_post_sales_scope_from_sale_parents() IS
  'Trigger-only: derives one consistent project/phase from linked sales rows; company-only customer work remains unscoped.';
REVOKE ALL ON FUNCTION public.derive_post_sales_scope_from_sale_parents() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS post_sales_checklists_scope_guard ON public.post_sales_checklists;
CREATE TRIGGER post_sales_checklists_scope_guard
BEFORE INSERT OR UPDATE OF tenant_id, application_id, contract_id, lead_id, reservation_id, project_id, phase_id
ON public.post_sales_checklists
FOR EACH ROW EXECUTE FUNCTION public.derive_post_sales_scope_from_sale_parents();
DROP TRIGGER IF EXISTS post_sales_tasks_scope_guard ON public.post_sales_tasks;
CREATE TRIGGER post_sales_tasks_scope_guard
BEFORE INSERT OR UPDATE OF tenant_id, application_id, contract_id, lead_id, reservation_id, project_id, phase_id
ON public.post_sales_tasks
FOR EACH ROW EXECUTE FUNCTION public.derive_post_sales_scope_from_sale_parents();

-- Existing permissive policies remain, while these restrictive policies make
-- current M3.6 membership checks apply to the newly scoped columns.
DROP POLICY IF EXISTS post_sales_scope_select ON public.post_sales_checklists;
CREATE POLICY post_sales_scope_select ON public.post_sales_checklists AS RESTRICTIVE
FOR SELECT TO authenticated
USING (
  (project_id IS NOT NULL AND phase_id IS NOT NULL
    AND public.user_has_project_access(tenant_id, project_id, phase_id))
  OR (project_id IS NULL AND phase_id IS NULL
    AND public.user_can_manage_tenant_workspace(tenant_id))
);
DROP POLICY IF EXISTS post_sales_scope_insert ON public.post_sales_checklists;
CREATE POLICY post_sales_scope_insert ON public.post_sales_checklists AS RESTRICTIVE
FOR INSERT TO authenticated
WITH CHECK (
  (project_id IS NOT NULL AND phase_id IS NOT NULL
    AND public.user_can_write_project(tenant_id, project_id, phase_id))
  OR (project_id IS NULL AND phase_id IS NULL
    AND public.user_can_manage_tenant_workspace(tenant_id))
);
DROP POLICY IF EXISTS post_sales_scope_update ON public.post_sales_checklists;
CREATE POLICY post_sales_scope_update ON public.post_sales_checklists AS RESTRICTIVE
FOR UPDATE TO authenticated
USING (
  (project_id IS NOT NULL AND phase_id IS NOT NULL
    AND public.user_can_write_project(tenant_id, project_id, phase_id))
  OR (project_id IS NULL AND phase_id IS NULL
    AND public.user_can_manage_tenant_workspace(tenant_id))
)
WITH CHECK (
  (project_id IS NOT NULL AND phase_id IS NOT NULL
    AND public.user_can_write_project(tenant_id, project_id, phase_id))
  OR (project_id IS NULL AND phase_id IS NULL
    AND public.user_can_manage_tenant_workspace(tenant_id))
);
DROP POLICY IF EXISTS post_sales_scope_delete ON public.post_sales_checklists;
CREATE POLICY post_sales_scope_delete ON public.post_sales_checklists AS RESTRICTIVE
FOR DELETE TO authenticated
USING (public.user_can_manage_tenant_workspace(tenant_id));

DROP POLICY IF EXISTS post_sales_scope_select ON public.post_sales_tasks;
CREATE POLICY post_sales_scope_select ON public.post_sales_tasks AS RESTRICTIVE
FOR SELECT TO authenticated
USING (
  (project_id IS NOT NULL AND phase_id IS NOT NULL
    AND public.user_has_project_access(tenant_id, project_id, phase_id))
  OR (project_id IS NULL AND phase_id IS NULL
    AND public.user_can_manage_tenant_workspace(tenant_id))
);
DROP POLICY IF EXISTS post_sales_scope_insert ON public.post_sales_tasks;
CREATE POLICY post_sales_scope_insert ON public.post_sales_tasks AS RESTRICTIVE
FOR INSERT TO authenticated
WITH CHECK (
  (project_id IS NOT NULL AND phase_id IS NOT NULL
    AND public.user_can_write_project(tenant_id, project_id, phase_id))
  OR (project_id IS NULL AND phase_id IS NULL
    AND public.user_can_manage_tenant_workspace(tenant_id))
);
DROP POLICY IF EXISTS post_sales_scope_update ON public.post_sales_tasks;
CREATE POLICY post_sales_scope_update ON public.post_sales_tasks AS RESTRICTIVE
FOR UPDATE TO authenticated
USING (
  (project_id IS NOT NULL AND phase_id IS NOT NULL
    AND public.user_can_write_project(tenant_id, project_id, phase_id))
  OR (project_id IS NULL AND phase_id IS NULL
    AND public.user_can_manage_tenant_workspace(tenant_id))
)
WITH CHECK (
  (project_id IS NOT NULL AND phase_id IS NOT NULL
    AND public.user_can_write_project(tenant_id, project_id, phase_id))
  OR (project_id IS NULL AND phase_id IS NULL
    AND public.user_can_manage_tenant_workspace(tenant_id))
);
DROP POLICY IF EXISTS post_sales_scope_delete ON public.post_sales_tasks;
CREATE POLICY post_sales_scope_delete ON public.post_sales_tasks AS RESTRICTIVE
FOR DELETE TO authenticated
USING (public.user_can_manage_tenant_workspace(tenant_id));

COMMENT ON COLUMN public.post_sales_checklists.project_id IS 'Verified project scope derived from linked sale parents; NULL is tenant-shared/legacy and restricted to workspace managers.';
COMMENT ON COLUMN public.post_sales_checklists.phase_id IS 'Verified phase scope derived from linked sale parents; NULL with project_id NULL is tenant-shared/legacy.';
COMMENT ON COLUMN public.post_sales_tasks.project_id IS 'Verified project scope derived from linked sale parents; NULL is tenant-shared/legacy and restricted to workspace managers.';
COMMENT ON COLUMN public.post_sales_tasks.phase_id IS 'Verified phase scope derived from linked sale parents; NULL with project_id NULL is tenant-shared/legacy.';

COMMIT;
