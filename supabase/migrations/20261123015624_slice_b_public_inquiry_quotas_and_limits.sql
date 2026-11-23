begin;

-- Preserve legacy recipient reservations while adding project scope. Rows made
-- by the earlier two-argument RPC cannot be assigned to a project, so their
-- recipient cooldown remains effective but they do not count toward a
-- project-specific cap.
alter table public.inquiry_confirmation_email_attempts
  add column project_id uuid references public.projects(id) on delete cascade;
alter table public.inquiry_confirmation_email_attempts
  alter column ip_hash drop not null;
alter table public.inquiry_confirmation_email_attempts
  drop constraint if exists inquiry_confirmation_email_attempts_ip_hash_check;
alter table public.inquiry_confirmation_email_attempts
  add constraint inquiry_confirmation_email_attempts_ip_hash_check
  check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$');

create index inquiry_confirmation_email_attempts_project_time_idx
  on public.inquiry_confirmation_email_attempts (project_id, attempted_at)
  where project_id is not null;

-- Replace the earlier signature so stale function bundles fail closed instead
-- of reserving without a project cap. An absent verified IP skips only the IP
-- sub-limit; the recipient and project allowances are still reserved.
drop function if exists public.reserve_inquiry_confirmation_quota(text, text);

create function public.reserve_inquiry_confirmation_quota(
  p_project_id uuid,
  p_recipient_hash text,
  p_ip_hash text default null
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
begin
  if p_project_id is null
    or p_recipient_hash is null or p_recipient_hash !~ '^[0-9a-f]{64}$'
    or (p_ip_hash is not null and p_ip_hash !~ '^[0-9a-f]{64}$') then
    return false;
  end if;

  -- Serialize check/insert to prevent concurrent requests from exceeding any
  -- rolling allowance, including requests with no verifiable client IP.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('wamule:inquiry-confirmation-email-quota:v2', 0)
  );
  v_now := pg_catalog.clock_timestamp();

  delete from public.inquiry_confirmation_email_attempts
    where attempted_at <= v_now - interval '24 hours';

  if exists (
    select 1 from public.inquiry_confirmation_email_attempts
    where recipient_hash = p_recipient_hash
      and attempted_at > v_now - interval '24 hours'
  ) or (
    select pg_catalog.count(*) from public.inquiry_confirmation_email_attempts
    where project_id = p_project_id
      and attempted_at > v_now - interval '24 hours'
  ) >= 50 or (
    p_ip_hash is not null and (
      select pg_catalog.count(*) from public.inquiry_confirmation_email_attempts
      where ip_hash = p_ip_hash
        and attempted_at > v_now - interval '24 hours'
    ) >= 10
  ) then
    return false;
  end if;

  insert into public.inquiry_confirmation_email_attempts
    (project_id, recipient_hash, ip_hash, attempted_at)
  values (p_project_id, p_recipient_hash, p_ip_hash, v_now);
  return true;
end;
$$;

revoke all on function public.reserve_inquiry_confirmation_quota(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_inquiry_confirmation_quota(uuid, text, text)
  to service_role;

comment on function public.reserve_inquiry_confirmation_quota(uuid, text, text) is
  'Atomically reserves one recipient attempt per rolling 24 hours, up to 50 attempts per project per rolling 24 hours, and up to 10 per IP when the caller has a verified client IP. Reservations count failed provider attempts.';

-- Per-project B1 lead allowances are configured independently of confirmation
-- email quotas. A row is required for every public-inquiry-enabled project;
-- unconfigured projects fail closed until their plan allowance is assigned.
create table public.project_public_inquiry_limits (
  project_id uuid primary key references public.projects(id) on delete cascade,
  max_leads integer not null check (max_leads > 0),
  rolling_window interval not null check (rolling_window > interval '0 seconds'),
  updated_at timestamptz not null default pg_catalog.clock_timestamp()
);

alter table public.project_public_inquiry_limits enable row level security;
revoke all on table public.project_public_inquiry_limits from public, anon, authenticated, service_role;

-- B1 grants every project 100 new public inquiry leads in any rolling 24-hour
-- window. Seed existing projects and cover future projects while briefly
-- excluding concurrent project inserts so no project can miss its allowance.
lock table public.projects in share row exclusive mode;
insert into public.project_public_inquiry_limits (project_id, max_leads, rolling_window)
  select id, 100, interval '24 hours' from public.projects
  on conflict (project_id) do nothing;

create function public.seed_public_inquiry_project_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.project_public_inquiry_limits (project_id, max_leads, rolling_window)
  values (new.id, 100, interval '24 hours')
  on conflict (project_id) do nothing;
  return new;
end;
$$;

revoke all on function public.seed_public_inquiry_project_limit() from public, anon, authenticated, service_role;
create trigger seed_public_inquiry_project_limit
  after insert on public.projects
  for each row execute function public.seed_public_inquiry_project_limit();

create index leads_public_inquiry_project_created_idx
  on public.leads (project_id, created_at)
  where source = 'public_inquiry';

create function public.enforce_public_inquiry_project_lead_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_window interval;
  v_now timestamptz;
  v_count bigint;
begin
  if new.source is distinct from 'public_inquiry' then
    return new;
  end if;
  if new.project_id is null then
    raise exception using errcode = 'P0001', message = 'public_inquiry_project_required';
  end if;

  -- A per-project transaction lock serializes limit check + lead insertion,
  -- including writes from older RPC overloads and every inquiry entry mode.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('wamule:public-inquiry-lead-limit:' || new.project_id::text, 0)
  );

  -- Retry RPCs and older ON CONFLICT paths reach this trigger before unique
  -- arbitration. Existing references reuse their lead and do not spend a slot.
  if new.client_reference_id is not null and exists (
    select 1 from public.leads existing
    where existing.tenant_id = new.tenant_id
      and existing.project_id = new.project_id
      and existing.client_reference_id = new.client_reference_id
  ) then
    return new;
  end if;

  select limits.max_leads, limits.rolling_window
    into v_limit, v_window
    from public.project_public_inquiry_limits limits
    where limits.project_id = new.project_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'public_inquiry_lead_limit_not_configured';
  end if;

  v_now := pg_catalog.clock_timestamp();
  -- The event time is set after taking the project lock, so long waits cannot
  -- make accepted rows appear older than the rolling lead-creation window.
  new.created_at := v_now;
  select pg_catalog.count(*) into v_count
    from public.leads existing
    where existing.project_id = new.project_id
      and existing.source = 'public_inquiry'
      and existing.created_at > v_now - v_window;
  if v_count >= v_limit then
    raise exception using errcode = 'P0001', message = 'public_inquiry_lead_limit_reached';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_public_inquiry_project_lead_limit() from public, anon, authenticated, service_role;
drop trigger if exists enforce_public_inquiry_project_lead_limit on public.leads;
create trigger enforce_public_inquiry_project_lead_limit
  before insert on public.leads
  for each row execute function public.enforce_public_inquiry_project_lead_limit();

comment on table public.project_public_inquiry_limits is
  'Project-scoped B1 public inquiry lead cap and rolling window; defaults to 100 new leads per rolling 24 hours and is never configurable by public clients.';
comment on function public.seed_public_inquiry_project_limit() is
  'Seeds every new project with the B1 default of 100 public inquiry leads per rolling 24 hours.';
comment on function public.enforce_public_inquiry_project_lead_limit() is
  'Serializes project-scoped public inquiry lead creation, shares the allowance across phases, hostnames, modern/legacy entry modes, and excludes idempotent retries.';

commit;
