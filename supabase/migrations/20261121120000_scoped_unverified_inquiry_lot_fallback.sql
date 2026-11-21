begin;

-- Keep the fingerprint-aware overload for rollback compatibility while adding
-- a scoped public-inquiry path that records unverifiable lot selections as
-- general inquiries. The selected lot is rechecked in the same transaction as
-- the lead, staff note, and follow-up writes.
create function public.revalidate_public_inquiry_hostname(
  p_hostname text,
  p_tenant_id uuid,
  p_project_id uuid,
  p_phase_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hostname text;
  v_resolution record;
begin
  v_hostname := provisioning_private.normalize_public_hostname(p_hostname);
  if v_hostname is null then return false; end if;

  select resolved.* into v_resolution
  from public.resolve_public_hostname(v_hostname) resolved;
  if not found or v_resolution.resolution <> 'resolved' then return false; end if;

  perform 1
  from public.public_hostname_bindings b
  join public.organizations o on o.id=b.tenant_id and o.is_active
  join public.projects p on p.id=b.project_id and p.tenant_id=o.id
  join public.development_phases ph on ph.id=p_phase_id and ph.tenant_id=o.id
    and ph.project_id=p.id and ph.is_active
  where b.hostname=v_hostname and b.status='active'
    and b.tenant_id=p_tenant_id and b.project_id=p_project_id
    and o.slug=v_resolution.tenant_slug and p.slug=v_resolution.project_slug
    and (b.default_phase_id is null or b.default_phase_id=p_phase_id)
    and (v_resolution.phase_slug is null or ph.slug=v_resolution.phase_slug)
    and b.verification_evidence ->> 'hostname' is not distinct from b.hostname
    and b.verification_evidence ->> 'challenge' is not distinct from b.verification_challenge::text
    and b.verification_evidence ->> 'method' is not distinct from b.verification_method
    and b.verification_evidence ->> 'verification_result' is not distinct from 'passed'
    and b.verification_evidence ->> 'server_validated' is not distinct from 'true'
  for share of b;
  return found;
end;
$$;

revoke all on function public.revalidate_public_inquiry_hostname(text, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.revalidate_public_inquiry_hostname(text, uuid, uuid, uuid)
  to service_role;
comment on function public.revalidate_public_inquiry_hostname(text, uuid, uuid, uuid) is
  'Service-role-only check that locks a verified public hostname binding for a scoped inquiry transaction.';

create function public.create_scoped_public_inquiry(
  p_tenant_id uuid,
  p_project_id uuid,
  p_phase_id uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_message text,
  p_page_url text,
  p_interests jsonb,
  p_client_reference_id text,
  p_submission_fingerprint text,
  p_parcel_id bigint,
  p_map_feature_id uuid,
  p_duplicate_reason text,
  p_unverified_lot_reference text,
  p_hostname text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_lead_id uuid;
  v_existing public.leads%rowtype;
  v_scope_tenant uuid;
  v_scope_project uuid;
  v_scope_phase uuid;
  v_map_mode text;
  v_label text;
  v_status text;
  v_waitlist boolean := false;
  v_publicly_eligible boolean := false;
  v_needs_review boolean;
  v_masterplan_version_id uuid;
  v_notes text;
  v_due_at timestamptz := now() + interval '24 hours';
  v_existing_fingerprint text;
  v_existing_unverified_lot_reference text;
  v_requested_lot_reference text;
  v_unverified_lot_reference text;
begin
  if p_tenant_id is null or p_project_id is null or p_phase_id is null
     or nullif(trim(p_name), '') is null or nullif(trim(p_email), '') is null
     or nullif(trim(p_client_reference_id), '') is null
     or nullif(trim(p_submission_fingerprint), '') is null then
    raise exception 'Public inquiry scope, contact and idempotency fields are required.';
  end if;
  if p_parcel_id is not null and p_map_feature_id is not null then
    raise exception 'An inquiry cannot reference both an inventory parcel and a map feature.';
  end if;
  perform 1 from public.development_phases ph
    join public.projects p on p.id=ph.project_id and p.tenant_id=ph.tenant_id
    join public.organizations o on o.id=p.tenant_id and o.is_active
    where ph.id=p_phase_id and ph.project_id=p_project_id and ph.tenant_id=p_tenant_id and ph.is_active
    for share of o, p, ph;
  if not found then raise exception 'Inquiry project/phase scope is invalid or inactive.'; end if;

  if p_hostname is not null then
    if public.revalidate_public_inquiry_hostname(p_hostname, p_tenant_id, p_project_id, p_phase_id) is not true then
      raise exception 'Inquiry hostname is no longer verified for this scope.';
    end if;
  end if;

  v_requested_lot_reference := nullif(left(regexp_replace(
    regexp_replace(coalesce(p_unverified_lot_reference, ''), '[<>[:cntrl:]]', '', 'g'),
    '[[:space:]]+', ' ', 'g'), 160), '');
  v_requested_lot_reference := nullif(trim(v_requested_lot_reference), '');

  if p_map_feature_id is not null then
    select i.tenant_id, i.project_id, i.phase_id, coalesce(linked.lot_number, pc.plot_number, f.demo_label)
      into v_scope_tenant, v_scope_project, v_scope_phase, v_label
    from public.map_feature_identities i
    join public.map_features f on f.identity_id=i.id
    join public.map_feature_snapshots s on s.id=f.snapshot_id
    join public.projects p on p.id=i.project_id and p.tenant_id=i.tenant_id
    left join public.project_map_packages pkg on pkg.snapshot_id=s.id
      and pkg.tenant_id=i.tenant_id and pkg.project_id=i.project_id and pkg.phase_id=i.phase_id
    left join public.project_plot_content pc on pc.identity_id=i.id
      and pc.tenant_id=i.tenant_id and pc.project_id=i.project_id and pc.phase_id=i.phase_id
    left join public.parcels linked on linked.id=pc.parcel_id
      and linked.tenant_id=pc.tenant_id and linked.project_id=pc.project_id and linked.phase_id=pc.phase_id
    where i.id=p_map_feature_id and s.is_active and f.is_active and f.public_visible
      and ((pkg.id is null and p.map_experience_mode='demo')
        or (pkg.id is not null and pc.public_visible and f.feature_kind='demo_plot'))
    order by f.created_at desc limit 1;
    if v_scope_tenant is null then raise exception 'Selected mapped plot is not part of an active public map.'; end if;
    if v_scope_tenant<>p_tenant_id or v_scope_project<>p_project_id or v_scope_phase<>p_phase_id then
      raise exception 'Selected mapped plot does not belong to the requested project/phase.';
    end if;
  elsif p_parcel_id is not null then
    select parcel.tenant_id, parcel.project_id, parcel.phase_id, parcel.lot_number, parcel.status,
      p.map_experience_mode, parcel.needs_review, parcel.masterplan_version_id
      into v_scope_tenant, v_scope_project, v_scope_phase, v_label, v_status, v_map_mode,
        v_needs_review, v_masterplan_version_id
    from public.parcels parcel
    left join public.projects p on p.id=parcel.project_id and p.tenant_id=parcel.tenant_id
    where parcel.id=p_parcel_id
    for update of parcel;

    if v_scope_tenant is not null and v_scope_tenant=p_tenant_id
       and v_scope_project=p_project_id and v_scope_phase=p_phase_id
       and v_map_mode='sales' and not coalesce(v_needs_review, true)
       and coalesce(v_status, '') in ('Available', 'Reserved') then
      perform 1
      from public.map_feature_snapshots snap
      join public.project_map_packages pkg on pkg.tenant_id=snap.tenant_id and pkg.project_id=snap.project_id
        and pkg.phase_id=snap.phase_id and pkg.snapshot_id=snap.id and pkg.published_at is not null
      join public.map_features f on f.tenant_id=snap.tenant_id and f.project_id=snap.project_id
        and f.phase_id=snap.phase_id and f.snapshot_id=snap.id and f.is_active and f.public_visible
      join public.project_plot_content pc on pc.tenant_id=f.tenant_id and pc.project_id=f.project_id
        and pc.phase_id=f.phase_id and pc.identity_id=f.identity_id and pc.public_visible
        and pc.parcel_id=p_parcel_id
      where snap.tenant_id=p_tenant_id and snap.project_id=p_project_id
        and snap.phase_id=p_phase_id and snap.is_active
      for share of snap, pkg, f, pc;
      v_publicly_eligible := found;

      if v_publicly_eligible and v_masterplan_version_id is not null then
        perform 1 from public.masterplan_versions mv
        where mv.id=v_masterplan_version_id and mv.tenant_id=p_tenant_id
          and mv.project_id=p_project_id and mv.phase_id=p_phase_id and mv.is_active
        for share of mv;
        v_publicly_eligible := found;
      end if;
    end if;

    if not v_publicly_eligible then
      p_parcel_id := null;
      v_unverified_lot_reference := coalesce(v_requested_lot_reference, '[unavailable]');
    else
      v_waitlist := v_status='Reserved';
    end if;
  elsif v_requested_lot_reference is not null then
    v_unverified_lot_reference := v_requested_lot_reference;
  end if;

  v_notes := concat_ws(E'\n',
    case when p_map_feature_id is not null then 'Specific mapped plot interest: ' || coalesce(v_label, 'Mapped plot')
         when p_parcel_id is not null then 'Specific lot interest: Lot ' || coalesce(v_label, '')
         else null end,
    case when v_unverified_lot_reference is not null
      then 'Unverified buyer-supplied lot reference: ' || v_unverified_lot_reference || ' (unverified).' end,
    case when nullif(trim(p_phone), '') is not null then 'Phone / WhatsApp: ' || trim(p_phone) end,
    case when nullif(trim(p_message), '') is not null then 'Buyer message: ' || trim(p_message) end
  );

  insert into public.leads(
    tenant_id, project_id, phase_id, parcel_id, map_feature_id, full_name, email, phone,
    source, pipeline_stage, buyer_journey_stage, preferred_contact_method, assigned_to,
    next_action, next_action_due_at, notes, client_reference_id, possible_duplicate,
    duplicate_reason, duplicate_checked_at, created_by
  ) values (
    p_tenant_id, p_project_id, p_phase_id, p_parcel_id, p_map_feature_id, trim(p_name), lower(trim(p_email)),
    nullif(trim(p_phone), ''), 'public_inquiry', 'new_lead', 'Public Information Request',
    case when nullif(trim(p_phone), '') is not null then 'Email or Phone / WhatsApp' else 'Email' end,
    null, 'Follow up on public project information inquiry', v_due_at, nullif(v_notes, ''),
    p_client_reference_id, nullif(trim(p_duplicate_reason), '') is not null,
    nullif(trim(p_duplicate_reason), ''), now(), null
  ) on conflict (tenant_id, client_reference_id) where client_reference_id is not null do nothing
  returning id into v_lead_id;

  if v_lead_id is null then
    select * into v_existing from public.leads
    where tenant_id=p_tenant_id and client_reference_id=p_client_reference_id;
    if not found then raise exception 'Inquiry idempotency resolution failed.'; end if;
    select a.metadata->>'submission_fingerprint', a.metadata->>'unverified_lot_reference'
      into v_existing_fingerprint, v_existing_unverified_lot_reference
    from public.lead_activities a
    where a.tenant_id=p_tenant_id and a.project_id=p_project_id and a.phase_id=p_phase_id
      and a.lead_id=v_existing.id and a.activity_type='note'
      and a.metadata->>'source'='public_inquiry'
    order by a.created_at asc limit 1;
    if (v_existing_fingerprint is not null and v_existing_fingerprint<>p_submission_fingerprint)
      or v_existing.project_id is distinct from p_project_id or v_existing.phase_id is distinct from p_phase_id
      or v_existing.full_name<>trim(p_name) or lower(coalesce(v_existing.email,''))<>lower(trim(p_email))
      or coalesce(v_existing.phone,'')<>coalesce(nullif(trim(p_phone),''),'')
      or (v_existing_fingerprint is null and v_existing.parcel_id is distinct from p_parcel_id)
      or v_existing.map_feature_id is distinct from p_map_feature_id then
      return jsonb_build_object('ok',false,'conflict',true);
    end if;
    return jsonb_build_object('ok',true,'deduplicated',true,'lead_id',v_existing.id,
      'follow_up_created',true,'unverified_lot',v_existing_unverified_lot_reference is not null);
  end if;

  insert into public.lead_activities(tenant_id, project_id, phase_id, lead_id, activity_type, title, description, metadata, created_by)
  values (
    p_tenant_id, p_project_id, p_phase_id, v_lead_id, 'note',
    case when nullif(trim(p_duplicate_reason),'') is null then 'Public information request received'
      else 'Public information request received - possible duplicate' end,
    v_notes,
    jsonb_build_object('source','public_inquiry','interests',coalesce(p_interests,'[]'::jsonb),
      'specific_map_feature_id',p_map_feature_id,'specific_parcel_id',p_parcel_id,'page_url',p_page_url,
      'submission_fingerprint',p_submission_fingerprint,'unverified_lot_reference',v_unverified_lot_reference,
      'possible_duplicate',nullif(trim(p_duplicate_reason),'') is not null,'duplicate_reason',nullif(trim(p_duplicate_reason),'')),
    null
  );
  insert into public.follow_up_tasks(tenant_id, project_id, phase_id, lead_id, title, description, due_at, status, priority, assigned_to, created_by)
  values (
    p_tenant_id, p_project_id, p_phase_id, v_lead_id,
    case when nullif(trim(p_duplicate_reason),'') is null then 'Follow up on public project information inquiry' else 'Review possible duplicate public inquiry' end,
    case when v_unverified_lot_reference is not null
      then 'Contact the buyer and follow up with currently available options; the submitted lot reference is unverified.'
      when v_waitlist then 'Contact the buyer about their waitlist request; do not promise current availability.'
      else 'Contact the buyer about their public project information request and answer their questions.' end,
    v_due_at, 'open', case when nullif(trim(p_duplicate_reason),'') is null then 'normal' else 'high' end, null, null
  );
  return jsonb_build_object('ok',true,'deduplicated',false,'lead_id',v_lead_id,
    'follow_up_created',true,'waitlist',v_waitlist,'unverified_lot',v_unverified_lot_reference is not null);
end;
$$;

revoke all on function public.create_scoped_public_inquiry(uuid, uuid, uuid, text, text, text, text, text, jsonb, text, text, bigint, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_scoped_public_inquiry(uuid, uuid, uuid, text, text, text, text, text, jsonb, text, text, bigint, uuid, text, text, text)
  to service_role;
comment on function public.create_scoped_public_inquiry(uuid, uuid, uuid, text, text, text, text, text, jsonb, text, text, bigint, uuid, text, text, text) is
  'Service-role-only atomic public inquiry create; records unverified scoped lot requests as general inquiries and deduplicates semantic retries.';

commit;
