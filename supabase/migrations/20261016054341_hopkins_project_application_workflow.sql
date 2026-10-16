-- Hopkins public project applications are separate from parcel-purchase applications.
-- This migration only adds workflow metadata and Hopkins project configuration.
-- It does not change existing parcel, lead, price, or application assignments.
begin;

do $$
begin
  if to_regclass('public.applications') is null
    or to_regclass('public.organizations') is null
    or to_regclass('public.projects') is null
    or to_regclass('public.development_phases') is null
    or to_regclass('public.project_settings') is null
    or to_regclass('public.map_feature_snapshots') is null
    or to_regclass('public.map_features') is null
    or to_regclass('public.leads') is null
    or to_regclass('public.lead_activities') is null
    or to_regclass('public.follow_up_tasks') is null then
    raise exception 'Hopkins project application prerequisites are missing; apply the reviewed hosted project/map migrations first.';
  end if;
  if (select count(*) from public.organizations where slug='hopkins-grove' and is_active) <> 1
    or (select count(*) from public.projects p join public.organizations t on t.id=p.tenant_id where t.slug='hopkins-grove' and p.slug='hopkins-grove') <> 1
    or (select count(*) from public.development_phases ph join public.projects p on p.id=ph.project_id and p.tenant_id=ph.tenant_id join public.organizations t on t.id=ph.tenant_id where t.slug='hopkins-grove' and p.slug='hopkins-grove' and ph.slug='initial' and ph.is_active) <> 1 then
    raise exception 'The published Hopkins tenant/project/phase scope is missing or ambiguous.';
  end if;
end;
$$;

-- project_settings is not publicly selectable; the public page reads its small
-- allowlist through get-public-project-page using service_role.
alter table public.project_settings drop constraint if exists project_settings_key_valid;
alter table public.project_settings add constraint project_settings_key_valid
  check (key in ('tenant_theme', 'company_profile', 'public_application'));

insert into public.project_settings(tenant_id, project_id, key, value)
select t.id, p.id, 'public_application', jsonb_build_object(
  'applications_open', true,
  'notice_version', 'hopkins-project-application-2026-10-15-v1',
  'public_notice_text', 'This is a Hopkins Grove project application for staff review. It does not reserve, allocate, or purchase a parcel, confirm availability, or create ownership rights. Map outline preferences identify areas of interest only; they are not saleable parcels or assigned lots.',
  'application_acknowledgment_text', 'I understand that my application is submitted for project-team review only. Any map outlines I select are preferences, not an assigned lot or a promise of sale. Submitting this form does not create a purchase agreement or guarantee an outcome. I consent to Ceiba Realty & Development using the information I provide to review and respond to this Hopkins Grove application.',
  'allowed_intended_uses', jsonb_build_array('Residential', 'Commercial', 'Agriculture', 'Investment', 'Rental Property', 'Other'),
  'max_map_preferences', 5,
  'default_confirmation_message', 'Your Hopkins Grove project application was received for staff review. No parcel or map outline has been assigned.',
  'outbound_notifications_enabled', false,
  'show_prices_publicly', false,
  'show_available_count_publicly', false
)
from public.organizations t
join public.projects p on p.tenant_id=t.id and p.slug='hopkins-grove'
join public.development_phases ph on ph.tenant_id=t.id and ph.project_id=p.id and ph.slug='initial' and ph.is_active
where t.slug='hopkins-grove' and t.is_active
on conflict (project_id, key) do update
set value=public.project_settings.value || excluded.value,
    updated_at=now();

alter table public.applications
  add column if not exists project_id uuid,
  add column if not exists phase_id uuid,
  add column if not exists application_kind text not null default 'land_purchase',
  add column if not exists preferred_map_feature_refs uuid[] not null default '{}'::uuid[],
  add column if not exists submission_reference uuid,
  add column if not exists submission_fingerprint text,
  add column if not exists project_notice_version text,
  add column if not exists project_public_notice_snapshot text,
  add column if not exists project_acknowledgment_snapshot text,
  add column if not exists project_notice_acknowledged_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.applications'::regclass and conname='applications_project_tenant_fkey') then
    alter table public.applications add constraint applications_project_tenant_fkey
      foreign key (project_id, tenant_id) references public.projects(id, tenant_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.applications'::regclass and conname='applications_phase_project_tenant_fkey') then
    alter table public.applications add constraint applications_phase_project_tenant_fkey
      foreign key (phase_id, project_id, tenant_id) references public.development_phases(id, project_id, tenant_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.applications'::regclass and conname='applications_project_phase_pair_check') then
    alter table public.applications add constraint applications_project_phase_pair_check
      check ((project_id is null and phase_id is null) or (project_id is not null and phase_id is not null));
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.applications'::regclass and conname='applications_kind_valid_check') then
    alter table public.applications add constraint applications_kind_valid_check
      check (application_kind in ('land_purchase', 'project_application'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.applications'::regclass and conname='applications_project_application_unallocated_check') then
    alter table public.applications add constraint applications_project_application_unallocated_check
      check (application_kind <> 'project_application' or (
        project_id is not null and phase_id is not null
        and parcel_id is null and parcel_count is null
        and cardinality(preferred_parcel_ids)=0
        and alternate_lot_preference is null and payment_option is null
        and cardinality(preferred_map_feature_refs) between 0 and 5
        and legal_notice_acknowledged is true
        and nullif(trim(applicant_acknowledgement_signature), '') is not null
        and nullif(trim(project_notice_version), '') is not null
        and nullif(trim(project_public_notice_snapshot), '') is not null
        and nullif(trim(project_acknowledgment_snapshot), '') is not null
        and project_notice_acknowledged_at is not null
        and submission_reference is not null
        and submission_fingerprint is not null
        and submission_fingerprint ~ '^[0-9a-f]{64}$'
      ));
  end if;
end;
$$;

create unique index if not exists applications_tenant_submission_reference_uidx
  on public.applications(tenant_id, submission_reference)
  where submission_reference is not null;
create index if not exists applications_project_review_idx
  on public.applications(tenant_id, project_id, phase_id, status, created_at desc);

create or replace function public.user_has_application_scope(p_tenant_id uuid, p_project_id uuid, p_phase_id uuid)
returns boolean
language sql stable security definer
set search_path = public, auth, pg_temp
as $$
  select case
    when p_project_id is not null and p_phase_id is not null
      then public.user_has_project_access(p_tenant_id, p_project_id, p_phase_id)
    when p_project_id is null and p_phase_id is null
      then exists (
        select 1
        from public.projects p
        join public.development_phases ph on ph.tenant_id=p.tenant_id and ph.project_id=p.id
        where p.tenant_id=p_tenant_id and p.is_default and ph.is_default
          and public.user_has_project_access(p.tenant_id, p.id, ph.id)
      )
    else false
  end;
$$;
revoke all on function public.user_has_application_scope(uuid, uuid, uuid) from public, anon;
grant execute on function public.user_has_application_scope(uuid, uuid, uuid) to authenticated, service_role;

create or replace function public.user_can_write_application_scope(p_tenant_id uuid, p_project_id uuid, p_phase_id uuid)
returns boolean
language sql stable security definer
set search_path = public, auth, pg_temp
as $$
  select case
    when p_project_id is not null and p_phase_id is not null
      then public.user_can_write_project(p_tenant_id, p_project_id, p_phase_id)
    when p_project_id is null and p_phase_id is null
      then exists (
        select 1
        from public.projects p
        join public.development_phases ph on ph.tenant_id=p.tenant_id and ph.project_id=p.id
        where p.tenant_id=p_tenant_id and p.is_default and ph.is_default
          and public.user_can_write_project(p.tenant_id, p.id, ph.id)
      )
    else false
  end;
$$;
revoke all on function public.user_can_write_application_scope(uuid, uuid, uuid) from public, anon;
grant execute on function public.user_can_write_application_scope(uuid, uuid, uuid) to authenticated, service_role;

create or replace function public.validate_project_application_scope()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_settings jsonb;
  v_active_snapshot uuid;
  v_distinct_refs integer;
  v_found_refs integer;
  v_scope_changed boolean;
begin
  if new.application_kind <> 'project_application' then
    if tg_op='UPDATE' and old.application_kind='project_application' then
      raise exception 'Project application type cannot be changed.' using errcode='23514';
    end if;
    return new;
  end if;

  if tg_op='UPDATE' and (
    old.application_kind is distinct from new.application_kind
    or old.tenant_id is distinct from new.tenant_id
    or old.project_id is distinct from new.project_id
    or old.phase_id is distinct from new.phase_id
  ) then
    raise exception 'Project application tenant and project scope are immutable.' using errcode='23514';
  end if;
  if new.project_id is null or new.phase_id is null or new.tenant_id is null then
    raise exception 'A project application must have a complete tenant, project, and phase scope.' using errcode='23514';
  end if;
  if new.parcel_id is not null or new.parcel_count is not null or cardinality(new.preferred_parcel_ids) <> 0
    or new.alternate_lot_preference is not null or new.payment_option is not null then
    raise exception 'Hopkins project applications cannot allocate or request a saleable parcel.' using errcode='23514';
  end if;
  if tg_op='INSERT' and new.status <> 'Pending Review' then
    raise exception 'A new project application must remain pending staff review.' using errcode='23514';
  end if;
  if new.legal_notice_acknowledged is not true
    or lower(trim(new.applicant_acknowledgement_signature)) <> lower(trim(new.applicant_full_name)) then
    raise exception 'The Hopkins project notice and applicant signature must be acknowledged.' using errcode='23514';
  end if;

  v_scope_changed := tg_op='INSERT';
  if tg_op='UPDATE' then
    v_scope_changed := old.preferred_map_feature_refs is distinct from new.preferred_map_feature_refs
      or old.project_notice_version is distinct from new.project_notice_version
      or old.project_public_notice_snapshot is distinct from new.project_public_notice_snapshot
      or old.project_acknowledgment_snapshot is distinct from new.project_acknowledgment_snapshot
      or old.project_notice_acknowledged_at is distinct from new.project_notice_acknowledged_at;
  end if;
  if not v_scope_changed then return new; end if;

  select ps.value into v_settings
  from public.project_settings ps
  where ps.tenant_id=new.tenant_id and ps.project_id=new.project_id and ps.key='public_application';
  if not found then raise exception 'This project has no published application configuration.' using errcode='23514'; end if;
  if tg_op='INSERT' and v_settings->>'applications_open' is distinct from 'true' then
    raise exception 'Project applications are closed.' using errcode='23514';
  end if;
  if new.project_notice_version is distinct from v_settings->>'notice_version'
    or new.project_public_notice_snapshot is distinct from v_settings->>'public_notice_text'
    or new.project_acknowledgment_snapshot is distinct from v_settings->>'application_acknowledgment_text'
    or new.project_notice_acknowledged_at is null then
    raise exception 'The applicant acknowledgement does not match the published project notice.' using errcode='23514';
  end if;
  if not coalesce((v_settings->'allowed_intended_uses') ? new.intended_use, false) then
    raise exception 'The intended use is not configured for this project.' using errcode='23514';
  end if;
  if cardinality(new.preferred_map_feature_refs) > coalesce((v_settings->>'max_map_preferences')::integer, 0) then
    raise exception 'Too many map-outline preferences were selected.' using errcode='23514';
  end if;
  select count(distinct ref)::integer into v_distinct_refs from unnest(new.preferred_map_feature_refs) as refs(ref);
  if v_distinct_refs <> cardinality(new.preferred_map_feature_refs) then
    raise exception 'Duplicate map-outline preferences are not allowed.' using errcode='23514';
  end if;
  if cardinality(new.preferred_map_feature_refs) > 0 then
    select s.id into v_active_snapshot
    from public.map_feature_snapshots s
    where s.tenant_id=new.tenant_id and s.project_id=new.project_id and s.phase_id=new.phase_id and s.is_active
    limit 1;
    if v_active_snapshot is null then raise exception 'No active public Hopkins map snapshot is available.' using errcode='23514'; end if;
    select count(distinct f.identity_id)::integer into v_found_refs
    from public.map_features f
    where f.tenant_id=new.tenant_id and f.project_id=new.project_id and f.phase_id=new.phase_id
      and f.snapshot_id=v_active_snapshot and f.is_active and f.public_visible
      and f.identity_id=any(new.preferred_map_feature_refs);
    if v_found_refs <> cardinality(new.preferred_map_feature_refs) then
      raise exception 'A map-outline preference is outside the published project map.' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.validate_project_application_scope() from public, anon, authenticated;
drop trigger if exists applications_project_application_scope_guard on public.applications;
create trigger applications_project_application_scope_guard
before insert or update on public.applications
for each row execute function public.validate_project_application_scope();

-- Keep the established land-purchase lead path unchanged. Project applications
-- get an explicitly scoped Hopkins lead/task and never enter Wamule's email queue.
create or replace function public.create_lead_from_project_application()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_lead_id uuid;
  v_full_name text;
  v_notes text;
  v_due_at timestamptz;
  v_possible_duplicate boolean;
begin
  if new.application_kind <> 'project_application' then return new; end if;
  select id into v_lead_id from public.leads where application_id=new.id limit 1;
  if v_lead_id is not null then return new; end if;

  v_full_name := coalesce(nullif(trim(new.applicant_full_name), ''), trim(new.first_name || ' ' || new.last_name));
  v_due_at := public.application_lead_due_at();
  select exists (
    select 1 from public.leads l
    where l.tenant_id=new.tenant_id and l.project_id=new.project_id and l.phase_id=new.phase_id
      and ((new.email is not null and lower(trim(l.email))=lower(trim(new.email)))
        or (new.phone is not null and regexp_replace(coalesce(l.phone,''),'[^0-9]','','g')=regexp_replace(new.phone,'[^0-9]','','g')))
  ) into v_possible_duplicate;
  v_notes := nullif(concat_ws(E'\n',
    'Hopkins Grove project application submitted for staff review.',
    case when new.intended_use is not null then 'Intended use: ' || new.intended_use else null end,
    case when new.intended_use_other is not null then 'Other intended use: ' || new.intended_use_other else null end,
    case when cardinality(new.preferred_map_feature_refs)>0 then 'Map-outline preferences: ' || array_to_string(new.preferred_map_feature_refs, ', ') else 'No map-outline preference selected.' end,
    case when new.notes is not null then 'Applicant notes: ' || new.notes else null end
  ), '');

  insert into public.leads (
    tenant_id, project_id, phase_id, full_name, email, phone, parcel_id, application_id,
    source, pipeline_stage, buyer_journey_stage, preferred_contact_method,
    next_action, next_action_due_at, notes, possible_duplicate, duplicate_reason,
    duplicate_checked_at, created_by
  ) values (
    new.tenant_id, new.project_id, new.phase_id, v_full_name, new.email, new.phone, null, new.id,
    'Hopkins Project Application', 'application_started', 'New Project Application',
    case when new.email is not null then 'Email' else 'Phone' end,
    'Review Hopkins project application', v_due_at, v_notes, v_possible_duplicate,
    case when v_possible_duplicate then 'Contact details match an existing Hopkins project lead.' else null end,
    now(), null
  ) on conflict do nothing returning id into v_lead_id;
  if v_lead_id is null then
    select id into v_lead_id from public.leads where application_id=new.id limit 1;
  end if;
  if v_lead_id is not null then
    insert into public.lead_activities(
      tenant_id, project_id, phase_id, lead_id, activity_type, title, description, metadata, created_by
    ) values (
      new.tenant_id, new.project_id, new.phase_id, v_lead_id, 'application_linked',
      'Hopkins project application received', 'Application #' || new.id || ' is ready for Hopkins staff review.',
      jsonb_build_object('application_id',new.id,'application_kind','project_application','parcel_assigned',false), null
    ) on conflict do nothing;
    insert into public.follow_up_tasks(
      tenant_id, project_id, phase_id, lead_id, application_id, title, description, due_at, status, priority, created_by
    ) values (
      new.tenant_id, new.project_id, new.phase_id, v_lead_id, new.id,
      'Review Hopkins project application', 'Review the submitted details and map-outline preferences with the applicant.',
      v_due_at, 'open', 'high', null
    ) on conflict do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.create_lead_from_project_application() from public, anon, authenticated;
drop trigger if exists trg_create_lead_from_application on public.applications;
create trigger trg_create_lead_from_application
after insert on public.applications
for each row when (new.application_kind is distinct from 'project_application')
execute function public.create_lead_from_application();
drop trigger if exists trg_create_lead_from_project_application on public.applications;
create trigger trg_create_lead_from_project_application
after insert on public.applications
for each row when (new.application_kind = 'project_application')
execute function public.create_lead_from_project_application();

-- Restrict application rows to the selected project and phase, while legacy
-- unscoped Wamule purchase applications remain visible from its default workspace.
drop policy if exists "Public can submit pending applications" on public.applications;
drop policy if exists "Staff can insert applications" on public.applications;
drop policy if exists "Applications readable by internal users" on public.applications;
drop policy if exists "Applications writable by admin staff" on public.applications;
drop policy if exists "Applications deletable by admins" on public.applications;
drop policy if exists applications_workspace_scope on public.applications;
create policy applications_workspace_scope on public.applications as restrictive for all to authenticated
  using (public.user_has_application_scope(tenant_id, project_id, phase_id))
  with check (public.user_has_application_scope(tenant_id, project_id, phase_id));
create policy "Applications readable by internal users" on public.applications
  for select to authenticated using (is_internal_user());
create policy "Applications writable by admin staff" on public.applications
  for update to authenticated using (can_write_admin_data() and public.user_can_write_application_scope(tenant_id, project_id, phase_id))
  with check (can_write_admin_data() and public.user_can_write_application_scope(tenant_id, project_id, phase_id));
create policy "Applications deletable by admins" on public.applications
  for delete to authenticated using (is_admin_user() and public.user_can_write_application_scope(tenant_id, project_id, phase_id));
create policy "Staff can insert applications" on public.applications
  for insert to authenticated with check (can_write_admin_data() and public.user_can_write_application_scope(tenant_id, project_id, phase_id));

revoke insert on public.applications from public, anon;
grant select, insert, update, delete on public.applications to authenticated, service_role;

commit;
