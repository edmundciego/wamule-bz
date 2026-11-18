-- M7.7: serialize inbound retries, scope AI summaries, and retain linked
-- Admin receipt access after moving generated receipts into tenant paths.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Keep historical summary rows as read history. New requests receive a stable
-- UUID from the caller; retries reuse it while an intentional regeneration
-- supplies a new one.
ALTER TABLE public.lead_ai_summaries ADD COLUMN IF NOT EXISTS generation_id uuid;
ALTER TABLE public.post_sales_ai_summaries ADD COLUMN IF NOT EXISTS generation_id uuid;
ALTER TABLE public.customer_ai_summaries ADD COLUMN IF NOT EXISTS generation_id uuid;

DO $preflight$
DECLARE
  v_groups bigint;
  v_extra_rows bigint;
BEGIN
  IF to_regclass('public.transactions') IS NULL
     OR to_regclass('public.payment_documents') IS NULL
     OR to_regclass('public.customer_ai_summaries') IS NULL
     OR to_regclass('public.lead_ai_summaries') IS NULL
     OR to_regclass('public.post_sales_ai_summaries') IS NULL
     OR to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'M7.7 requires the reconciled M3.2, M3.6 and M7.5 schema.';
  END IF;

  SELECT count(*), COALESCE(sum(n - 1), 0) INTO v_groups, v_extra_rows
  FROM (SELECT count(*) AS n FROM public.transactions
        WHERE receipt_notes LIKE 'M77-INBOUND:%' GROUP BY tenant_id, receipt_notes HAVING count(*) > 1) duplicates;
  IF v_groups > 0 THEN
    RAISE EXCEPTION 'M7.7 preflight found % duplicate inbound event keys (% excess rows); review without auto-repair.', v_groups, v_extra_rows;
  END IF;
  SELECT count(*), COALESCE(sum(n - 1), 0) INTO v_groups, v_extra_rows
  FROM (SELECT count(*) AS n FROM public.payment_documents GROUP BY tenant_id, file_path HAVING count(*) > 1) duplicates;
  IF v_groups > 0 THEN
    RAISE EXCEPTION 'M7.7 preflight found % duplicate tenant document paths (% excess rows); review without auto-repair.', v_groups, v_extra_rows;
  END IF;
  SELECT count(*), COALESCE(sum(n - 1), 0) INTO v_groups, v_extra_rows
  FROM (SELECT count(*) AS n FROM public.lead_ai_summaries WHERE generation_id IS NOT NULL
        GROUP BY tenant_id, lead_id, generation_id HAVING count(*) > 1) duplicates;
  IF v_groups > 0 THEN
    RAISE EXCEPTION 'M7.7 preflight found % duplicate lead-summary request keys (% excess rows); review without auto-repair.', v_groups, v_extra_rows;
  END IF;
  SELECT count(*), COALESCE(sum(n - 1), 0) INTO v_groups, v_extra_rows
  FROM (SELECT count(*) AS n FROM public.post_sales_ai_summaries WHERE generation_id IS NOT NULL
        GROUP BY tenant_id, checklist_id, generation_id HAVING count(*) > 1) duplicates;
  IF v_groups > 0 THEN
    RAISE EXCEPTION 'M7.7 preflight found % duplicate post-sales-summary request keys (% excess rows); review without auto-repair.', v_groups, v_extra_rows;
  END IF;
END;
$preflight$;

-- One signed provider event attachment produces one needs_review receipt in a
-- tenant. Customer identity is intentionally not used to infer a sale scope.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_tenant_inbound_marker_m77_uq
  ON public.transactions (tenant_id, receipt_notes)
  WHERE receipt_notes LIKE 'M77-INBOUND:%';

-- A single deterministic private object path must have one metadata row. This
-- makes a concurrent replay recover the first committed document record.
CREATE UNIQUE INDEX IF NOT EXISTS payment_documents_tenant_path_m77_uq
  ON public.payment_documents (tenant_id, file_path);

-- A retry reuses its generation_id. NULL historical generations remain
-- unconstrained so existing summary history, including repeated parent rows,
-- stays intact and is never merged by this migration.
CREATE UNIQUE INDEX IF NOT EXISTS lead_ai_summaries_generation_m77_uq
  ON public.lead_ai_summaries (tenant_id, lead_id, generation_id);
CREATE UNIQUE INDEX IF NOT EXISTS post_sales_ai_summaries_generation_m77_uq
  ON public.post_sales_ai_summaries (tenant_id, checklist_id, generation_id);

-- Preserve the M3.6 Admin-only receipt contract for both the historical path
-- and the M7.7 tenant/customer/receipt path. Exact linked transaction paths
-- also remain valid for any already-registered object.
-- The original pre-tenant policy is permissive and would OR with this policy,
-- exposing every private business object to any authenticated internal user.
DROP POLICY IF EXISTS "Internal users can read Wamuale files" ON storage.objects;
-- The older restrictive tenant boundary also recognizes only the historical
-- customer/receipt path. Keep that isolation check and add the new server
-- receipt path so it does not block an otherwise authorized Admin read.
DROP POLICY IF EXISTS "Wamule private file tenant boundary read" ON storage.objects;
CREATE POLICY "Wamule private file tenant boundary read" ON storage.objects
  AS RESTRICTIVE FOR SELECT TO authenticated USING (
    storage.objects.bucket_id NOT IN ('contracts','receipts','application-documents','payment-documents')
    OR (storage.objects.bucket_id='contracts' AND EXISTS (
      SELECT 1 FROM public.contracts c
      WHERE public.user_has_tenant_access(c.tenant_id)
        AND c.signed_contract_file_path=storage.objects.name
    ))
    OR (storage.objects.bucket_id='receipts' AND EXISTS (
      SELECT 1 FROM public.transactions t
      WHERE public.user_has_tenant_access(t.tenant_id)
        AND (
          t.receipt_file_path=storage.objects.name
          OR (t.customer_id::text || '/' || t.receipt_number || '.pdf')=storage.objects.name
          OR (t.tenant_id::text || '/' || t.customer_id::text || '/' || t.receipt_number || '.pdf')=storage.objects.name
        )
    ))
    OR (storage.objects.bucket_id='payment-documents' AND EXISTS (
      SELECT 1 FROM public.payment_documents d
      WHERE public.user_has_tenant_access(d.tenant_id)
        AND d.file_path=storage.objects.name
    ))
    OR (storage.objects.bucket_id='application-documents' AND EXISTS (
      SELECT 1 FROM public.application_documents d
      WHERE d.object_name=storage.objects.name
        AND public.can_read_application_document(d.tenant_id,d.application_id)
    ))
  );
DROP POLICY IF EXISTS "Tenant admins read linked private files" ON storage.objects;
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
          AND (
            t.receipt_file_path = storage.objects.name
            OR (t.customer_id::text || '/' || t.receipt_number || '.pdf') = storage.objects.name
            OR (t.tenant_id::text || '/' || t.customer_id::text || '/' || t.receipt_number || '.pdf') = storage.objects.name
          )
      ))
      OR (bucket_id = 'payment-documents' AND EXISTS (
        SELECT 1 FROM public.payment_documents d
        WHERE public.user_has_tenant_access(d.tenant_id)
          AND d.file_path = storage.objects.name
      ))
    )
  );

-- Customer finance summaries can aggregate more than one phase. Restrict them
-- to verified tenant Admin/Super Admin readers; all writes remain server-only.
DROP POLICY IF EXISTS "Internal can read customer AI summaries" ON public.customer_ai_summaries;
DROP POLICY IF EXISTS "Admin staff can create customer AI summaries" ON public.customer_ai_summaries;
DROP POLICY IF EXISTS "Admin staff can update customer AI summaries" ON public.customer_ai_summaries;
DROP POLICY IF EXISTS "Admins can delete customer AI summaries" ON public.customer_ai_summaries;
DROP POLICY IF EXISTS m77_customer_ai_summary_admin_read ON public.customer_ai_summaries;
ALTER TABLE public.customer_ai_summaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY m77_customer_ai_summary_admin_read ON public.customer_ai_summaries
  FOR SELECT TO authenticated
  USING (public.user_has_tenant_access(tenant_id) AND public.is_admin_user());
REVOKE ALL ON public.customer_ai_summaries FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.customer_ai_summaries FROM authenticated;
GRANT SELECT ON public.customer_ai_summaries TO authenticated;

-- Lead AI contains only the linked operational lead summary. Staff and Read
-- Only readers must still hold a live membership in that exact parent phase.
DROP POLICY IF EXISTS "Internal can read lead AI summaries" ON public.lead_ai_summaries;
DROP POLICY IF EXISTS "Admin staff can create lead AI summaries" ON public.lead_ai_summaries;
DROP POLICY IF EXISTS "Admins can delete lead AI summaries" ON public.lead_ai_summaries;
DROP POLICY IF EXISTS m77_lead_ai_summary_scoped_read ON public.lead_ai_summaries;
ALTER TABLE public.lead_ai_summaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY m77_lead_ai_summary_scoped_read ON public.lead_ai_summaries
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.leads l
      WHERE l.id = lead_ai_summaries.lead_id
        AND l.tenant_id = lead_ai_summaries.tenant_id
        AND public.user_has_tenant_access(l.tenant_id)
        AND (
          public.is_admin_user()
          OR (
            l.project_id IS NOT NULL AND l.phase_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.admin_profiles ap
              WHERE ap.user_id = auth.uid()
                AND ap.role::text IN ('Staff', 'Read Only')
            )
            AND public.user_has_project_access(l.tenant_id, l.project_id, l.phase_id)
          )
        )
    )
  );
REVOKE ALL ON public.lead_ai_summaries FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.lead_ai_summaries FROM authenticated;
GRANT SELECT ON public.lead_ai_summaries TO authenticated;

-- Post-sales summaries may contain contract, payment and document readiness,
-- so they follow the Admin-only contract and remain server-written.
DROP POLICY IF EXISTS "Internal can read post-sales AI summaries" ON public.post_sales_ai_summaries;
DROP POLICY IF EXISTS "Admin staff can create post-sales AI summaries" ON public.post_sales_ai_summaries;
DROP POLICY IF EXISTS "Admins can delete post-sales AI summaries" ON public.post_sales_ai_summaries;
DROP POLICY IF EXISTS m77_post_sales_ai_summary_admin_read ON public.post_sales_ai_summaries;
ALTER TABLE public.post_sales_ai_summaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY m77_post_sales_ai_summary_admin_read ON public.post_sales_ai_summaries
  FOR SELECT TO authenticated
  USING (public.user_has_tenant_access(tenant_id) AND public.is_admin_user());
REVOKE ALL ON public.post_sales_ai_summaries FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.post_sales_ai_summaries FROM authenticated;
GRANT SELECT ON public.post_sales_ai_summaries TO authenticated;

-- A server-side claim serializes one AI generation before the provider is
-- called. Parent keys are text because customer IDs are bigint while lead and
-- checklist IDs are UUIDs. This private table is never exposed to API roles.
CREATE TABLE IF NOT EXISTS audit_private.ai_summary_generation_claims (
  summary_kind text NOT NULL CHECK (summary_kind IN ('customer','lead','post_sales')),
  tenant_id uuid NOT NULL,
  parent_key text NOT NULL CHECK (length(parent_key) > 0),
  generation_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('in_progress','completed')),
  claim_token uuid NOT NULL,
  summary_id text,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (summary_kind,tenant_id,parent_key,generation_id),
  CHECK ((state = 'completed') = (summary_id IS NOT NULL))
);
ALTER TABLE audit_private.ai_summary_generation_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE audit_private.ai_summary_generation_claims FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION audit_private.resolve_ai_summary_scope(
  p_summary_kind text,
  p_tenant_id uuid,
  p_parent_id text
)
RETURNS TABLE (project_id uuid, phase_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_project_id uuid;
  v_phase_id uuid;
BEGIN
  IF (auth.jwt() ->> 'role') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'AI summary claims require the service role.' USING ERRCODE = '42501';
  END IF;
  IF p_summary_kind IS NULL OR p_summary_kind NOT IN ('customer','lead','post_sales')
     OR p_tenant_id IS NULL OR NULLIF(btrim(p_parent_id),'') IS NULL THEN
    RAISE EXCEPTION 'A supported summary kind, tenant, and parent are required.' USING ERRCODE = '22023';
  END IF;

  IF p_summary_kind = 'customer' THEN
    IF p_parent_id !~ '^[1-9][0-9]*$' OR NOT EXISTS (
      SELECT 1 FROM public.customers c
      JOIN public.organizations o ON o.id = c.tenant_id
      WHERE c.id::text = p_parent_id AND c.tenant_id = p_tenant_id AND o.is_active
    ) THEN
      RAISE EXCEPTION 'The active tenant customer could not be verified.' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY SELECT NULL::uuid, NULL::uuid;
    RETURN;
  ELSIF p_summary_kind = 'lead' THEN
    SELECT l.project_id, l.phase_id INTO v_project_id, v_phase_id
    FROM public.leads l
    WHERE l.id = p_parent_id::uuid AND l.tenant_id = p_tenant_id;
    IF NOT FOUND OR v_project_id IS NULL OR v_phase_id IS NULL
       OR NOT public.workspace_scope_is_active(p_tenant_id,v_project_id,v_phase_id) THEN
      RAISE EXCEPTION 'The active lead project and phase could not be verified.' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY SELECT v_project_id, v_phase_id;
    RETURN;
  ELSE
    SELECT s.project_id, s.phase_id INTO v_project_id, v_phase_id
    FROM public.active_post_sales_checklist_scope(p_parent_id::uuid,p_tenant_id) AS s;
    IF NOT FOUND OR v_project_id IS NULL OR v_phase_id IS NULL
       OR NOT public.workspace_scope_is_active(p_tenant_id,v_project_id,v_phase_id) THEN
      RAISE EXCEPTION 'The active post-sales checklist project and phase could not be verified.' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY SELECT v_project_id, v_phase_id;
    RETURN;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION audit_private.resolve_ai_summary_scope(text,uuid,text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION audit_private.ai_summary_actor_can_generate(
  p_actor_id uuid,
  p_summary_kind text,
  p_tenant_id uuid,
  p_project_id uuid,
  p_phase_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(o.is_active AND (
    ap.role::text = 'Super Admin'
    OR (ap.role::text = 'Admin' AND ap.tenant_id = p_tenant_id)
    OR (
      p_summary_kind = 'lead'
      AND ap.role::text = 'Staff'
      AND ap.tenant_id = p_tenant_id
      AND p_project_id IS NOT NULL AND p_phase_id IS NOT NULL
      AND public.workspace_scope_is_active(p_tenant_id,p_project_id,p_phase_id)
      AND (SELECT count(*) = 1
           FROM public.project_memberships m
           WHERE m.tenant_id = p_tenant_id AND m.project_id = p_project_id
             AND m.user_id = p_actor_id AND (m.phase_id IS NULL OR m.phase_id = p_phase_id)
             AND m.member_role::text IN ('owner','admin','staff'))
    )
  ),false)
  FROM public.admin_profiles ap
  JOIN public.organizations o ON o.id = p_tenant_id
  WHERE ap.user_id = p_actor_id;
$function$;
REVOKE ALL ON FUNCTION audit_private.ai_summary_actor_can_generate(uuid,text,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION audit_private.find_ai_summary_result(
  p_summary_kind text,
  p_tenant_id uuid,
  p_parent_id text,
  p_generation_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_summary_id text;
BEGIN
  IF p_summary_kind = 'customer' THEN
    SELECT s.id::text INTO v_summary_id FROM public.customer_ai_summaries s
    WHERE s.tenant_id=p_tenant_id AND s.customer_id::text=p_parent_id
      AND s.generation_id=p_generation_id;
  ELSIF p_summary_kind = 'lead' THEN
    SELECT s.id::text INTO v_summary_id FROM public.lead_ai_summaries s
    WHERE s.tenant_id=p_tenant_id AND s.lead_id=p_parent_id::uuid AND s.generation_id=p_generation_id;
  ELSIF p_summary_kind = 'post_sales' THEN
    SELECT s.id::text INTO v_summary_id FROM public.post_sales_ai_summaries s
    WHERE s.tenant_id=p_tenant_id AND s.checklist_id=p_parent_id::uuid AND s.generation_id=p_generation_id;
  END IF;
  RETURN v_summary_id;
END;
$function$;
REVOKE ALL ON FUNCTION audit_private.find_ai_summary_result(text,uuid,text,uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_ai_summary_generation_v1(
  p_summary_kind text,
  p_tenant_id uuid,
  p_parent_id text,
  p_generation_id uuid,
  p_actor_id uuid
)
RETURNS TABLE (status text, claim_token uuid, summary_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_scope record;
  v_claim audit_private.ai_summary_generation_claims%ROWTYPE;
  v_claim_token uuid;
  v_summary_id text;
BEGIN
  IF (auth.jwt() ->> 'role') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'AI summary claims require the service role.' USING ERRCODE = '42501';
  END IF;
  IF p_generation_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'A generation ID and verified actor are required.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_scope FROM audit_private.resolve_ai_summary_scope(p_summary_kind,p_tenant_id,p_parent_id);
  IF NOT audit_private.ai_summary_actor_can_generate(p_actor_id,p_summary_kind,p_tenant_id,v_scope.project_id,v_scope.phase_id) THEN
    RAISE EXCEPTION 'The actor no longer has permission to generate this AI summary.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO audit_private.ai_summary_generation_claims(
    summary_kind,tenant_id,parent_key,generation_id,actor_id,state,claim_token
  ) VALUES (p_summary_kind,p_tenant_id,p_parent_id,p_generation_id,p_actor_id,'in_progress',gen_random_uuid())
  ON CONFLICT DO NOTHING
  RETURNING audit_private.ai_summary_generation_claims.claim_token INTO v_claim_token;
  IF FOUND THEN
    RETURN QUERY SELECT 'claimed'::text,v_claim_token,NULL::text;
    RETURN;
  END IF;

  SELECT c.* INTO v_claim FROM audit_private.ai_summary_generation_claims c
  WHERE c.summary_kind=p_summary_kind AND c.tenant_id=p_tenant_id
    AND c.parent_key=p_parent_id AND c.generation_id=p_generation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The AI summary generation claim could not be recovered.' USING ERRCODE = '40001';
  END IF;
  IF v_claim.actor_id IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION 'This generation belongs to a different initiating user.' USING ERRCODE = '42501';
  END IF;

  v_summary_id := audit_private.find_ai_summary_result(p_summary_kind,p_tenant_id,p_parent_id,p_generation_id);
  IF v_summary_id IS NOT NULL THEN
    UPDATE audit_private.ai_summary_generation_claims c
    SET state='completed',summary_id=v_summary_id,updated_at=clock_timestamp()
    WHERE c.summary_kind=p_summary_kind AND c.tenant_id=p_tenant_id
      AND c.parent_key=p_parent_id AND c.generation_id=p_generation_id;
    RETURN QUERY SELECT 'completed'::text,NULL::uuid,v_summary_id;
    RETURN;
  END IF;

  IF v_claim.state='in_progress' AND v_claim.claimed_at > clock_timestamp() - interval '10 minutes' THEN
    RETURN QUERY SELECT 'in_progress'::text,NULL::uuid,NULL::text;
    RETURN;
  END IF;

  UPDATE audit_private.ai_summary_generation_claims c
  SET state='in_progress',claim_token=gen_random_uuid(),summary_id=NULL,
      claimed_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE c.summary_kind=p_summary_kind AND c.tenant_id=p_tenant_id
    AND c.parent_key=p_parent_id AND c.generation_id=p_generation_id
  RETURNING c.claim_token INTO v_claim_token;
  RETURN QUERY SELECT 'claimed'::text,v_claim_token,NULL::text;
END;
$function$;
REVOKE ALL ON FUNCTION public.claim_ai_summary_generation_v1(text,uuid,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_ai_summary_generation_v1(text,uuid,text,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_ai_summary_generation_v1(
  p_summary_kind text,
  p_tenant_id uuid,
  p_parent_id text,
  p_generation_id uuid,
  p_claim_token uuid,
  p_summary_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_claim audit_private.ai_summary_generation_claims%ROWTYPE;
  v_scope record;
  v_saved_summary text;
BEGIN
  IF (auth.jwt() ->> 'role') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'AI summary completion requires the service role.' USING ERRCODE = '42501';
  END IF;
  SELECT c.* INTO v_claim FROM audit_private.ai_summary_generation_claims c
  WHERE c.summary_kind=p_summary_kind AND c.tenant_id=p_tenant_id
    AND c.parent_key=p_parent_id AND c.generation_id=p_generation_id
    AND c.claim_token=p_claim_token AND c.state='in_progress'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The AI summary completion claim is stale.' USING ERRCODE = '40001'; END IF;
  SELECT * INTO v_scope FROM audit_private.resolve_ai_summary_scope(p_summary_kind,p_tenant_id,p_parent_id);
  IF NOT audit_private.ai_summary_actor_can_generate(v_claim.actor_id,p_summary_kind,p_tenant_id,v_scope.project_id,v_scope.phase_id) THEN
    RAISE EXCEPTION 'The initiating actor lost permission before summary completion.' USING ERRCODE = '42501';
  END IF;
  v_saved_summary := audit_private.find_ai_summary_result(p_summary_kind,p_tenant_id,p_parent_id,p_generation_id);
  IF v_saved_summary IS NULL OR v_saved_summary IS DISTINCT FROM p_summary_id THEN
    RAISE EXCEPTION 'The summary row does not match the verified generation.' USING ERRCODE = '23503';
  END IF;
  UPDATE audit_private.ai_summary_generation_claims c
  SET state='completed',summary_id=v_saved_summary,updated_at=clock_timestamp()
  WHERE c.summary_kind=p_summary_kind AND c.tenant_id=p_tenant_id
    AND c.parent_key=p_parent_id AND c.generation_id=p_generation_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.complete_ai_summary_generation_v1(text,uuid,text,uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_ai_summary_generation_v1(text,uuid,text,uuid,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.release_ai_summary_generation_v1(
  p_summary_kind text,
  p_tenant_id uuid,
  p_parent_id text,
  p_generation_id uuid,
  p_claim_token uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_claim audit_private.ai_summary_generation_claims%ROWTYPE;
  v_scope record;
  v_saved_summary text;
BEGIN
  IF (auth.jwt() ->> 'role') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'AI summary claim release requires the service role.' USING ERRCODE = '42501';
  END IF;
  SELECT c.* INTO v_claim FROM audit_private.ai_summary_generation_claims c
  WHERE c.summary_kind=p_summary_kind AND c.tenant_id=p_tenant_id
    AND c.parent_key=p_parent_id AND c.generation_id=p_generation_id
    AND c.claim_token=p_claim_token AND c.state='in_progress'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_scope FROM audit_private.resolve_ai_summary_scope(p_summary_kind,p_tenant_id,p_parent_id);
  IF NOT audit_private.ai_summary_actor_can_generate(v_claim.actor_id,p_summary_kind,p_tenant_id,v_scope.project_id,v_scope.phase_id) THEN
    RAISE EXCEPTION 'The initiating actor lost permission before claim release.' USING ERRCODE = '42501';
  END IF;
  v_saved_summary := audit_private.find_ai_summary_result(p_summary_kind,p_tenant_id,p_parent_id,p_generation_id);
  IF v_saved_summary IS NOT NULL THEN
    UPDATE audit_private.ai_summary_generation_claims c
    SET state='completed',summary_id=v_saved_summary,updated_at=clock_timestamp()
    WHERE c.summary_kind=p_summary_kind AND c.tenant_id=p_tenant_id
      AND c.parent_key=p_parent_id AND c.generation_id=p_generation_id;
  ELSE
    DELETE FROM audit_private.ai_summary_generation_claims c
    WHERE c.summary_kind=p_summary_kind AND c.tenant_id=p_tenant_id
      AND c.parent_key=p_parent_id AND c.generation_id=p_generation_id
      AND c.claim_token=p_claim_token;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.release_ai_summary_generation_v1(text,uuid,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_ai_summary_generation_v1(text,uuid,text,uuid,uuid) TO service_role;

COMMIT;
