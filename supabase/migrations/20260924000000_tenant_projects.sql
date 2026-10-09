-- Tenant projects (named developments/phases within an organization).
-- A parcel belongs to at most one project; legacy rows keep project_id NULL
-- and render under the tenant's default project (back-compat).
-- Slugs are IMMUTABLE once published: no code path updates them (enforced
-- below by trigger), renames ship as a new project + data move, never an
-- in-place slug edit (cached embeds + printed QR codes keep working).
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  slug text not null,
  name text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),

  constraint projects_slug_valid check (slug ~ '^[a-z0-9-]+$'),
  constraint projects_name_present check (length(trim(name)) > 0)
);

create unique index if not exists uniq_projects_tenant_slug
  on public.projects (tenant_id, lower(slug));

-- Exactly one default project per tenant.
create unique index if not exists uniq_projects_tenant_default
  on public.projects (tenant_id) where is_default;

create or replace function public.prevent_project_slug_change()
returns trigger language plpgsql as $$
begin
  if new.slug is distinct from old.slug then
    raise exception 'Project slugs are immutable once published (project %). Create a new project instead.', old.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_projects_slug_immutable on public.projects;
create trigger trg_projects_slug_immutable
  before update on public.projects
  for each row execute function public.prevent_project_slug_change();

alter table public.parcels
  add column if not exists project_id uuid references public.projects(id) on delete set null;

comment on table public.projects is 'Named tenant developments for /embed/:tenant/:project. Slugs immutable once published.';
comment on column public.parcels.project_id is 'Owning project; NULL = legacy unassigned rows, shown under the default project.';
