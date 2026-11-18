-- Staging-only patch for Supabase project kvocwmrcuhiaezlcgzjf.
-- Kept outside supabase/migrations so it cannot silently enter the shared
-- migration chain before the staging correction has been reviewed.
--
-- Supabase view security guidance:
-- https://supabase.com/docs/guides/database/views
-- security_invoker makes underlying RLS apply as the calling role.

BEGIN;

DO $$
DECLARE
  v_required_view text;
BEGIN
  IF to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'Expected Supabase anon and authenticated roles';
  END IF;

  IF to_regprocedure('public.is_internal_user()') IS NULL THEN
    RAISE EXCEPTION 'Expected public.is_internal_user() from the captured staging schema';
  END IF;

  FOREACH v_required_view IN ARRAY ARRAY[
    'analytics_snapshot',
    'community_fee_account_status',
    'contract_balances',
    'contract_financial_summary',
    'customer_balance_view'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = v_required_view
        AND c.relkind = 'v'
    ) THEN
      RAISE EXCEPTION 'Expected captured staging view public.%', v_required_view;
    END IF;

    IF NOT has_table_privilege(
      'authenticated',
      format('public.%I', v_required_view),
      'SELECT'
    ) THEN
      RAISE EXCEPTION 'Expected authenticated SELECT on public.%', v_required_view;
    END IF;
  END LOOP;
END;
$$;

-- These three views were recorded with owner-security defaults, which let
-- their postgres owner bypass the tenant policies on the underlying tables.
ALTER VIEW public.analytics_snapshot SET (security_invoker = true);
ALTER VIEW public.community_fee_account_status SET (security_invoker = true);
ALTER VIEW public.contract_balances SET (security_invoker = true);

-- The snapshot is a one-row aggregate even when RLS hides every source row.
-- Keep it absent for callers without an internal profile; staff and admins
-- with a profile still receive aggregates over only rows their RLS permits.
CREATE OR REPLACE VIEW public.analytics_snapshot AS
SELECT
  (
    SELECT COALESCE(sum(transactions.amount), 0::numeric)::numeric(12, 2)
    FROM public.transactions
  ) AS total_aggregated_revenue,
  (
    SELECT COALESCE(sum(contract_balances.overdue_balance), 0::numeric)::numeric(12, 2)
    FROM public.contract_balances
    WHERE contract_balances.is_active = true
  ) AS overdue_installment_balances,
  (
    SELECT count(*)::integer
    FROM public.community_fee_account_status
    WHERE community_fee_account_status.community_fee_balance > 0::numeric
  ) AS active_community_delinquency_accounts
WHERE public.is_internal_user();

-- CREATE OR REPLACE VIEW may reset view reloptions on some Postgres versions;
-- explicitly set caller security after replacing the aggregate definition.
ALTER VIEW public.analytics_snapshot SET (security_invoker = true);

-- Remove direct and inherited anonymous/public access from the five views.
-- Existing authenticated grants are preserved, and the two parcel views plus
-- the get-public-lots Edge Function are intentionally untouched.
REVOKE ALL PRIVILEGES ON TABLE
  public.analytics_snapshot,
  public.community_fee_account_status,
  public.contract_balances,
  public.contract_financial_summary,
  public.customer_balance_view
FROM anon, PUBLIC;

COMMIT;
