DO $post_sales_backfill$
DECLARE
  v_north uuid := 'e3000000-0000-4000-8000-000000000001';
  v_south uuid := 'e3000000-0000-4000-8000-000000000002';
  v_project uuid := 'e2000000-0000-4000-8000-000000000001';
  v_tenant uuid := 'e1000000-0000-4000-8000-000000000001';
  v_count bigint;
BEGIN
  SELECT count(*) INTO v_count FROM public.post_sales_tasks
  WHERE id='e5000000-0000-4000-8000-000000000001' AND tenant_id=v_tenant AND project_id=v_project AND phase_id=v_north;
  IF v_count <> 1 THEN RAISE EXCEPTION 'North task was not consistently backfilled.'; END IF;
  SELECT count(*) INTO v_count FROM public.post_sales_tasks
  WHERE id='e5000000-0000-4000-8000-000000000002' AND project_id=v_project AND phase_id=v_south;
  IF v_count <> 1 THEN RAISE EXCEPTION 'South task was not consistently backfilled.'; END IF;
  SELECT count(*) INTO v_count FROM public.post_sales_checklists
  WHERE id='e7000000-0000-4000-8000-000000000001' AND project_id=v_project AND phase_id=v_north;
  IF v_count <> 1 THEN RAISE EXCEPTION 'North checklist was not consistently backfilled.'; END IF;
  SELECT count(*) INTO v_count FROM public.post_sales_checklists
  WHERE id='e7000000-0000-4000-8000-000000000002' AND project_id=v_project AND phase_id=v_south;
  IF v_count <> 1 THEN RAISE EXCEPTION 'South checklist was not consistently backfilled.'; END IF;
  SELECT count(*) INTO v_count FROM public.post_sales_tasks
  WHERE id='e5000000-0000-4000-8000-000000000003' AND project_id IS NULL AND phase_id IS NULL;
  IF v_count <> 1 THEN RAISE EXCEPTION 'Unverified legacy task was assigned guessed scope.'; END IF;
  SELECT count(*) INTO v_count FROM public.post_sales_checklists
  WHERE id='e7000000-0000-4000-8000-000000000003' AND project_id IS NULL AND phase_id IS NULL;
  IF v_count <> 1 THEN RAISE EXCEPTION 'Unverified legacy checklist was assigned guessed scope.'; END IF;
  SELECT count(*) INTO v_count FROM public.post_sales_tasks;
  IF v_count <> 3 THEN RAISE EXCEPTION 'Post-sales task records were unexpectedly lost after removing only the rejected fixture.'; END IF;
  SELECT count(*) INTO v_count FROM public.post_sales_checklists;
  IF v_count <> 3 THEN RAISE EXCEPTION 'Post-sales checklist records were unexpectedly lost after removing only the rejected fixture.'; END IF;
END;
$post_sales_backfill$;

-- Guard direct writes and later scope/reference reassignment. A rejected
-- statement must leave the row count and original verified scope unchanged.
DO $post_sales_direct_guards$
DECLARE
  v_before bigint;
  v_after bigint;
  v_phase uuid;
  v_project uuid := 'e2000000-0000-4000-8000-000000000001';
  v_tenant uuid := 'e1000000-0000-4000-8000-000000000001';
BEGIN
  SELECT count(*) INTO v_before FROM public.post_sales_tasks;
  BEGIN
    INSERT INTO public.post_sales_tasks(id, tenant_id, application_id, lead_id, title)
    VALUES ('e5000000-0000-4000-8000-000000000099', v_tenant, 990000101,
      'e6000000-0000-4000-8000-000000000002', 'Rejected cross-phase parents');
    RAISE EXCEPTION 'Cross-phase parent insert unexpectedly succeeded.';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SELECT count(*) INTO v_after FROM public.post_sales_tasks;
  IF v_after <> v_before THEN RAISE EXCEPTION 'Rejected insert left a partial task row.'; END IF;

  BEGIN
    UPDATE public.post_sales_tasks SET lead_id='e6000000-0000-4000-8000-000000000002'
    WHERE id='e5000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'Cross-phase parent update unexpectedly succeeded.';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SELECT phase_id INTO v_phase FROM public.post_sales_tasks WHERE id='e5000000-0000-4000-8000-000000000001';
  IF v_phase <> 'e3000000-0000-4000-8000-000000000001' THEN RAISE EXCEPTION 'Rejected update changed the original phase.'; END IF;

  BEGIN
    UPDATE public.post_sales_tasks SET application_id=990000102
    WHERE id='e5000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'Mismatched phase reassignment unexpectedly succeeded.';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SELECT phase_id INTO v_phase FROM public.post_sales_tasks WHERE id='e5000000-0000-4000-8000-000000000001';
  IF v_phase <> 'e3000000-0000-4000-8000-000000000001' THEN RAISE EXCEPTION 'Rejected reassign left a partial scope change.'; END IF;

  -- The optional lead/contract/reservation links may stay NULL for a valid
  -- customer-only legacy item; NULL does not authorize arbitrary scope.
  INSERT INTO public.post_sales_tasks(id, tenant_id, customer_id, title)
  VALUES ('e5000000-0000-4000-8000-000000000098', v_tenant, 990000001, 'Shared customer follow-up');
  SELECT count(*) INTO v_after FROM public.post_sales_tasks
  WHERE id='e5000000-0000-4000-8000-000000000098' AND project_id IS NULL AND phase_id IS NULL;
  IF v_after <> 1 THEN RAISE EXCEPTION 'Valid unscoped optional-link row did not remain usable.'; END IF;
  BEGIN
    UPDATE public.post_sales_tasks SET project_id=v_project, phase_id='e3000000-0000-4000-8000-000000000002'
    WHERE id='e5000000-0000-4000-8000-000000000098';
    RAISE EXCEPTION 'Customer-only row acquired unverified phase scope.';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$post_sales_direct_guards$;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e4000000-0000-4000-8000-000000000001', true);
DO $staff_access$
DECLARE
  v_count bigint;
  v_affected bigint;
BEGIN
  SELECT count(*) INTO v_count FROM public.post_sales_tasks WHERE phase_id='e3000000-0000-4000-8000-000000000001';
  IF v_count <> 1 THEN RAISE EXCEPTION 'North Staff cannot read assigned task scope.'; END IF;
  SELECT count(*) INTO v_count FROM public.post_sales_tasks WHERE phase_id='e3000000-0000-4000-8000-000000000002';
  IF v_count <> 0 THEN RAISE EXCEPTION 'North Staff can read an out-of-phase task.'; END IF;
  SELECT count(*) INTO v_count FROM public.post_sales_checklists WHERE phase_id='e3000000-0000-4000-8000-000000000001';
  IF v_count <> 1 THEN RAISE EXCEPTION 'North Staff cannot read assigned checklist scope.'; END IF;
  SELECT count(*) INTO v_count FROM public.post_sales_checklists WHERE phase_id='e3000000-0000-4000-8000-000000000002';
  IF v_count <> 0 THEN RAISE EXCEPTION 'North Staff can read an out-of-phase checklist.'; END IF;

  INSERT INTO public.post_sales_tasks(id, tenant_id, application_id, title)
  VALUES ('e5000000-0000-4000-8000-000000000011', 'e1000000-0000-4000-8000-000000000001', 990000101, 'Staff in-scope task write');
  INSERT INTO public.post_sales_checklists(id, tenant_id, application_id, status)
  VALUES ('e7000000-0000-4000-8000-000000000011', 'e1000000-0000-4000-8000-000000000001', 990000101, 'in_progress');

  BEGIN
    INSERT INTO public.post_sales_tasks(id, tenant_id, application_id, title)
    VALUES ('e5000000-0000-4000-8000-000000000012', 'e1000000-0000-4000-8000-000000000001', 990000102, 'Denied South task write');
    RAISE EXCEPTION 'Out-of-scope Staff task write unexpectedly succeeded.';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.post_sales_checklists(id, tenant_id, application_id, status)
    VALUES ('e7000000-0000-4000-8000-000000000012', 'e1000000-0000-4000-8000-000000000001', 990000102, 'in_progress');
    RAISE EXCEPTION 'Out-of-scope Staff checklist write unexpectedly succeeded.';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  UPDATE public.post_sales_tasks SET status='in_progress'
  WHERE id='e5000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN RAISE EXCEPTION 'Assigned-scope Staff task update failed.'; END IF;
  UPDATE public.post_sales_checklists SET status='completed'
  WHERE id='e7000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN RAISE EXCEPTION 'Assigned-scope Staff checklist update failed.'; END IF;
  UPDATE public.post_sales_checklists SET status='completed'
  WHERE id='e7000000-0000-4000-8000-000000000002';
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 0 THEN RAISE EXCEPTION 'Out-of-scope Staff checklist update was not denied.'; END IF;

  SELECT count(*) INTO v_count FROM public.post_sales_tasks WHERE id='e5000000-0000-4000-8000-000000000012';
  IF v_count <> 0 THEN RAISE EXCEPTION 'Denied task write left a partial row.'; END IF;
  SELECT count(*) INTO v_count FROM public.post_sales_checklists WHERE id='e7000000-0000-4000-8000-000000000012';
  IF v_count <> 0 THEN RAISE EXCEPTION 'Denied checklist write left a partial row.'; END IF;
END;
$staff_access$;
ROLLBACK;

-- M1.5 is applied separately by the runner before view repair. These checks
-- prove the final view keeps that access boundary and the M3.1 finance policy.
DO $community_view_catalog$
DECLARE
  v_options text[];
BEGIN
  SELECT reloptions INTO v_options FROM pg_class WHERE oid='public.community_fee_account_status'::regclass;
  IF NOT COALESCE(v_options @> ARRAY['security_invoker=true'], false) THEN
    RAISE EXCEPTION 'Community fee status view is not security_invoker.';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.community_fee_account_status', 'SELECT') THEN
    RAISE EXCEPTION 'Authenticated must retain view SELECT for permitted Admin scope.';
  END IF;
  IF has_table_privilege('anon', 'public.community_fee_account_status', 'SELECT') THEN
    RAISE EXCEPTION 'Anonymous view SELECT grant must remain revoked.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM aclexplode(COALESCE(
      (SELECT relacl FROM pg_class WHERE oid='public.community_fee_account_status'::regclass),
      acldefault('r', (SELECT relowner FROM pg_class WHERE oid='public.community_fee_account_status'::regclass))
    )) acl WHERE acl.grantee=0 AND acl.privilege_type='SELECT'
  ) THEN RAISE EXCEPTION 'PUBLIC inherited SELECT remains on the view.'; END IF;
END;
$community_view_catalog$;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e4000000-0000-4000-8000-000000000002', true);
DO $tenant_admin_view$
DECLARE
  v_count bigint;
  v_amount numeric;
  v_tenant_matches boolean;
BEGIN
  SELECT count(*), min(garbage_fee_amount), bool_and(tenant_id='e1000000-0000-4000-8000-000000000001')
    INTO v_count, v_amount, v_tenant_matches
  FROM public.community_fee_account_status WHERE customer_id=990000001 AND tenant_id='e1000000-0000-4000-8000-000000000001';
  IF v_count <> 1 OR v_amount <> 500 OR v_tenant_matches IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Tenant Admin did not receive exactly the contract tenant fee row.';
  END IF;
END;
$tenant_admin_view$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e4000000-0000-4000-8000-000000000003', true);
DO $unrelated_admin_view$
DECLARE v_count bigint;
BEGIN
  SELECT count(*) INTO v_count FROM public.community_fee_account_status WHERE customer_id=990000001;
  IF v_count <> 0 THEN RAISE EXCEPTION 'Unrelated tenant Admin can read another tenant fee view.'; END IF;
END;
$unrelated_admin_view$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e4000000-0000-4000-8000-000000000001', true);
DO $staff_finance_denial$
DECLARE v_count bigint;
BEGIN
  SELECT count(*) INTO v_count FROM public.community_fee_account_status WHERE customer_id=990000001;
  IF v_count <> 0 THEN RAISE EXCEPTION 'Staff received contract/payment summary forbidden by M3.1.'; END IF;
END;
$staff_finance_denial$;
ROLLBACK;

SELECT 'M1.5 grants, security-invoker, Admin tenant scope, unrelated tenant denial, Staff finance denial, and Staff North-only post-sales RLS passed' AS result;
