-- Phase B Contract Void/Cancel: safe contract correction with audit event.

alter table public.contracts
  add column if not exists status text,
  add column if not exists void_reason text,
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references auth.users(id) on delete set null,
  add column if not exists cancel_reason text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users(id) on delete set null;

do $$
begin
  if exists (
    select 1
    from pg_trigger
    where tgname = 'trg_validate_contract_write'
      and tgrelid = 'public.contracts'::regclass
  ) then
    alter table public.contracts disable trigger trg_validate_contract_write;
  end if;
end;
$$;

update public.contracts
set status = case when is_active then 'active' else 'archived' end
where status is null;

do $$
begin
  if exists (
    select 1
    from pg_trigger
    where tgname = 'trg_validate_contract_write'
      and tgrelid = 'public.contracts'::regclass
  ) then
    alter table public.contracts enable trigger trg_validate_contract_write;
  end if;
end;
$$;

alter table public.contracts
  alter column status set default 'active',
  alter column status set not null,
  drop constraint if exists contracts_status_valid,
  add constraint contracts_status_valid check (status in ('active', 'voided', 'cancelled', 'archived')),
  drop constraint if exists contracts_status_active_consistent,
  add constraint contracts_status_active_consistent check (
    (status = 'active' and is_active = true)
    or (status in ('voided', 'cancelled', 'archived') and is_active = false)
  ),
  drop constraint if exists contracts_void_reason_when_voided,
  add constraint contracts_void_reason_when_voided check (
    status <> 'voided'
    or (
      voided_at is not null
      and coalesce(trim(void_reason), '') <> ''
    )
  ),
  drop constraint if exists contracts_cancel_reason_when_cancelled,
  add constraint contracts_cancel_reason_when_cancelled check (
    status <> 'cancelled'
    or cancelled_at is not null
  );

create index if not exists idx_contracts_status
  on public.contracts(status);
create index if not exists idx_contracts_voided_at
  on public.contracts(voided_at);
create index if not exists idx_contracts_customer_status
  on public.contracts(customer_id, status);

create or replace function public.validate_contract_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.parcel_status;
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

  if tg_op = 'UPDATE'
    and new.parcel_id = old.parcel_id
    and new.is_active = false
    and old.is_active = true then
    return new;
  end if;

  select status into v_status
  from public.parcels
  where id = new.parcel_id
  for update;

  if v_status = 'Sold' then
    raise exception 'Cannot create contract for a sold lot.';
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
  v_actor record;
  v_reason text;
begin
  if not public.is_admin_user() then
    raise exception 'Only Admin and Super Admin users can void contracts.';
  end if;

  v_reason := nullif(trim(p_void_reason), '');
  if v_reason is null then
    raise exception 'Void reason is required.';
  end if;

  select *
  into v_contract
  from public.contracts
  where id = p_contract_id
  for update;

  if not found then
    raise exception 'Contract not found.';
  end if;

  if v_contract.status = 'voided' then
    raise exception 'Contract is already voided.';
  end if;

  if v_contract.status = 'cancelled' then
    raise exception 'Cancelled contracts cannot be voided in this workflow.';
  end if;

  select full_name, email
  into v_actor
  from public.admin_profiles
  where user_id = auth.uid();

  update public.contracts
  set
    status = 'voided',
    is_active = false,
    void_reason = v_reason,
    voided_at = now(),
    voided_by = auth.uid()
  where id = p_contract_id
  returning * into v_updated_contract;

  insert into public.audit_events (
    entity_type,
    entity_id,
    action,
    title,
    summary,
    before_data,
    after_data,
    metadata,
    actor_user_id,
    actor_name,
    actor_email
  )
  values (
    'contract',
    p_contract_id::text,
    'voided',
    'Contract voided',
    'Contract #' || p_contract_id::text || ' was voided and kept in history.',
    jsonb_build_object(
      'status', v_contract.status,
      'is_active', v_contract.is_active,
      'voided_at', v_contract.voided_at
    ),
    jsonb_build_object(
      'status', v_updated_contract.status,
      'is_active', v_updated_contract.is_active,
      'voided_at', v_updated_contract.voided_at,
      'void_reason', v_reason
    ),
    jsonb_build_object(
      'customer_id', v_contract.customer_id,
      'parcel_id', v_contract.parcel_id
    ),
    auth.uid(),
    v_actor.full_name,
    v_actor.email
  );

  return v_updated_contract;
end;
$$;

revoke all on function public.void_contract(bigint, text) from public;
grant execute on function public.void_contract(bigint, text) to authenticated;

comment on column public.contracts.status is 'Contract lifecycle status. Phase B uses active, voided, cancelled, and archived without changing payment or collections calculations.';
comment on column public.contracts.void_reason is 'Staff-entered reason for voiding a contract. Voiding keeps the contract in history.';
comment on function public.void_contract(bigint, text) is 'Admin-only contract void workflow. Sets contract inactive/voided and writes an audit event without mutating payments, collections, parcels, reservations, applications, leads, or post-sales records.';
