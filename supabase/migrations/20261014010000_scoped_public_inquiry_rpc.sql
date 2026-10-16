-- Atomic, server-only public inquiry write for tenant/project/phase scope.
-- The Edge Function resolves the public reference to an active row; this RPC
-- rechecks that the selected parcel/feature still belongs to that exact scope
-- and creates lead + activity + follow-up in one transaction.

begin;

create or replace function public.create_scoped_public_inquiry(
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
  p_parcel_id bigint default null,
  p_map_feature_id uuid default null,
  p_duplicate_reason text default null
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
  v_label text;
  v_status text;
  v_waitlist boolean := false;
  v_notes text;
  v_due_at timestamptz := now() + interval '24 hours';
begin
  if p_tenant_id is null or p_project_id is null or p_phase_id is null
     or nullif(trim(p_name), '') is null or nullif(trim(p_email), '') is null
     or nullif(trim(p_client_reference_id), '') is null then
    raise exception 'Public inquiry scope, contact and idempotency fields are required.';
  end if;
  if p_parcel_id is not null and p_map_feature_id is not null then
    raise exception 'An inquiry cannot reference both an inventory parcel and a demo map feature.';
  end if;
  if not exists (
    select 1 from public.development_phases ph
    join public.projects p on p.id=ph.project_id and p.tenant_id=ph.tenant_id
    join public.organizations o on o.id=p.tenant_id and o.is_active
    where ph.id=p_phase_id and ph.project_id=p_project_id and ph.tenant_id=p_tenant_id and ph.is_active
  ) then raise exception 'Inquiry project/phase scope is invalid or inactive.'; end if;

  if p_map_feature_id is not null then
    select i.tenant_id, i.project_id, i.phase_id, f.demo_label
      into v_scope_tenant, v_scope_project, v_scope_phase, v_label
    from public.map_feature_identities i
    join public.map_features f on f.identity_id=i.id
    join public.map_feature_snapshots s on s.id=f.snapshot_id
    join public.projects p on p.id=i.project_id and p.tenant_id=i.tenant_id and p.map_experience_mode='demo'
    where i.id=p_map_feature_id and s.is_active and f.is_active and f.public_visible
    order by f.created_at desc limit 1;
    if v_scope_tenant is null then raise exception 'Selected demo plot is not part of an active public map.'; end if;
    if v_scope_tenant<>p_tenant_id or v_scope_project<>p_project_id or v_scope_phase<>p_phase_id then
      raise exception 'Selected demo plot does not belong to the requested project/phase.';
    end if;
  elsif p_parcel_id is not null then
    select parcel.tenant_id, parcel.project_id, parcel.phase_id, parcel.lot_number, parcel.status
      into v_scope_tenant, v_scope_project, v_scope_phase, v_label, v_status
    from public.parcels parcel
    join public.projects p on p.id=parcel.project_id and p.tenant_id=parcel.tenant_id
      and p.map_experience_mode='sales'
    where parcel.id=p_parcel_id;
    if v_scope_tenant is null or v_scope_tenant<>p_tenant_id or v_scope_project<>p_project_id or v_scope_phase<>p_phase_id then
      raise exception 'Selected parcel does not belong to the requested project/phase.';
    end if;
    if v_status not in ('Available', 'Reserved') then raise exception 'Selected parcel is no longer available for inquiry.'; end if;
    v_waitlist := v_status='Reserved';
  end if;

  v_notes := concat_ws(E'\n',
    case when p_map_feature_id is not null then 'Specific mapped plot interest: ' || coalesce(v_label, 'Demo plot')
         when p_parcel_id is not null then 'Specific lot interest: Lot ' || coalesce(v_label, '')
         else null end,
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
    if v_existing.full_name<>trim(p_name) or lower(coalesce(v_existing.email,''))<>lower(trim(p_email))
      or coalesce(v_existing.phone,'')<>coalesce(nullif(trim(p_phone),''),'')
      or v_existing.parcel_id is distinct from p_parcel_id
      or v_existing.map_feature_id is distinct from p_map_feature_id then
      return jsonb_build_object('ok',false,'conflict',true);
    end if;
    return jsonb_build_object('ok',true,'deduplicated',true,'lead_id',v_existing.id,'follow_up_created',true);
  end if;

  insert into public.lead_activities(tenant_id, project_id, phase_id, lead_id, activity_type, title, description, metadata, created_by)
  values (
    p_tenant_id, p_project_id, p_phase_id, v_lead_id, 'note',
    case when nullif(trim(p_duplicate_reason),'') is null then 'Public information request received'
      else 'Public information request received - possible duplicate' end,
    v_notes,
    jsonb_build_object('source','public_inquiry','interests',coalesce(p_interests,'[]'::jsonb),
      'specific_map_feature_id',p_map_feature_id,'specific_parcel_id',p_parcel_id,'page_url',p_page_url,
      'possible_duplicate',nullif(trim(p_duplicate_reason),'') is not null,'duplicate_reason',nullif(trim(p_duplicate_reason),'')),
    null
  );
  insert into public.follow_up_tasks(tenant_id, project_id, phase_id, lead_id, title, description, due_at, status, priority, assigned_to, created_by)
  values (
    p_tenant_id, p_project_id, p_phase_id, v_lead_id,
    case when nullif(trim(p_duplicate_reason),'') is null then 'Follow up on public project information inquiry' else 'Review possible duplicate public inquiry' end,
    case when v_waitlist then 'Contact the buyer about their waitlist request; do not promise current availability.'
      else 'Contact the buyer about their public project information request and answer their questions.' end,
    v_due_at, 'open', case when nullif(trim(p_duplicate_reason),'') is null then 'normal' else 'high' end, null, null
  );
  return jsonb_build_object('ok',true,'deduplicated',false,'lead_id',v_lead_id,'follow_up_created',true,'waitlist',v_waitlist);
end;
$$;

revoke all on function public.create_scoped_public_inquiry(uuid, uuid, uuid, text, text, text, text, text, jsonb, text, bigint, uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_scoped_public_inquiry(uuid, uuid, uuid, text, text, text, text, text, jsonb, text, bigint, uuid, text)
  to service_role;
comment on function public.create_scoped_public_inquiry(uuid, uuid, uuid, text, text, text, text, text, jsonb, text, bigint, uuid, text) is
  'Service-role-only atomic public inquiry create; derives trusted project scope from active source records and writes lead/activity/follow-up together.';

commit;
