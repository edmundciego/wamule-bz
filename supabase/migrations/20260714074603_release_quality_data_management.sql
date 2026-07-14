-- Release quality pass: Super Admin-only, server-coordinated contact purge.
-- This deliberately targets test/training/import-error records; routine operations
-- must continue to use the normal close, void, cancel, archive, or anonymize flows.
begin;

create table if not exists public.purge_storage_cleanup_tasks (
  id uuid primary key default gen_random_uuid(),
  purge_reference text not null,
  audit_event_id uuid references public.audit_events(id) on delete set null,
  bucket_id text not null,
  object_path text not null,
  status text not null default 'pending' check (status in ('pending', 'removed', 'failed')),
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (purge_reference, bucket_id, object_path)
);

alter table public.purge_storage_cleanup_tasks enable row level security;
revoke all on table public.purge_storage_cleanup_tasks from anon, authenticated;

create or replace function public.purge_contact_preview(p_root_type text, p_root_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_ids uuid[] := '{}';
  v_application_ids bigint[] := '{}';
  v_customer_ids bigint[] := '{}';
  v_contract_ids bigint[] := '{}';
  v_transaction_ids bigint[] := '{}';
  v_reservation_ids uuid[] := '{}';
  v_checklist_ids uuid[] := '{}';
  v_task_ids uuid[] := '{}';
  v_display_name text;
  v_auth_user_id uuid;
  v_counts jsonb;
begin
  if p_root_type not in ('lead', 'application', 'customer') then
    raise exception 'A lead, application, or customer root record is required.' using errcode = '22023';
  end if;

  if p_root_type = 'lead' then
    select array[id], full_name into v_lead_ids, v_display_name from public.leads where id::text = p_root_id;
  elsif p_root_type = 'application' then
    select array[id], trim(concat_ws(' ', first_name, last_name)) into v_application_ids, v_display_name from public.applications where id::text = p_root_id;
  else
    select array[id], trim(concat_ws(' ', first_name, last_name)), auth_user_id into v_customer_ids, v_display_name, v_auth_user_id from public.customers where id::text = p_root_id;
  end if;

  if coalesce(cardinality(v_lead_ids), 0) + coalesce(cardinality(v_application_ids), 0) + coalesce(cardinality(v_customer_ids), 0) = 0 then
    raise exception 'The selected record no longer exists.' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(distinct id), '{}') into v_application_ids
  from public.applications
  where id = any(v_application_ids)
     or id in (select application_id from public.leads where id = any(v_lead_ids) and application_id is not null)
     or id in (select application_id from public.customers where id = any(v_customer_ids));

  select coalesce(array_agg(distinct id), '{}') into v_customer_ids
  from public.customers
  where id = any(v_customer_ids) or application_id = any(v_application_ids);

  select coalesce(array_agg(distinct id), '{}') into v_lead_ids
  from public.leads
  where id = any(v_lead_ids) or application_id = any(v_application_ids) or customer_id = any(v_customer_ids);

  select coalesce(array_agg(distinct id), '{}') into v_contract_ids from public.contracts where customer_id = any(v_customer_ids);
  select coalesce(array_agg(distinct id), '{}') into v_transaction_ids from public.transactions where customer_id = any(v_customer_ids) or contract_id = any(v_contract_ids);
  select coalesce(array_agg(distinct id), '{}') into v_reservation_ids from public.lot_reservations where lead_id = any(v_lead_ids) or application_id = any(v_application_ids) or customer_id = any(v_customer_ids) or converted_contract_id = any(v_contract_ids);
  select coalesce(array_agg(distinct id), '{}') into v_checklist_ids from public.post_sales_checklists where lead_id = any(v_lead_ids) or application_id = any(v_application_ids) or customer_id = any(v_customer_ids) or contract_id = any(v_contract_ids) or reservation_id = any(v_reservation_ids);
  select coalesce(array_agg(distinct id), '{}') into v_task_ids from public.post_sales_tasks where lead_id = any(v_lead_ids) or application_id = any(v_application_ids) or customer_id = any(v_customer_ids) or contract_id = any(v_contract_ids) or reservation_id = any(v_reservation_ids);

  select jsonb_build_object(
    'leads', cardinality(v_lead_ids),
    'lead_activities', (select count(*) from public.lead_activities where lead_id = any(v_lead_ids)),
    'follow_up_tasks', (select count(*) from public.follow_up_tasks where lead_id = any(v_lead_ids) or application_id = any(v_application_ids) or customer_id = any(v_customer_ids)),
    'site_visits', (select count(*) from public.site_visits where lead_id = any(v_lead_ids) or application_id = any(v_application_ids) or customer_id = any(v_customer_ids)),
    'applications', cardinality(v_application_ids),
    'application_ai_reviews', (select count(*) from public.application_ai_reviews where application_id = any(v_application_ids)),
    'customers', cardinality(v_customer_ids),
    'contracts', cardinality(v_contract_ids),
    'payments', cardinality(v_transaction_ids),
    'payment_documents', (select count(*) from public.payment_documents where customer_id = any(v_customer_ids) or transaction_id = any(v_transaction_ids)),
    'payment_requests', (select count(*) from public.payment_requests where customer_id = any(v_customer_ids) or contract_id = any(v_contract_ids)),
    'reservations', cardinality(v_reservation_ids),
    'reservation_activities', (select count(*) from public.reservation_activities where reservation_id = any(v_reservation_ids)),
    'post_sales_checklists', cardinality(v_checklist_ids),
    'post_sales_tasks', cardinality(v_task_ids),
    'post_sales_activities', (select count(*) from public.post_sales_activities where checklist_id = any(v_checklist_ids) or task_id = any(v_task_ids) or customer_id = any(v_customer_ids) or application_id = any(v_application_ids) or contract_id = any(v_contract_ids)),
    'lead_ai_summaries', (select count(*) from public.lead_ai_summaries where lead_id = any(v_lead_ids)),
    'customer_ai_summaries', (select count(*) from public.customer_ai_summaries where customer_id = any(v_customer_ids)),
    'post_sales_ai_summaries', (select count(*) from public.post_sales_ai_summaries where checklist_id = any(v_checklist_ids) or customer_id = any(v_customer_ids) or application_id = any(v_application_ids) or contract_id = any(v_contract_ids) or lead_id = any(v_lead_ids) or reservation_id = any(v_reservation_ids)),
    'email_notifications', (select count(*) from public.email_notifications where related_record_id = any(array_cat(array_cat(v_lead_ids::text[], v_application_ids::text[]), v_customer_ids::text[]))),
    'audit_events', (select count(*) from public.audit_events where entity_id = any(array_cat(array_cat(array_cat(v_lead_ids::text[], v_application_ids::text[]), v_customer_ids::text[]), array_cat(v_contract_ids::text[], v_transaction_ids::text[]))))
  ) into v_counts;

  if v_auth_user_id is null then
    select auth_user_id into v_auth_user_id from public.customers where id = any(v_customer_ids) and auth_user_id is not null limit 1;
  end if;

  return jsonb_build_object(
    'root_type', p_root_type,
    'root_id', p_root_id,
    'display_name', coalesce(v_display_name, 'Selected record'),
    'counts', v_counts,
    'lead_ids', to_jsonb(v_lead_ids),
    'application_ids', to_jsonb(v_application_ids),
    'customer_ids', to_jsonb(v_customer_ids),
    'contract_ids', to_jsonb(v_contract_ids),
    'transaction_ids', to_jsonb(v_transaction_ids),
    'reservation_ids', to_jsonb(v_reservation_ids),
    'linked_auth_user_id', v_auth_user_id
  );
end;
$$;

create or replace function public.purge_contact_record(
  p_root_type text,
  p_root_id text,
  p_actor_id uuid,
  p_reason text,
  p_remove_linked_auth boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_preview jsonb;
  v_reference text := 'PUR-' || to_char(now() at time zone 'UTC', 'YYYYMMDDHH24MISS') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  v_audit_id uuid;
  v_lead_ids uuid[];
  v_application_ids bigint[];
  v_customer_ids bigint[];
  v_contract_ids bigint[];
  v_transaction_ids bigint[];
  v_reservation_ids uuid[];
  v_checklist_ids uuid[] := '{}';
  v_task_ids uuid[] := '{}';
  v_parcel_ids bigint[] := '{}';
  v_auth_user_id uuid;
  v_actor record;
  v_storage jsonb;
begin
  if nullif(trim(p_reason), '') is null then raise exception 'A purge reason is required.' using errcode = '22023'; end if;
  select * into v_actor from public.admin_profiles where user_id = p_actor_id;
  if not found or v_actor.role <> 'Super Admin' then raise exception 'Only Super Admin users can purge records.' using errcode = '42501'; end if;

  v_preview := public.purge_contact_preview(p_root_type, p_root_id);
  v_lead_ids := array(select jsonb_array_elements_text(v_preview->'lead_ids')::uuid);
  v_application_ids := array(select jsonb_array_elements_text(v_preview->'application_ids')::bigint);
  v_customer_ids := array(select jsonb_array_elements_text(v_preview->'customer_ids')::bigint);
  v_contract_ids := array(select jsonb_array_elements_text(v_preview->'contract_ids')::bigint);
  v_transaction_ids := array(select jsonb_array_elements_text(v_preview->'transaction_ids')::bigint);
  v_reservation_ids := array(select jsonb_array_elements_text(v_preview->'reservation_ids')::uuid);
  v_auth_user_id := nullif(v_preview->>'linked_auth_user_id', '')::uuid;
  select coalesce(array_agg(distinct id), '{}') into v_checklist_ids from public.post_sales_checklists where customer_id = any(v_customer_ids) or application_id = any(v_application_ids) or contract_id = any(v_contract_ids) or lead_id = any(v_lead_ids) or reservation_id = any(v_reservation_ids);
  select coalesce(array_agg(distinct id), '{}') into v_task_ids from public.post_sales_tasks where customer_id = any(v_customer_ids) or application_id = any(v_application_ids) or contract_id = any(v_contract_ids) or lead_id = any(v_lead_ids) or reservation_id = any(v_reservation_ids);

  if p_remove_linked_auth and v_auth_user_id is not null then
    if v_auth_user_id = p_actor_id then raise exception 'You cannot purge your own login account.' using errcode = '42501'; end if;
    if exists (select 1 from public.admin_profiles where user_id = v_auth_user_id and role = 'Super Admin')
       and (select count(*) from public.admin_profiles where role = 'Super Admin') <= 1 then
      raise exception 'The last remaining Super Admin cannot be deleted.' using errcode = '42501';
    end if;
  end if;

  select coalesce(array_agg(distinct parcel_id), '{}') into v_parcel_ids from public.contracts where id = any(v_contract_ids);
  select coalesce(v_parcel_ids || array_agg(distinct parcel_id), v_parcel_ids) into v_parcel_ids from public.lot_reservations where id = any(v_reservation_ids) and parcel_id is not null;

  select coalesce(jsonb_agg(jsonb_build_object('bucket_id', bucket_id, 'object_path', object_path)), '[]'::jsonb) into v_storage
  from (
    select 'contracts'::text bucket_id, signed_contract_file_path object_path from public.contracts where id = any(v_contract_ids) and signed_contract_file_path is not null
    union all select 'receipts', receipt_file_path from public.transactions where id = any(v_transaction_ids) and receipt_file_path is not null
    union all select 'payment-documents', file_path from public.payment_documents where customer_id = any(v_customer_ids) or transaction_id = any(v_transaction_ids)
  ) files;

  delete from public.post_sales_ai_summaries where customer_id = any(v_customer_ids) or application_id = any(v_application_ids) or contract_id = any(v_contract_ids) or lead_id = any(v_lead_ids) or reservation_id = any(v_reservation_ids);
  delete from public.post_sales_activities where customer_id = any(v_customer_ids) or application_id = any(v_application_ids) or contract_id = any(v_contract_ids) or checklist_id in (select id from public.post_sales_checklists where customer_id = any(v_customer_ids) or application_id = any(v_application_ids) or contract_id = any(v_contract_ids) or lead_id = any(v_lead_ids) or reservation_id = any(v_reservation_ids)) or task_id in (select id from public.post_sales_tasks where customer_id = any(v_customer_ids) or application_id = any(v_application_ids) or contract_id = any(v_contract_ids) or lead_id = any(v_lead_ids) or reservation_id = any(v_reservation_ids));
  delete from public.post_sales_tasks where customer_id = any(v_customer_ids) or application_id = any(v_application_ids) or contract_id = any(v_contract_ids) or lead_id = any(v_lead_ids) or reservation_id = any(v_reservation_ids);
  delete from public.post_sales_checklists where customer_id = any(v_customer_ids) or application_id = any(v_application_ids) or contract_id = any(v_contract_ids) or lead_id = any(v_lead_ids) or reservation_id = any(v_reservation_ids);
  delete from public.customer_ai_summaries where customer_id = any(v_customer_ids);
  delete from public.lead_ai_summaries where lead_id = any(v_lead_ids);
  delete from public.application_ai_reviews where application_id = any(v_application_ids);
  delete from public.reservation_activities where reservation_id = any(v_reservation_ids);
  delete from public.lot_reservations where id = any(v_reservation_ids);
  delete from public.payment_documents where customer_id = any(v_customer_ids) or transaction_id = any(v_transaction_ids);
  delete from public.payment_requests where customer_id = any(v_customer_ids) or contract_id = any(v_contract_ids);
  delete from public.receipt_jobs where transaction_id = any(v_transaction_ids);
  delete from public.transactions where id = any(v_transaction_ids);
  delete from public.contracts where id = any(v_contract_ids);
  delete from public.site_visits where lead_id = any(v_lead_ids) or application_id = any(v_application_ids) or customer_id = any(v_customer_ids);
  delete from public.follow_up_tasks where lead_id = any(v_lead_ids) or application_id = any(v_application_ids) or customer_id = any(v_customer_ids);
  delete from public.lead_activities where lead_id = any(v_lead_ids);
  delete from public.brief_action_items where related_record_id = any(array_cat(array_cat(v_lead_ids::text[], v_application_ids::text[]), v_customer_ids::text[]));
  delete from public.email_notifications where related_record_id = any(array_cat(array_cat(v_lead_ids::text[], v_application_ids::text[]), v_customer_ids::text[]));
  delete from public.audit_events
  where entity_id = any(array_cat(array_cat(array_cat(v_lead_ids::text[], v_application_ids::text[]), v_customer_ids::text[]), array_cat(v_contract_ids::text[], v_transaction_ids::text[])))
     or entity_id = any(v_reservation_ids::text[])
     or entity_id = any(v_checklist_ids::text[])
     or entity_id = any(v_task_ids::text[]);
  delete from public.customers where id = any(v_customer_ids);
  delete from public.leads where id = any(v_lead_ids);
  delete from public.applications where id = any(v_application_ids);

  if exists (select 1 from public.leads where id = any(v_lead_ids))
     or exists (select 1 from public.applications where id = any(v_application_ids))
     or exists (select 1 from public.customers where id = any(v_customer_ids))
     or exists (select 1 from public.contracts where id = any(v_contract_ids))
     or exists (select 1 from public.transactions where id = any(v_transaction_ids))
     or exists (select 1 from public.lot_reservations where id = any(v_reservation_ids)) then
    raise exception 'Post-purge verification found connected operational records; transaction rolled back.';
  end if;

  update public.parcels p set status = 'Available', updated_at = now()
  where p.id = any(v_parcel_ids)
    and not exists (select 1 from public.contracts c where c.parcel_id = p.id and c.is_active)
    and not exists (select 1 from public.lot_reservations r where r.parcel_id = p.id and r.status in ('reserved', 'deposit_pending', 'deposit_submitted', 'deposit_confirmed'));

  insert into public.audit_events (entity_type, entity_id, action, title, summary, metadata, actor_user_id, actor_name, actor_email)
  values ('system', p_root_id, 'deleted', 'Purge Test or Incorrect Record completed', 'Permanent removal completed for the selected test or incorrect record.', jsonb_build_object('purge_reference', v_reference, 'root_type', p_root_type, 'counts', v_preview->'counts', 'storage_cleanup', case when jsonb_array_length(v_storage) = 0 then 'not_required' else 'pending' end, 'linked_auth_requested', p_remove_linked_auth, 'reason', left(trim(p_reason), 500)), p_actor_id, v_actor.full_name, v_actor.email)
  returning id into v_audit_id;

  insert into public.purge_storage_cleanup_tasks (purge_reference, audit_event_id, bucket_id, object_path)
  select distinct v_reference, v_audit_id, value->>'bucket_id', value->>'object_path' from jsonb_array_elements(v_storage);

  return jsonb_build_object('purge_reference', v_reference, 'audit_event_id', v_audit_id, 'counts', v_preview->'counts', 'storage_files', v_storage, 'linked_auth_user_id', v_auth_user_id, 'remove_linked_auth', p_remove_linked_auth, 'completed_at', now());
end;
$$;

revoke all on function public.purge_contact_preview(text, text) from public, anon, authenticated;
revoke all on function public.purge_contact_record(text, text, uuid, text, boolean) from public, anon, authenticated;

-- Correct legacy runtime defaults without rewriting archived historical migrations.
update public.business_settings
set value = jsonb_set(value, '{company_name}', '"Wamule Development"'::jsonb), updated_at = now()
where key = 'company_profile' and value->>'company_name' in ('Wamuale Development', 'Wamuale Development Platform', 'Wamule Development Platform');

update public.business_settings
set value = replace(replace(value::text, 'Wamuale Development', 'Wamule Development'), 'Wamuale', 'Wamule')::jsonb, updated_at = now()
where key = 'public_application' and value::text ilike '%wamuale%';

commit;
