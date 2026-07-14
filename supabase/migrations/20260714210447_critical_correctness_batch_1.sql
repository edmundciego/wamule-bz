-- Critical correctness batch 1.
-- IMPORTANT: 20260714203000_controlled_payment_removal.sql is an unsafe hard-delete
-- design. Do not apply it independently. This migration supersedes its RPC if it
-- exists in an environment that already ran it.

begin;

-- -----------------------------------------------------------------------------
-- Immutable payment correction lifecycle
-- -----------------------------------------------------------------------------

alter table public.transactions
  add column if not exists status text not null default 'posted',
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references auth.users(id) on delete set null,
  add column if not exists void_reason text,
  add column if not exists reversal_of_transaction_id bigint references public.transactions(id) on delete restrict,
  add column if not exists correction_notes text,
  add column if not exists updated_at timestamptz not null default now();

update public.transactions
set status = 'posted'
where status is null;

alter table public.transactions
  drop constraint if exists transactions_status_valid,
  add constraint transactions_status_valid check (status in ('posted', 'voided', 'reversed')),
  drop constraint if exists transactions_voided_state_valid,
  add constraint transactions_voided_state_valid check (
    (status = 'voided' and voided_at is not null and voided_by is not null and coalesce(trim(void_reason), '') <> '')
    or (status in ('posted', 'reversed') and voided_at is null and voided_by is null and void_reason is null)
  );

create index if not exists idx_transactions_contract_status
  on public.transactions(contract_id, status);
create index if not exists idx_transactions_reversal_of_transaction_id
  on public.transactions(reversal_of_transaction_id)
  where reversal_of_transaction_id is not null;

drop trigger if exists trg_transactions_updated_at on public.transactions;
create trigger trg_transactions_updated_at
before update on public.transactions
for each row execute function public.set_updated_at();

-- Posted financial records are immutable through the table API. The controlled
-- RPC sets this transaction-local flag while it performs the allowed status change.
create or replace function public.prevent_immutable_transaction_edits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
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

-- This closes the legacy Super Admin test-data purge path as well as table API
-- deletes. Transaction history is immutable: a purge that reaches a payment
-- must fail and roll back instead of deleting financial evidence.
create or replace function public.prevent_transaction_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Payment records cannot be deleted. Void the payment or retain the historical record.';
end;
$$;

drop trigger if exists trg_prevent_transaction_delete on public.transactions;
create trigger trg_prevent_transaction_delete
before delete on public.transactions
for each row execute function public.prevent_transaction_delete();

-- RLS no longer allows direct transaction deletion or updates. Keep the
-- existing permitted payment-recording workflow as INSERT-only for writers.
drop policy if exists "Transactions deletable by admins" on public.transactions;
drop policy if exists "Staff can write transactions" on public.transactions;
drop policy if exists "Internal writers can create transactions" on public.transactions;
create policy "Internal writers can create transactions"
on public.transactions for insert to authenticated
with check (public.can_write_admin_data());

drop function if exists public.remove_payment_record(bigint, text);

create or replace function public.void_payment_record(
  p_transaction_id bigint,
  p_reason text
)
returns public.transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.transactions%rowtype;
  v_updated public.transactions%rowtype;
  v_actor record;
  v_documents jsonb;
begin
  if not public.is_admin_user() then
    raise exception 'Only Admin and Super Admin users can void payments.';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A void reason is required.';
  end if;

  select * into v_payment
  from public.transactions
  where id = p_transaction_id
  for update;

  if not found then
    raise exception 'Payment record not found.';
  end if;

  if v_payment.status <> 'posted' then
    raise exception 'Only posted payments may be voided.';
  end if;

  select full_name, email into v_actor
  from public.admin_profiles
  where user_id = auth.uid();

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'document_type', document_type,
    'original_file_name', original_file_name,
    'file_path', file_path
  ) order by created_at), '[]'::jsonb)
  into v_documents
  from public.payment_documents
  where transaction_id = v_payment.id;

  perform set_config('app.payment_correction', 'void_payment_record', true);
  update public.transactions
  set
    status = 'voided',
    voided_at = now(),
    voided_by = auth.uid(),
    void_reason = trim(p_reason),
    correction_notes = coalesce(correction_notes, '')
  where id = v_payment.id
  returning * into v_updated;

  insert into public.audit_events (
    entity_type, entity_id, action, title, summary,
    before_data, after_data, metadata,
    actor_user_id, actor_name, actor_email
  ) values (
    'payment', v_payment.id::text, 'voided', 'Payment voided',
    'Payment remains in history and is excluded from current account totals.',
    to_jsonb(v_payment),
    to_jsonb(v_updated),
    jsonb_build_object(
      'customer_id', v_payment.customer_id,
      'contract_id', v_payment.contract_id,
      'amount', v_payment.amount,
      'collection_method', v_payment.collection_method,
      'transaction_type', v_payment.transaction_type,
      'created_at', v_payment.created_at,
      'bank_reference', v_payment.bank_reference,
      'receipt_number', v_payment.receipt_number,
      'manual_receipt_number', v_payment.manual_receipt_number,
      'documents', v_documents,
      'reason', trim(p_reason)
    ),
    auth.uid(), v_actor.full_name, v_actor.email
  );

  return v_updated;
end;
$$;

revoke all on function public.void_payment_record(bigint, text) from public;
grant execute on function public.void_payment_record(bigint, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Contract void resolution record and lot authorization
-- -----------------------------------------------------------------------------

create table if not exists public.contract_void_resolutions (
  id uuid primary key default gen_random_uuid(),
  contract_id bigint not null references public.contracts(id) on delete restrict,
  customer_id bigint not null references public.customers(id) on delete restrict,
  parcel_id bigint not null references public.parcels(id) on delete restrict,
  status text not null default 'pending',
  resolution_type text,
  reservation_id uuid references public.lot_reservations(id) on delete set null,
  resolution_reason text,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contract_void_resolutions_status_valid check (status in ('pending', 'resolved')),
  constraint contract_void_resolutions_type_valid check (
    resolution_type is null or resolution_type in ('release_lot', 'return_to_reservation', 'retain_sold', 'other')
  ),
  constraint contract_void_resolutions_resolved_state_valid check (
    (status = 'pending' and resolution_type is null and resolved_at is null and resolved_by is null)
    or (status = 'resolved' and resolution_type is not null and resolved_at is not null and resolved_by is not null)
  )
);

create unique index if not exists uniq_pending_contract_void_resolution_per_contract
  on public.contract_void_resolutions(contract_id)
  where status = 'pending';
create index if not exists idx_contract_void_resolutions_parcel_status
  on public.contract_void_resolutions(parcel_id, status);

-- Legacy safety backfill: old voids left parcels Sold without an explicit
-- operational decision. Create only a review record; never release a parcel,
-- change a reservation, or modify a payment as part of this migration.
do $$
declare
  v_legacy_resolution_count integer;
begin
  insert into public.contract_void_resolutions (contract_id, customer_id, parcel_id, status)
  select c.id, c.customer_id, c.parcel_id, 'pending'
  from public.contracts c
  join public.parcels p on p.id = c.parcel_id
  where c.status = 'voided'
    and p.status = 'Sold'
    and not exists (
      select 1
      from public.contract_void_resolutions resolution
      where resolution.contract_id = c.id
    );

  get diagnostics v_legacy_resolution_count = row_count;
  raise notice 'Created % pending legacy contract-void resolution record(s).', v_legacy_resolution_count;
end;
$$;

drop trigger if exists trg_contract_void_resolutions_updated_at on public.contract_void_resolutions;
create trigger trg_contract_void_resolutions_updated_at
before update on public.contract_void_resolutions
for each row execute function public.set_updated_at();

alter table public.contract_void_resolutions enable row level security;
drop policy if exists "Internal can read contract void resolutions" on public.contract_void_resolutions;
create policy "Internal can read contract void resolutions"
on public.contract_void_resolutions for select to authenticated
using (public.is_internal_user());
grant select on public.contract_void_resolutions to authenticated;

-- Active reservation for this batch deliberately excludes draft, converted,
-- expired, cancelled, and released records.
create or replace function public.validate_contract_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application_id bigint;
  v_application_status public.application_status;
  v_application_parcel_id bigint;
  v_reservation_id uuid;
  v_reservation_parcel_id bigint;
  v_parcel_status public.parcel_status;
begin
  if tg_op = 'UPDATE'
    and (
      new.status is distinct from old.status
      or new.is_active is distinct from old.is_active
      or new.void_reason is distinct from old.void_reason
      or new.voided_at is distinct from old.voided_at
      or new.voided_by is distinct from old.voided_by
      or new.cancel_reason is distinct from old.cancel_reason
      or new.cancelled_at is distinct from old.cancelled_at
      or new.cancelled_by is distinct from old.cancelled_by
    )
    and not public.is_admin_user() then
    raise exception 'Only Admin and Super Admin users can change contract lifecycle status.';
  end if;

  if new.is_active is not true or new.status <> 'active' then
    return new;
  end if;

  select status into v_parcel_status
  from public.parcels
  where id = new.parcel_id
  for update;

  if not found then
    raise exception 'Parcel % does not exist.', new.parcel_id;
  end if;

  if v_parcel_status = 'Sold' and (tg_op = 'INSERT' or new.parcel_id is distinct from old.parcel_id) then
    raise exception 'Cannot create an active contract for a sold lot.';
  end if;

  if exists (
    select 1 from public.contract_void_resolutions
    where parcel_id = new.parcel_id and status = 'pending'
  ) then
    raise exception 'Lot resolution is required before another contract can use this parcel.';
  end if;

  select c.application_id into v_application_id
  from public.customers c
  where c.id = new.customer_id;
  if not found then
    raise exception 'Customer % does not exist.', new.customer_id;
  end if;

  select r.id, r.parcel_id into v_reservation_id, v_reservation_parcel_id
  from public.lot_reservations r
  where r.customer_id = new.customer_id
    and r.status in ('reserved', 'deposit_pending', 'deposit_submitted', 'deposit_confirmed')
  order by r.updated_at desc
  limit 1
  for update;

  if v_reservation_id is not null then
    if v_reservation_parcel_id is distinct from new.parcel_id then
      raise exception 'Contract parcel must match the customer active reservation lot.';
    end if;
    return new;
  end if;

  select a.status, a.parcel_id into v_application_status, v_application_parcel_id
  from public.applications a
  where a.id = v_application_id;

  if v_application_status is distinct from 'Approved'::public.application_status
     or v_application_parcel_id is null
     or v_application_parcel_id is distinct from new.parcel_id then
    raise exception 'An approved application or active reservation must authorize the selected contract lot.';
  end if;

  return new;
end;
$$;

create or replace function public.void_contract(
  p_contract_id bigint,
  p_void_reason text
)
returns public.contracts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract public.contracts%rowtype;
  v_updated_contract public.contracts%rowtype;
  v_resolution public.contract_void_resolutions%rowtype;
  v_actor record;
  v_reason text;
  v_payment_count integer;
  v_payment_total numeric(12,2);
begin
  if not public.is_admin_user() then
    raise exception 'Only Admin and Super Admin users can void contracts.';
  end if;
  v_reason := nullif(trim(p_void_reason), '');
  if v_reason is null then
    raise exception 'Void reason is required.';
  end if;

  select * into v_contract from public.contracts where id = p_contract_id for update;
  if not found then raise exception 'Contract not found.'; end if;
  if v_contract.status <> 'active' or v_contract.is_active is not true then
    raise exception 'Only active contracts may be voided.';
  end if;

  select full_name, email into v_actor from public.admin_profiles where user_id = auth.uid();
  select count(*), coalesce(sum(amount), 0) into v_payment_count, v_payment_total
  from public.transactions
  where contract_id = v_contract.id and status = 'posted';

  update public.contracts
  set status = 'voided', is_active = false, void_reason = v_reason,
      voided_at = now(), voided_by = auth.uid()
  where id = v_contract.id
  returning * into v_updated_contract;

  insert into public.contract_void_resolutions (contract_id, customer_id, parcel_id, status)
  values (v_contract.id, v_contract.customer_id, v_contract.parcel_id, 'pending')
  returning * into v_resolution;

  insert into public.audit_events (
    entity_type, entity_id, action, title, summary, before_data, after_data, metadata,
    actor_user_id, actor_name, actor_email
  ) values (
    'contract', v_contract.id::text, 'voided', 'Contract voided — resolution required',
    'The contract remains in history. Lot and linked payment review are required before another contract can use the lot.',
    to_jsonb(v_contract), to_jsonb(v_updated_contract),
    jsonb_build_object(
      'customer_id', v_contract.customer_id,
      'parcel_id', v_contract.parcel_id,
      'final_purchase_price', v_contract.final_purchase_price,
      'linked_posted_payment_count', v_payment_count,
      'linked_posted_payment_total', v_payment_total,
      'void_reason', v_reason,
      'pending_resolution_id', v_resolution.id
    ), auth.uid(), v_actor.full_name, v_actor.email
  );

  return v_updated_contract;
end;
$$;

create or replace function public.resolve_contract_void_resolution(
  p_resolution_id uuid,
  p_resolution_type text,
  p_reason text default null,
  p_reservation_id uuid default null
)
returns public.contract_void_resolutions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_resolution public.contract_void_resolutions%rowtype;
  v_updated public.contract_void_resolutions%rowtype;
  v_previous_status public.parcel_status;
  v_actor record;
begin
  if not public.is_admin_user() then
    raise exception 'Only Admin and Super Admin users can resolve voided contracts.';
  end if;
  if p_resolution_type not in ('release_lot', 'return_to_reservation', 'retain_sold') then
    raise exception 'Choose a valid resolution type.';
  end if;
  if p_resolution_type = 'retain_sold' and coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required to retain a lot as sold.';
  end if;

  select * into v_resolution from public.contract_void_resolutions where id = p_resolution_id for update;
  if not found or v_resolution.status <> 'pending' then
    raise exception 'Pending contract void resolution not found.';
  end if;
  select status into v_previous_status from public.parcels where id = v_resolution.parcel_id for update;
  select full_name, email into v_actor from public.admin_profiles where user_id = auth.uid();

  if p_resolution_type = 'release_lot' then
    if exists (select 1 from public.contracts where parcel_id = v_resolution.parcel_id and is_active and status = 'active')
       or exists (select 1 from public.lot_reservations where parcel_id = v_resolution.parcel_id and status in ('reserved', 'deposit_pending', 'deposit_submitted', 'deposit_confirmed')) then
      raise exception 'The lot cannot be released while an active contract or reservation exists.';
    end if;
    update public.parcels set status = 'Available', updated_at = now() where id = v_resolution.parcel_id;
  elsif p_resolution_type = 'return_to_reservation' then
    if p_reservation_id is null or not exists (
      select 1 from public.lot_reservations
      where id = p_reservation_id
        and parcel_id = v_resolution.parcel_id
        and customer_id = v_resolution.customer_id
        and status in ('reserved', 'deposit_pending', 'deposit_submitted', 'deposit_confirmed', 'expired', 'cancelled', 'released')
    ) then
      raise exception 'A valid historical or active reservation for this customer and lot is required.';
    end if;
    if exists (
      select 1 from public.lot_reservations
      where parcel_id = v_resolution.parcel_id
        and id <> p_reservation_id
        and status in ('reserved', 'deposit_pending', 'deposit_submitted', 'deposit_confirmed')
    ) then
      raise exception 'Another active reservation already requires this lot.';
    end if;
    update public.lot_reservations
    set status = 'reserved', reserved_at = coalesce(reserved_at, now()), released_at = null
    where id = p_reservation_id;
    update public.parcels set status = 'Reserved', updated_at = now() where id = v_resolution.parcel_id;
  end if;

  update public.contract_void_resolutions
  set status = 'resolved', resolution_type = p_resolution_type,
      reservation_id = p_reservation_id, resolution_reason = nullif(trim(p_reason), ''),
      resolved_by = auth.uid(), resolved_at = now()
  where id = v_resolution.id
  returning * into v_updated;

  insert into public.audit_events (
    entity_type, entity_id, action, title, summary, before_data, after_data, metadata,
    actor_user_id, actor_name, actor_email
  ) values (
    'parcel', v_resolution.parcel_id::text, 'status_changed', 'Voided contract lot resolution',
    'Resolution completed for a voided contract lot.',
    jsonb_build_object('parcel_status', v_previous_status, 'resolution_status', 'pending'),
    jsonb_build_object('resolution_status', 'resolved', 'resolution_type', p_resolution_type),
    jsonb_build_object('contract_id', v_resolution.contract_id, 'customer_id', v_resolution.customer_id,
      'reservation_id', p_reservation_id, 'reason', nullif(trim(p_reason), '')),
    auth.uid(), v_actor.full_name, v_actor.email
  );

  return v_updated;
end;
$$;

revoke all on function public.resolve_contract_void_resolution(uuid, text, text, uuid) from public;
grant execute on function public.resolve_contract_void_resolution(uuid, text, text, uuid) to authenticated;

-- Canonical server-side totals. Security invoker ensures callers receive only
-- rows available through the existing contracts/transactions RLS policies.
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
  coalesce((select sum(summary.total_posted_land_paid) from public.contract_financial_summary summary where summary.customer_id = cu.id), 0)::numeric(12,2) as land_paid,
  coalesce((select sum(t.amount) from public.transactions t where t.customer_id = cu.id and t.status = 'posted' and t.transaction_type in ('Garbage Fee'::public.transaction_type, 'Road Maintenance'::public.transaction_type)), 0)::numeric(12,2) as community_paid,
  coalesce((select sum(summary.remaining_balance) from public.contract_financial_summary summary where summary.customer_id = cu.id), 0)::numeric(12,2) as land_balance
from public.customers cu
;

grant select on public.customer_balance_view to authenticated;

-- Inspection-only queries for existing records. These do not change data.
comment on table public.contract_void_resolutions is
  'Batch 1 holds an explicit pending/resolved lot decision after contract void, including legacy voided contracts with Sold parcels. It never automatically releases parcels or changes payments.';
comment on view public.contract_financial_summary is
  'Canonical active-contract financial totals: active means is_active=true and status=active; only posted contract-linked land payments count.';
comment on function public.void_payment_record(bigint, text) is
  'Admin-only immutable payment correction: marks posted transaction voided, preserves documents, and writes a complete audit event. Never deletes a payment.';

commit;
