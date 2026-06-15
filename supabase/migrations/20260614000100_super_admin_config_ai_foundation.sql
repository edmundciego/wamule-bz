-- Super Admin roles, configurable business options, and AI foundation.

create extension if not exists pgcrypto;

alter type public.app_role add value if not exists 'Super Admin';

create or replace function public.is_super_admin_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.admin_profiles
    where user_id = auth.uid()
      and role::text = 'Super Admin'
  );
$$;

create or replace function public.is_admin_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.admin_profiles
    where user_id = auth.uid()
      and role::text in ('Super Admin', 'Admin')
  );
$$;

create or replace function public.is_internal_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.admin_profiles
    where user_id = auth.uid()
      and role::text in ('Super Admin', 'Admin', 'Staff', 'Read Only')
  );
$$;

create or replace function public.can_write_admin_data()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.admin_profiles
    where user_id = auth.uid()
      and role::text in ('Super Admin', 'Admin', 'Staff')
  );
$$;

create table if not exists public.payment_methods (
  id bigint generated always as identity primary key,
  name text not null,
  method_type text not null,
  bank_name text,
  account_name text,
  account_number text,
  currency text not null default 'BZD',
  instructions text,
  is_active boolean not null default true,
  is_public boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_methods_method_type_valid check (method_type in ('Cash', 'Bank Transfer', 'Other')),
  constraint payment_methods_bank_fields_for_cash check (
    method_type <> 'Cash'
    or (
      coalesce(trim(bank_name), '') = ''
      and coalesce(trim(account_name), '') = ''
      and coalesce(trim(account_number), '') = ''
    )
  )
);

alter table public.installment_plans
  add column if not exists initial_deposit numeric(12,2) not null default 0;

update public.installment_plans
set initial_deposit = reservation_fee
where initial_deposit = 0
  and reservation_fee > 0;

alter table public.installment_plans
  drop constraint if exists installment_plans_term_max_60,
  add constraint installment_plans_term_max_60 check (term_months between 1 and 60),
  drop constraint if exists installment_plans_initial_deposit_nonnegative,
  add constraint installment_plans_initial_deposit_nonnegative check (initial_deposit >= 0);

create table if not exists public.lot_sizes (
  id bigint generated always as identity primary key,
  name text not null,
  dimensions text not null,
  default_price numeric(12,2) not null default 0,
  description text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lot_sizes_default_price_nonnegative check (default_price >= 0)
);

alter table public.parcels
  add column if not exists lot_size_id bigint references public.lot_sizes(id) on delete set null;

create table if not exists public.fee_types (
  id bigint generated always as identity primary key,
  name text not null,
  description text,
  default_amount numeric(12,2) not null default 0,
  frequency text not null default 'Monthly',
  is_required boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fee_types_default_amount_nonnegative check (default_amount >= 0),
  constraint fee_types_frequency_valid check (frequency in ('One-Time', 'Monthly', 'Yearly', 'As Needed'))
);

create table if not exists public.ai_settings (
  id bigint generated always as identity primary key,
  provider text not null default 'Gemini',
  model text not null default 'gemini-3.1-flash-lite',
  is_enabled boolean not null default false,
  daily_brief_enabled boolean not null default false,
  application_summary_enabled boolean not null default false,
  collections_assistant_enabled boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_settings_provider_valid check (provider in ('Gemini'))
);

create unique index if not exists uniq_payment_methods_name on public.payment_methods(lower(name));
create index if not exists idx_payment_methods_active_public_sort on public.payment_methods(is_active, is_public, sort_order);
create unique index if not exists uniq_lot_sizes_name on public.lot_sizes(lower(name));
create index if not exists idx_lot_sizes_active_sort on public.lot_sizes(is_active, sort_order);
create index if not exists idx_parcels_lot_size_id on public.parcels(lot_size_id);
create unique index if not exists uniq_fee_types_name on public.fee_types(lower(name));
create index if not exists idx_fee_types_active_sort on public.fee_types(is_active, sort_order);
create unique index if not exists uniq_single_ai_settings on public.ai_settings((true));

drop trigger if exists trg_payment_methods_updated_at on public.payment_methods;
create trigger trg_payment_methods_updated_at before update on public.payment_methods for each row execute function public.set_updated_at();
drop trigger if exists trg_lot_sizes_updated_at on public.lot_sizes;
create trigger trg_lot_sizes_updated_at before update on public.lot_sizes for each row execute function public.set_updated_at();
drop trigger if exists trg_fee_types_updated_at on public.fee_types;
create trigger trg_fee_types_updated_at before update on public.fee_types for each row execute function public.set_updated_at();
drop trigger if exists trg_ai_settings_updated_at on public.ai_settings;
create trigger trg_ai_settings_updated_at before update on public.ai_settings for each row execute function public.set_updated_at();

insert into public.payment_methods (name, method_type, currency, instructions, is_active, is_public, sort_order)
values
  ('Cash', 'Cash', 'BZD', 'Pay in person and record the manual receipt book number.', true, true, 10),
  ('Bank Transfer', 'Bank Transfer', 'BZD', 'Include the bank reference number when recording payment.', true, true, 20)
on conflict ((lower(name))) do update set
  method_type = excluded.method_type,
  currency = excluded.currency,
  instructions = coalesce(public.payment_methods.instructions, excluded.instructions),
  is_active = true,
  sort_order = excluded.sort_order,
  updated_at = now();

insert into public.installment_plans (
  name,
  description,
  reservation_fee,
  initial_deposit,
  final_purchase_price,
  term_months,
  monthly_payment,
  is_active,
  sort_order
)
values
  ('Installment Plan - 36 months', '$2,500 reservation fee, then $625.00 monthly for 36 months.', 2500, 2500, 25000, 36, 625, true, 10),
  ('Installment Plan - 48 months', '$2,500 reservation fee, then $470.00 monthly for 48 months.', 2500, 2500, 25000, 48, 470, true, 20),
  ('Installment Plan - 60 months', '$2,500 reservation fee, then $375.00 monthly for 60 months.', 2500, 2500, 25000, 60, 375, true, 30),
  ('Paid in Full', 'Full purchase price paid at contract signing.', 0, 25000, 25000, 1, 0, true, 40),
  ('Custom Agreement / Other Terms', 'Use custom payment terms approved by management.', 0, 0, 25000, 60, 0, true, 50)
on conflict (name) do update set
  description = excluded.description,
  reservation_fee = excluded.reservation_fee,
  initial_deposit = excluded.initial_deposit,
  final_purchase_price = excluded.final_purchase_price,
  term_months = excluded.term_months,
  monthly_payment = excluded.monthly_payment,
  is_active = true,
  sort_order = excluded.sort_order,
  updated_at = now();

insert into public.lot_sizes (name, dimensions, default_price, description, is_active, sort_order)
values
  ('Standard Phase 1 Lot', '65 x 101 ft', 25000, 'Standard Wamule Phase 1 lot size.', true, 10),
  ('Large Phase 1 Lot', '75 x 101 ft', 25000, 'Large Wamule Phase 1 lot size.', true, 20)
on conflict ((lower(name))) do update set
  dimensions = excluded.dimensions,
  default_price = excluded.default_price,
  description = excluded.description,
  is_active = true,
  sort_order = excluded.sort_order,
  updated_at = now();

with default_size as (
  select id
  from public.lot_sizes
  order by sort_order, id
  limit 1
)
update public.parcels
set lot_size_id = default_size.id
from default_size
where public.parcels.lot_size_id is null;

insert into public.fee_types (name, description, default_amount, frequency, is_required, is_active, sort_order)
values
  ('Garbage Fee', 'Community garbage collection fee.', 0, 'Monthly', true, true, 10),
  ('Road Maintenance', 'Community road maintenance fee.', 0, 'Monthly', true, true, 20)
on conflict ((lower(name))) do update set
  description = excluded.description,
  frequency = excluded.frequency,
  is_required = excluded.is_required,
  is_active = true,
  sort_order = excluded.sort_order,
  updated_at = now();

insert into public.ai_settings (
  provider,
  model,
  is_enabled,
  daily_brief_enabled,
  application_summary_enabled,
  collections_assistant_enabled
)
select 'Gemini', 'gemini-3.1-flash-lite', false, false, false, false
where not exists (select 1 from public.ai_settings);

drop view if exists public.public_parcel_options cascade;
create view public.public_parcel_options as
select
  p.id,
  p.lot_number,
  coalesce(ls.dimensions, p.dimensions) as dimensions,
  p.zoning,
  p.status,
  coalesce(nullif(p.base_price, 0), ls.default_price, p.base_price) as base_price,
  p.lot_size_id,
  ls.name as lot_size_name
from public.parcels p
left join public.lot_sizes ls on ls.id = p.lot_size_id
where p.lot_number ~ '^[0-9]{2}$'
  and p.status = 'Available'
order by p.lot_number;

drop view if exists public.parcel_board_view cascade;
create view public.parcel_board_view as
select
  p.id,
  p.lot_number,
  coalesce(ls.dimensions, p.dimensions) as dimensions,
  p.zoning,
  p.status,
  coalesce(nullif(p.base_price, 0), ls.default_price, p.base_price) as base_price,
  p.created_at,
  p.updated_at,
  p.lot_size_id,
  ls.name as lot_size_name,
  c.id as contract_id,
  cu.id as customer_id,
  trim(cu.first_name || ' ' || cu.last_name) as customer_name
from public.parcels p
left join public.lot_sizes ls on ls.id = p.lot_size_id
left join public.contracts c on c.parcel_id = p.id and c.is_active
left join public.customers cu on cu.id = c.customer_id
order by p.lot_number;

alter table public.payment_methods enable row level security;
alter table public.lot_sizes enable row level security;
alter table public.fee_types enable row level security;
alter table public.ai_settings enable row level security;

drop policy if exists "Internal can read admin profiles" on public.admin_profiles;
drop policy if exists "Admins manage admin profiles" on public.admin_profiles;
create policy "Internal can read admin profiles" on public.admin_profiles for select using (public.is_internal_user());
create policy "Super Admins manage admin profiles" on public.admin_profiles for all using (public.is_super_admin_user()) with check (public.is_super_admin_user());

drop policy if exists "Internal can read payment methods" on public.payment_methods;
drop policy if exists "Public can read active public payment methods" on public.payment_methods;
drop policy if exists "Admins manage payment methods" on public.payment_methods;
create policy "Internal can read payment methods" on public.payment_methods for select using (public.is_internal_user());
create policy "Public can read active public payment methods" on public.payment_methods for select using (is_active and is_public);
create policy "Admins manage payment methods" on public.payment_methods for all using (public.is_admin_user()) with check (public.is_admin_user());

drop policy if exists "Internal can read lot sizes" on public.lot_sizes;
drop policy if exists "Public can read active lot sizes" on public.lot_sizes;
drop policy if exists "Admins manage lot sizes" on public.lot_sizes;
create policy "Internal can read lot sizes" on public.lot_sizes for select using (public.is_internal_user());
create policy "Public can read active lot sizes" on public.lot_sizes for select using (is_active);
create policy "Admins manage lot sizes" on public.lot_sizes for all using (public.is_admin_user()) with check (public.is_admin_user());

drop policy if exists "Internal can read fee types" on public.fee_types;
drop policy if exists "Admins manage fee types" on public.fee_types;
create policy "Internal can read fee types" on public.fee_types for select using (public.is_internal_user());
create policy "Admins manage fee types" on public.fee_types for all using (public.is_admin_user()) with check (public.is_admin_user());

drop policy if exists "Internal can read AI settings" on public.ai_settings;
drop policy if exists "Super Admins manage AI settings" on public.ai_settings;
create policy "Internal can read AI settings" on public.ai_settings for select using (public.is_internal_user());
create policy "Super Admins manage AI settings" on public.ai_settings for all using (public.is_super_admin_user()) with check (public.is_super_admin_user());

grant select, insert, update, delete on public.payment_methods to authenticated;
grant select on public.payment_methods to anon;
grant select, insert, update, delete on public.lot_sizes to authenticated;
grant select on public.lot_sizes to anon;
grant select, insert, update, delete on public.fee_types to authenticated;
grant select, insert, update, delete on public.ai_settings to authenticated;
grant select on public.public_parcel_options to anon, authenticated;
grant select on public.parcel_board_view to authenticated;

comment on table public.ai_settings is 'AI feature flags and provider metadata. Provider API keys must remain server-side Supabase secrets or Vault entries.';
comment on function public.is_super_admin_user() is 'True when the current authenticated user has the Super Admin role.';
