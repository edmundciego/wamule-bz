-- Make the customer community-fee status view return and join by its verified
-- contract tenant. Preserve the original consumer columns in their existing
-- order, appending tenant_id for DocumentPage's workspace filter.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regclass('public.community_fee_account_status') IS NULL
     OR to_regclass('public.contracts') IS NULL
     OR to_regclass('public.community_fee_settings') IS NULL
     OR to_regclass('public.transactions') IS NULL THEN
    RAISE EXCEPTION 'Community-fee tenant repair requires the reconciled M7.5 catalog.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='contracts' AND column_name='tenant_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='community_fee_settings' AND column_name='tenant_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='transactions' AND column_name='tenant_id'
  ) THEN
    RAISE EXCEPTION 'Community-fee tenant repair requires tenant_id on contracts, settings, and transactions.';
  END IF;
END;
$preflight$;

CREATE OR REPLACE VIEW public.community_fee_account_status AS
SELECT
  c.id AS contract_id,
  c.customer_id,
  c.parcel_id,
  cfg.garbage_fee_amount,
  cfg.road_maintenance_amount,
  cfg.due_day,
  public.months_due_since(c.start_date, cfg.due_day, current_date) AS community_months_due,
  (public.months_due_since(c.start_date, cfg.due_day, current_date) * cfg.garbage_fee_amount)::numeric(12,2) AS expected_garbage_fees,
  (public.months_due_since(c.start_date, cfg.due_day, current_date) * cfg.road_maintenance_amount)::numeric(12,2) AS expected_road_fees,
  COALESCE(sum(t.amount) FILTER (WHERE t.transaction_type = 'Garbage Fee'::public.transaction_type), 0)::numeric(12,2) AS total_garbage_paid,
  COALESCE(sum(t.amount) FILTER (WHERE t.transaction_type = 'Road Maintenance'::public.transaction_type), 0)::numeric(12,2) AS total_road_paid,
  greatest(
    (public.months_due_since(c.start_date, cfg.due_day, current_date) * cfg.garbage_fee_amount)
      - COALESCE(sum(t.amount) FILTER (WHERE t.transaction_type = 'Garbage Fee'::public.transaction_type), 0),
    0
  )::numeric(12,2) AS garbage_fee_balance,
  greatest(
    (public.months_due_since(c.start_date, cfg.due_day, current_date) * cfg.road_maintenance_amount)
      - COALESCE(sum(t.amount) FILTER (WHERE t.transaction_type = 'Road Maintenance'::public.transaction_type), 0),
    0
  )::numeric(12,2) AS road_fee_balance,
  greatest(
    ((public.months_due_since(c.start_date, cfg.due_day, current_date) * cfg.garbage_fee_amount)
      - COALESCE(sum(t.amount) FILTER (WHERE t.transaction_type = 'Garbage Fee'::public.transaction_type), 0))
    + ((public.months_due_since(c.start_date, cfg.due_day, current_date) * cfg.road_maintenance_amount)
      - COALESCE(sum(t.amount) FILTER (WHERE t.transaction_type = 'Road Maintenance'::public.transaction_type), 0)),
    0
  )::numeric(12,2) AS community_fee_balance,
  c.tenant_id AS tenant_id
FROM public.contracts c
JOIN public.community_fee_settings cfg ON cfg.tenant_id = c.tenant_id
LEFT JOIN public.transactions t
  ON t.customer_id = c.customer_id
 AND t.tenant_id = c.tenant_id
 AND t.created_at::date >= c.start_date
 AND t.transaction_type IN ('Garbage Fee'::public.transaction_type, 'Road Maintenance'::public.transaction_type)
GROUP BY c.id, cfg.id, cfg.garbage_fee_amount, cfg.road_maintenance_amount, cfg.due_day;

-- CREATE OR REPLACE VIEW can reset view options on supported PG versions.
ALTER VIEW public.community_fee_account_status SET (security_invoker = true);
REVOKE ALL PRIVILEGES ON TABLE public.community_fee_account_status FROM anon, PUBLIC;
GRANT SELECT ON TABLE public.community_fee_account_status TO authenticated;

COMMENT ON VIEW public.community_fee_account_status IS
  'Tenant-scoped community-fee summary. tenant_id comes from the contract; fee settings and transactions must match that tenant. Underlying RLS is enforced with security_invoker.';

COMMIT;
