-- Slice 1.7 local-only DB hardening (embedded Postgres harness only).
--
-- LOCAL ONLY — never move into supabase/migrations/ and never run against
-- staging/prod. (Versioned in git only because the slice-1.7 DB test depends
-- on it; living under scripts/ means `supabase db push` can never pick it
-- up.) It tightens the slice-1.5 objects for the 1.7 threat model:
--
-- 1. onboarding_states: authenticated loses ALL writes (SELECT only).
--    Only the edge function's service role writes stage rows.
-- 2. correction_drafts: new real `stage` column (mirrors the gated stage;
--    edge function writes it alongside onboarding_states). Authenticated
--    gets column-scoped grants that EXCLUDE `stage`: direct
--    UPDATE ... SET stage is refused with 42501 permission denied.
-- 3. correction_waivers: scope check extended with 'overlap' (1.7 gate).
-- 4. correction_gate_results (new): append-only-by-service record of
--    passing gate evaluations. Authenticated: SELECT only.
-- 5. masterplan_versions (minimal local copy): activation
--    (is_active = true) requires a recorded passing 'masterplan-activation'
--    gate result — enforced by trigger for EVERY role including service.
-- 6. correction_bulk_seeds (new): server-issued single-use nonces.
--    Authenticated: SELECT only. Consumption is ONLY via
--    consume_correction_bulk_seed(), which flips used atomically.
--
-- What the harness superuser connection stands in for: service_role
-- (bypassrls + explicit GRANT ALL, mirroring hosted). Staff tests run
-- SET ROLE authenticated + app.uid impersonation.

-- -----------------------------------------------------------------------------
-- 1. Onboarding states: SELECT-only for authenticated.
-- -----------------------------------------------------------------------------
drop policy if exists "Staff can manage onboarding states" on public.onboarding_states;

revoke all on public.onboarding_states from authenticated;
grant select on public.onboarding_states to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Drafts: real stage column, authenticated cannot touch it.
-- -----------------------------------------------------------------------------
alter table public.correction_drafts
  add column if not exists stage text not null default 'intake';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'correction_drafts_stage_valid'
  ) then
    alter table public.correction_drafts
      add constraint correction_drafts_stage_valid check (stage in (
        'intake', 'classify', 'legend', 'read', 'correct',
        'validate', 'preview', 'sign-off', 'live', 'operate'
      ));
  end if;
end
$$;

revoke all on public.correction_drafts from authenticated;
grant select on public.correction_drafts to authenticated;
grant insert (tenant_id, project_slug, rev, doc, updated_by)
  on public.correction_drafts to authenticated;
grant update (rev, doc, updated_by, updated_at)
  on public.correction_drafts to authenticated;

comment on column public.correction_drafts.stage is
  'Slice 1.7: server-side stage mirror. Written only by the gated publish path (service role); authenticated has no grant on this column. The doc-embedded stage is client-influenced and never trusted.';

-- -----------------------------------------------------------------------------
-- 3. Waiver scopes: add overlap (within-draft overlap waivers).
-- -----------------------------------------------------------------------------
alter table public.correction_waivers
  drop constraint if exists correction_waivers_scope_valid;

alter table public.correction_waivers
  add constraint correction_waivers_scope_valid
  check (scope in ('lot', 'gate', 'duplicate', 'gap', 'overlap'));

-- -----------------------------------------------------------------------------
-- 4. Gate results: service-written record of passing evaluations.
-- -----------------------------------------------------------------------------
create table if not exists public.correction_gate_results (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  project_slug text not null default '',
  gate text not null,
  pass boolean not null,
  details jsonb not null default '{}'::jsonb,
  actor text not null,
  created_at timestamptz not null default now(),

  constraint correction_gate_results_gate_present check (length(trim(gate)) > 0),
  constraint correction_gate_results_actor_present check (length(trim(actor)) > 0)
);

create index if not exists idx_correction_gate_results_tenant_gate
  on public.correction_gate_results (tenant_id, gate, pass, created_at);

comment on table public.correction_gate_results is
  'Slice 1.7: recorded gate evaluations. Only service_role inserts (edge function after running the shared verdict); activation triggers and seed issuance read passing rows. Authenticated has SELECT only.';

alter table public.correction_gate_results enable row level security;

drop policy if exists "Internal can read gate results" on public.correction_gate_results;
create policy "Internal can read gate results"
on public.correction_gate_results for select to authenticated
using (public.is_internal_user());

drop policy if exists tenant_isolation on public.correction_gate_results;
create policy tenant_isolation on public.correction_gate_results as restrictive for all to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

revoke all on public.correction_gate_results from authenticated;
grant select on public.correction_gate_results to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Masterplan versions (minimal local copy) + activation gate trigger.
-- -----------------------------------------------------------------------------
create table if not exists public.masterplan_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  version_number integer not null,
  image_url text not null,
  file_name text not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid,

  constraint masterplan_versions_number_positive check (version_number > 0),
  constraint masterplan_versions_image_present check (length(trim(image_url)) > 0),
  constraint masterplan_versions_file_present check (length(trim(file_name)) > 0)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'uniq_masterplan_versions_tenant_number'
  ) then
    alter table public.masterplan_versions
      add constraint uniq_masterplan_versions_tenant_number unique (tenant_id, version_number);
  end if;
end
$$;

alter table public.masterplan_versions enable row level security;

drop policy if exists "Internal can read masterplan versions" on public.masterplan_versions;
create policy "Internal can read masterplan versions"
on public.masterplan_versions for select to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create masterplan versions" on public.masterplan_versions;
create policy "Staff can create masterplan versions"
on public.masterplan_versions for insert to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Staff can update masterplan versions" on public.masterplan_versions;
create policy "Staff can update masterplan versions"
on public.masterplan_versions for update to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists tenant_isolation on public.masterplan_versions;
create policy tenant_isolation on public.masterplan_versions as restrictive for all to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

revoke all on public.masterplan_versions from authenticated;
grant select, insert, update, delete on public.masterplan_versions to authenticated;

-- Activation requires a RECORDED PASSING gate result (all roles, no bypass:
-- the check is on the record, not the caller).
create or replace function public.require_gate_result_for_masterplan_activation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_active is true and (TG_OP = 'INSERT' or old.is_active is distinct from true) then
    if not exists (
      select 1 from public.correction_gate_results g
      where g.tenant_id = new.tenant_id
        and g.gate = 'masterplan-activation'
        and g.pass is true
    ) then
      raise exception 'masterplan activation refused: no recorded passing masterplan-activation gate result for tenant %', new.tenant_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_require_gate_for_activation on public.masterplan_versions;
create trigger trg_require_gate_for_activation
  before insert or update of is_active on public.masterplan_versions
  for each row execute function public.require_gate_result_for_masterplan_activation();

comment on function public.require_gate_result_for_masterplan_activation() is
  'Slice 1.7: masterplan_versions.is_active may only turn true when a passing masterplan-activation gate result is recorded. Applies to every role including service_role.';

-- -----------------------------------------------------------------------------
-- 6. Bulk-seed nonces: single-use enforced in the database.
-- -----------------------------------------------------------------------------
create table if not exists public.correction_bulk_seeds (
  seed_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  project_slug text not null,
  seed bigint not null,
  proposal jsonb not null default '[]'::jsonb,
  sample jsonb not null default '[]'::jsonb,
  used boolean not null default false,
  used_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),

  constraint correction_bulk_seeds_project_present check (length(trim(project_slug)) > 0),
  constraint correction_bulk_seeds_creator_present check (length(trim(created_by)) > 0)
);

create unique index if not exists uniq_correction_bulk_seeds_tenant_project_seed
  on public.correction_bulk_seeds (tenant_id, project_slug, seed_id);

comment on table public.correction_bulk_seeds is
  'Slice 1.7: server-issued bulk-accept nonces. Only service_role inserts; the ONLY consumer is consume_correction_bulk_seed(), which flips used atomically (compare-and-swap). Authenticated has SELECT only.';

alter table public.correction_bulk_seeds enable row level security;

drop policy if exists "Internal can read bulk seeds" on public.correction_bulk_seeds;
create policy "Internal can read bulk seeds"
on public.correction_bulk_seeds for select to authenticated
using (public.is_internal_user());

drop policy if exists tenant_isolation on public.correction_bulk_seeds;
create policy tenant_isolation on public.correction_bulk_seeds as restrictive for all to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

revoke all on public.correction_bulk_seeds from authenticated;
grant select on public.correction_bulk_seeds to authenticated;

-- Atomic single-use consumer. The service layer authenticates the caller
-- (JWT -> tenant) BEFORE calling; this function re-verifies the seed is
-- bound to the claimed tenant, then compare-and-swaps used=false -> true.
-- Replay, unknown ids, and cross-tenant seeds all raise.
create or replace function public.consume_correction_bulk_seed(
  p_seed_id uuid,
  p_tenant_id uuid,
  p_actor text
)
returns table (proposal jsonb, sample jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_used boolean;
begin
  if p_actor is null or length(trim(p_actor)) = 0 then
    raise exception 'bulk seed consume refused: actor is required';
  end if;
  select s.tenant_id, s.used into v_tenant, v_used
  from public.correction_bulk_seeds s
  where s.seed_id = p_seed_id;
  if not found then
    raise exception 'bulk seed consume refused: unknown seed %', p_seed_id;
  end if;
  if v_tenant is distinct from p_tenant_id then
    raise exception 'bulk seed consume refused: cross-tenant seed';
  end if;
  if v_used then
    raise exception 'bulk seed consume refused: seed % already used (single-use)', p_seed_id;
  end if;
  return query
  update public.correction_bulk_seeds s
  set used = true, used_at = now()
  where s.seed_id = p_seed_id and s.used = false
  returning s.proposal, s.sample;
  if not found then
    raise exception 'bulk seed consume refused: seed % already used (single-use)', p_seed_id;
  end if;
end;
$$;

comment on function public.consume_correction_bulk_seed(uuid, uuid, text) is
  'Slice 1.7: atomic single-use consumer for bulk-accept nonces. Lost races (two concurrent consumes) resolve to exactly one winner via the used=false compare-and-swap.';
