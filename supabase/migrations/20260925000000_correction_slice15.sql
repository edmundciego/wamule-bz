-- Slice 1.5 correction workspace persistence.
--
-- Design notes (enforcement split):
-- - This migration owns persistence + access control + structural invariants.
-- - Overlap refusal and stage-gate evaluation are enforced by the publish
--   path (src/lib/correction: DraftStore.publish runs matchPublish() then
--   the stage gate; any failure refuses). Any future publish RPC/route MUST
--   call that same path — the UI preview is never authoritative.
-- - Draft concurrency is optimistic locking on correction_drafts.rev: savers
--   must UPDATE ... WHERE rev = :baseRev and treat 0 updated rows as a
--   409 conflict (reload + retry). The trigger below additionally rejects
--   rev moving backwards.
-- - Actor binding: updated_by/actor columns are populated from the server
--   session (auth.uid()), never trusted from client payloads.
-- - Renumber integrity: lots are keyed by stable id; lot_number is display
--   only. Publish joins on id, so renames cannot break linkage. Every
--   renumber is an append-only correction_edits row (before/after).
--
-- 1. Onboarding states (one row per tenant/project).
-- -----------------------------------------------------------------------------

create table if not exists public.onboarding_states (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  project_slug text not null,
  stage text not null default 'intake',
  artifacts jsonb not null default '{}'::jsonb,
  gate_results jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz not null default now(),

  constraint onboarding_stage_valid check (stage in (
    'intake', 'classify', 'legend', 'read', 'correct',
    'validate', 'preview', 'sign-off', 'live', 'operate'
  )),
  constraint onboarding_project_slug_present check (length(trim(project_slug)) > 0)
);

create unique index if not exists uniq_onboarding_tenant_project
  on public.onboarding_states (tenant_id, project_slug);

comment on table public.onboarding_states is 'Slice 1.5: onboarding stage per tenant/project. Stage advances only through the gated publish path (DraftStore.publish); direct writes cannot skip gates.';

-- 2. Correction drafts (server-side working copy, optimistic locking).
-- -----------------------------------------------------------------------------

create table if not exists public.correction_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  project_slug text not null,
  rev integer not null default 0,
  doc jsonb not null default '{"lots": {}}'::jsonb,
  updated_by uuid,
  updated_at timestamptz not null default now(),

  constraint correction_drafts_rev_nonnegative check (rev >= 0),
  constraint correction_drafts_project_present check (length(trim(project_slug)) > 0)
);

create unique index if not exists uniq_correction_drafts_tenant_project
  on public.correction_drafts (tenant_id, project_slug);

-- Rev must never move backwards (OCC compare-and-swap on top).
create or replace function public.prevent_draft_rev_regress()
returns trigger language plpgsql as $$
begin
  if new.rev < old.rev then
    raise exception 'correction_drafts.rev cannot move backwards (draft %, % -> %). Reload and retry.', old.id, old.rev, new.rev;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_correction_drafts_rev_monotonic on public.correction_drafts;
create trigger trg_correction_drafts_rev_monotonic
  before update on public.correction_drafts
  for each row execute function public.prevent_draft_rev_regress();

comment on table public.correction_drafts is 'Slice 1.5: server-side correction drafts. Saves must UPDATE ... WHERE rev = :baseRev (0 rows = 409 conflict). Drafts are working copies; publish runs overlap + gate checks first.';

-- 3. Waivers (reason required, actor + time recorded).
-- -----------------------------------------------------------------------------

create table if not exists public.correction_waivers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  project_slug text not null,
  scope text not null,
  target text not null,
  reason text not null,
  actor text not null,
  created_at timestamptz not null default now(),

  constraint correction_waivers_scope_valid check (scope in ('lot', 'gate', 'duplicate', 'gap')),
  constraint correction_waivers_reason_present check (length(trim(reason)) > 0),
  constraint correction_waivers_actor_present check (length(trim(actor)) > 0)
);

create unique index if not exists uniq_correction_waivers_scope_target
  on public.correction_waivers (tenant_id, project_slug, scope, target);

comment on table public.correction_waivers is 'Slice 1.5: gate waivers. Empty reasons rejected by check constraint; every waiver carries actor + timestamp.';

-- 4. Edit log (append-only: RLS offers select + insert only; the trigger
--    below belt-and-braces rejects UPDATE/DELETE outright).
-- -----------------------------------------------------------------------------

create table if not exists public.correction_edits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  project_slug text not null,
  batch_id text not null,
  lot_id text not null,
  field text not null,
  before jsonb,
  after jsonb,
  actor text not null,
  created_at timestamptz not null default now(),

  constraint correction_edits_actor_present check (length(trim(actor)) > 0)
);

create index if not exists idx_correction_edits_tenant_project
  on public.correction_edits (tenant_id, project_slug, created_at);

create or replace function public.prevent_correction_edit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'correction_edits is append-only (edit log with undo derives state; rows are never mutated).';
  return null;
end;
$$;

drop trigger if exists trg_correction_edits_append_only on public.correction_edits;
create trigger trg_correction_edits_append_only
  before update or delete on public.correction_edits
  for each row execute function public.prevent_correction_edit_mutation();

comment on table public.correction_edits is 'Slice 1.5: append-only correction edit log (actor, time, before, after). Undo is a pointer over this log; rows are never updated or deleted.';

-- 5. Row-level security (tenant isolation at the DB layer).
-- -----------------------------------------------------------------------------

alter table public.onboarding_states enable row level security;
alter table public.correction_drafts enable row level security;
alter table public.correction_waivers enable row level security;
alter table public.correction_edits enable row level security;

drop policy if exists "Internal can read onboarding states" on public.onboarding_states;
create policy "Internal can read onboarding states"
on public.onboarding_states for select to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can manage onboarding states" on public.onboarding_states;
create policy "Staff can manage onboarding states"
on public.onboarding_states for all to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists tenant_isolation on public.onboarding_states;
create policy tenant_isolation on public.onboarding_states as restrictive for all to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "Internal can read correction drafts" on public.correction_drafts;
create policy "Internal can read correction drafts"
on public.correction_drafts for select to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can manage correction drafts" on public.correction_drafts;
create policy "Staff can manage correction drafts"
on public.correction_drafts for all to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists tenant_isolation on public.correction_drafts;
create policy tenant_isolation on public.correction_drafts as restrictive for all to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "Internal can read correction waivers" on public.correction_waivers;
create policy "Internal can read correction waivers"
on public.correction_waivers for select to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can manage correction waivers" on public.correction_waivers;
create policy "Staff can manage correction waivers"
on public.correction_waivers for all to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists tenant_isolation on public.correction_waivers;
create policy tenant_isolation on public.correction_waivers as restrictive for all to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

-- Edits: select + insert only (append-only; no update/delete policies).
drop policy if exists "Internal can read correction edits" on public.correction_edits;
create policy "Internal can read correction edits"
on public.correction_edits for select to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can append correction edits" on public.correction_edits;
create policy "Staff can append correction edits"
on public.correction_edits for insert to authenticated
with check (public.can_write_admin_data());

drop policy if exists tenant_isolation on public.correction_edits;
create policy tenant_isolation on public.correction_edits as restrictive for all to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));
