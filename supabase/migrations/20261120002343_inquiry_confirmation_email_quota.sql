-- Temporary confirmation-email containment only; this does not rate-limit
-- inquiry intake. A successful reservation permits one provider attempt,
-- even when that attempt fails. The caller supplies SHA-256 hex digests of
-- the normalized recipient email and the trusted, canonical requester IP.
-- These digests are pseudonymous, not anonymous.
create table public.inquiry_confirmation_email_attempts (
  recipient_hash text not null check (recipient_hash ~ '^[0-9a-f]{64}$'),
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  attempted_at timestamptz not null
);

create index inquiry_confirmation_email_attempts_recipient_time_idx
  on public.inquiry_confirmation_email_attempts (recipient_hash, attempted_at);
create index inquiry_confirmation_email_attempts_ip_time_idx
  on public.inquiry_confirmation_email_attempts (ip_hash, attempted_at);
create index inquiry_confirmation_email_attempts_time_idx
  on public.inquiry_confirmation_email_attempts (attempted_at);

alter table public.inquiry_confirmation_email_attempts enable row level security;
revoke all on table public.inquiry_confirmation_email_attempts from public, anon, authenticated, service_role;
grant select, insert, delete on table public.inquiry_confirmation_email_attempts to service_role;

create function public.reserve_inquiry_confirmation_quota(
  p_recipient_hash text,
  p_ip_hash text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
begin
  if p_recipient_hash is null or p_recipient_hash !~ '^[0-9a-f]{64}$'
    or p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  -- One short global transaction lock prevents all check/insert races and
  -- avoids lock-order problems when different recipients share an IP.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('wamule:inquiry-confirmation-email-quota:v1', 0)
  );
  v_now := pg_catalog.clock_timestamp();

  -- Expired records are removed on the next reservation, with no cron job.
  delete from public.inquiry_confirmation_email_attempts
    where attempted_at <= v_now - interval '24 hours';

  if exists (
    select 1 from public.inquiry_confirmation_email_attempts
    where recipient_hash = p_recipient_hash
      and attempted_at > v_now - interval '24 hours'
  ) or (
    select pg_catalog.count(*) from public.inquiry_confirmation_email_attempts
    where ip_hash = p_ip_hash
      and attempted_at > v_now - interval '24 hours'
  ) >= 10 then
    return false;
  end if;

  insert into public.inquiry_confirmation_email_attempts (recipient_hash, ip_hash, attempted_at)
    values (p_recipient_hash, p_ip_hash, v_now);
  return true;
end;
$$;

revoke all on function public.reserve_inquiry_confirmation_quota(text, text) from public, anon, authenticated, service_role;
grant execute on function public.reserve_inquiry_confirmation_quota(text, text) to service_role;

comment on table public.inquiry_confirmation_email_attempts is
  'Temporary confirmation attempts: hashed recipient/IP only; expired rows are pruned at the next reservation.';
comment on function public.reserve_inquiry_confirmation_quota(text, text) is
  'Reserves at most 1 confirmation attempt per recipient and 10 per IP in a rolling 24 hours; caller must supply trusted IP and reserve before contacting the provider.';
