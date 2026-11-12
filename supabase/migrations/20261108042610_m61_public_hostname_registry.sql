-- M6.1: public hostname ownership and route-only scope resolution.
-- No host is considered active by default. DNS/Netlify proof is recorded by
-- the service-only verifier; M8 performs live staging DNS/HTTPS verification.

begin;

create schema if not exists provisioning_private;

create table public.public_hostname_bindings (
  id uuid primary key default gen_random_uuid(),
  hostname text not null,
  tenant_id uuid not null,
  project_id uuid not null,
  default_phase_id uuid,
  status text not null default 'pending',
  verification_challenge uuid not null default gen_random_uuid(),
  verification_method text,
  verification_evidence jsonb,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint public_hostname_bindings_hostname_unique unique (hostname),
  constraint public_hostname_bindings_status_valid
    check (status in ('pending', 'verified', 'active', 'inactive')),
  constraint public_hostname_bindings_verified_shape
    check (
      (status = 'pending'
        and verification_method is null
        and verification_evidence is null
        and verified_at is null)
      or (status in ('verified', 'active')
        and verification_method is not null
        and verification_evidence is not null
        and jsonb_typeof(verification_evidence) = 'object'
        and verified_at is not null)
      or (status = 'inactive'
        and (
          (verification_method is null and verification_evidence is null and verified_at is null)
          or (verification_method is not null
            and verification_evidence is not null
            and jsonb_typeof(verification_evidence) = 'object'
            and verified_at is not null)
        ))
    ),
  constraint public_hostname_bindings_tenant_fkey
    foreign key (tenant_id) references public.organizations(id) on update restrict on delete restrict,
  constraint public_hostname_bindings_project_tenant_fkey
    foreign key (project_id, tenant_id) references public.projects(id, tenant_id)
    on update restrict on delete restrict,
  constraint public_hostname_bindings_phase_scope_fkey
    foreign key (default_phase_id, project_id, tenant_id)
    references public.development_phases(id, project_id, tenant_id)
    on update restrict on delete restrict
);

comment on table public.public_hostname_bindings is
  'Private hostname-to-public-route registry. Never grants workspace or CRM access.';
comment on column public.public_hostname_bindings.hostname is
  'Canonical lowercase ASCII DNS hostname without a trailing dot, port, scheme, or path.';
comment on column public.public_hostname_bindings.default_phase_id is
  'Optional active default phase in the same project; null leaves phase selection to public routing.';
comment on column public.public_hostname_bindings.verification_evidence is
  'Sanitized service-validated evidence only; raw DNS/provider responses and challenge secrets are not stored.';

create index public_hostname_bindings_scope_idx
  on public.public_hostname_bindings (tenant_id, project_id, status);

alter table public.public_hostname_bindings enable row level security;
revoke all on table public.public_hostname_bindings from public, anon, authenticated, service_role;

create or replace function provisioning_private.normalize_public_hostname(p_hostname text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_hostname text;
begin
  if p_hostname is null then
    return null;
  end if;
  -- Reject non-ASCII input before case-folding so the SQL and JS normalizers
  -- accept the same ASCII/IDNA-A-label contract (for example, Kelvin sign → k).
  if octet_length(p_hostname) <> char_length(p_hostname) then
    return null;
  end if;

  v_hostname := lower(btrim(p_hostname));
  if right(v_hostname, 1) = '.' then
    v_hostname := left(v_hostname, length(v_hostname) - 1);
  end if;

  if length(v_hostname) > 253
    or v_hostname ~ '^[0-9.]+$'
    or v_hostname !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
  then
    return null;
  end if;

  return v_hostname;
end;
$$;

create or replace function provisioning_private.canonicalize_public_hostname_binding()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_hostname text;
begin
  v_hostname := provisioning_private.normalize_public_hostname(new.hostname);
  if v_hostname is null then
    raise exception 'Hostname must be a valid DNS name in canonical IDNA ASCII form.'
      using errcode = '22023';
  end if;
  new.hostname := v_hostname;
  new.updated_at := now();

  if tg_op = 'INSERT' then
    -- A direct insert cannot claim verified/active status.
    new.status := 'pending';
    new.verification_challenge := gen_random_uuid();
    new.verification_method := null;
    new.verification_evidence := null;
    new.verified_at := null;
  elsif new.hostname is distinct from old.hostname
    or new.tenant_id is distinct from old.tenant_id
    or new.project_id is distinct from old.project_id
    or new.default_phase_id is distinct from old.default_phase_id
  then
    -- Reassignment always starts a fresh challenge and clears prior proof.
    new.status := 'pending';
    new.verification_challenge := gen_random_uuid();
    new.verification_method := null;
    new.verification_evidence := null;
    new.verified_at := null;
  end if;

  return new;
end;
$$;

create trigger public_hostname_bindings_canonicalize
before insert or update on public.public_hostname_bindings
for each row execute function provisioning_private.canonicalize_public_hostname_binding();

create or replace function public.register_public_hostname_binding(
  p_hostname text,
  p_tenant_id uuid,
  p_project_id uuid,
  p_default_phase_id uuid default null
)
returns table (
  binding_id uuid,
  canonical_hostname text,
  verification_challenge uuid,
  binding_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hostname text;
  v_binding public.public_hostname_bindings%rowtype;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role is required.' using errcode = '42501';
  end if;

  v_hostname := provisioning_private.normalize_public_hostname(p_hostname);
  if v_hostname is null then
    raise exception 'Hostname is invalid.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.projects p
    where p.id = p_project_id and p.tenant_id = p_tenant_id
  ) then
    raise exception 'Project does not belong to the supplied tenant.' using errcode = '23503';
  end if;
  if p_default_phase_id is not null and not exists (
    select 1 from public.development_phases ph
    where ph.id = p_default_phase_id
      and ph.project_id = p_project_id
      and ph.tenant_id = p_tenant_id
  ) then
    raise exception 'Default phase does not belong to the supplied project and tenant.' using errcode = '23503';
  end if;

  select b.* into v_binding
  from public.public_hostname_bindings b
  where b.hostname = v_hostname
  for update;
  if found then
    if v_binding.tenant_id is distinct from p_tenant_id
      or v_binding.project_id is distinct from p_project_id
      or v_binding.default_phase_id is distinct from p_default_phase_id
    then
      raise exception 'Hostname is already claimed by another public scope.' using errcode = '23505';
    end if;
    return query select v_binding.id, v_binding.hostname, v_binding.verification_challenge, v_binding.status;
    return;
  end if;

  insert into public.public_hostname_bindings(hostname, tenant_id, project_id, default_phase_id)
  values (v_hostname, p_tenant_id, p_project_id, p_default_phase_id)
  returning * into v_binding;

  return query select v_binding.id, v_binding.hostname, v_binding.verification_challenge, v_binding.status;
end;
$$;

create or replace function public.reassign_public_hostname_binding(
  p_binding_id uuid,
  p_hostname text,
  p_tenant_id uuid,
  p_project_id uuid,
  p_default_phase_id uuid default null
)
returns table (
  binding_id uuid,
  canonical_hostname text,
  verification_challenge uuid,
  binding_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hostname text;
  v_binding public.public_hostname_bindings%rowtype;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role is required.' using errcode = '42501';
  end if;
  v_hostname := provisioning_private.normalize_public_hostname(p_hostname);
  if v_hostname is null then
    raise exception 'Hostname is invalid.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.projects p
    where p.id = p_project_id and p.tenant_id = p_tenant_id
  ) then
    raise exception 'Project does not belong to the supplied tenant.' using errcode = '23503';
  end if;
  if p_default_phase_id is not null and not exists (
    select 1 from public.development_phases ph
    where ph.id = p_default_phase_id
      and ph.project_id = p_project_id
      and ph.tenant_id = p_tenant_id
  ) then
    raise exception 'Default phase does not belong to the supplied project and tenant.' using errcode = '23503';
  end if;

  update public.public_hostname_bindings b
  set hostname = v_hostname,
      tenant_id = p_tenant_id,
      project_id = p_project_id,
      default_phase_id = p_default_phase_id
  where b.id = p_binding_id
  returning b.* into v_binding;
  if not found then
    raise exception 'Hostname binding was not found.' using errcode = 'P0002';
  end if;

  return query select v_binding.id, v_binding.hostname, v_binding.verification_challenge, v_binding.status;
end;
$$;

create or replace function public.get_public_hostname_verification_challenge(p_binding_id uuid)
returns table (
  binding_id uuid,
  canonical_hostname text,
  verification_challenge uuid,
  binding_status text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role is required.' using errcode = '42501';
  end if;

  return query
  select b.id, b.hostname, b.verification_challenge, b.status
  from public.public_hostname_bindings b
  where b.id = p_binding_id;
  if not found then
    raise exception 'Hostname binding was not found.' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.record_public_hostname_verification(
  p_binding_id uuid,
  p_evidence jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.public_hostname_bindings%rowtype;
  v_checked_at timestamptz;
  v_method text;
  v_provider text;
  v_stored_evidence jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role is required.' using errcode = '42501';
  end if;

  select b.* into v_binding
  from public.public_hostname_bindings b
  where b.id = p_binding_id
  for update;
  if not found then
    raise exception 'Hostname binding was not found.' using errcode = 'P0002';
  end if;
  if v_binding.status not in ('pending', 'inactive') then
    raise exception 'Only a pending or inactive binding may be verified.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_evidence) is distinct from 'object'
    or p_evidence ->> 'hostname' is distinct from v_binding.hostname
    or p_evidence ->> 'challenge' is distinct from v_binding.verification_challenge::text
    or p_evidence ->> 'verification_result' is distinct from 'passed'
    or p_evidence ->> 'server_validated' is distinct from 'true'
  then
    raise exception 'Server-validated evidence must match the current hostname challenge.' using errcode = '22023';
  end if;

  v_method := p_evidence ->> 'method';
  if v_method is null or v_method not in ('dns_txt', 'netlify_site_api', 'https_well_known') then
    raise exception 'Verification method is not supported.' using errcode = '22023';
  end if;
  v_provider := nullif(btrim(p_evidence ->> 'provider'), '');
  if v_provider is null or length(v_provider) > 120 then
    raise exception 'Verification provider is missing or invalid.' using errcode = '22023';
  end if;
  begin
    v_checked_at := (p_evidence ->> 'checked_at')::timestamptz;
  exception when others then
    raise exception 'Verification evidence has an invalid checked_at timestamp.' using errcode = '22023';
  end;
  if v_checked_at is null or v_checked_at > now() + interval '5 minutes' then
    raise exception 'Verification timestamp is invalid.' using errcode = '22023';
  end if;

  v_stored_evidence := jsonb_build_object(
    'hostname', v_binding.hostname,
    'challenge', v_binding.verification_challenge::text,
    'method', v_method,
    'provider', v_provider,
    'verification_result', 'passed',
    'server_validated', true,
    'checked_at', v_checked_at,
    'simulated', coalesce((p_evidence ->> 'simulated')::boolean, false),
    'evidence_digest', nullif(p_evidence ->> 'evidence_digest', '')
  );

  update public.public_hostname_bindings b
  set status = 'verified',
      verification_method = v_method,
      verification_evidence = v_stored_evidence,
      verified_at = v_checked_at
  where b.id = p_binding_id;

  return 'verified';
end;
$$;

create or replace function public.activate_public_hostname_binding(p_binding_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.public_hostname_bindings%rowtype;
  v_target_active boolean;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role is required.' using errcode = '42501';
  end if;

  select b.* into v_binding
  from public.public_hostname_bindings b
  where b.id = p_binding_id
  for update;
  if not found then
    raise exception 'Hostname binding was not found.' using errcode = 'P0002';
  end if;
  if v_binding.status not in ('verified', 'inactive')
    or v_binding.verification_evidence ->> 'hostname' is distinct from v_binding.hostname
    or v_binding.verification_evidence ->> 'challenge' is distinct from v_binding.verification_challenge::text
    or v_binding.verification_evidence ->> 'method' is distinct from v_binding.verification_method
    or v_binding.verification_evidence ->> 'verification_result' is distinct from 'passed'
    or v_binding.verification_evidence ->> 'server_validated' is distinct from 'true'
  then
    raise exception 'A current server-verified hostname proof is required before activation.' using errcode = '22023';
  end if;

  select o.is_active and p.id is not null
    and (v_binding.default_phase_id is null or coalesce(ph.is_active, false))
  into v_target_active
  from public.organizations o
  join public.projects p on p.id = v_binding.project_id and p.tenant_id = v_binding.tenant_id
  left join public.development_phases ph
    on ph.id = v_binding.default_phase_id
    and ph.project_id = v_binding.project_id
    and ph.tenant_id = v_binding.tenant_id
  where o.id = v_binding.tenant_id;

  if coalesce(v_target_active, false) is not true then
    raise exception 'Tenant, project, or default phase is not currently eligible.' using errcode = '22023';
  end if;

  update public.public_hostname_bindings b
  set status = 'active'
  where b.id = p_binding_id;
  return 'active';
end;
$$;

create or replace function public.deactivate_public_hostname_binding(p_binding_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role is required.' using errcode = '42501';
  end if;

  update public.public_hostname_bindings b
  set status = 'inactive'
  where b.id = p_binding_id;
  if not found then
    raise exception 'Hostname binding was not found.' using errcode = 'P0002';
  end if;
  return 'inactive';
end;
$$;

create or replace function public.resolve_public_hostname(p_hostname text)
returns table (
  resolution text,
  reason text,
  tenant_slug text,
  project_slug text,
  phase_slug text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hostname text;
  v_binding record;
begin
  v_hostname := provisioning_private.normalize_public_hostname(p_hostname);
  if v_hostname is null then
    return query select 'unresolved'::text, 'invalid_hostname'::text, null::text, null::text, null::text;
    return;
  end if;

  select b.status, b.verification_challenge, b.verification_method, b.verification_evidence,
    b.tenant_id, b.project_id, b.default_phase_id,
    o.slug as tenant_slug, o.is_active as tenant_active,
    p.slug as project_slug, p.id as resolved_project_id,
    ph.slug as phase_slug, ph.is_active as phase_active
  into v_binding
  from public.public_hostname_bindings b
  left join public.organizations o on o.id = b.tenant_id
  left join public.projects p on p.id = b.project_id and p.tenant_id = b.tenant_id
  left join public.development_phases ph
    on ph.id = b.default_phase_id
    and ph.project_id = b.project_id
    and ph.tenant_id = b.tenant_id
  where b.hostname = v_hostname;

  if not found then
    return query select 'unresolved'::text, 'unknown_host'::text, null::text, null::text, null::text;
    return;
  end if;
  if v_binding.status = 'pending' then
    return query select 'unresolved'::text, 'pending_verification'::text, null::text, null::text, null::text;
    return;
  end if;
  if v_binding.status = 'verified' then
    return query select 'unresolved'::text, 'awaiting_activation'::text, null::text, null::text, null::text;
    return;
  end if;
  if v_binding.status = 'inactive' then
    return query select 'unresolved'::text, 'inactive_binding'::text, null::text, null::text, null::text;
    return;
  end if;
  if v_binding.verification_evidence ->> 'hostname' is distinct from v_hostname
    or v_binding.verification_evidence ->> 'challenge' is distinct from v_binding.verification_challenge::text
    or v_binding.verification_evidence ->> 'method' is distinct from v_binding.verification_method
    or v_binding.verification_evidence ->> 'verification_result' is distinct from 'passed'
    or v_binding.verification_evidence ->> 'server_validated' is distinct from 'true'
  then
    return query select 'unresolved'::text, 'stale_verification'::text, null::text, null::text, null::text;
    return;
  end if;
  if v_binding.tenant_slug is null or v_binding.tenant_active is not true
    or v_binding.resolved_project_id is null
  then
    return query select 'unresolved'::text, 'inactive_or_ineligible_target'::text, null::text, null::text, null::text;
    return;
  end if;
  if v_binding.default_phase_id is not null and v_binding.phase_active is not true then
    return query select 'unresolved'::text, 'inactive_or_ineligible_target'::text, null::text, null::text, null::text;
    return;
  end if;

  return query select 'resolved'::text, null::text, v_binding.tenant_slug, v_binding.project_slug, v_binding.phase_slug;
end;
$$;

revoke all on function provisioning_private.normalize_public_hostname(text) from public, anon, authenticated, service_role;
revoke all on function provisioning_private.canonicalize_public_hostname_binding() from public, anon, authenticated, service_role;

revoke all on function public.register_public_hostname_binding(text, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.reassign_public_hostname_binding(uuid, text, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_public_hostname_verification_challenge(uuid) from public, anon, authenticated, service_role;
revoke all on function public.record_public_hostname_verification(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.activate_public_hostname_binding(uuid) from public, anon, authenticated, service_role;
revoke all on function public.deactivate_public_hostname_binding(uuid) from public, anon, authenticated, service_role;
revoke all on function public.resolve_public_hostname(text) from public, anon, authenticated, service_role;

grant execute on function public.register_public_hostname_binding(text, uuid, uuid, uuid) to service_role;
grant execute on function public.reassign_public_hostname_binding(uuid, text, uuid, uuid, uuid) to service_role;
grant execute on function public.get_public_hostname_verification_challenge(uuid) to service_role;
grant execute on function public.record_public_hostname_verification(uuid, jsonb) to service_role;
grant execute on function public.activate_public_hostname_binding(uuid) to service_role;
grant execute on function public.deactivate_public_hostname_binding(uuid) to service_role;
grant execute on function public.resolve_public_hostname(text) to anon, authenticated, service_role;

commit;
