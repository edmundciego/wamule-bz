-- Phase-specific public application intake remains subordinate to the existing
-- company and project opt-in. Missing allowlists preserve existing projects;
-- present lists are validated and fail closed for every non-listed phase.
begin;

create or replace function public.validate_project_application_scope()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_settings jsonb;
  v_company_settings jsonb;
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

  if not public.workspace_scope_is_active(new.tenant_id, new.project_id, new.phase_id) then
    raise exception 'Applications require an active tenant, project, and phase.' using errcode='23514';
  end if;

  select ps.value into v_settings
  from public.project_settings ps
  where ps.tenant_id=new.tenant_id and ps.project_id=new.project_id and ps.key='public_application';
  if not found then raise exception 'This project has no published application configuration.' using errcode='23514'; end if;

  if v_settings ? 'allowed_phase_ids' then
    if jsonb_typeof(v_settings->'allowed_phase_ids') is distinct from 'array' then
      raise exception 'The project application phase allowlist is invalid.' using errcode='23514';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(v_settings->'allowed_phase_ids') as phase_value(value)
      where jsonb_typeof(phase_value.value) is distinct from 'string'
        or (phase_value.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) then
      raise exception 'The project application phase allowlist is invalid.' using errcode='23514';
    end if;
    if not exists (
      select 1
      from jsonb_array_elements(v_settings->'allowed_phase_ids') as phase_value(value)
      where lower(phase_value.value #>> '{}')=new.phase_id::text
    ) then
      raise exception 'Applications are not enabled for the selected project phase.' using errcode='23514';
    end if;
  end if;

  if tg_op='INSERT' then
    select bs.value into v_company_settings
    from public.business_settings bs
    where bs.tenant_id=new.tenant_id and bs.key='public_application';
    if not found or v_company_settings->>'applications_open' is distinct from 'true' then
      raise exception 'Company applications are closed.' using errcode='23514';
    end if;
    if v_settings->>'applications_open' is distinct from 'true' then
      raise exception 'Project applications are closed.' using errcode='23514';
    end if;
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

commit;
