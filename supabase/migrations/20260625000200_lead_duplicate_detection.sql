begin;

alter table public.leads
  add column if not exists possible_duplicate boolean not null default false,
  add column if not exists duplicate_reason text,
  add column if not exists duplicate_checked_at timestamptz;

create index if not exists idx_leads_possible_duplicate
  on public.leads(possible_duplicate)
  where possible_duplicate = true;

create or replace function public.normalize_duplicate_email(p_email text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(lower(trim(coalesce(p_email, ''))), '');
$$;

create or replace function public.normalize_duplicate_phone(p_phone text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), '');
$$;

create or replace function public.normalize_duplicate_name(p_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(lower(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'))), '');
$$;

create or replace function public.application_duplicate_reasons(
  p_application_id bigint,
  p_full_name text,
  p_email text,
  p_phone text,
  p_parcel_id bigint
)
returns text[]
language plpgsql
stable
set search_path = public
as $$
declare
  v_reasons text[] := array[]::text[];
  v_email text := public.normalize_duplicate_email(p_email);
  v_phone text := public.normalize_duplicate_phone(p_phone);
  v_name text := public.normalize_duplicate_name(p_full_name);
begin
  if v_email is not null and (
    exists (
      select 1
      from public.applications a
      where a.id <> p_application_id
        and public.normalize_duplicate_email(a.email) = v_email
    )
    or exists (
      select 1
      from public.leads l
      where coalesce(l.application_id, -1) <> p_application_id
        and public.normalize_duplicate_email(l.email) = v_email
    )
  ) then
    v_reasons := array_append(v_reasons, 'Same email found on another lead or application.');
  end if;

  if v_phone is not null and (
    exists (
      select 1
      from public.applications a
      where a.id <> p_application_id
        and public.normalize_duplicate_phone(a.phone) = v_phone
    )
    or exists (
      select 1
      from public.leads l
      where coalesce(l.application_id, -1) <> p_application_id
        and public.normalize_duplicate_phone(l.phone) = v_phone
    )
  ) then
    v_reasons := array_append(v_reasons, 'Same phone found on another lead or application.');
  end if;

  if v_name is not null and p_parcel_id is not null and (
    exists (
      select 1
      from public.applications a
      where a.id <> p_application_id
        and public.normalize_duplicate_name(coalesce(a.applicant_full_name, trim(coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, '')))) = v_name
        and public.application_primary_parcel_id(a) = p_parcel_id
    )
    or exists (
      select 1
      from public.leads l
      where coalesce(l.application_id, -1) <> p_application_id
        and public.normalize_duplicate_name(l.full_name) = v_name
        and l.parcel_id = p_parcel_id
    )
  ) then
    v_reasons := array_append(v_reasons, 'Same applicant name and preferred lot found on another lead or application.');
  end if;

  return v_reasons;
end;
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
  v_duplicate_reasons text[];
  v_duplicate_reason text;
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
  v_duplicate_reasons := public.application_duplicate_reasons(new.id, v_full_name, new.email, new.phone, v_parcel_id);
  v_duplicate_reason := nullif(array_to_string(v_duplicate_reasons, ' '), '');
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
    possible_duplicate,
    duplicate_reason,
    duplicate_checked_at,
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
    coalesce(array_length(v_duplicate_reasons, 1), 0) > 0,
    v_duplicate_reason,
    now(),
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
      case when v_duplicate_reason is not null then 'Lead created from public application - possible duplicate' else 'Lead created from public application' end,
      case
        when v_duplicate_reason is not null then 'Application #' || new.id || ' was added to the sales pipeline and flagged for duplicate review. ' || v_duplicate_reason
        else 'Application #' || new.id || ' was added to the sales pipeline for staff follow-up.'
      end,
      jsonb_build_object(
        'application_id', new.id,
        'source', 'Public Application Form',
        'possible_duplicate', v_duplicate_reason is not null,
        'duplicate_reason', v_duplicate_reason
      ),
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
      case when v_duplicate_reason is not null then 'Review possible duplicate lead' else 'Follow up on public application' end,
      case
        when v_duplicate_reason is not null then 'Review the application and linked lead for possible duplicate records. ' || v_duplicate_reason
        else 'Review the application, confirm buyer readiness, and contact the applicant.'
      end,
      v_due_at,
      'open',
      case when v_duplicate_reason is not null then 'urgent' else 'high' end,
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
        coalesce(v_full_name, 'Application #' || new.id) || ' submitted a public application and was added to the sales pipeline as a lead.'
          || case when v_duplicate_reason is not null then ' Possible duplicate: ' || v_duplicate_reason else '' end,
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

with linked_application_leads as (
  select
    l.id,
    public.application_duplicate_reasons(
      a.id,
      coalesce(a.applicant_full_name, trim(coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, ''))),
      a.email,
      a.phone,
      public.application_primary_parcel_id(a)
    ) as reasons
  from public.leads l
  join public.applications a on a.id = l.application_id
)
update public.leads l
set
  possible_duplicate = coalesce(array_length(lal.reasons, 1), 0) > 0,
  duplicate_reason = nullif(array_to_string(lal.reasons, ' '), ''),
  duplicate_checked_at = now()
from linked_application_leads lal
where l.id = lal.id;

comment on column public.leads.possible_duplicate is
  'Display-only duplicate review flag set when a linked application shares phone, email, or applicant name plus preferred lot with another lead/application.';

comment on column public.leads.duplicate_reason is
  'Display-only explanation for why a lead was flagged as a possible duplicate.';

comment on column public.leads.duplicate_checked_at is
  'Timestamp when lightweight duplicate detection last evaluated this lead.';

comment on function public.application_duplicate_reasons(bigint, text, text, text, bigint) is
  'Returns display-only duplicate review reasons for application-to-lead creation. Does not block inserts or merge records.';

revoke execute on function public.normalize_duplicate_email(text) from public;
revoke execute on function public.normalize_duplicate_phone(text) from public;
revoke execute on function public.normalize_duplicate_name(text) from public;
revoke execute on function public.application_duplicate_reasons(bigint, text, text, text, bigint) from public;

commit;
