-- Tenant-defaulting triggers + Vision ingestion columns + needs_review status.
--
-- Follows 20260915000000_multi_tenant_foundation.sql (tenant_id NOT NULL).
-- Goals:
-- 1. Existing frontend inserts that omit tenant_id keep working: BEFORE INSERT
--    trigger fills NEW.tenant_id from the caller's admin profile, falling back
--    to the default tenant for anon/service contexts (public form, cron).
-- 2. Automated inbound-email ingestion can stage payments for staff review via
--    transactions.status = 'needs_review' without tripping land-payment guards.
-- 3. Vision extraction output has a home: payment_documents.parsed_metadata +
--    ai_confidence.
--
-- Idempotent: IF NOT EXISTS / DROP IF EXISTS + pg_trigger guards.
-- Deployment order: apply after 20260915000000. Do not edit history.

begin;

-- -----------------------------------------------------------------------------
-- 0. Ensure default tenant exists (defensive; foundation seeds it).
-- -----------------------------------------------------------------------------
insert into public.organizations (id, name, slug)
values ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Default Client', 'default-client')
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 1. SECURITY DEFINER trigger function: default tenant_id on insert.
-- -----------------------------------------------------------------------------
create or replace function public.set_default_tenant_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
begin
  if new.tenant_id is null then
    -- Caller tenant (NULL for anon / service_role without JWT context).
    v_tenant := public.get_current_user_tenant_id();
    if v_tenant is null then
      -- Backward-compat fallback so pre-tenant frontend inserts and public
      -- anon application submits keep working. Tenant-aware callers and Edge
      -- Functions should always supply tenant_id explicitly.
      v_tenant := 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid;
    end if;
    new.tenant_id := v_tenant;
  end if;
  return new;
end;
$$;

comment on function public.set_default_tenant_id() is 'BEFORE INSERT defaulting for tenant_id: caller tenant via get_current_user_tenant_id(), fallback to default-client for anon/service contexts. Explicit tenant_id values are never overwritten.';

-- -----------------------------------------------------------------------------
-- 2. Attach BEFORE INSERT trigger to all 39 tenant-scoped tables.
-- -----------------------------------------------------------------------------
do $$
declare
  tbl text;
  scoped_tables text[] := array[
    'parcels', 'applications', 'customers', 'contracts', 'transactions',
    'payment_documents', 'payment_requests', 'payment_methods', 'receipt_jobs', 'installment_plans',
    'business_settings', 'lot_sizes', 'fee_types', 'community_fee_settings',
    'leads', 'lead_activities', 'follow_up_tasks', 'site_visits',
    'lot_reservations', 'reservation_activities',
    'post_sales_checklists', 'post_sales_tasks', 'post_sales_activities',
    'ai_settings', 'application_ai_reviews', 'ai_daily_briefs', 'customer_ai_summaries',
    'lead_ai_summaries', 'post_sales_ai_summaries',
    'brief_action_items', 'email_notifications', 'notification_settings', 'developer_feedback',
    'audit_events', 'contract_void_resolutions',
    'information_topics', 'information_requests', 'information_request_topics', 'information_packs'
  ];
begin
  foreach tbl in array scoped_tables loop
    if to_regclass('public.' || tbl) is null then
      raise notice 'tenant-default: table public.% missing, skipping trigger', tbl;
      continue;
    end if;

    -- Drop + recreate so reruns converge even if a prior version differs.
    execute format('drop trigger if exists trg_set_default_tenant_id on public.%I', tbl);
    execute format(
      'create trigger trg_set_default_tenant_id before insert on public.%I '
      'for each row execute function public.set_default_tenant_id()',
      tbl
    );
  end loop;
end;
$$;

-- NOTE: admin_profiles is intentionally excluded (NULL tenant is valid for
-- Super Admin via chk_admin_profiles_tenant_or_super_admin). organizations is
-- the tenant root itself and must not default.

-- -----------------------------------------------------------------------------
-- 3. Vision columns on payment_documents.
-- -----------------------------------------------------------------------------
alter table public.payment_documents
  add column if not exists parsed_metadata jsonb not null default '{}'::jsonb,
  add column if not exists ai_confidence numeric(3,2);

do $$
begin
  if to_regclass('public.payment_documents') is not null
     and not exists (
       select 1 from pg_constraint
       where conname = 'payment_documents_ai_confidence_range'
         and conrelid = 'public.payment_documents'::regclass
     ) then
    alter table public.payment_documents
      add constraint payment_documents_ai_confidence_range
      check (ai_confidence is null or (ai_confidence >= 0 and ai_confidence <= 1));
  end if;

  if to_regclass('public.payment_documents') is not null
     and not exists (
       select 1 from pg_constraint
       where conname = 'payment_documents_parsed_metadata_object'
         and conrelid = 'public.payment_documents'::regclass
     ) then
    alter table public.payment_documents
      add constraint payment_documents_parsed_metadata_object
      check (jsonb_typeof(parsed_metadata) = 'object');
  end if;
end;
$$;

comment on column public.payment_documents.parsed_metadata is 'Raw structured JSON returned by Gemini Vision OCR for this receipt/proof. Never stores secrets.';
comment on column public.payment_documents.ai_confidence is 'Vision confidence 0.00-1.00. NULL when not machine-parsed.';

-- 3b. System ingestion has no human actor yet: allow NULL actor columns.
--     Staff-authored writes still supply user IDs; staff set authorized_by
--     when approving needs_review -> posted.
alter table public.payment_documents alter column uploaded_by drop not null;
alter table public.transactions alter column authorized_by drop not null;

-- -----------------------------------------------------------------------------
-- 4. needs_review transaction status for automated ingestion.
--
-- Financial views count only status=posted land payments, so needs_review rows
-- are automatically excluded from balances until staff approve (posted) them.
-- -----------------------------------------------------------------------------

-- 4a. Extend status check to include needs_review.
alter table public.transactions
  drop constraint if exists transactions_status_valid;

do $$
begin
  if to_regclass('public.transactions') is not null
     and not exists (
       select 1 from pg_constraint
       where conname = 'transactions_status_valid'
         and conrelid = 'public.transactions'::regclass
     ) then
    alter table public.transactions
      add constraint transactions_status_valid
      check (status in ('posted', 'voided', 'reversed', 'needs_review'));
  end if;
end;
$$;

-- 4b. Void-state invariant: needs_review behaves like posted (no void metadata).
alter table public.transactions
  drop constraint if exists transactions_voided_state_valid;

do $$
begin
  if to_regclass('public.transactions') is not null
     and not exists (
       select 1 from pg_constraint
       where conname = 'transactions_voided_state_valid'
         and conrelid = 'public.transactions'::regclass
     ) then
    alter table public.transactions
      add constraint transactions_voided_state_valid
      check (
        (status = 'voided' and voided_at is not null and voided_by is not null and coalesce(trim(void_reason), '') <> '')
        or (status in ('posted', 'reversed', 'needs_review') and voided_at is null and voided_by is null and void_reason is null)
      );
  end if;
end;
$$;

-- 4c. Relax amount/bank-reference/contract guards for needs_review staging rows.
--     Staff supply the corrected values when approving to posted.
alter table public.transactions
  drop constraint if exists transactions_amount_positive,
  drop constraint if exists transactions_online_reference_required,
  drop constraint if exists transactions_land_types_require_contract;

do $$
begin
  if to_regclass('public.transactions') is not null
     and not exists (select 1 from pg_constraint where conname = 'transactions_amount_positive') then
    alter table public.transactions
      add constraint transactions_amount_positive
      check ((amount > 0) or (status = 'needs_review' and amount >= 0));
  end if;

  if to_regclass('public.transactions') is not null
     and not exists (select 1 from pg_constraint where conname = 'transactions_online_reference_required') then
    alter table public.transactions
      add constraint transactions_online_reference_required
      check (
        (collection_method = 'Online Transfer' and bank_reference is not null and length(trim(bank_reference)) > 0)
        or (collection_method = 'Cash')
        or (status = 'needs_review')
      );
  end if;

  if to_regclass('public.transactions') is not null
     and not exists (select 1 from pg_constraint where conname = 'transactions_land_types_require_contract') then
    alter table public.transactions
      add constraint transactions_land_types_require_contract
      check (
        (transaction_type in ('Down Payment', 'Land Installment') and contract_id is not null)
        or (transaction_type in ('Garbage Fee', 'Road Maintenance'))
        or (status = 'needs_review')
      );
  end if;
end;
$$;

-- 4d. validate_transaction_write: normalize + pass through needs_review rows.
--     Full contract/reference validation runs when staff approve to posted.
create or replace function public.validate_transaction_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract_customer_id bigint;
begin
  if new.bank_reference is not null then
    new.bank_reference = nullif(upper(trim(new.bank_reference)), '');
  end if;

  -- Automated ingestion staging: staff complete contract/reference on review.
  if new.status = 'needs_review' then
    if new.collection_method = 'Cash'::public.collection_method then
      new.bank_reference = null;
    end if;
    if new.contract_id is not null then
      select c.customer_id
        into v_contract_customer_id
      from public.contracts c
      where c.id = new.contract_id;
      if not found then
        raise exception 'Contract % does not exist.', new.contract_id;
      end if;
      if v_contract_customer_id <> new.customer_id then
        raise exception 'Transaction customer does not match the selected contract customer.';
      end if;
    end if;
    return new;
  end if;

  if new.collection_method = 'Online Transfer'::public.collection_method
     and new.bank_reference is null then
    raise exception 'Bank reference is required for online transfer payments.';
  end if;

  if new.collection_method = 'Cash'::public.collection_method then
    new.bank_reference = null;
  end if;

  if new.transaction_type in ('Down Payment'::public.transaction_type, 'Land Installment'::public.transaction_type)
     and new.contract_id is null then
    raise exception 'Land payment transactions require a contract.';
  end if;

  if new.contract_id is not null then
    select c.customer_id
      into v_contract_customer_id
    from public.contracts c
    where c.id = new.contract_id;

    if not found then
      raise exception 'Contract % does not exist.', new.contract_id;
    end if;

    if v_contract_customer_id <> new.customer_id then
      raise exception 'Transaction customer does not match the selected contract customer.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_transaction_write on public.transactions;
create trigger trg_validate_transaction_write
before insert or update on public.transactions
for each row
execute function public.validate_transaction_write();

-- 4e. Immutability guard: allow staff approval needs_review -> posted.
--     All other UPDATE rules (void via RPC only) are unchanged.
create or replace function public.prevent_immutable_transaction_edits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Staff review approval: needs_review may transition to posted (or stay
  -- needs_review for corrections). RLS still restricts who can UPDATE.
  if tg_op = 'UPDATE'
     and old.status = 'needs_review'
     and new.status in ('needs_review', 'posted') then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and coalesce(current_setting('app.payment_correction', true), '') <> 'void_payment_record' then
    raise exception 'Posted payment records are immutable. Void the payment and record a linked replacement instead.';
  end if;

  if tg_op = 'INSERT'
     and new.reversal_of_transaction_id is not null then
    if not exists (
      select 1
      from public.transactions original
      where original.id = new.reversal_of_transaction_id
        and original.status = 'voided'
        and original.customer_id = new.customer_id
        and original.contract_id is not distinct from new.contract_id
    ) then
      raise exception 'A replacement payment must reference a voided payment for the same customer and contract.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_immutable_transaction_edits on public.transactions;
create trigger trg_prevent_immutable_transaction_edits
before insert or update on public.transactions
for each row execute function public.prevent_immutable_transaction_edits();

-- 4f. Receipt-job queue: propagate tenant_id so the NOT NULL + RLS chain holds.
create or replace function public.queue_receipt_generation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.receipt_jobs (transaction_id, tenant_id)
  values (new.id, new.tenant_id)
  on conflict (transaction_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_queue_receipt_generation on public.transactions;
create trigger trg_queue_receipt_generation
after insert on public.transactions
for each row
execute function public.queue_receipt_generation();

comment on column public.transactions.status is 'Lifecycle: posted (live), needs_review (auto-ingested, excluded from balances until staff approve), voided, reversed.';

commit;
