-- Phase A Audit Foundation: append-only global audit trail.

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id text,
  action text not null,
  title text not null,
  summary text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_name text,
  actor_email text,
  created_at timestamptz not null default now(),
  constraint audit_events_entity_type_valid check (
    entity_type in (
      'lead',
      'application',
      'customer',
      'contract',
      'payment',
      'payment_request',
      'parcel',
      'reservation',
      'post_sales_checklist',
      'post_sales_task',
      'document',
      'ai_summary',
      'settings',
      'user',
      'system'
    )
  ),
  constraint audit_events_action_valid check (
    action in (
      'created',
      'updated',
      'deleted',
      'voided',
      'cancelled',
      'released',
      'status_changed',
      'assignment_changed',
      'generated',
      'uploaded',
      'reviewed',
      'settings_changed'
    )
  ),
  constraint audit_events_title_present check (length(trim(title)) > 0),
  constraint audit_events_entity_id_present check (entity_id is null or length(trim(entity_id)) > 0),
  constraint audit_events_before_data_object check (
    before_data is null or jsonb_typeof(before_data) = 'object'
  ),
  constraint audit_events_after_data_object check (
    after_data is null or jsonb_typeof(after_data) = 'object'
  ),
  constraint audit_events_metadata_object check (
    metadata is null or jsonb_typeof(metadata) = 'object'
  )
);

create index if not exists idx_audit_events_created_at
  on public.audit_events(created_at desc);
create index if not exists idx_audit_events_entity
  on public.audit_events(entity_type, entity_id);
create index if not exists idx_audit_events_action
  on public.audit_events(action);
create index if not exists idx_audit_events_actor_user_id
  on public.audit_events(actor_user_id);

alter table public.audit_events enable row level security;

drop policy if exists "Internal can read audit events" on public.audit_events;
create policy "Internal can read audit events"
on public.audit_events
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create audit events" on public.audit_events;
create policy "Staff can create audit events"
on public.audit_events
for insert
to authenticated
with check (public.can_write_admin_data());

grant select, insert on public.audit_events to authenticated;

comment on table public.audit_events is 'Append-only global audit trail for important staff and system actions. Phase A creates the foundation only and does not automatically log existing workflow changes.';
comment on column public.audit_events.entity_id is 'Text identifier so audit events can reference both UUID and bigint-backed Wamule records without cross-table coupling.';
comment on column public.audit_events.before_data is 'Optional minimal before-state JSON. Do not store secrets or full sensitive documents.';
comment on column public.audit_events.after_data is 'Optional minimal after-state JSON. Do not store secrets or full sensitive documents.';
comment on column public.audit_events.metadata is 'Optional contextual JSON. Do not store secrets or full sensitive documents.';
