begin;

create or replace function public.application_lead_due_at()
returns timestamptz
language sql
set search_path = public
as $$
  select now() + interval '1 day';
$$;

create or replace function public.application_primary_parcel_id(p_application public.applications)
returns bigint
language sql
stable
set search_path = public
as $$
  select coalesce(
    p_application.parcel_id,
    case
      when p_application.preferred_parcel_ids is not null and array_length(p_application.preferred_parcel_ids, 1) > 0
        then p_application.preferred_parcel_ids[1]
      else null
    end
  );
$$;

create or replace function public.create_lead_from_application()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id uuid;
  v_full_name text;
  v_parcel_id bigint;
  v_notes text;
  v_due_at timestamptz;
  v_admin_email text;
begin
  select id
    into v_lead_id
  from public.leads
  where application_id = new.id
  limit 1;

  if v_lead_id is not null then
    return new;
  end if;

  v_full_name := nullif(trim(coalesce(new.applicant_full_name, trim(coalesce(new.first_name, '') || ' ' || coalesce(new.last_name, '')))), '');
  v_parcel_id := public.application_primary_parcel_id(new);
  v_due_at := public.application_lead_due_at();
  v_notes := nullif(
    concat_ws(
      E'\n',
      'Auto-created from public application form.',
      case when new.intended_use is not null then 'Intended use: ' || new.intended_use else null end,
      case when new.intended_use_other is not null then 'Other use: ' || new.intended_use_other else null end,
      case when new.payment_option is not null then 'Payment option: ' || new.payment_option else null end,
      case when new.alternate_lot_preference is not null then 'Alternate lot preference: ' || new.alternate_lot_preference else null end,
      case when new.notes is not null then 'Applicant notes: ' || new.notes else null end
    ),
    ''
  );

  insert into public.leads (
    full_name,
    email,
    phone,
    parcel_id,
    application_id,
    source,
    pipeline_stage,
    buyer_journey_stage,
    preferred_contact_method,
    next_action,
    next_action_due_at,
    notes,
    created_by
  )
  values (
    coalesce(v_full_name, 'Application #' || new.id),
    new.email,
    new.phone,
    v_parcel_id,
    new.id,
    'Public Application Form',
    'application_started',
    'New Application',
    case when new.email is not null then 'Email' else 'Phone' end,
    'Review public application and follow up with applicant',
    v_due_at,
    v_notes,
    auth.uid()
  )
  on conflict do nothing
  returning id into v_lead_id;

  if v_lead_id is null then
    select id
      into v_lead_id
    from public.leads
    where application_id = new.id
    limit 1;
  end if;

  if v_lead_id is not null then
    insert into public.lead_activities (
      lead_id,
      activity_type,
      title,
      description,
      metadata,
      created_by
    )
    values (
      v_lead_id,
      'application_linked',
      'Lead created from public application',
      'Application #' || new.id || ' was added to the sales pipeline for staff follow-up.',
      jsonb_build_object('application_id', new.id, 'source', 'Public Application Form'),
      auth.uid()
    );

    insert into public.follow_up_tasks (
      lead_id,
      application_id,
      title,
      description,
      due_at,
      status,
      priority,
      created_by
    )
    values (
      v_lead_id,
      new.id,
      'Follow up on public application',
      'Review the application, confirm buyer readiness, and contact the applicant.',
      v_due_at,
      'open',
      'high',
      auth.uid()
    )
    on conflict do nothing;

    select ns.admin_email
      into v_admin_email
    from public.notification_settings ns
    where ns.notification_type = 'New Application'
      and ns.send_to_admin = true
      and ns.is_active = true
      and nullif(trim(ns.admin_email), '') is not null
    limit 1;

    if v_admin_email is not null then
      insert into public.email_notifications (
        recipient_email,
        recipient_name,
        subject,
        body,
        notification_type,
        related_table,
        related_record_id,
        status,
        created_by
      )
      values (
        v_admin_email,
        'Wamule Admin',
        'New public application received',
        coalesce(v_full_name, 'Application #' || new.id) || ' submitted a public application and was added to the sales pipeline as a lead.',
        'New Application',
        'applications',
        new.id::text,
        'Pending',
        auth.uid()
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_create_lead_from_application on public.applications;
create trigger trg_create_lead_from_application
after insert on public.applications
for each row execute function public.create_lead_from_application();

with created_leads as (
  insert into public.leads (
    full_name,
    email,
    phone,
    parcel_id,
    application_id,
    source,
    pipeline_stage,
    buyer_journey_stage,
    preferred_contact_method,
    next_action,
    next_action_due_at,
    notes,
    created_by
  )
  select
    coalesce(
      nullif(trim(coalesce(a.applicant_full_name, trim(coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, '')))), ''),
      'Application #' || a.id
    ),
    a.email,
    a.phone,
    public.application_primary_parcel_id(a),
    a.id,
    'Existing Application',
    case
      when a.status = 'Approved' then 'application_started'
      when a.status = 'Declined' then 'lost_inactive'
      else 'application_started'
    end,
    'Backfilled Application',
    case when a.email is not null then 'Email' else 'Phone' end,
    'Review application and follow up with applicant',
    public.application_lead_due_at(),
    nullif(
      concat_ws(
        E'\n',
        'Backfilled from existing application.',
        case when a.intended_use is not null then 'Intended use: ' || a.intended_use else null end,
        case when a.payment_option is not null then 'Payment option: ' || a.payment_option else null end
      ),
      ''
    ),
    null
  from public.applications a
  where not exists (
    select 1
    from public.leads l
    where l.application_id = a.id
  )
  on conflict do nothing
  returning id, application_id
)
insert into public.lead_activities (
  lead_id,
  activity_type,
  title,
  description,
  metadata,
  created_by
)
select
  cl.id,
  'application_linked',
  'Lead backfilled from application',
  'Existing application #' || cl.application_id || ' was added to the sales pipeline for staff follow-up.',
  jsonb_build_object('application_id', cl.application_id, 'source', 'Existing Application'),
  null
from created_leads cl;

insert into public.follow_up_tasks (
  lead_id,
  application_id,
  title,
  description,
  due_at,
  status,
  priority,
  created_by
)
select
  l.id,
  l.application_id,
  'Follow up on application',
  'Review the application, confirm buyer readiness, and contact the applicant.',
  coalesce(l.next_action_due_at, public.application_lead_due_at()),
  'open',
  'high',
  null
from public.leads l
where l.application_id is not null
  and l.pipeline_stage <> 'lost_inactive'
  and not exists (
    select 1
    from public.follow_up_tasks t
    where t.lead_id = l.id
      and t.application_id = l.application_id
      and t.title in ('Follow up on public application', 'Follow up on application')
  );

comment on function public.create_lead_from_application() is
  'Creates a linked sales lead, lead activity, and follow-up task after an application is inserted. Does not approve, reserve, create customers, create contracts, or record payments.';

comment on trigger trg_create_lead_from_application on public.applications is
  'Automatically adds public/internal applications to the sales pipeline as linked leads for staff follow-up.';

commit;
