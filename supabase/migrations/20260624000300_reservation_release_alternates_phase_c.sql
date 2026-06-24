-- Phase C Reservation Release Alternates: staff-confirmed release of other active buyer holds.

create or replace function public.release_alternate_reservations(
  p_primary_reservation_id uuid,
  p_reservation_ids uuid[],
  p_release_reason text
)
returns table (
  released_reservation_ids uuid[],
  skipped_reservations jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary public.lot_reservations%rowtype;
  v_reservation public.lot_reservations%rowtype;
  v_updated public.lot_reservations%rowtype;
  v_actor record;
  v_reason text;
  v_released uuid[] := array[]::uuid[];
  v_skipped jsonb := '[]'::jsonb;
  v_id uuid;
  v_active_statuses text[] := array[
    'draft',
    'reserved',
    'deposit_pending',
    'deposit_submitted',
    'deposit_confirmed'
  ];
begin
  if not public.can_write_admin_data() then
    raise exception 'Missing permission to release reservations.';
  end if;

  v_reason := nullif(trim(p_release_reason), '');
  if v_reason is null then
    raise exception 'Release reason is required.';
  end if;

  if p_reservation_ids is null or cardinality(p_reservation_ids) = 0 then
    raise exception 'Select at least one reservation to release.';
  end if;

  select *
  into v_primary
  from public.lot_reservations
  where id = p_primary_reservation_id;

  if not found then
    raise exception 'Primary reservation not found.';
  end if;

  if not (
    v_primary.lead_id is not null
    or v_primary.application_id is not null
    or v_primary.customer_id is not null
  ) then
    raise exception 'Primary reservation does not have buyer context for matching alternates.';
  end if;

  if v_primary.status <> all(v_active_statuses) then
    raise exception 'Primary reservation must be active before releasing alternates.';
  end if;

  select full_name, email
  into v_actor
  from public.admin_profiles
  where user_id = auth.uid();

  foreach v_id in array p_reservation_ids loop
    if v_id = p_primary_reservation_id then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'reservation_id', v_id,
        'reason', 'Primary reservation cannot be released by this action.'
      ));
      continue;
    end if;

    select *
    into v_reservation
    from public.lot_reservations
    where id = v_id
    for update;

    if not found then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'reservation_id', v_id,
        'reason', 'Reservation not found.'
      ));
      continue;
    end if;

    if v_reservation.status <> all(v_active_statuses) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'reservation_id', v_id,
        'reason', 'Reservation is already inactive or historical.'
      ));
      continue;
    end if;

    if v_primary.parcel_id is not null and v_reservation.parcel_id = v_primary.parcel_id then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'reservation_id', v_id,
        'reason', 'Reservation is on the same lot as the primary reservation.'
      ));
      continue;
    end if;

    if not (
      (v_primary.lead_id is not null and v_reservation.lead_id = v_primary.lead_id)
      or (v_primary.application_id is not null and v_reservation.application_id = v_primary.application_id)
      or (v_primary.customer_id is not null and v_reservation.customer_id = v_primary.customer_id)
    ) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'reservation_id', v_id,
        'reason', 'Reservation does not share lead, application, or customer context.'
      ));
      continue;
    end if;

    update public.lot_reservations
    set
      status = 'released',
      released_at = now(),
      notes = case
        when coalesce(trim(notes), '') = '' then 'Released: ' || v_reason
        else notes || E'\n\nReleased: ' || v_reason
      end
    where id = v_id
    returning * into v_updated;

    insert into public.reservation_activities (
      reservation_id,
      activity_type,
      title,
      description,
      metadata,
      created_by
    )
    values (
      v_id,
      'reservation_released',
      'Reservation released',
      'Released as an alternate to primary reservation ' || p_primary_reservation_id::text || '. Reason: ' || v_reason,
      jsonb_build_object(
        'primary_reservation_id', p_primary_reservation_id,
        'release_reason', v_reason
      ),
      auth.uid()
    );

    insert into public.audit_events (
      entity_type,
      entity_id,
      action,
      title,
      summary,
      before_data,
      after_data,
      metadata,
      actor_user_id,
      actor_name,
      actor_email
    )
    values (
      'reservation',
      v_id::text,
      'released',
      'Reservation released',
      'Alternate reservation released after buyer confirmed another lot.',
      jsonb_build_object(
        'status', v_reservation.status,
        'deposit_status', v_reservation.deposit_status,
        'released_at', v_reservation.released_at
      ),
      jsonb_build_object(
        'status', v_updated.status,
        'released_at', v_updated.released_at
      ),
      jsonb_build_object(
        'primary_reservation_id', p_primary_reservation_id,
        'release_reason', v_reason,
        'lead_id', v_reservation.lead_id,
        'application_id', v_reservation.application_id,
        'customer_id', v_reservation.customer_id,
        'parcel_id', v_reservation.parcel_id
      ),
      auth.uid(),
      v_actor.full_name,
      v_actor.email
    );

    v_released := array_append(v_released, v_id);
  end loop;

  released_reservation_ids := v_released;
  skipped_reservations := v_skipped;
  return next;
end;
$$;

revoke all on function public.release_alternate_reservations(uuid, uuid[], text) from public;
grant execute on function public.release_alternate_reservations(uuid, uuid[], text) to authenticated;

comment on function public.release_alternate_reservations(uuid, uuid[], text) is 'Staff-confirmed release of alternate active reservations sharing lead/application/customer context with a primary reservation. Writes reservation activity and audit events without mutating parcels, payments, contracts, applications, customers, leads, post-sales records, documents, or AI records.';
