begin;

create table if not exists public.business_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_business_settings_updated_at on public.business_settings;
create trigger trg_business_settings_updated_at
before update on public.business_settings
for each row execute function public.set_updated_at();

create table if not exists public.installment_plans (
  id bigint generated always as identity primary key,
  name text not null unique,
  description text,
  reservation_fee numeric(12,2) not null default 0,
  final_purchase_price numeric(12,2) not null default 0,
  term_months integer not null default 1,
  monthly_payment numeric(12,2) not null default 0,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint installment_plans_reservation_fee_nonnegative check (reservation_fee >= 0),
  constraint installment_plans_final_price_nonnegative check (final_purchase_price >= 0),
  constraint installment_plans_term_positive check (term_months > 0),
  constraint installment_plans_monthly_nonnegative check (monthly_payment >= 0)
);

create index if not exists idx_installment_plans_active_sort on public.installment_plans(is_active, sort_order);

drop trigger if exists trg_installment_plans_updated_at on public.installment_plans;
create trigger trg_installment_plans_updated_at
before update on public.installment_plans
for each row execute function public.set_updated_at();

insert into public.business_settings (key, value)
values
  ('company_profile', '{
    "company_name": "Wamuale Development",
    "logo_url": "/favicon/android-chrome-192x192.png",
    "contact_email": "",
    "phone_number": "",
    "website": "",
    "location_address": "Mile 3, Hummingbird Highway, Dangriga Town, Belize",
    "short_description": "Private subdivision land development in Dangriga Town, Belize."
  }'::jsonb),
  ('public_application', '{
    "applications_open": true,
    "public_notice_text": "Submission of this application is solely a request to be considered for the purchase of a lot within Wamuale Development. Submission or acceptance of this application does not create any legal right to purchase land, does not reserve a lot, and does not guarantee that any lot will be sold or transferred to the applicant.",
    "application_acknowledgment_text": "By signing this application, I acknowledge and understand that submission does not guarantee approval or allocation of a lot; approval is subject to availability and acceptance by Wamuale Development; the reservation fee is non-refundable and paid to reserve a selected lot; final selection is subject to inspection and confirmation; only a signed purchase agreement may result in ownership transfer; utilities and closing charges may be applicant responsibilities; and this application is not a sale agreement.",
    "show_lot_prices_publicly": true,
    "show_available_lot_count_publicly": true,
    "default_confirmation_message": "Application submitted. A Wamuale Development representative will contact you after review."
  }'::jsonb),
  ('payment_settings', '{
    "accepted_payment_methods": "Cash, Online Transfer",
    "bank_name": "",
    "account_name": "",
    "account_number": "",
    "payment_instructions": "",
    "manual_receipt_book_required": true,
    "receipt_number_instructions": "Record the physical receipt book number after payment is received."
  }'::jsonb),
  ('lot_phase', '{
    "phase_name": "Phase 1",
    "default_lot_size": "65 x 101 or 75 x 101 ft",
    "default_lot_price": 25000,
    "public_availability_display": true
  }'::jsonb)
on conflict (key) do nothing;

insert into public.installment_plans (
  name,
  description,
  reservation_fee,
  final_purchase_price,
  term_months,
  monthly_payment,
  is_active,
  sort_order
)
values
  ('Installment Plan - 36 months', '$2,500 reservation fee, $625.00 monthly', 2500, 25000, 36, 625, true, 10),
  ('Installment Plan - 48 months', '$2,500 reservation fee, $470.00 monthly', 2500, 25000, 48, 470, true, 20),
  ('Installment Plan - 60 months', '$2,500 reservation fee, $375.00 monthly', 2500, 25000, 60, 375, true, 30),
  ('Paid in Full', '$2,500 reservation fee, remaining balance due at purchase agreement', 2500, 25000, 1, 0, true, 40),
  ('Other Agreement / Custom Terms', 'Use custom deposit, price, and term', 0, 0, 1, 0, true, 50)
on conflict (name) do nothing;

insert into storage.buckets (id, name, public)
values ('business-assets', 'business-assets', true)
on conflict (id) do update set public = excluded.public;

alter table public.business_settings enable row level security;
alter table public.installment_plans enable row level security;

drop policy if exists "Business settings readable by internal users" on public.business_settings;
create policy "Business settings readable by internal users"
on public.business_settings
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Public business settings readable by anon" on public.business_settings;
create policy "Public business settings readable by anon"
on public.business_settings
for select
to anon
using (key in ('company_profile', 'public_application', 'lot_phase'));

drop policy if exists "Business settings updateable by admins" on public.business_settings;
create policy "Business settings updateable by admins"
on public.business_settings
for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

drop policy if exists "Business settings insertable by admins" on public.business_settings;
create policy "Business settings insertable by admins"
on public.business_settings
for insert
to authenticated
with check (public.is_admin_user());

drop policy if exists "Installment plans readable by internal users" on public.installment_plans;
create policy "Installment plans readable by internal users"
on public.installment_plans
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Active installment plans readable by anon" on public.installment_plans;
create policy "Active installment plans readable by anon"
on public.installment_plans
for select
to anon
using (is_active = true);

drop policy if exists "Installment plans writable by admins" on public.installment_plans;
create policy "Installment plans writable by admins"
on public.installment_plans
for all
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

drop policy if exists "Business assets readable publicly" on storage.objects;
create policy "Business assets readable publicly"
on storage.objects
for select
to public
using (bucket_id = 'business-assets');

drop policy if exists "Business assets managed by admins" on storage.objects;
create policy "Business assets managed by admins"
on storage.objects
for all
to authenticated
using (bucket_id = 'business-assets' and public.is_admin_user())
with check (bucket_id = 'business-assets' and public.is_admin_user());

grant select, insert, update on public.business_settings to authenticated;
grant select on public.business_settings to anon;
grant select, insert, update, delete on public.installment_plans to authenticated;
grant select on public.installment_plans to anon;

commit;
