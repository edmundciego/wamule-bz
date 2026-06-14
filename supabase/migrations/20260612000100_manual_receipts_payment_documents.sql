begin;

alter table public.transactions
  add column if not exists manual_receipt_number text,
  add column if not exists receipt_date date,
  add column if not exists receipt_issued_by text,
  add column if not exists receipt_notes text;

create index if not exists idx_transactions_manual_receipt_number
  on public.transactions(manual_receipt_number);

create table if not exists public.payment_documents (
  id bigint generated always as identity primary key,
  transaction_id bigint references public.transactions(id) on delete set null,
  customer_id bigint not null references public.customers(id) on delete restrict,
  document_type text not null,
  file_path text not null,
  original_file_name text not null,
  uploaded_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),

  constraint payment_documents_document_type_valid check (
    document_type in ('Bank Transfer Proof', 'Manual Receipt Photo', 'Signed Payment Note', 'Other')
  )
);

create index if not exists idx_payment_documents_transaction_id
  on public.payment_documents(transaction_id);
create index if not exists idx_payment_documents_customer_id
  on public.payment_documents(customer_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-documents',
  'payment-documents',
  false,
  10485760,
  array['application/pdf','image/jpeg','image/png','image/webp']
)
on conflict (id) do nothing;

alter table public.payment_documents enable row level security;

drop policy if exists "Payment documents readable by internal users" on public.payment_documents;
create policy "Payment documents readable by internal users"
on public.payment_documents
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Payment documents writable by admin staff" on public.payment_documents;
create policy "Payment documents writable by admin staff"
on public.payment_documents
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Payment documents updateable by admins" on public.payment_documents;
create policy "Payment documents updateable by admins"
on public.payment_documents
for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

drop policy if exists "Payment documents deletable by admins" on public.payment_documents;
create policy "Payment documents deletable by admins"
on public.payment_documents
for delete
to authenticated
using (public.is_admin_user());

drop policy if exists "Internal users can read Wamuale files" on storage.objects;
create policy "Internal users can read Wamuale files"
on storage.objects
for select
to authenticated
using (
  bucket_id in ('contracts', 'receipts', 'application-documents', 'payment-documents')
  and public.is_internal_user()
);

drop policy if exists "Admin staff can upload Wamuale files" on storage.objects;
create policy "Admin staff can upload Wamuale files"
on storage.objects
for insert
to authenticated
with check (
  bucket_id in ('contracts', 'receipts', 'application-documents', 'payment-documents')
  and public.can_write_admin_data()
);

drop policy if exists "Admins can update Wamuale files" on storage.objects;
create policy "Admins can update Wamuale files"
on storage.objects
for update
to authenticated
using (
  bucket_id in ('contracts', 'receipts', 'application-documents', 'payment-documents')
  and public.is_admin_user()
)
with check (
  bucket_id in ('contracts', 'receipts', 'application-documents', 'payment-documents')
  and public.is_admin_user()
);

drop policy if exists "Admins can delete Wamuale files" on storage.objects;
create policy "Admins can delete Wamuale files"
on storage.objects
for delete
to authenticated
using (
  bucket_id in ('contracts', 'receipts', 'application-documents', 'payment-documents')
  and public.is_admin_user()
);

grant select, insert, update, delete on public.payment_documents to authenticated;

commit;
