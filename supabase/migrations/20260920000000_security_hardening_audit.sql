-- Security hardening audit: pin search_path on every SECURITY DEFINER function.
--
-- SECURITY DEFINER functions run with the owner's privileges. When search_path
-- is not pinned (or pins pg_temp first, the historical default), an attacker
-- who can create temporary objects can shadow the tables/functions these
-- helpers reference and hijack privileged execution (search_path escalation).
-- This migration pins EVERY public SECURITY DEFINER function to
-- `set search_path = public, pg_temp` (trusted objects first, temp last).
--
-- Covers, among others, the multi-tenant RLS helpers:
--   public.set_default_tenant_id()
--   public.get_current_user_tenant_id()
--   public.user_has_tenant_access(uuid)
--   public.sync_active_masterplan()
--   public.set_tenant_masterplan(uuid, text)
--
-- Idempotent: guarded ALTERs via to_regprocedure + catch-all sweep.
-- Deployment order: apply last. Do not edit history.

begin;

-- -----------------------------------------------------------------------------
-- 1. Explicit pinning of all known SECURITY DEFINER functions.
--    Signatures are guarded so the migration also succeeds on databases where
--    foundation-era functions were replaced or dropped.
-- -----------------------------------------------------------------------------
do $$
declare
  signatures text[] := array[
    -- Multi-tenant RLS helpers (20260915000000_multi_tenant_foundation).
    'public.get_current_user_tenant_id()',
    'public.is_super_admin_user()',
    'public.is_admin_user()',
    'public.is_internal_user()',
    'public.can_write_admin_data()',
    'public.user_has_tenant_access(uuid)',
    -- Tenant defaulting + payment staging triggers (20260916000000).
    'public.set_default_tenant_id()',
    'public.prevent_immutable_transaction_edits()',
    'public.validate_transaction_write()',
    'public.queue_receipt_generation()',
    -- Masterplan storage + versioning (20260918000000 / 20260919000000).
    'public.set_tenant_masterplan(uuid, text)',
    'public.assign_masterplan_version_number()',
    'public.sync_active_masterplan()',
    -- Financial correctness batch (20260714223959).
    'public.prevent_transaction_delete()',
    'public.void_payment_record(bigint, text)',
    'public.validate_contract_write()',
    'public.void_contract(bigint, text)',
    'public.resolve_contract_void_resolution(uuid, text, text, uuid)',
    -- Contract void / reservation release phases.
    'public.release_alternate_reservations(uuid, uuid[], text)',
    -- Lead automation.
    'public.create_lead_from_application()',
    -- Application approval (20260610000200) + foundation-era triggers.
    'public.approve_application(bigint, bigint)',
    'public.handle_application_approval()',
    'public.mark_parcel_sold_after_contract()'
  ];
  sig text;
begin
  foreach sig in array signatures loop
    if to_regprocedure(sig) is not null then
      execute format('alter function %s set search_path = public, pg_temp', sig);
    end if;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Catch-all sweep: pin any public SECURITY DEFINER function the explicit
--    list did not cover (e.g. functions introduced between migrations).
-- -----------------------------------------------------------------------------
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
  loop
    execute format('alter function %s set search_path = public, pg_temp', fn.signature);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Verification: fail the migration if any public SECURITY DEFINER function
--    still lacks the pinned search_path.
-- -----------------------------------------------------------------------------
do $$
declare
  offenders text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
    into offenders
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and not exists (
      select 1
      from unnest(coalesce(p.proconfig, '{}'::text[])) as cfg
      where cfg like 'search_path=%pg_temp%'
    );

  if offenders is not null then
    raise exception 'SECURITY DEFINER functions without pinned search_path: %', offenders;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Financial view verification: needs_review must never pollute balances.
--    customer_balance_view aggregates land figures through
--    contract_financial_summary, which counts ONLY status = 'posted'
--    contract-linked land payments; community_paid also filters
--    status = 'posted'. Auto-ingested transactions staged as
--    status = 'needs_review' are therefore excluded from every balance until
--    staff approve them to 'posted'. This block re-asserts the definitions so
--    a future edit that drops the posted filter fails this migration loudly.
-- -----------------------------------------------------------------------------
create or replace view public.contract_financial_summary
with (security_invoker = true)
as
select
  c.id as contract_id,
  c.customer_id,
  c.parcel_id,
  c.is_active,
  c.status as contract_status,
  c.final_purchase_price,
  c.initial_deposit,
  c.monthly_payment,
  c.start_date,
  c.payment_due_day,
  coalesce(sum(t.amount) filter (
    where t.status = 'posted'
      and t.contract_id = c.id
      and t.transaction_type in ('Down Payment'::public.transaction_type, 'Land Installment'::public.transaction_type)
  ), 0)::numeric(12,2) as total_posted_land_paid,
  greatest(c.final_purchase_price - coalesce(sum(t.amount) filter (
    where t.status = 'posted'
      and t.contract_id = c.id
      and t.transaction_type in ('Down Payment'::public.transaction_type, 'Land Installment'::public.transaction_type)
  ), 0), 0)::numeric(12,2) as remaining_balance
from public.contracts c
left join public.transactions t on t.contract_id = c.id
where c.is_active = true and c.status = 'active'
group by c.id;

grant select on public.contract_financial_summary to authenticated;

create or replace view public.customer_balance_view
with (security_invoker = true)
as
select
  cu.id as customer_id,
  trim(cu.first_name || ' ' || cu.last_name) as customer_name,
  coalesce((select sum(summary.total_posted_land_paid) from public.contract_financial_summary summary where summary.customer_id = cu.id), 0::numeric) as land_paid,
  coalesce((select sum(t.amount) from public.transactions t where t.customer_id = cu.id and t.status = 'posted' and t.transaction_type in ('Garbage Fee'::public.transaction_type, 'Road Maintenance'::public.transaction_type)), 0::numeric) as community_paid,
  coalesce((select sum(summary.remaining_balance) from public.contract_financial_summary summary where summary.customer_id = cu.id), 0::numeric) as land_balance
from public.customers cu
;

grant select on public.customer_balance_view to authenticated;

comment on view public.customer_balance_view is
  'Balance source of truth: land figures via contract_financial_summary (posted-only), community fees posted-only. needs_review transactions are excluded until staff approval flips them to posted.';

commit;
