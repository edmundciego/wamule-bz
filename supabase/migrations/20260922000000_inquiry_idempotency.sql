-- Inquiry endpoint idempotency: retries (user double-submit, network retry
-- after a 500) carry the same client_reference_id and must not create a
-- second lead. Uniqueness is per (tenant_id, key): the same key may be
-- reused across developments, but never twice within one. Partial index
-- keeps legacy NULL keys out. New public inquiries always resolve a tenant
-- (lot-authoritative, no default fallback), so tenant_id is non-null there.
alter table public.leads
  add column if not exists client_reference_id text;

create unique index if not exists leads_tenant_reference_uniq
  on public.leads (tenant_id, client_reference_id)
  where client_reference_id is not null;

comment on column public.leads.client_reference_id is
  'Inquiry idempotency key (uuid per form open) for submit-public-inquiry retries. Unique per tenant.';
