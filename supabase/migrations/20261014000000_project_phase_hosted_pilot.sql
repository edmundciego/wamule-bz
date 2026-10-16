-- Project/phase-scoped hosted map pilot foundation.
--
-- This is deliberately additive to the existing tenant/project track. It is
-- not an instruction to repair migration history or apply to a hosted project
-- until the release preflight compares the remote schema and migration ledger.
-- Existing tenant/project business rows are retained and assigned only to
-- their own project's default phase; no Hopkins row is seeded here.

begin;

do $$
begin
  if to_regclass('public.organizations') is null
     or to_regclass('public.projects') is null
     or to_regclass('public.parcels') is null
     or to_regclass('public.masterplan_versions') is null
     or to_regclass('public.leads') is null
     or to_regclass('public.lead_activities') is null
     or to_regclass('public.follow_up_tasks') is null
     or to_regclass('public.information_requests') is null
     or to_regclass('public.information_request_topics') is null
     or to_regclass('public.information_packs') is null
     or to_regclass('public.information_topics') is null
     or to_regclass('public.site_visits') is null
     or to_regclass('public.admin_profiles') is null
     or to_regclass('public.customers') is null
     or to_regclass('public.contracts') is null
     or to_regclass('public.transactions') is null
     or to_regclass('public.payment_documents') is null
     or to_regclass('storage.objects') is null then
    raise exception 'Hosted pilot migration prerequisites are missing. Reconcile the tenant/project migration baseline before applying.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='projects' and column_name='tenant_id'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='masterplan_versions' and column_name='project_id'
  ) then
    raise exception 'Tenant/project columns are incomplete. Rehearse the reviewed project-scoping migrations first.';
  end if;
end;
$$;

create unique index if not exists uniq_projects_id_tenant
  on public.projects(id, tenant_id);

alter table public.projects
  add column if not exists map_experience_mode text not null default 'sales';
alter table public.projects drop constraint if exists projects_map_experience_mode_valid;
alter table public.projects add constraint projects_map_experience_mode_valid
  check (map_experience_mode in ('sales', 'demo'));

create table if not exists public.development_phases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete restrict,
  project_id uuid not null,
  slug text not null,
  name text not null,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint development_phases_slug_valid check (slug ~ '^[a-z0-9-]+$'),
  constraint development_phases_name_present check (length(trim(name)) > 0),
  constraint development_phases_project_tenant_fkey
    foreign key (project_id, tenant_id) references public.projects(id, tenant_id) on delete restrict,
  constraint development_phases_id_scope_unique unique (id, project_id, tenant_id),
  constraint development_phases_project_slug_unique unique (project_id, slug)
);
create unique index if not exists uniq_development_phases_project_default
  on public.development_phases(project_id) where is_default;
create index if not exists idx_development_phases_scope
  on public.development_phases(tenant_id, project_id, is_active);

-- Existing projects get a phase in-place; existing business rows stay in the
-- same tenant and project. The deterministic slug makes this rerunnable.
insert into public.development_phases(tenant_id, project_id, slug, name, is_default)
select p.tenant_id, p.id, 'default', 'Default phase', true
from public.projects p
on conflict (project_id, slug) do nothing;

create table if not exists public.project_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete restrict,
  project_id uuid not null,
  phase_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  member_role text not null default 'staff',
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  constraint project_memberships_role_valid check (member_role in ('owner', 'admin', 'staff', 'read_only')),
  constraint project_memberships_project_tenant_fkey
    foreign key (project_id, tenant_id) references public.projects(id, tenant_id) on delete cascade,
  constraint project_memberships_phase_scope_fkey
    foreign key (phase_id, project_id, tenant_id)
    references public.development_phases(id, project_id, tenant_id) on delete cascade
);
create unique index if not exists uniq_project_memberships_project_user_all_phases
  on public.project_memberships(tenant_id, project_id, user_id) where phase_id is null;
create unique index if not exists uniq_project_memberships_project_phase_user
  on public.project_memberships(tenant_id, project_id, phase_id, user_id) where phase_id is not null;
create index if not exists idx_project_memberships_user_scope
  on public.project_memberships(user_id, tenant_id, project_id, phase_id);

-- Preserve pre-existing Wamule staff access by translating each existing
-- tenant profile only to that tenant's own default project/default phase.
do $$
begin
  if to_regclass('public.admin_profiles') is not null then
    insert into public.project_memberships(tenant_id, project_id, phase_id, user_id, member_role)
    select ap.tenant_id, p.id, ph.id, ap.user_id,
      case when ap.role::text = 'Admin' then 'admin'
           when ap.role::text = 'Read Only' then 'read_only'
           else 'staff' end
    from public.admin_profiles ap
    join public.projects p on p.tenant_id = ap.tenant_id and p.is_default
    join public.development_phases ph on ph.tenant_id = p.tenant_id and ph.project_id = p.id and ph.is_default
    where ap.tenant_id is not null
    on conflict do nothing;
  end if;
end;
$$;

create or replace function public.user_has_project_access(p_tenant_id uuid, p_project_id uuid, p_phase_id uuid default null)
returns boolean
language sql stable security definer
set search_path = public, auth, pg_temp
as $$
  select public.is_super_admin_user()
    or (
      public.user_has_tenant_access(p_tenant_id)
      and exists (
        select 1 from public.project_memberships m
        where m.tenant_id = p_tenant_id
          and m.project_id = p_project_id
          and m.user_id = auth.uid()
          and (p_phase_id is null or m.phase_id is null or m.phase_id = p_phase_id)
      )
    );
$$;
revoke all on function public.user_has_project_access(uuid, uuid, uuid) from public, anon;
grant execute on function public.user_has_project_access(uuid, uuid, uuid) to authenticated, service_role;

create or replace function public.user_can_manage_project(p_tenant_id uuid, p_project_id uuid)
returns boolean
language sql stable security definer
set search_path = public, auth, pg_temp
as $$
  select public.is_super_admin_user()
    or exists (
      select 1 from public.project_memberships m
      where m.tenant_id = p_tenant_id and m.project_id = p_project_id
        and m.user_id = auth.uid() and m.member_role in ('owner', 'admin')
    );
$$;
revoke all on function public.user_can_manage_project(uuid, uuid) from public, anon;
grant execute on function public.user_can_manage_project(uuid, uuid) to authenticated, service_role;

create or replace function public.user_can_write_project(p_tenant_id uuid, p_project_id uuid, p_phase_id uuid default null)
returns boolean
language sql stable security definer
set search_path = public, auth, pg_temp
as $$
  select public.is_super_admin_user()
    or exists (
      select 1 from public.project_memberships m
      where m.tenant_id = p_tenant_id and m.project_id = p_project_id
        and m.user_id = auth.uid()
        and m.member_role in ('owner', 'admin', 'staff')
        and (p_phase_id is null or m.phase_id is null or m.phase_id = p_phase_id)
    );
$$;
revoke all on function public.user_can_write_project(uuid, uuid, uuid) from public, anon;
grant execute on function public.user_can_write_project(uuid, uuid, uuid) to authenticated, service_role;

alter table public.projects enable row level security;
revoke all on table public.projects from public, anon;
grant select on public.projects to authenticated;
drop policy if exists projects_member_read on public.projects;
create policy projects_member_read on public.projects
  for select to authenticated using (public.user_has_project_access(tenant_id, id, null));
drop policy if exists projects_admin_update on public.projects;
create policy projects_admin_update on public.projects
  for update to authenticated using (public.user_can_manage_project(tenant_id, id))
  with check (public.user_can_manage_project(tenant_id, id));

alter table public.development_phases enable row level security;
alter table public.project_memberships enable row level security;
revoke all on table public.development_phases, public.project_memberships from public, anon;
grant select on public.development_phases to authenticated;
grant select on public.project_memberships to authenticated;
create policy development_phases_member_read on public.development_phases
  for select to authenticated using (public.user_has_project_access(tenant_id, project_id, id));
create policy development_phases_admin_write on public.development_phases
  for all to authenticated using (public.user_can_manage_project(tenant_id, project_id))
  with check (public.user_can_manage_project(tenant_id, project_id));
create policy project_memberships_scoped_read on public.project_memberships
  for select to authenticated using (
    user_id = auth.uid() or public.is_super_admin_user()
    or public.user_has_project_access(tenant_id, project_id, phase_id)
  );
drop policy if exists project_memberships_admin_write on public.project_memberships;

-- The legacy organization SELECT policy is intentionally permissive for all
-- internal users. Add a restrictive tenant boundary so an ordinary tenant
-- account cannot read another organization's private configuration (including
-- provider credentials). Super Admin access remains explicit.
revoke all on function public.user_has_tenant_access(uuid) from public, anon;
grant execute on function public.user_has_tenant_access(uuid) to authenticated, service_role;
drop policy if exists organizations_tenant_read_scope on public.organizations;
create policy organizations_tenant_read_scope on public.organizations
  as restrictive for select to authenticated
  using (public.user_has_tenant_access(id));
revoke all on table public.organizations from public, anon;
grant select on public.organizations to authenticated;

-- Views created before the multi-tenant foundation ran as their owner's role,
-- bypassing underlying RLS. Make them invoker-security views and remove the
-- old anonymous parcel-catalogue grant. Public buyers use the project-scoped
-- get-public-lots Edge Function, not an unscoped table view.
do $$
begin
  if to_regclass('public.parcel_board_view') is not null then
    execute 'alter view public.parcel_board_view set (security_invoker = true)';
    execute 'revoke all on public.parcel_board_view from public, anon';
    execute 'grant select on public.parcel_board_view to authenticated';
  end if;
  if to_regclass('public.public_parcel_options') is not null then
    execute 'alter view public.public_parcel_options set (security_invoker = true)';
    execute 'revoke all on public.public_parcel_options from public, anon';
    execute 'grant select on public.public_parcel_options to authenticated';
  end if;
end;
$$;

-- Add a phase to inventory/map versions. NULL-project legacy rows remain NULL;
-- project-scoped records move only into that same project's default phase.
alter table public.parcels add column if not exists phase_id uuid;
alter table public.masterplan_versions add column if not exists phase_id uuid;
update public.parcels p set phase_id = ph.id
from public.development_phases ph
where p.tenant_id = ph.tenant_id and p.project_id = ph.project_id and ph.is_default and p.phase_id is null;
update public.masterplan_versions v set phase_id = ph.id
from public.development_phases ph
where v.tenant_id = ph.tenant_id and v.project_id = ph.project_id and ph.is_default and v.phase_id is null;

alter table public.parcels drop constraint if exists parcels_phase_scope_fkey;
alter table public.parcels add constraint parcels_phase_scope_fkey
  foreign key (phase_id, project_id, tenant_id)
  references public.development_phases(id, project_id, tenant_id) on delete restrict;
alter table public.parcels drop constraint if exists parcels_id_scope_unique;
alter table public.parcels add constraint parcels_id_scope_unique unique (id, tenant_id, project_id, phase_id);
alter table public.masterplan_versions drop constraint if exists masterplan_versions_phase_scope_fkey;
alter table public.masterplan_versions add constraint masterplan_versions_phase_scope_fkey
  foreign key (phase_id, project_id, tenant_id)
  references public.development_phases(id, project_id, tenant_id) on delete restrict;

-- Permit a displayed lot number to recur in another phase while retaining
-- uniqueness inside the actual project/phase scope.
drop index if exists public.uniq_parcels_project_lot;
drop index if exists public.uniq_parcels_legacy_lot;
create unique index if not exists uniq_parcels_project_phase_lot
  on public.parcels(tenant_id, project_id, phase_id, lot_number)
  where project_id is not null and phase_id is not null;
create unique index if not exists uniq_parcels_project_unphased_lot
  on public.parcels(tenant_id, project_id, lot_number)
  where project_id is not null and phase_id is null;
create unique index if not exists uniq_parcels_legacy_lot
  on public.parcels(tenant_id, lot_number)
  where project_id is null;

-- Version numbering and active-map uniqueness are per project AND phase.
alter table public.masterplan_versions drop constraint if exists uniq_masterplan_versions_project_number;
drop index if exists public.uniq_masterplan_versions_project_number;
create unique index if not exists uniq_masterplan_versions_project_phase_number
  on public.masterplan_versions(tenant_id, project_id, phase_id, version_number)
  where project_id is not null and phase_id is not null;
drop index if exists public.uniq_masterplan_versions_one_active_project;
create unique index if not exists uniq_masterplan_versions_one_active_phase
  on public.masterplan_versions(tenant_id, project_id, phase_id)
  where project_id is not null and phase_id is not null and is_active;
create index if not exists idx_masterplan_versions_tenant_project_phase_active
  on public.masterplan_versions(tenant_id, project_id, phase_id, is_active, version_number desc);

create or replace function public.assign_masterplan_version_number()
returns trigger language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
begin
  if new.project_id is null then
    select id into new.project_id from public.projects
    where tenant_id = new.tenant_id and is_default limit 1;
  end if;
  if new.phase_id is null and new.project_id is not null then
    select id into new.phase_id from public.development_phases
    where tenant_id = new.tenant_id and project_id = new.project_id and is_default limit 1;
  end if;
  if new.tenant_id is not null and (new.project_id is null or new.phase_id is null) then
    raise exception 'A new map version requires an existing default project and phase for this tenant.';
  end if;
  if new.version_number is null then
    select coalesce(max(version_number), 0) + 1 into new.version_number
    from public.masterplan_versions
    where tenant_id = new.tenant_id and project_id is not distinct from new.project_id
      and phase_id is not distinct from new.phase_id;
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  return new;
end;
$$;

create or replace function public.assign_parcel_project_phase_scope()
returns trigger language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
begin
  if new.project_id is null then
    select id into new.project_id from public.projects
    where tenant_id = new.tenant_id and is_default limit 1;
  end if;
  if new.phase_id is null and new.project_id is not null then
    select id into new.phase_id from public.development_phases
    where tenant_id = new.tenant_id and project_id = new.project_id and is_default limit 1;
  end if;
  if new.tenant_id is not null and (new.project_id is null or new.phase_id is null) then
    raise exception 'A new parcel requires an existing default project and phase for this tenant.';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_z_assign_parcel_project_phase_scope on public.parcels;
create trigger trg_z_assign_parcel_project_phase_scope
  before insert or update of tenant_id, project_id, phase_id on public.parcels
  for each row execute function public.assign_parcel_project_phase_scope();

create or replace function public.deactivate_other_project_masterplans()
returns trigger language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
begin
  if new.is_active then
    update public.masterplan_versions set is_active = false
    where tenant_id = new.tenant_id and project_id is not distinct from new.project_id
      and phase_id is not distinct from new.phase_id and id is distinct from new.id and is_active;
  end if;
  return new;
end;
$$;

create or replace function public.sync_active_masterplan()
returns trigger language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
begin
  if new.is_active then
    update public.masterplan_versions set is_active = false
    where tenant_id = new.tenant_id and project_id is not distinct from new.project_id
      and phase_id is not distinct from new.phase_id and id <> new.id and is_active;
    if new.project_id is null or exists (
      select 1 from public.projects p
      join public.development_phases ph on ph.project_id = p.id and ph.tenant_id = p.tenant_id
      where p.id = new.project_id and p.tenant_id = new.tenant_id and p.is_default and ph.id = new.phase_id and ph.is_default
    ) then
      update public.organizations set masterplan_image_url = new.image_url, updated_at = now()
      where id = new.tenant_id;
      insert into public.business_settings(tenant_id, key, value)
      values (new.tenant_id, 'masterplan_image_url', jsonb_build_object('url', new.image_url))
      on conflict (tenant_id, key) do update set value=excluded.value, updated_at=now();
    end if;
  end if;
  return new;
end;
$$;

-- Geometry-only map features are deliberately not parcels. There is no status,
-- price, contract, customer or canonical lot-number column here.
create table if not exists public.map_feature_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete restrict,
  project_id uuid not null,
  phase_id uuid not null,
  snapshot_fingerprint text not null,
  source_image_sha256 text not null,
  detection_source_sha256 text not null,
  correction_manifest_sha256 text not null,
  correction_manifest_revision integer not null,
  snapshot_version integer not null,
  outline_count integer not null,
  is_active boolean not null default false,
  activated_as_demo_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  constraint map_feature_snapshots_hash_valid check (
    snapshot_fingerprint ~ '^[0-9a-f]{64}$' and source_image_sha256 ~ '^[0-9a-f]{64}$'
    and detection_source_sha256 ~ '^[0-9a-f]{64}$' and correction_manifest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint map_feature_snapshots_outline_count_positive check (outline_count > 0),
  constraint map_feature_snapshots_version_positive check (snapshot_version > 0),
  constraint map_feature_snapshots_project_phase_fkey
    foreign key (phase_id, project_id, tenant_id)
    references public.development_phases(id, project_id, tenant_id) on delete restrict,
  constraint map_feature_snapshots_scope_fingerprint_unique
    unique (tenant_id, project_id, phase_id, snapshot_fingerprint),
  constraint map_feature_snapshots_scope_version_unique
    unique (tenant_id, project_id, phase_id, snapshot_version),
  constraint map_feature_snapshots_id_scope_unique unique (id, tenant_id, project_id, phase_id)
);
create unique index if not exists uniq_map_feature_snapshot_active_scope
  on public.map_feature_snapshots(tenant_id, project_id, phase_id)
  where is_active;

create table if not exists public.map_feature_identities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete restrict,
  project_id uuid not null,
  phase_id uuid not null,
  feature_key text not null,
  created_at timestamptz not null default now(),
  constraint map_feature_identities_key_present check (length(trim(feature_key)) between 1 and 160),
  constraint map_feature_identities_project_phase_fkey
    foreign key (phase_id, project_id, tenant_id)
    references public.development_phases(id, project_id, tenant_id) on delete restrict,
  constraint map_feature_identities_scope_key_unique unique (tenant_id, project_id, phase_id, feature_key),
  constraint map_feature_identities_id_scope_unique unique (id, tenant_id, project_id, phase_id)
);

create table if not exists public.map_features (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete restrict,
  project_id uuid not null,
  phase_id uuid not null,
  snapshot_id uuid not null,
  identity_id uuid not null,
  demo_label text not null,
  feature_kind text not null default 'demo_plot',
  parent_feature_key text,
  source_detection_id text,
  map_polygon jsonb not null,
  provenance jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  public_visible boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint map_features_label_present check (length(trim(demo_label)) between 1 and 100),
  constraint map_features_kind_valid check (feature_kind in ('demo_plot', 'common_area', 'amenity')),
  constraint map_features_geometry_array check (jsonb_typeof(map_polygon) = 'array' and jsonb_array_length(map_polygon) >= 3),
  constraint map_features_provenance_object check (jsonb_typeof(provenance) = 'object'),
  constraint map_features_snapshot_identity_unique unique (snapshot_id, identity_id),
  constraint map_features_id_scope_unique unique (id, tenant_id, project_id, phase_id),
  constraint map_features_project_phase_fkey
    foreign key (phase_id, project_id, tenant_id)
    references public.development_phases(id, project_id, tenant_id) on delete restrict,
  constraint map_features_snapshot_scope_fkey
    foreign key (snapshot_id, tenant_id, project_id, phase_id)
    references public.map_feature_snapshots(id, tenant_id, project_id, phase_id) on delete restrict,
  constraint map_features_identity_scope_fkey
    foreign key (identity_id, tenant_id, project_id, phase_id)
    references public.map_feature_identities(id, tenant_id, project_id, phase_id) on delete restrict
);
create index if not exists idx_map_features_active_public_scope
  on public.map_features(tenant_id, project_id, phase_id, snapshot_id, is_active, public_visible);
create index if not exists idx_map_features_source_detection
  on public.map_features(tenant_id, project_id, phase_id, source_detection_id);

alter table public.map_feature_snapshots enable row level security;
alter table public.map_feature_identities enable row level security;
alter table public.map_features enable row level security;
revoke all on table public.map_feature_snapshots, public.map_feature_identities, public.map_features from public, anon;
grant select on public.map_feature_snapshots, public.map_feature_identities, public.map_features to authenticated;
grant select, insert, update, delete on public.map_feature_snapshots, public.map_feature_identities, public.map_features to service_role;
revoke insert, update, delete on public.map_feature_snapshots, public.map_feature_identities, public.map_features from authenticated;
create policy map_feature_snapshots_project_read on public.map_feature_snapshots
  for select to authenticated using (public.user_has_project_access(tenant_id, project_id, phase_id));
create policy map_features_project_read on public.map_features
  for select to authenticated using (public.user_has_project_access(tenant_id, project_id, phase_id));
create policy map_feature_identities_project_read on public.map_feature_identities
  for select to authenticated using (public.user_has_project_access(tenant_id, project_id, phase_id));

-- Lead / inquiry scope is derived from its parcel or selected map feature by a
-- trigger; direct clients cannot forge a different tenant/project/phase.
alter table public.leads add column if not exists project_id uuid;
alter table public.leads add column if not exists phase_id uuid;
alter table public.leads add column if not exists map_feature_id uuid;
alter table public.lead_activities add column if not exists project_id uuid;
alter table public.lead_activities add column if not exists phase_id uuid;
alter table public.follow_up_tasks add column if not exists project_id uuid;
alter table public.follow_up_tasks add column if not exists phase_id uuid;

update public.leads l set project_id=p.project_id, phase_id=p.phase_id
from public.parcels p where l.parcel_id=p.id and l.tenant_id=p.tenant_id and l.project_id is null;
-- Any tenant-owned legacy inquiries without a selected parcel are assigned to
-- that same tenant's default project and phase; no row changes tenant.
update public.leads l set project_id=p.id
from public.projects p
where l.tenant_id=p.tenant_id and p.is_default and l.project_id is null;
update public.leads l set phase_id=ph.id
from public.development_phases ph
where l.tenant_id=ph.tenant_id and l.project_id=ph.project_id and ph.is_default and l.phase_id is null;
update public.lead_activities a set project_id=l.project_id, phase_id=l.phase_id
from public.leads l where a.lead_id=l.id and a.tenant_id=l.tenant_id and a.project_id is null;
update public.follow_up_tasks f set project_id=l.project_id, phase_id=l.phase_id
from public.leads l where f.lead_id=l.id and f.tenant_id=l.tenant_id and f.project_id is null;

-- Refuse an incomplete upgrade rather than leave scoped workflows with
-- tenant-only rows. Non-lead follow-ups and site visits remain compatible
-- with other existing application/customer workflows.
do $$
begin
  if exists (select 1 from public.parcels where project_id is null or phase_id is null)
    or exists (select 1 from public.masterplan_versions where project_id is null or phase_id is null)
    or exists (select 1 from public.leads where project_id is null or phase_id is null)
    or exists (select 1 from public.lead_activities where project_id is null or phase_id is null)
    or exists (select 1 from public.follow_up_tasks where lead_id is not null and (project_id is null or phase_id is null)) then
    raise exception 'Project/phase backfill is incomplete. Reconcile tenants without a default project/phase and mismatched linked records before retrying.';
  end if;
end;
$$;

alter table public.leads drop constraint if exists leads_project_tenant_fkey;
alter table public.leads add constraint leads_project_tenant_fkey
  foreign key (project_id, tenant_id) references public.projects(id, tenant_id) on delete restrict;
alter table public.leads drop constraint if exists leads_phase_project_tenant_fkey;
alter table public.leads add constraint leads_phase_project_tenant_fkey
  foreign key (phase_id, project_id, tenant_id) references public.development_phases(id, project_id, tenant_id) on delete restrict;
alter table public.leads drop constraint if exists leads_parcel_scope_fkey;
alter table public.leads add constraint leads_parcel_scope_fkey
  foreign key (parcel_id, tenant_id, project_id, phase_id)
  references public.parcels(id, tenant_id, project_id, phase_id) on delete restrict;
alter table public.leads drop constraint if exists leads_map_feature_scope_fkey;
alter table public.leads add constraint leads_map_feature_scope_fkey
  foreign key (map_feature_id, tenant_id, project_id, phase_id)
  references public.map_feature_identities(id, tenant_id, project_id, phase_id) on delete restrict;
alter table public.leads drop constraint if exists leads_id_scope_unique;
alter table public.leads add constraint leads_id_scope_unique unique (id, tenant_id, project_id, phase_id);

alter table public.lead_activities drop constraint if exists lead_activities_lead_scope_fkey;
alter table public.lead_activities add constraint lead_activities_lead_scope_fkey
  foreign key (lead_id, tenant_id, project_id, phase_id)
  references public.leads(id, tenant_id, project_id, phase_id) on delete cascade;
alter table public.follow_up_tasks drop constraint if exists follow_up_tasks_lead_scope_fkey;
alter table public.follow_up_tasks add constraint follow_up_tasks_lead_scope_fkey
  foreign key (lead_id, tenant_id, project_id, phase_id)
  references public.leads(id, tenant_id, project_id, phase_id) on delete cascade;
alter table public.follow_up_tasks drop constraint if exists follow_up_tasks_id_scope_unique;
alter table public.follow_up_tasks add constraint follow_up_tasks_id_scope_unique unique (id, tenant_id, project_id, phase_id);

create or replace function public.assign_inquiry_project_scope()
returns trigger language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare scoped_tenant uuid; scoped_project uuid; scoped_phase uuid;
begin
  if new.map_feature_id is not null then
    select f.tenant_id, f.project_id, f.phase_id into scoped_tenant, scoped_project, scoped_phase
    from public.map_features f
    join public.map_feature_snapshots s on s.id=f.snapshot_id and s.is_active
    where f.identity_id=new.map_feature_id and f.is_active and f.public_visible
    order by f.created_at desc limit 1;
    if scoped_tenant is null then raise exception 'Selected map feature is not part of the active public map.'; end if;
  elsif new.parcel_id is not null then
    select tenant_id, project_id, phase_id into scoped_tenant, scoped_project, scoped_phase
    from public.parcels where id=new.parcel_id;
    if scoped_tenant is null then raise exception 'Selected parcel was not found.'; end if;
  else
    scoped_tenant := new.tenant_id;
    scoped_project := new.project_id;
    scoped_phase := new.phase_id;
    if scoped_tenant is not null and scoped_project is null then
      select id into scoped_project from public.projects
      where tenant_id=scoped_tenant and is_default limit 1;
    end if;
    if scoped_tenant is not null and scoped_phase is null and scoped_project is not null then
      select id into scoped_phase from public.development_phases
      where tenant_id=scoped_tenant and project_id=scoped_project and is_default limit 1;
    end if;
    if scoped_tenant is null or scoped_project is null or scoped_phase is null then
      raise exception 'An inquiry requires a tenant with a default project and active default phase.';
    end if;
  end if;
  if new.tenant_id is not null and scoped_tenant is not null and new.tenant_id <> scoped_tenant then
    raise exception 'Inquiry tenant does not own the selected map feature or parcel.';
  end if;
  if new.project_id is not null and scoped_project is not null and new.project_id <> scoped_project then
    raise exception 'Inquiry project does not own the selected map feature or parcel.';
  end if;
  if new.phase_id is not null and scoped_phase is not null and new.phase_id <> scoped_phase then
    raise exception 'Inquiry phase does not own the selected map feature or parcel.';
  end if;
  new.tenant_id := scoped_tenant;
  new.project_id := scoped_project;
  new.phase_id := scoped_phase;
  return new;
end;
$$;
drop trigger if exists trg_assign_inquiry_project_scope on public.leads;
create trigger trg_assign_inquiry_project_scope before insert or update of parcel_id, map_feature_id, tenant_id, project_id, phase_id
  on public.leads for each row execute function public.assign_inquiry_project_scope();

create or replace function public.inherit_lead_project_scope()
returns trigger language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare parent_tenant uuid; parent_project uuid; parent_phase uuid;
begin
  select tenant_id, project_id, phase_id into parent_tenant, parent_project, parent_phase
  from public.leads where id=new.lead_id;
  if parent_tenant is null then raise exception 'Lead not found for scoped activity.'; end if;
  if new.tenant_id is not null and new.tenant_id <> parent_tenant then raise exception 'Activity tenant does not match its lead.'; end if;
  if new.project_id is not null and new.project_id is distinct from parent_project then raise exception 'Activity project does not match its lead.'; end if;
  if new.phase_id is not null and new.phase_id is distinct from parent_phase then raise exception 'Activity phase does not match its lead.'; end if;
  new.tenant_id := parent_tenant; new.project_id := parent_project; new.phase_id := parent_phase;
  return new;
end;
$$;
drop trigger if exists trg_inherit_lead_scope_activities on public.lead_activities;
create trigger trg_inherit_lead_scope_activities before insert or update of lead_id, tenant_id, project_id, phase_id
  on public.lead_activities for each row execute function public.inherit_lead_project_scope();
drop trigger if exists trg_inherit_lead_scope_followups on public.follow_up_tasks;
create trigger trg_inherit_lead_scope_followups before insert or update of lead_id, tenant_id, project_id, phase_id
  on public.follow_up_tasks for each row execute function public.inherit_lead_project_scope();

-- Additional lead-linked inquiry records inherit precisely the same scope.
alter table public.information_requests add column if not exists project_id uuid;
alter table public.information_requests add column if not exists phase_id uuid;
alter table public.information_request_topics add column if not exists project_id uuid;
alter table public.information_request_topics add column if not exists phase_id uuid;
alter table public.information_packs add column if not exists project_id uuid;
alter table public.information_packs add column if not exists phase_id uuid;
alter table public.site_visits add column if not exists project_id uuid;
alter table public.site_visits add column if not exists phase_id uuid;
update public.information_requests r set project_id=l.project_id, phase_id=l.phase_id
from public.leads l where r.lead_id=l.id and r.tenant_id=l.tenant_id and r.project_id is null;
update public.information_request_topics rt set tenant_id=r.tenant_id, project_id=r.project_id, phase_id=r.phase_id
from public.information_requests r where rt.request_id=r.id and rt.project_id is null;
update public.information_packs p set tenant_id=r.tenant_id, project_id=r.project_id, phase_id=r.phase_id
from public.information_requests r where p.request_id=r.id and p.project_id is null;
update public.site_visits s set project_id=l.project_id, phase_id=l.phase_id
from public.leads l where s.lead_id=l.id and s.tenant_id=l.tenant_id and s.project_id is null;

do $$
begin
  if exists (select 1 from public.information_requests where project_id is null or phase_id is null)
    or exists (select 1 from public.information_request_topics where project_id is null or phase_id is null)
    or exists (select 1 from public.information_packs where project_id is null or phase_id is null)
    or exists (select 1 from public.site_visits where lead_id is not null and (project_id is null or phase_id is null)) then
    raise exception 'Inquiry-linked project/phase backfill is incomplete. Reconcile orphaned or mismatched inquiry records before retrying.';
  end if;
end;
$$;

alter table public.information_topics drop constraint if exists information_topics_id_tenant_unique;
alter table public.information_topics add constraint information_topics_id_tenant_unique unique (id, tenant_id);

alter table public.information_requests drop constraint if exists information_requests_lead_scope_fkey;
alter table public.information_requests add constraint information_requests_lead_scope_fkey
  foreign key (lead_id, tenant_id, project_id, phase_id)
  references public.leads(id, tenant_id, project_id, phase_id) on delete restrict;
alter table public.information_requests drop constraint if exists information_requests_id_scope_unique;
alter table public.information_requests add constraint information_requests_id_scope_unique
  unique (id, tenant_id, project_id, phase_id);
alter table public.information_requests drop constraint if exists information_requests_parcel_scope_fkey;
alter table public.information_requests add constraint information_requests_parcel_scope_fkey
  foreign key (parcel_id, tenant_id, project_id, phase_id)
  references public.parcels(id, tenant_id, project_id, phase_id) on delete restrict;
alter table public.information_requests drop constraint if exists information_requests_follow_up_scope_fkey;
alter table public.information_requests add constraint information_requests_follow_up_scope_fkey
  foreign key (follow_up_task_id, tenant_id, project_id, phase_id)
  references public.follow_up_tasks(id, tenant_id, project_id, phase_id) on delete restrict;
alter table public.information_requests add constraint information_requests_phase_project_fkey
  foreign key (phase_id, project_id, tenant_id)
  references public.development_phases(id, project_id, tenant_id) on delete restrict;
alter table public.information_request_topics add constraint information_request_topics_request_scope_fkey
  foreign key (request_id, tenant_id, project_id, phase_id)
  references public.information_requests(id, tenant_id, project_id, phase_id) on delete cascade;
alter table public.information_request_topics drop constraint if exists information_request_topics_topic_tenant_fkey;
alter table public.information_request_topics add constraint information_request_topics_topic_tenant_fkey
  foreign key (topic_id, tenant_id) references public.information_topics(id, tenant_id) on delete restrict;
alter table public.information_packs add constraint information_packs_request_scope_fkey
  foreign key (request_id, tenant_id, project_id, phase_id)
  references public.information_requests(id, tenant_id, project_id, phase_id) on delete restrict;
alter table public.site_visits add constraint site_visits_lead_scope_fkey
  foreign key (lead_id, tenant_id, project_id, phase_id)
  references public.leads(id, tenant_id, project_id, phase_id) on delete cascade;

create or replace function public.inherit_information_request_scope()
returns trigger language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare parent_tenant uuid; parent_project uuid; parent_phase uuid;
begin
  select tenant_id, project_id, phase_id into parent_tenant, parent_project, parent_phase
  from public.information_requests where id=new.request_id;
  if parent_tenant is null then raise exception 'Information request not found for scoped child record.'; end if;
  if new.tenant_id is not null and new.tenant_id <> parent_tenant then raise exception 'Information record tenant does not match its request.'; end if;
  if new.project_id is not null and new.project_id is distinct from parent_project then raise exception 'Information record project does not match its request.'; end if;
  if new.phase_id is not null and new.phase_id is distinct from parent_phase then raise exception 'Information record phase does not match its request.'; end if;
  new.tenant_id := parent_tenant; new.project_id := parent_project; new.phase_id := parent_phase;
  return new;
end;
$$;
drop trigger if exists trg_inherit_information_request_lead_scope on public.information_requests;
create trigger trg_inherit_information_request_lead_scope before insert or update of lead_id, tenant_id, project_id, phase_id
  on public.information_requests for each row execute function public.inherit_lead_project_scope();
drop trigger if exists trg_inherit_information_request_topics_scope on public.information_request_topics;
create trigger trg_inherit_information_request_topics_scope
  before insert or update of request_id, tenant_id, project_id, phase_id on public.information_request_topics
  for each row execute function public.inherit_information_request_scope();
drop trigger if exists trg_inherit_information_pack_scope on public.information_packs;
create trigger trg_inherit_information_pack_scope
  before insert or update of request_id, tenant_id, project_id, phase_id on public.information_packs
  for each row execute function public.inherit_information_request_scope();
drop trigger if exists trg_inherit_site_visit_scope on public.site_visits;
create trigger trg_inherit_site_visit_scope before insert or update of lead_id, tenant_id, project_id, phase_id
  on public.site_visits for each row execute function public.inherit_lead_project_scope();

-- Phase-specific restrictive RLS supplements all existing tenant/role rules.
do $$
declare t text;
begin
  foreach t in array array[
    'parcels','masterplan_versions','leads','lead_activities','follow_up_tasks',
    'information_requests','information_request_topics','information_packs','site_visits'
  ] loop
    execute format('drop policy if exists project_phase_membership on public.%I', t);
    execute format('drop policy if exists project_phase_read_scope on public.%I', t);
    execute format('drop policy if exists project_phase_insert_scope on public.%I', t);
    execute format('drop policy if exists project_phase_update_scope on public.%I', t);
    execute format('drop policy if exists project_phase_delete_scope on public.%I', t);
    execute format(
      'create policy project_phase_read_scope on public.%I as restrictive for select to authenticated using (public.user_has_tenant_access(tenant_id) and (project_id is null or public.user_has_project_access(tenant_id, project_id, phase_id)))',
      t
    );
    execute format('create policy project_phase_insert_scope on public.%I as restrictive for insert to authenticated with check '
      '(public.user_has_tenant_access(tenant_id) and (project_id is null or public.user_can_write_project(tenant_id, project_id, phase_id)))', t);
    execute format('create policy project_phase_update_scope on public.%I as restrictive for update to authenticated using '
      '(public.user_has_tenant_access(tenant_id) and (project_id is null or public.user_can_write_project(tenant_id, project_id, phase_id))) with check '
      '(public.user_has_tenant_access(tenant_id) and (project_id is null or public.user_can_write_project(tenant_id, project_id, phase_id)))', t);
    execute format('create policy project_phase_delete_scope on public.%I as restrictive for delete to authenticated using '
      '(public.user_has_tenant_access(tenant_id) and (project_id is null or public.user_can_write_project(tenant_id, project_id, phase_id)))', t);
  end loop;
end;
$$;

-- Public map imagery goes to a separate bucket. Only the approved display
-- raster is public; source PDFs, OCR crops and reviewer evidence stay private.
insert into storage.buckets(id, name, public)
values ('project-map-public', 'project-map-public', true)
on conflict (id) do update set public=true;
drop policy if exists "Project map display images are public" on storage.objects;
create policy "Project map display images are public" on storage.objects
  for select to public using (storage.objects.bucket_id = 'project-map-public');
drop policy if exists "Project managers upload map display images" on storage.objects;
create policy "Project managers upload map display images" on storage.objects
  for insert to authenticated with check (
    storage.objects.bucket_id = 'project-map-public'
    and storage.objects.name ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/maps/[a-z0-9_-]+\.(webp|avif|png|jpe?g)$'
    and exists (
      select 1 from public.development_phases ph
      where ph.tenant_id::text = (storage.foldername(storage.objects.name))[1]
        and ph.project_id::text = (storage.foldername(storage.objects.name))[2]
        and ph.id::text = (storage.foldername(storage.objects.name))[3]
        and public.user_can_manage_project(ph.tenant_id, ph.project_id)
    )
  );
drop policy if exists "Project managers update map display images" on storage.objects;
create policy "Project managers update map display images" on storage.objects
  for update to authenticated using (
    storage.objects.bucket_id = 'project-map-public'
    and storage.objects.name ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/maps/[a-z0-9_-]+\.(webp|avif|png|jpe?g)$'
    and exists (
      select 1 from public.development_phases ph
      where ph.tenant_id::text = (storage.foldername(storage.objects.name))[1]
        and ph.project_id::text = (storage.foldername(storage.objects.name))[2]
        and ph.id::text = (storage.foldername(storage.objects.name))[3]
        and public.user_can_manage_project(ph.tenant_id, ph.project_id)
    )
  ) with check (
    storage.objects.bucket_id = 'project-map-public'
    and storage.objects.name ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/maps/[a-z0-9_-]+\.(webp|avif|png|jpe?g)$'
    and exists (
      select 1 from public.development_phases ph
      where ph.tenant_id::text = (storage.foldername(storage.objects.name))[1]
        and ph.project_id::text = (storage.foldername(storage.objects.name))[2]
        and ph.id::text = (storage.foldername(storage.objects.name))[3]
        and public.user_can_manage_project(ph.tenant_id, ph.project_id)
    )
  );
drop policy if exists "Project managers delete map display images" on storage.objects;
create policy "Project managers delete map display images" on storage.objects
  for delete to authenticated using (
    storage.objects.bucket_id = 'project-map-public'
    and exists (
      select 1 from public.development_phases ph
      where ph.tenant_id::text = (storage.foldername(storage.objects.name))[1]
        and ph.project_id::text = (storage.foldername(storage.objects.name))[2]
        and ph.id::text = (storage.foldername(storage.objects.name))[3]
        and public.user_can_manage_project(ph.tenant_id, ph.project_id)
    )
  );

-- The pre-existing private-file policies only checked is_internal_user(),
-- which allowed staff from one tenant to read another tenant's contracts,
-- receipts and payment documents. These object paths use global customer IDs;
-- authorize a file only when its exact path is linked to a row belonging to
-- the caller's tenant. application-documents has no persisted owner/path link
-- in this application yet, so it intentionally receives no allow policy.
drop policy if exists "Internal users can read Wamuale files" on storage.objects;
drop policy if exists "Admin staff can upload Wamuale files" on storage.objects;
drop policy if exists "Admins can update Wamuale files" on storage.objects;
drop policy if exists "Admins can delete Wamuale files" on storage.objects;

drop policy if exists "Wamule private file tenant boundary read" on storage.objects;
create policy "Wamule private file tenant boundary read" on storage.objects
  as restrictive for select to authenticated using (
    storage.objects.bucket_id not in ('contracts','receipts','application-documents','payment-documents')
    or (storage.objects.bucket_id='contracts' and exists (
      select 1 from public.contracts c
      where public.user_has_tenant_access(c.tenant_id)
        and c.signed_contract_file_path=storage.objects.name
    ))
    or (storage.objects.bucket_id='receipts' and exists (
      select 1 from public.transactions t
      where public.user_has_tenant_access(t.tenant_id)
        and (t.customer_id::text || '/' || t.receipt_number || '.pdf')=storage.objects.name
    ))
    or (storage.objects.bucket_id='payment-documents' and exists (
      select 1 from public.payment_documents d
      where public.user_has_tenant_access(d.tenant_id)
        and d.file_path=storage.objects.name
    ))
  );

drop policy if exists "Wamule private file tenant boundary insert" on storage.objects;
create policy "Wamule private file tenant boundary insert" on storage.objects
  as restrictive for insert to authenticated with check (
    storage.objects.bucket_id not in ('contracts','receipts','application-documents','payment-documents')
    or (storage.objects.bucket_id in ('contracts','payment-documents')
      and public.can_write_admin_data()
      and exists (
        select 1 from public.customers c
        where public.user_has_tenant_access(c.tenant_id)
          and c.id::text=(storage.foldername(storage.objects.name))[1]
      ))
  );

drop policy if exists "Wamule private file tenant boundary update" on storage.objects;
create policy "Wamule private file tenant boundary update" on storage.objects
  as restrictive for update to authenticated using (
    storage.objects.bucket_id not in ('contracts','receipts','application-documents','payment-documents')
    or (storage.objects.bucket_id='contracts' and exists (
      select 1 from public.contracts c
      where public.user_has_tenant_access(c.tenant_id)
        and c.signed_contract_file_path=storage.objects.name
    ))
    or (storage.objects.bucket_id='payment-documents' and exists (
      select 1 from public.payment_documents d
      where public.user_has_tenant_access(d.tenant_id)
        and d.file_path=storage.objects.name
    ))
  ) with check (
    storage.objects.bucket_id not in ('contracts','receipts','application-documents','payment-documents')
    or (storage.objects.bucket_id in ('contracts','payment-documents')
      and public.can_write_admin_data()
      and exists (
        select 1 from public.customers c
        where public.user_has_tenant_access(c.tenant_id)
          and c.id::text=(storage.foldername(storage.objects.name))[1]
      ))
  );

drop policy if exists "Wamule private file tenant boundary delete" on storage.objects;
create policy "Wamule private file tenant boundary delete" on storage.objects
  as restrictive for delete to authenticated using (
    storage.objects.bucket_id not in ('contracts','receipts','application-documents','payment-documents')
    or (storage.objects.bucket_id='contracts' and exists (
      select 1 from public.contracts c
      where public.user_has_tenant_access(c.tenant_id)
        and c.signed_contract_file_path=storage.objects.name
    ))
    or (storage.objects.bucket_id='payment-documents' and exists (
      select 1 from public.payment_documents d
      where public.user_has_tenant_access(d.tenant_id)
        and d.file_path=storage.objects.name
    ))
  );

create policy "Tenant staff read linked private files" on storage.objects
  for select to authenticated using (
    (storage.objects.bucket_id='contracts' and exists (
      select 1 from public.contracts c
      where public.user_has_tenant_access(c.tenant_id)
        and c.signed_contract_file_path=storage.objects.name
    ))
    or (storage.objects.bucket_id='receipts' and exists (
      select 1 from public.transactions t
      where public.user_has_tenant_access(t.tenant_id)
        and (t.customer_id::text || '/' || t.receipt_number || '.pdf')=storage.objects.name
    ))
    or (storage.objects.bucket_id='payment-documents' and exists (
      select 1 from public.payment_documents d
      where public.user_has_tenant_access(d.tenant_id)
        and d.file_path=storage.objects.name
    ))
  );

create policy "Tenant staff upload linked private files" on storage.objects
  for insert to authenticated with check (
    storage.objects.bucket_id in ('contracts','payment-documents')
    and public.can_write_admin_data()
    and exists (
      select 1 from public.customers c
      where public.user_has_tenant_access(c.tenant_id)
        and c.id::text=(storage.foldername(storage.objects.name))[1]
    )
  );

create policy "Tenant admins update linked private files" on storage.objects
  for update to authenticated using (
    public.is_admin_user()
    and ((storage.objects.bucket_id='contracts' and exists (
      select 1 from public.contracts c
      where public.user_has_tenant_access(c.tenant_id)
        and c.signed_contract_file_path=storage.objects.name
    )) or (storage.objects.bucket_id='payment-documents' and exists (
      select 1 from public.payment_documents d
      where public.user_has_tenant_access(d.tenant_id)
        and d.file_path=storage.objects.name
    )))
  ) with check (
    public.is_admin_user()
    and storage.objects.bucket_id in ('contracts','payment-documents')
    and exists (
      select 1 from public.customers c
      where public.user_has_tenant_access(c.tenant_id)
        and c.id::text=(storage.foldername(storage.objects.name))[1]
    )
  );

create policy "Tenant admins delete linked private files" on storage.objects
  for delete to authenticated using (
    public.is_admin_user()
    and ((storage.objects.bucket_id='contracts' and exists (
      select 1 from public.contracts c
      where public.user_has_tenant_access(c.tenant_id)
        and c.signed_contract_file_path=storage.objects.name
    )) or (storage.objects.bucket_id='payment-documents' and exists (
      select 1 from public.payment_documents d
      where public.user_has_tenant_access(d.tenant_id)
        and d.file_path=storage.objects.name
    )))
  );

-- Reusable, atomic tenant/project/phase bootstrap. It does not create Auth
-- users or send invitations. An existing profile may never be reassigned
-- from another tenant, and a Super Admin profile is not repurposed.
create or replace function public.onboard_project_tenant(
  p_tenant_slug text,
  p_tenant_name text,
  p_project_slug text,
  p_project_name text,
  p_phase_slug text,
  p_phase_name text,
  p_theme jsonb,
  p_company_profile jsonb,
  p_staff_user_id uuid,
  p_member_role text default 'owner',
  p_demo_mode boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_tenant public.organizations%rowtype;
  v_project public.projects%rowtype;
  v_phase public.development_phases%rowtype;
  v_profile public.admin_profiles%rowtype;
  v_existing_role text;
  v_user_email text;
  v_user_name text;
  v_is_default boolean;
begin
  if p_tenant_slug !~ '^[a-z0-9][a-z0-9-]{0,62}$'
    or p_project_slug !~ '^[a-z0-9][a-z0-9-]{0,62}$'
    or p_phase_slug !~ '^[a-z0-9][a-z0-9-]{0,62}$'
    or nullif(trim(p_tenant_name),'') is null
    or nullif(trim(p_project_name),'') is null
    or nullif(trim(p_phase_name),'') is null
    or p_staff_user_id is null
    or p_member_role not in ('owner','admin','staff','read_only')
    or jsonb_typeof(coalesce(p_theme,'{}'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_company_profile,'{}'::jsonb)) <> 'object' then
    raise exception 'Tenant onboarding payload is incomplete or invalid.';
  end if;
  perform pg_advisory_xact_lock(hashtext('tenant-onboard:' || p_tenant_slug));
  select * into v_tenant from public.organizations where lower(slug)=lower(p_tenant_slug) for update;
  if not found then
    insert into public.organizations(name,slug,is_active)
      values (trim(p_tenant_name),p_tenant_slug,true) returning * into v_tenant;
  elsif not v_tenant.is_active then
    raise exception 'Tenant slug already exists but is inactive; onboarding will not reactivate it.';
  elsif v_tenant.name <> trim(p_tenant_name) then
    raise exception 'Existing tenant name differs from onboarding config; review it rather than overwriting.';
  end if;

  select * into v_profile from public.admin_profiles where user_id=p_staff_user_id for update;
  if found then
    if v_profile.tenant_id is distinct from v_tenant.id or v_profile.role::text='Super Admin' then
      raise exception 'The selected staff account already belongs to another tenant or is a Super Admin; it was not reassigned.';
    end if;
  else
    select email, coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', '')
      into v_user_email, v_user_name from auth.users where id=p_staff_user_id;
    if not found or nullif(trim(v_user_email),'') is null then
      raise exception 'The selected staff account must already exist in Auth and have an email; no invitation was sent.';
    end if;
    insert into public.admin_profiles(user_id,email,full_name,role,tenant_id)
      values (p_staff_user_id,lower(trim(v_user_email)),coalesce(nullif(trim(v_user_name),''),trim(v_user_email)),'Staff',v_tenant.id)
      returning * into v_profile;
  end if;

  select * into v_project from public.projects
    where tenant_id=v_tenant.id and lower(slug)=lower(p_project_slug) for update;
  if not found then
    select not exists(select 1 from public.projects where tenant_id=v_tenant.id and is_default) into v_is_default;
    insert into public.projects(tenant_id,slug,name,is_default,map_experience_mode)
      values (v_tenant.id,p_project_slug,trim(p_project_name),v_is_default,case when p_demo_mode then 'demo' else 'sales' end)
      returning * into v_project;
  elsif v_project.name <> trim(p_project_name)
    or v_project.map_experience_mode <> (case when p_demo_mode then 'demo' else 'sales' end) then
    raise exception 'Existing project settings differ from this onboarding config; review them rather than overwriting.';
  end if;

  select * into v_phase from public.development_phases
    where tenant_id=v_tenant.id and project_id=v_project.id and lower(slug)=lower(p_phase_slug) for update;
  if not found then
    select not exists(select 1 from public.development_phases where project_id=v_project.id and is_default) into v_is_default;
    insert into public.development_phases(tenant_id,project_id,slug,name,is_default)
      values (v_tenant.id,v_project.id,p_phase_slug,trim(p_phase_name),v_is_default)
      returning * into v_phase;
  elsif v_phase.name <> trim(p_phase_name) or not v_phase.is_active then
    raise exception 'Existing project phase differs from this onboarding config; review it rather than overwriting.';
  end if;

  select member_role into v_existing_role from public.project_memberships
    where tenant_id=v_tenant.id and project_id=v_project.id and phase_id=v_phase.id and user_id=p_staff_user_id for update;
  if found and v_existing_role <> p_member_role then
    raise exception 'The staff account already has a different project role; review that assignment instead of changing it implicitly.';
  elsif not found then
    insert into public.project_memberships(tenant_id,project_id,phase_id,user_id,member_role)
      values(v_tenant.id,v_project.id,v_phase.id,p_staff_user_id,p_member_role);
  end if;

  insert into public.project_settings(tenant_id,project_id,key,value)
    values(v_tenant.id,v_project.id,'tenant_theme',coalesce(p_theme,'{}'::jsonb))
    on conflict(project_id,key) do nothing;
  insert into public.project_settings(tenant_id,project_id,key,value)
    values(v_tenant.id,v_project.id,'company_profile',coalesce(p_company_profile,'{}'::jsonb))
    on conflict(project_id,key) do nothing;
  if not exists (select 1 from public.project_settings where tenant_id=v_tenant.id and project_id=v_project.id
      and key='tenant_theme' and value=coalesce(p_theme,'{}'::jsonb))
    or not exists (select 1 from public.project_settings where tenant_id=v_tenant.id and project_id=v_project.id
      and key='company_profile' and value=coalesce(p_company_profile,'{}'::jsonb)) then
    raise exception 'Existing project branding differs from onboarding config; review it rather than overwriting.';
  end if;

  return jsonb_build_object('tenant_id',v_tenant.id,'project_id',v_project.id,'phase_id',v_phase.id,
    'staff_user_id',p_staff_user_id,'member_role',p_member_role,'created_or_reused',true);
end;
$$;
revoke all on function public.onboard_project_tenant(text,text,text,text,text,text,jsonb,jsonb,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.onboard_project_tenant(text,text,text,text,text,text,jsonb,jsonb,uuid,text,boolean) to service_role;
comment on function public.onboard_project_tenant(text,text,text,text,text,text,jsonb,jsonb,uuid,text,boolean) is
  'Atomic, repeatable project onboarding for an existing Auth user. Never creates/invites users or moves an existing profile between tenants.';

-- Atomic active-map switch after the importer has uploaded its immutable
-- feature rows and hosted display raster. Existing map remains active on error.
create or replace function public.activate_project_demo_map_snapshot(
  p_snapshot_id uuid,
  p_masterplan_version_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  s public.map_feature_snapshots%rowtype;
  feature_count integer;
begin
  select * into s from public.map_feature_snapshots where id=p_snapshot_id for update;
  if not found then raise exception 'Map feature snapshot was not found.'; end if;
  if not exists (
    select 1 from public.projects p where p.id=s.project_id and p.tenant_id=s.tenant_id
      and p.map_experience_mode='demo'
  ) then raise exception 'Snapshot target is not configured as an isolated demo project.'; end if;
  select count(*) into feature_count from public.map_features f
    where f.snapshot_id=s.id and f.tenant_id=s.tenant_id and f.project_id=s.project_id
      and f.phase_id=s.phase_id and f.is_active and f.public_visible;
  if feature_count <> s.outline_count then
    raise exception 'Snapshot outline count mismatch: expected %, found % public active features.', s.outline_count, feature_count;
  end if;
  if not exists (
    select 1 from public.masterplan_versions v where v.id=p_masterplan_version_id
      and v.tenant_id=s.tenant_id and v.project_id=s.project_id and v.phase_id=s.phase_id
      and v.image_url ~ '^https?://'
  ) then raise exception 'Hosted map image version is missing or belongs to another project/phase.'; end if;

  update public.map_feature_snapshots set is_active=false
  where tenant_id=s.tenant_id and project_id=s.project_id and phase_id=s.phase_id and id<>s.id and is_active;
  update public.map_feature_snapshots set is_active=true,
    activated_as_demo_at=coalesce(activated_as_demo_at, now()) where id=s.id;
  update public.masterplan_versions set is_active=true where id=p_masterplan_version_id;

  return jsonb_build_object(
    'snapshot_id', s.id,
    'tenant_id', s.tenant_id,
    'project_id', s.project_id,
    'phase_id', s.phase_id,
    'outline_count', feature_count,
    'masterplan_version_id', p_masterplan_version_id,
    'activated', true
  );
end;
$$;
revoke all on function public.activate_project_demo_map_snapshot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.activate_project_demo_map_snapshot(uuid, uuid) to service_role;
comment on function public.activate_project_demo_map_snapshot(uuid, uuid) is
  'Atomically switches the isolated demo map to an already loaded immutable feature snapshot and same-scope raster version. Service-role importer only; never changes parcels or inventory.';

grant select, insert, update, delete on public.development_phases to authenticated;
grant select on public.map_features, public.map_feature_snapshots, public.map_feature_identities to authenticated;
-- Explicit service-role grants are needed by the SECURITY INVOKER inquiry and
-- activation RPCs; do not rely on project-specific default privileges.
grant select, insert, update, delete on public.development_phases, public.project_memberships to service_role;
grant select on public.projects, public.organizations to service_role;
grant select on public.business_settings to service_role;
grant select, insert, update, delete on public.parcels, public.project_settings, public.project_lot_tiers,
  public.leads, public.lead_activities, public.follow_up_tasks,
  public.map_features, public.map_feature_snapshots, public.map_feature_identities,
  public.masterplan_versions to service_role;

comment on table public.map_features is 'Project/phase-scoped geometry-only public map features. Never inventory; intentionally has no prices, sale status, contracts or canonical lot identity.';
comment on table public.map_feature_snapshots is 'Immutable, versioned imports of geometry-only map features. Only one snapshot is active per project/phase.';
comment on column public.project_memberships.phase_id is 'NULL grants the member access to every phase in the project; otherwise access is limited to the named phase.';

commit;
