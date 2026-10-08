-- Inquiry endpoint idempotency: retries (user double-submit, network retry
-- after a 500) carry the same client_reference_id and must not create a
-- second lead. Nullable + unique: existing rows keep NULL (Postgres allows
-- multiple NULLs in a unique index), new public inquiries set one uuid.
alter table public.leads
  add column if not exists client_reference_id text;

do $$
begin
  if not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = 'leads_client_reference_id_uniq'
  ) then
    create unique index leads_client_reference_id_uniq
      on public.leads (client_reference_id);
  end if;
end $$;

comment on column public.leads.client_reference_id is
  'Inquiry idempotency key (uuid per form open) for submit-public-inquiry retries.';
