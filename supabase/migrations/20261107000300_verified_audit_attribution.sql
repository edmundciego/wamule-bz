-- M3.5: bind audit events to their verified target and commit them atomically.
-- Historical rows are preserved as legacy rows. Their old tenant_id values
-- are not copied into target_tenant_id because the former default trigger may
-- have attributed them to the actor profile or default-client.

BEGIN;

CREATE SCHEMA IF NOT EXISTS audit_private;
REVOKE ALL ON SCHEMA audit_private FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE audit_private.verified_operation_context (
  backend_pid integer NOT NULL,
  transaction_id bigint NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('workspace_member', 'reservation_settings')),
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  target_tenant_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  PRIMARY KEY (backend_pid, transaction_id, purpose)
);
REVOKE ALL ON TABLE audit_private.verified_operation_context FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.audit_events
  ADD COLUMN IF NOT EXISTS target_tenant_id uuid,
  ADD COLUMN IF NOT EXISTS target_project_id uuid,
  ADD COLUMN IF NOT EXISTS target_phase_id uuid,
  ADD COLUMN IF NOT EXISTS actor_kind text NOT NULL DEFAULT 'legacy';

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_events_target_tenant_fk'
      AND conrelid = 'public.audit_events'::regclass
  ) THEN
    ALTER TABLE public.audit_events
      ADD CONSTRAINT audit_events_target_tenant_fk
      FOREIGN KEY (target_tenant_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_events_target_project_fk'
      AND conrelid = 'public.audit_events'::regclass
  ) THEN
    ALTER TABLE public.audit_events
      ADD CONSTRAINT audit_events_target_project_fk
      FOREIGN KEY (target_project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_events_target_phase_fk'
      AND conrelid = 'public.audit_events'::regclass
  ) THEN
    ALTER TABLE public.audit_events
      ADD CONSTRAINT audit_events_target_phase_fk
      FOREIGN KEY (target_phase_id) REFERENCES public.development_phases(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_events_target_tenant_matches_legacy_tenant'
      AND conrelid = 'public.audit_events'::regclass
  ) THEN
    ALTER TABLE public.audit_events
      ADD CONSTRAINT audit_events_target_tenant_matches_legacy_tenant
      CHECK (target_tenant_id IS NULL OR tenant_id = target_tenant_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_events_phase_requires_project'
      AND conrelid = 'public.audit_events'::regclass
  ) THEN
    ALTER TABLE public.audit_events
      ADD CONSTRAINT audit_events_phase_requires_project
      CHECK (target_phase_id IS NULL OR target_project_id IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_events_actor_kind_valid'
      AND conrelid = 'public.audit_events'::regclass
  ) THEN
    ALTER TABLE public.audit_events
      ADD CONSTRAINT audit_events_actor_kind_valid
      CHECK (actor_kind IN ('human', 'service', 'system', 'legacy'));
  END IF;
END;
$migration$;

CREATE INDEX IF NOT EXISTS idx_audit_events_target_tenant_created
  ON public.audit_events(target_tenant_id, created_at DESC)
  WHERE target_tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_events_target_scope
  ON public.audit_events(target_project_id, target_phase_id, created_at DESC)
  WHERE target_phase_id IS NOT NULL;

COMMENT ON COLUMN public.audit_events.tenant_id IS
  'Compatibility tenant column. For new rows it equals target_tenant_id; legacy rows retain their historical value without claiming it is a verified target.';
COMMENT ON COLUMN public.audit_events.target_tenant_id IS
  'Verified target workspace, distinct from actor_user_id. NULL only on preserved legacy events whose original target cannot be reconstructed.';
COMMENT ON COLUMN public.audit_events.target_project_id IS
  'Verified project scope when the operation concerns a project; NULL for company-wide operations.';
COMMENT ON COLUMN public.audit_events.target_phase_id IS
  'Verified phase scope when the operation concerns a phase; NULL for company-wide or project-wide operations.';
COMMENT ON COLUMN public.audit_events.actor_kind IS
  'human for a verified Wamule actor, service/system for a trusted server operation without a verified human initiator, and legacy for preserved pre-M3.5 rows.';

-- Do not let the historical tenant default silently assign future audit rows
-- to the actor's profile tenant or the default-client workspace.
DROP TRIGGER IF EXISTS trg_set_default_tenant_id ON public.audit_events;

CREATE OR REPLACE FUNCTION audit_private.keep_json_keys(p_value jsonb, p_keys text[])
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $function$
  SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
  FROM jsonb_each(COALESCE(p_value, '{}'::jsonb)) AS entry(key, value)
  WHERE entry.key = ANY (p_keys)
$function$;
REVOKE ALL ON FUNCTION audit_private.keep_json_keys(jsonb, text[]) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION audit_private.merge_audit_scope(
  p_current_tenant_id uuid,
  p_current_project_id uuid,
  p_current_phase_id uuid,
  p_parent_tenant_id uuid,
  p_parent_project_id uuid,
  p_parent_phase_id uuid
)
RETURNS TABLE (tenant_id uuid, project_id uuid, phase_id uuid)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $function$
BEGIN
  IF p_parent_tenant_id IS NULL THEN
    RAISE EXCEPTION 'An audited parent record has no verified tenant.';
  END IF;
  IF p_current_tenant_id IS NOT NULL AND p_current_tenant_id IS DISTINCT FROM p_parent_tenant_id THEN
    RAISE EXCEPTION 'The audited record links to a parent in another tenant.';
  END IF;
  IF p_current_project_id IS NOT NULL AND p_parent_project_id IS NOT NULL
     AND p_current_project_id IS DISTINCT FROM p_parent_project_id THEN
    RAISE EXCEPTION 'The audited record links to records in different projects.';
  END IF;
  IF p_current_phase_id IS NOT NULL AND p_parent_phase_id IS NOT NULL
     AND p_current_phase_id IS DISTINCT FROM p_parent_phase_id THEN
    RAISE EXCEPTION 'The audited record links to records in different phases.';
  END IF;
  tenant_id := COALESCE(p_current_tenant_id, p_parent_tenant_id);
  project_id := COALESCE(p_current_project_id, p_parent_project_id);
  phase_id := COALESCE(p_current_phase_id, p_parent_phase_id);
  IF phase_id IS NOT NULL AND project_id IS NULL THEN
    RAISE EXCEPTION 'A verified audit phase requires its project.';
  END IF;
  RETURN NEXT;
END;
$function$;
REVOKE ALL ON FUNCTION audit_private.merge_audit_scope(uuid, uuid, uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION audit_private.resolve_audit_scope(p_entity_type text, p_entity_id text)
RETURNS TABLE (tenant_id uuid, project_id uuid, phase_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_tenant_id uuid;
  v_project_id uuid;
  v_phase_id uuid;
  v_link_id bigint;
  v_parent_scope record;
  v_reservation public.lot_reservations%rowtype;
  v_post_sales record;
BEGIN
  IF p_entity_id IS NULL THEN
    RETURN;
  END IF;

  CASE p_entity_type
    WHEN 'lead' THEN
      SELECT l.tenant_id, l.project_id, l.phase_id
        INTO v_tenant_id, v_project_id, v_phase_id
      FROM public.leads AS l WHERE l.id = p_entity_id::uuid;
    WHEN 'application' THEN
      SELECT a.tenant_id, a.project_id, a.phase_id
        INTO v_tenant_id, v_project_id, v_phase_id
      FROM public.applications AS a WHERE a.id = p_entity_id::bigint;
    WHEN 'parcel' THEN
      SELECT p.tenant_id, p.project_id, p.phase_id
        INTO v_tenant_id, v_project_id, v_phase_id
      FROM public.parcels AS p WHERE p.id = p_entity_id::bigint;
    WHEN 'customer' THEN
      SELECT c.tenant_id, NULL::uuid, NULL::uuid
        INTO v_tenant_id, v_project_id, v_phase_id
      FROM public.customers AS c WHERE c.id = p_entity_id::bigint;
    WHEN 'contract' THEN
      SELECT c.tenant_id, p.project_id, p.phase_id
        INTO v_tenant_id, v_project_id, v_phase_id
      FROM public.contracts AS c
      LEFT JOIN public.parcels AS p ON p.id = c.parcel_id AND p.tenant_id = c.tenant_id
      WHERE c.id = p_entity_id::bigint;
      IF FOUND AND EXISTS (
        SELECT 1 FROM public.contracts AS c
        WHERE c.id = p_entity_id::bigint AND c.parcel_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.parcels AS p WHERE p.id = c.parcel_id AND p.tenant_id = c.tenant_id)
      ) THEN
        RAISE EXCEPTION 'The audited contract has a missing or cross-tenant parcel.';
      END IF;
    WHEN 'payment' THEN
      SELECT t.tenant_id, p.project_id, p.phase_id, t.contract_id
        INTO v_tenant_id, v_project_id, v_phase_id, v_link_id
      FROM public.transactions AS t
      LEFT JOIN public.contracts AS c ON c.id = t.contract_id AND c.tenant_id = t.tenant_id
      LEFT JOIN public.parcels AS p ON p.id = c.parcel_id AND p.tenant_id = c.tenant_id
      WHERE t.id = p_entity_id::bigint;
      IF FOUND AND v_link_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.contracts AS c WHERE c.id = v_link_id AND c.tenant_id = v_tenant_id
      ) THEN
        RAISE EXCEPTION 'The audited payment has a missing or cross-tenant contract.';
      END IF;
    WHEN 'payment_request' THEN
      SELECT r.tenant_id, p.project_id, p.phase_id, r.contract_id
        INTO v_tenant_id, v_project_id, v_phase_id, v_link_id
      FROM public.payment_requests AS r
      LEFT JOIN public.contracts AS c ON c.id = r.contract_id AND c.tenant_id = r.tenant_id
      LEFT JOIN public.parcels AS p ON p.id = c.parcel_id AND p.tenant_id = c.tenant_id
      WHERE r.id = p_entity_id::bigint;
      IF FOUND AND v_link_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.contracts AS c WHERE c.id = v_link_id AND c.tenant_id = v_tenant_id
      ) THEN
        RAISE EXCEPTION 'The audited payment request has a missing or cross-tenant contract.';
      END IF;
    WHEN 'reservation' THEN
      SELECT r.* INTO v_reservation FROM public.lot_reservations AS r WHERE r.id = p_entity_id::uuid;
      IF NOT FOUND THEN RETURN; END IF;
      v_tenant_id := v_reservation.tenant_id;
      v_project_id := NULL;
      v_phase_id := NULL;
      IF v_reservation.customer_id IS NOT NULL THEN
        SELECT c.tenant_id, NULL::uuid AS project_id, NULL::uuid AS phase_id INTO v_parent_scope
        FROM public.customers AS c WHERE c.id = v_reservation.customer_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited reservation has a missing customer.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_reservation.lead_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('lead', v_reservation.lead_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited reservation has a missing lead.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_reservation.application_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('application', v_reservation.application_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited reservation has a missing application.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_reservation.parcel_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('parcel', v_reservation.parcel_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited reservation has a missing parcel.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_reservation.payment_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('payment', v_reservation.payment_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited reservation has a missing payment.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_reservation.converted_application_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('application', v_reservation.converted_application_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited reservation has a missing converted application.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_reservation.converted_contract_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('contract', v_reservation.converted_contract_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited reservation has a missing converted contract.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
    WHEN 'document' THEN
      SELECT d.tenant_id, p.project_id, p.phase_id, d.transaction_id
        INTO v_tenant_id, v_project_id, v_phase_id, v_link_id
      FROM public.payment_documents AS d
      LEFT JOIN public.transactions AS t ON t.id = d.transaction_id AND t.tenant_id = d.tenant_id
      LEFT JOIN public.contracts AS c ON c.id = t.contract_id AND c.tenant_id = t.tenant_id
      LEFT JOIN public.parcels AS p ON p.id = c.parcel_id AND p.tenant_id = c.tenant_id
      WHERE d.id = p_entity_id::bigint;
      IF FOUND AND v_link_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.transactions AS t WHERE t.id = v_link_id AND t.tenant_id = v_tenant_id
      ) THEN
        RAISE EXCEPTION 'The audited payment document has a missing or cross-tenant transaction.';
      END IF;
    WHEN 'post_sales_checklist' THEN
      SELECT * INTO v_post_sales FROM public.post_sales_checklists AS x WHERE x.id = p_entity_id::uuid;
      IF NOT FOUND THEN RETURN; END IF;
      v_tenant_id := v_post_sales.tenant_id;
      v_project_id := NULL;
      v_phase_id := NULL;
      IF v_post_sales.customer_id IS NOT NULL THEN
        SELECT c.tenant_id, NULL::uuid AS project_id, NULL::uuid AS phase_id INTO v_parent_scope
        FROM public.customers AS c WHERE c.id = v_post_sales.customer_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited checklist has a missing customer.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_post_sales.application_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('application', v_post_sales.application_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited checklist has a missing application.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_post_sales.contract_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('contract', v_post_sales.contract_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited checklist has a missing contract.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_post_sales.lead_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('lead', v_post_sales.lead_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited checklist has a missing lead.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_post_sales.reservation_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('reservation', v_post_sales.reservation_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited checklist has a missing reservation.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
    WHEN 'post_sales_task' THEN
      SELECT * INTO v_post_sales FROM public.post_sales_tasks AS x WHERE x.id = p_entity_id::uuid;
      IF NOT FOUND THEN RETURN; END IF;
      v_tenant_id := v_post_sales.tenant_id;
      v_project_id := NULL;
      v_phase_id := NULL;
      IF v_post_sales.customer_id IS NOT NULL THEN
        SELECT c.tenant_id, NULL::uuid AS project_id, NULL::uuid AS phase_id INTO v_parent_scope
        FROM public.customers AS c WHERE c.id = v_post_sales.customer_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited task has a missing customer.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_post_sales.application_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('application', v_post_sales.application_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited task has a missing application.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_post_sales.contract_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('contract', v_post_sales.contract_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited task has a missing contract.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_post_sales.lead_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('lead', v_post_sales.lead_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited task has a missing lead.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_post_sales.reservation_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('reservation', v_post_sales.reservation_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited task has a missing reservation.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
    WHEN 'ai_summary' THEN
      SELECT x.tenant_id, x.checklist_id, x.customer_id, x.application_id, x.contract_id, x.lead_id, x.reservation_id
        INTO v_post_sales FROM public.post_sales_ai_summaries AS x WHERE x.id = p_entity_id::uuid;
      IF NOT FOUND THEN RETURN; END IF;
      SELECT s.* INTO v_parent_scope
      FROM audit_private.resolve_audit_scope('post_sales_checklist', v_post_sales.checklist_id::text) AS s;
      IF NOT FOUND THEN RAISE EXCEPTION 'The audited AI summary has a missing checklist.'; END IF;
      v_tenant_id := v_post_sales.tenant_id;
      v_project_id := NULL;
      v_phase_id := NULL;
      SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
      FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
        v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      IF v_post_sales.customer_id IS NOT NULL THEN
        SELECT c.tenant_id, NULL::uuid AS project_id, NULL::uuid AS phase_id INTO v_parent_scope
        FROM public.customers AS c WHERE c.id = v_post_sales.customer_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited AI summary has a missing customer.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_post_sales.application_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('application', v_post_sales.application_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited AI summary has a missing application.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_post_sales.contract_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('contract', v_post_sales.contract_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited AI summary has a missing contract.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_post_sales.lead_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('lead', v_post_sales.lead_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited AI summary has a missing lead.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
      IF v_post_sales.reservation_id IS NOT NULL THEN
        SELECT s.* INTO v_parent_scope FROM audit_private.resolve_audit_scope('reservation', v_post_sales.reservation_id::text) AS s;
        IF NOT FOUND THEN RAISE EXCEPTION 'The audited AI summary has a missing reservation.'; END IF;
        SELECT s.tenant_id, s.project_id, s.phase_id INTO v_tenant_id, v_project_id, v_phase_id
        FROM audit_private.merge_audit_scope(v_tenant_id, v_project_id, v_phase_id,
          v_parent_scope.tenant_id, v_parent_scope.project_id, v_parent_scope.phase_id) AS s;
      END IF;
    ELSE
      RAISE EXCEPTION 'No verified audit scope resolver exists for entity type %.', p_entity_type;
  END CASE;

  IF v_tenant_id IS NULL THEN
    RETURN;
  END IF;
  tenant_id := v_tenant_id;
  project_id := v_project_id;
  phase_id := v_phase_id;
  RETURN NEXT;
END;
$function$;
REVOKE ALL ON FUNCTION audit_private.resolve_audit_scope(text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.can_read_audit_event(
  p_target_tenant_id uuid,
  p_target_project_id uuid,
  p_target_phase_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_role text;
  v_tenant_id uuid;
BEGIN
  SELECT ap.role::text, ap.tenant_id
    INTO v_role, v_tenant_id
  FROM public.admin_profiles AS ap
  WHERE ap.user_id = auth.uid();
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_role = 'Super Admin' THEN
    RETURN true;
  END IF;
  IF p_target_tenant_id IS NULL OR v_tenant_id IS DISTINCT FROM p_target_tenant_id THEN
    RETURN false;
  END IF;
  IF v_role = 'Admin' THEN
    RETURN true;
  END IF;
  IF v_role IN ('Staff', 'Read Only') THEN
    RETURN p_target_project_id IS NOT NULL
       AND p_target_phase_id IS NOT NULL
       AND public.user_has_project_access(p_target_tenant_id, p_target_project_id, p_target_phase_id);
  END IF;
  RETURN false;
END;
$function$;
REVOKE ALL ON FUNCTION public.can_read_audit_event(uuid, uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.can_read_audit_event(uuid, uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_verified_audit_attribution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_request_role text := NULLIF(current_setting('request.jwt.claim.role', true), '');
  v_actor_id uuid;
  v_actor_name text;
  v_actor_email text;
  v_actor_role text;
  v_actor_tenant_id uuid;
  v_source_tenant_id uuid;
  v_source_project_id uuid;
  v_source_phase_id uuid;
  v_target_tenant_id uuid;
  v_target_project_id uuid;
  v_target_phase_id uuid;
  v_context record;
  v_scope_from_record boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Audit events are append-only.';
  END IF;

  IF v_request_role = 'authenticated' OR (v_request_role IS NULL AND auth.uid() IS NOT NULL) THEN
    v_actor_id := auth.uid();
    IF v_actor_id IS NULL OR (NEW.actor_user_id IS NOT NULL AND NEW.actor_user_id IS DISTINCT FROM v_actor_id) THEN
      RAISE EXCEPTION 'The audit actor must be the current authenticated user.';
    END IF;
    SELECT ap.full_name, ap.email, ap.role::text, ap.tenant_id
      INTO v_actor_name, v_actor_email, v_actor_role, v_actor_tenant_id
    FROM public.admin_profiles AS ap WHERE ap.user_id = v_actor_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The authenticated audit actor has no active Wamule profile.';
    END IF;
    IF NEW.actor_name IS NOT NULL AND NEW.actor_name IS DISTINCT FROM v_actor_name THEN
      RAISE EXCEPTION 'The audit actor name must come from the current profile.';
    END IF;
    IF NEW.actor_email IS NOT NULL AND lower(NEW.actor_email) IS DISTINCT FROM lower(v_actor_email) THEN
      RAISE EXCEPTION 'The audit actor email must come from the current profile.';
    END IF;
    NEW.actor_user_id := v_actor_id;
    NEW.actor_name := v_actor_name;
    NEW.actor_email := v_actor_email;
    NEW.actor_kind := 'human';
  ELSIF v_request_role = 'service_role' THEN
    SELECT c.actor_id, c.target_tenant_id
      INTO v_context
    FROM audit_private.verified_operation_context AS c
    WHERE c.backend_pid = pg_catalog.pg_backend_pid()
      AND c.transaction_id = pg_catalog.txid_current()
      AND c.purpose = 'workspace_member';
    IF FOUND THEN
      v_actor_id := v_context.actor_id;
      IF NEW.actor_user_id IS NOT NULL AND NEW.actor_user_id IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION 'The server audit actor does not match its verified operation context.';
      END IF;
      SELECT ap.full_name, ap.email, ap.role::text, ap.tenant_id
        INTO v_actor_name, v_actor_email, v_actor_role, v_actor_tenant_id
      FROM public.admin_profiles AS ap WHERE ap.user_id = v_actor_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'The verified server actor has no active Wamule profile.';
      END IF;
      NEW.actor_user_id := v_actor_id;
      NEW.actor_name := v_actor_name;
      NEW.actor_email := v_actor_email;
      NEW.actor_kind := 'human';
    ELSE
      IF NEW.actor_user_id IS NOT NULL THEN
        RAISE EXCEPTION 'A service event cannot claim a human actor without a verified operation context.';
      END IF;
      NEW.actor_user_id := NULL;
      NEW.actor_name := 'Service operation';
      NEW.actor_email := NULL;
      NEW.actor_kind := 'service';
    END IF;
  ELSE
    RAISE EXCEPTION 'Audit events require an authenticated actor or trusted service operation.';
  END IF;

  IF NEW.entity_id IS NOT NULL AND NEW.entity_type NOT IN ('user') THEN
    SELECT resolved.tenant_id, resolved.project_id, resolved.phase_id
      INTO v_source_tenant_id, v_source_project_id, v_source_phase_id
    FROM audit_private.resolve_audit_scope(NEW.entity_type, NEW.entity_id) AS resolved;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The audit entity does not resolve to an existing verified record.';
    END IF;
    v_scope_from_record := true;
  END IF;

  v_target_tenant_id := CASE WHEN v_scope_from_record THEN v_source_tenant_id ELSE NEW.target_tenant_id END;
  v_target_project_id := CASE WHEN v_scope_from_record THEN v_source_project_id ELSE NEW.target_project_id END;
  v_target_phase_id := CASE WHEN v_scope_from_record THEN v_source_phase_id ELSE NEW.target_phase_id END;

  IF v_target_tenant_id IS NULL THEN
    RAISE EXCEPTION 'A new audit event must identify its verified target tenant.';
  END IF;
  IF v_scope_from_record AND NEW.target_tenant_id IS NOT NULL
     AND NEW.target_tenant_id IS DISTINCT FROM v_source_tenant_id THEN
    RAISE EXCEPTION 'The audit target tenant does not match the referenced record.';
  END IF;
  IF v_scope_from_record AND NEW.target_project_id IS NOT NULL
     AND NEW.target_project_id IS DISTINCT FROM v_source_project_id THEN
    RAISE EXCEPTION 'The audit target project does not match the referenced record.';
  END IF;
  IF v_scope_from_record AND NEW.target_phase_id IS NOT NULL
     AND NEW.target_phase_id IS DISTINCT FROM v_source_phase_id THEN
    RAISE EXCEPTION 'The audit target phase does not match the referenced record.';
  END IF;
  IF NEW.tenant_id IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM v_target_tenant_id THEN
    RAISE EXCEPTION 'The compatibility tenant_id must equal the verified target tenant.';
  END IF;

  IF NEW.entity_type IN ('customer', 'settings', 'user')
     AND (v_target_project_id IS NOT NULL OR v_target_phase_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Tenant-shared audit operations cannot inherit an arbitrary project or phase.';
  END IF;

  IF v_target_project_id IS NOT NULL THEN
    PERFORM 1 FROM public.projects AS p
    WHERE p.id = v_target_project_id AND p.tenant_id = v_target_tenant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The audit project does not belong to the verified target tenant.';
    END IF;
  END IF;
  IF v_target_phase_id IS NOT NULL THEN
    IF v_target_project_id IS NULL THEN
      RAISE EXCEPTION 'A target phase requires a verified project.';
    END IF;
    PERFORM 1 FROM public.development_phases AS ph
    WHERE ph.id = v_target_phase_id
      AND ph.project_id = v_target_project_id
      AND ph.tenant_id = v_target_tenant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The audit phase does not belong to the verified project and tenant.';
    END IF;
  END IF;

  IF v_request_role = 'authenticated' OR (v_request_role IS NULL AND auth.uid() IS NOT NULL) THEN
    IF NEW.entity_type IN ('settings', 'user', 'system') THEN
      IF v_actor_role <> 'Super Admin'
         AND (v_actor_role <> 'Admin' OR v_actor_tenant_id IS DISTINCT FROM v_target_tenant_id) THEN
        RAISE EXCEPTION 'This tenant-wide audit operation requires a Tenant Admin or Super Admin for the verified target.';
      END IF;
      IF NEW.entity_type = 'user' AND NOT EXISTS (
        SELECT 1 FROM audit_private.verified_operation_context AS c
        WHERE c.backend_pid = pg_catalog.pg_backend_pid()
          AND c.transaction_id = pg_catalog.txid_current()
          AND c.purpose = 'workspace_member'
          AND c.actor_id = v_actor_id
          AND c.target_tenant_id = v_target_tenant_id
      ) THEN
        RAISE EXCEPTION 'Workspace membership events require the atomic membership operation.';
      END IF;
      IF NEW.entity_type = 'user' THEN
        DELETE FROM audit_private.verified_operation_context AS c
        WHERE c.backend_pid = pg_catalog.pg_backend_pid()
          AND c.transaction_id = pg_catalog.txid_current()
          AND c.purpose = 'workspace_member'
          AND c.actor_id = v_actor_id
          AND c.target_tenant_id = v_target_tenant_id;
      END IF;
    ELSIF v_actor_role <> 'Super Admin' AND v_actor_tenant_id IS DISTINCT FROM v_target_tenant_id THEN
      RAISE EXCEPTION 'The authenticated actor cannot create an event for another tenant.';
    END IF;
  END IF;

  IF v_request_role = 'service_role' AND NEW.actor_kind = 'human' THEN
    IF v_context.target_tenant_id IS DISTINCT FROM v_target_tenant_id THEN
      RAISE EXCEPTION 'The verified service actor is not authorized for this target tenant.';
    END IF;
    DELETE FROM audit_private.verified_operation_context AS c
    WHERE c.backend_pid = pg_catalog.pg_backend_pid()
      AND c.transaction_id = pg_catalog.txid_current()
      AND c.purpose = 'workspace_member';
  END IF;

  NEW.target_tenant_id := v_target_tenant_id;
  NEW.target_project_id := v_target_project_id;
  NEW.target_phase_id := v_target_phase_id;
  NEW.tenant_id := v_target_tenant_id;

  -- Keep the audit useful while discarding free-text notes, document paths,
  -- bank/receipt identifiers, contact details and other sensitive row fields.
  IF NEW.entity_type = 'payment' THEN
    NEW.before_data := audit_private.keep_json_keys(NEW.before_data, ARRAY['status','amount','transaction_type','collection_method','receipt_date','created_at']);
    NEW.after_data := audit_private.keep_json_keys(NEW.after_data, ARRAY['status','amount','transaction_type','collection_method','receipt_date','created_at']);
    NEW.metadata := audit_private.keep_json_keys(NEW.metadata, ARRAY['amount','transaction_type','collection_method','linked_posted_payment_count','linked_posted_payment_total','confidence','customer_matched']);
  ELSIF NEW.entity_type = 'contract' THEN
    NEW.before_data := audit_private.keep_json_keys(NEW.before_data, ARRAY['status','is_active','final_purchase_price','term_months','start_date','payment_due_day']);
    NEW.after_data := audit_private.keep_json_keys(NEW.after_data, ARRAY['status','is_active','final_purchase_price','term_months','start_date','payment_due_day']);
    NEW.metadata := audit_private.keep_json_keys(NEW.metadata, ARRAY['final_purchase_price','linked_posted_payment_count','linked_posted_payment_total','resolution_type']);
  ELSIF NEW.entity_type = 'reservation' THEN
    NEW.before_data := audit_private.keep_json_keys(NEW.before_data, ARRAY['status','deposit_status','released_at']);
    NEW.after_data := audit_private.keep_json_keys(NEW.after_data, ARRAY['status','deposit_status','released_at']);
    NEW.metadata := audit_private.keep_json_keys(NEW.metadata, ARRAY['primary_reservation_id']);
  ELSIF NEW.entity_type = 'parcel' THEN
    NEW.before_data := audit_private.keep_json_keys(NEW.before_data, ARRAY['parcel_status','resolution_status']);
    NEW.after_data := audit_private.keep_json_keys(NEW.after_data, ARRAY['parcel_status','resolution_status','resolution_type']);
    NEW.metadata := audit_private.keep_json_keys(NEW.metadata, ARRAY['resolution_status','resolution_type']);
  ELSIF NEW.entity_type = 'settings' THEN
    NEW.before_data := audit_private.keep_json_keys(NEW.before_data, ARRAY['setting_key']);
    NEW.after_data := audit_private.keep_json_keys(NEW.after_data, ARRAY['setting_key']);
    NEW.metadata := audit_private.keep_json_keys(NEW.metadata, ARRAY['setting_key']);
  ELSIF NEW.entity_type = 'user' THEN
    NEW.before_data := audit_private.keep_json_keys(NEW.before_data, ARRAY['role']);
    NEW.after_data := audit_private.keep_json_keys(NEW.after_data, ARRAY['role']);
    NEW.metadata := audit_private.keep_json_keys(NEW.metadata, ARRAY['membership_count']);
  ELSIF NEW.entity_type = 'system' THEN
    NEW.before_data := NULL;
    NEW.after_data := NULL;
    NEW.metadata := audit_private.keep_json_keys(NEW.metadata, ARRAY['event_code','source']);
  ELSE
    NEW.before_data := audit_private.keep_json_keys(NEW.before_data, ARRAY['status','created_at','updated_at']);
    NEW.after_data := audit_private.keep_json_keys(NEW.after_data, ARRAY['status','created_at','updated_at']);
    NEW.metadata := audit_private.keep_json_keys(NEW.metadata, ARRAY['event_code','source']);
  END IF;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_verified_audit_attribution() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_enforce_verified_audit_attribution ON public.audit_events;
CREATE TRIGGER trg_enforce_verified_audit_attribution
BEFORE INSERT ON public.audit_events
FOR EACH ROW EXECUTE FUNCTION public.enforce_verified_audit_attribution();

CREATE OR REPLACE FUNCTION public.reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Audit events are append-only.';
END;
$function$;
REVOKE ALL ON FUNCTION public.reject_audit_event_mutation() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_audit_events_no_mutation ON public.audit_events;
CREATE TRIGGER trg_audit_events_no_mutation
BEFORE UPDATE OR DELETE ON public.audit_events
FOR EACH ROW EXECUTE FUNCTION public.reject_audit_event_mutation();

-- Only authenticated readers may query the table directly. All writes happen
-- inside audited SECURITY DEFINER operations and their owning transaction.
REVOKE ALL ON TABLE public.audit_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.audit_events TO authenticated;
DROP POLICY IF EXISTS "Internal can read audit events" ON public.audit_events;
DROP POLICY IF EXISTS "Staff can create audit events" ON public.audit_events;
DROP POLICY IF EXISTS audit_events_target_read ON public.audit_events;
CREATE POLICY audit_events_target_read
ON public.audit_events
FOR SELECT
TO authenticated
USING (public.can_read_audit_event(target_tenant_id, target_project_id, target_phase_id));

-- Reservation settings are tenant-shared. A private one-transaction context
-- prevents direct table writes from bypassing their required audit event.
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
      AND c.purpose = 'reservation_settings'
      AND c.actor_id = auth.uid()
      AND c.target_tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Reservation workflow settings must be saved with their audit event.';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_reservation_workflow_setting_write() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_guard_reservation_workflow_setting_write ON public.business_settings;
CREATE TRIGGER trg_guard_reservation_workflow_setting_write
BEFORE INSERT OR UPDATE ON public.business_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_reservation_workflow_setting_write();

CREATE OR REPLACE FUNCTION public.save_reservation_workflow_settings(p_tenant_id uuid, p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_actor_tenant_id uuid;
  v_tenant_active boolean;
  v_before jsonb;
BEGIN
  IF NULLIF(current_setting('request.jwt.claim.role', true), '') <> 'authenticated' OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'An authenticated Wamule administrator is required.';
  END IF;
  IF jsonb_typeof(p_value) <> 'object' THEN
    RAISE EXCEPTION 'Reservation workflow settings must be a JSON object.';
  END IF;
  SELECT ap.role::text, ap.tenant_id INTO v_actor_role, v_actor_tenant_id
  FROM public.admin_profiles AS ap WHERE ap.user_id = v_actor_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The actor has no active Wamule profile.';
  END IF;
  SELECT o.is_active INTO v_tenant_active FROM public.organizations AS o WHERE o.id = p_tenant_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The target tenant does not exist.';
  END IF;
  IF v_actor_role = 'Admin' THEN
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id OR NOT v_tenant_active THEN
      RAISE EXCEPTION 'Tenant Admin settings are limited to the Admin tenant while it is active.';
    END IF;
  ELSIF v_actor_role <> 'Super Admin' THEN
    RAISE EXCEPTION 'Only a Tenant Admin or Super Admin may change reservation settings.';
  END IF;

  SELECT bs.value INTO v_before FROM public.business_settings AS bs
  WHERE bs.tenant_id = p_tenant_id AND bs.key = 'reservation_workflow_settings' FOR UPDATE;

  INSERT INTO audit_private.verified_operation_context(
    backend_pid, transaction_id, purpose, actor_id, target_tenant_id
  ) VALUES (
    pg_catalog.pg_backend_pid(), pg_catalog.txid_current(), 'reservation_settings', v_actor_id, p_tenant_id
  );

  INSERT INTO public.business_settings(tenant_id, key, value, updated_by)
  VALUES (p_tenant_id, 'reservation_workflow_settings', p_value, v_actor_id)
  ON CONFLICT (tenant_id, key) DO UPDATE
    SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = pg_catalog.now();

  DELETE FROM audit_private.verified_operation_context
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.txid_current()
    AND purpose = 'reservation_settings';

  INSERT INTO public.audit_events(
    tenant_id, target_tenant_id, entity_type, action, title, summary,
    before_data, after_data, metadata, actor_user_id
  ) VALUES (
    p_tenant_id, p_tenant_id, 'settings', 'settings_changed',
    'Reservation settings updated',
    'Reservation workflow defaults were updated for this tenant.',
    CASE WHEN v_before IS NULL THEN NULL ELSE jsonb_build_object('setting_key', 'reservation_workflow_settings') END,
    jsonb_build_object('setting_key', 'reservation_workflow_settings'),
    jsonb_build_object('setting_key', 'reservation_workflow_settings'), v_actor_id
  );

  RETURN jsonb_build_object('tenant_id', p_tenant_id, 'setting_key', 'reservation_workflow_settings');
END;
$function$;
REVOKE ALL ON FUNCTION public.save_reservation_workflow_settings(uuid, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.save_reservation_workflow_settings(uuid, jsonb) TO authenticated;

-- Inbound email system events accept a tenant ID resolved by the trusted
-- routing code and a fixed event code. They never accept arbitrary text/JSON.
CREATE OR REPLACE FUNCTION public.record_inbound_email_review_event(p_tenant_id uuid, p_event_code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_title text;
  v_summary text;
BEGIN
  IF NULLIF(current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Inbound email review events are restricted to the trusted service role.';
  END IF;
  SELECT CASE p_event_code
           WHEN 'customer_reconciliation_needed' THEN 'Inbound email needs customer reconciliation'
           WHEN 'no_processable_receipt' THEN 'Inbound email had no processable receipt'
         END,
         CASE p_event_code
           WHEN 'customer_reconciliation_needed' THEN 'A recognized tenant could not resolve a customer for an inbound message.'
           WHEN 'no_processable_receipt' THEN 'An inbound message had no supported receipt attachment and was sent for review.'
         END
    INTO v_title, v_summary;
  IF v_title IS NULL OR v_summary IS NULL THEN
    RAISE EXCEPTION 'Unsupported inbound email audit event code.';
  END IF;
  PERFORM 1 FROM public.organizations AS o WHERE o.id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The inbound event target tenant does not exist.';
  END IF;
  INSERT INTO public.audit_events(tenant_id, target_tenant_id, entity_type, action, title, summary, metadata)
  VALUES (p_tenant_id, p_tenant_id, 'system', 'reviewed', v_title, v_summary,
          jsonb_build_object('event_code', p_event_code, 'source', 'inbound_email'));
END;
$function$;
REVOKE ALL ON FUNCTION public.record_inbound_email_review_event(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_inbound_email_review_event(uuid, text) TO service_role;

-- Membership changes remain on the M3.4 API name, but an outer wrapper makes
-- the profile/membership mutation and its tenant-wide audit event one commit.
ALTER FUNCTION public.manage_workspace_member(uuid, uuid, text, jsonb, text, text, uuid)
  RENAME TO manage_workspace_member_unlogged;
REVOKE ALL ON FUNCTION public.manage_workspace_member_unlogged(uuid, uuid, text, jsonb, text, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

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
  v_request_role text := NULLIF(current_setting('request.jwt.claim.role', true), '');
  v_actor_id uuid;
  v_result jsonb;
  v_previous_role text;
  v_membership_count integer;
BEGIN
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

  SELECT ap.role::text INTO v_previous_role FROM public.admin_profiles AS ap
  WHERE ap.user_id = p_target_user_id;
  SELECT count(*) INTO v_membership_count FROM public.project_memberships AS pm
  WHERE pm.user_id = p_target_user_id AND pm.tenant_id = p_tenant_id;

  v_result := public.manage_workspace_member_unlogged(
    p_target_user_id, p_tenant_id, p_profile_role, p_memberships,
    p_email, p_full_name, p_actor_id
  );

  INSERT INTO audit_private.verified_operation_context(
    backend_pid, transaction_id, purpose, actor_id, target_tenant_id
  ) VALUES (
    pg_catalog.pg_backend_pid(), pg_catalog.txid_current(), 'workspace_member', v_actor_id, p_tenant_id
  );

  INSERT INTO public.audit_events(
    tenant_id, target_tenant_id, entity_type, entity_id, action, title, summary,
    before_data, after_data, metadata, actor_user_id
  ) VALUES (
    p_tenant_id, p_tenant_id, 'user', p_target_user_id::text, 'updated',
    'Workspace membership changed',
    'A workspace profile role and its project memberships were updated atomically.',
    CASE WHEN v_previous_role IS NULL THEN NULL ELSE jsonb_build_object('role', v_previous_role) END,
    jsonb_build_object('role', p_profile_role),
    jsonb_build_object('membership_count', jsonb_array_length(COALESCE(p_memberships, '[]'::jsonb))),
    v_actor_id
  );
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.manage_workspace_member(uuid, uuid, text, jsonb, text, text, uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.manage_workspace_member(uuid, uuid, text, jsonb, text, text, uuid)
  TO authenticated, service_role;

-- Successful provisioning is a service event with verified tenant/project/
-- phase scope and no claimed human actor.
ALTER FUNCTION public.onboard_project_tenant(text, text, text, text, text, text, jsonb, jsonb, uuid, text, boolean)
  RENAME TO onboard_project_tenant_unlogged;
REVOKE ALL ON FUNCTION public.onboard_project_tenant_unlogged(text, text, text, text, text, text, jsonb, jsonb, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

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
SET search_path = ''
AS $function$
DECLARE
  v_result jsonb;
  v_tenant_id uuid;
  v_project_id uuid;
  v_phase_id uuid;
BEGIN
  IF NULLIF(current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Tenant onboarding is restricted to the trusted service role.';
  END IF;
  v_result := public.onboard_project_tenant_unlogged(
    p_tenant_slug, p_tenant_name, p_project_slug, p_project_name,
    p_phase_slug, p_phase_name, p_theme, p_company_profile,
    p_staff_user_id, p_member_role, p_demo_mode
  );
  v_tenant_id := (v_result->>'tenant_id')::uuid;
  v_project_id := (v_result->>'project_id')::uuid;
  v_phase_id := (v_result->>'phase_id')::uuid;
  INSERT INTO public.audit_events(
    tenant_id, target_tenant_id, target_project_id, target_phase_id,
    entity_type, action, title, summary, metadata
  ) VALUES (
    v_tenant_id, v_tenant_id, v_project_id, v_phase_id,
    'system', 'created', 'Workspace provisioned',
    'A verified service operation created or reused a tenant workspace.',
    jsonb_build_object('event_code', 'tenant_onboarded', 'source', 'tenant_onboarding')
  );
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.onboard_project_tenant(text, text, text, text, text, text, jsonb, jsonb, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.onboard_project_tenant(text, text, text, text, text, text, jsonb, jsonb, uuid, text, boolean)
  TO service_role;

-- Receipt intake uses service-role inserts. These AFTER triggers write their
-- compact events in the same transaction as each successful row creation.
CREATE OR REPLACE FUNCTION public.audit_needs_review_transaction_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.status = 'needs_review' THEN
    INSERT INTO public.audit_events(
      tenant_id, target_tenant_id, entity_type, entity_id, action, title, summary, metadata
    ) VALUES (
      NEW.tenant_id, NEW.tenant_id, 'payment', NEW.id::text, 'created',
      'Payment staged for review',
      'A payment record was added to the review queue.',
      jsonb_build_object('event_code', 'payment_needs_review', 'source', 'payment_intake')
    );
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.audit_needs_review_transaction_insert() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_audit_needs_review_transaction_insert ON public.transactions;
CREATE TRIGGER trg_audit_needs_review_transaction_insert
AFTER INSERT ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.audit_needs_review_transaction_insert();

CREATE OR REPLACE FUNCTION public.audit_payment_document_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.audit_events(
    tenant_id, target_tenant_id, entity_type, entity_id, action, title, summary, metadata
  ) VALUES (
    NEW.tenant_id, NEW.tenant_id, 'document', NEW.id::text, 'uploaded',
    'Payment document uploaded',
    'A payment document was attached to a verified payment record.',
    jsonb_build_object('event_code', 'payment_document_uploaded', 'source', 'payment_intake')
  );
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.audit_payment_document_insert() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_audit_payment_document_insert ON public.payment_documents;
CREATE TRIGGER trg_audit_payment_document_insert
AFTER INSERT ON public.payment_documents
FOR EACH ROW EXECUTE FUNCTION public.audit_payment_document_insert();

COMMIT;
