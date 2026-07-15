-- Information Centre foundation.
-- Adds reusable content topics, lead information requests, versioned pack snapshots,
-- and staff-controlled workflow states. No messages are sent automatically.

create table if not exists public.information_topics (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  default_content text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint information_topics_code_present check (length(trim(code)) > 0),
  constraint information_topics_name_present check (length(trim(name)) > 0),
  constraint information_topics_content_present check (length(trim(default_content)) > 0),
  constraint information_topics_sort_order_valid check (sort_order >= 0)
);

create table if not exists public.information_requests (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete restrict,
  parcel_id bigint references public.parcels(id) on delete set null,
  project_name text not null,
  custom_request text,
  personalized_intro text,
  status text not null default 'requested',
  communication_status text not null default 'action_required',
  assigned_to uuid references public.admin_profiles(user_id) on delete set null,
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  sent_at timestamptz,
  sent_by uuid references auth.users(id) on delete set null,
  sent_channel text,
  follow_up_task_id uuid references public.follow_up_tasks(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint information_requests_project_name_present check (length(trim(project_name)) > 0),
  constraint information_requests_status_valid check (
    status in (
      'requested',
      'draft_generated',
      'ready_for_review',
      'approved',
      'sent',
      'needs_revision',
      'cancelled'
    )
  ),
  constraint information_requests_communication_status_valid check (
    communication_status in (
      'action_required',
      'follow_up_scheduled',
      'waiting_for_customer',
      'customer_responded',
      'long_term_follow_up',
      'closed'
    )
  ),
  constraint information_requests_sent_channel_present check (
    sent_at is null or (sent_channel is not null and length(trim(sent_channel)) > 0)
  )
);

create table if not exists public.information_request_topics (
  request_id uuid not null references public.information_requests(id) on delete cascade,
  topic_id uuid not null references public.information_topics(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (request_id, topic_id)
);

create table if not exists public.information_packs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.information_requests(id) on delete restrict,
  version integer not null,
  document_number text not null unique,
  title text not null,
  status text not null default 'draft',
  introduction text,
  content_snapshot jsonb not null,
  file_path text,
  generated_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  generated_at timestamptz not null default now(),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint information_packs_version_valid check (version > 0),
  constraint information_packs_title_present check (length(trim(title)) > 0),
  constraint information_packs_document_number_present check (length(trim(document_number)) > 0),
  constraint information_packs_status_valid check (status in ('draft', 'approved', 'superseded')),
  constraint information_packs_snapshot_object check (jsonb_typeof(content_snapshot) = 'object'),
  constraint information_packs_request_version_unique unique (request_id, version)
);

create index if not exists idx_information_topics_active_sort
  on public.information_topics(is_active, sort_order, name);
create index if not exists idx_information_requests_lead
  on public.information_requests(lead_id, updated_at desc);
create index if not exists idx_information_requests_status
  on public.information_requests(status, communication_status, updated_at desc);
create index if not exists idx_information_requests_assigned
  on public.information_requests(assigned_to, updated_at desc);
create index if not exists idx_information_packs_request
  on public.information_packs(request_id, version desc);

create or replace function public.touch_information_centre_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists information_topics_touch_updated_at on public.information_topics;
create trigger information_topics_touch_updated_at
before update on public.information_topics
for each row execute function public.touch_information_centre_updated_at();

drop trigger if exists information_requests_touch_updated_at on public.information_requests;
create trigger information_requests_touch_updated_at
before update on public.information_requests
for each row execute function public.touch_information_centre_updated_at();

drop trigger if exists information_packs_touch_updated_at on public.information_packs;
create trigger information_packs_touch_updated_at
before update on public.information_packs
for each row execute function public.touch_information_centre_updated_at();

alter table public.information_topics enable row level security;
alter table public.information_requests enable row level security;
alter table public.information_request_topics enable row level security;
alter table public.information_packs enable row level security;

drop policy if exists "Internal can read information topics" on public.information_topics;
create policy "Internal can read information topics"
on public.information_topics
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Admins can create information topics" on public.information_topics;
create policy "Admins can create information topics"
on public.information_topics
for insert
to authenticated
with check (public.is_admin_user());

drop policy if exists "Admins can update information topics" on public.information_topics;
create policy "Admins can update information topics"
on public.information_topics
for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

drop policy if exists "Internal can read information requests" on public.information_requests;
create policy "Internal can read information requests"
on public.information_requests
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create information requests" on public.information_requests;
create policy "Staff can create information requests"
on public.information_requests
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Staff can update information requests" on public.information_requests;
create policy "Staff can update information requests"
on public.information_requests
for update
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists "Internal can read information request topics" on public.information_request_topics;
create policy "Internal can read information request topics"
on public.information_request_topics
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create information request topics" on public.information_request_topics;
create policy "Staff can create information request topics"
on public.information_request_topics
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Staff can remove information request topics" on public.information_request_topics;
create policy "Staff can remove information request topics"
on public.information_request_topics
for delete
to authenticated
using (public.can_write_admin_data());

drop policy if exists "Internal can read information packs" on public.information_packs;
create policy "Internal can read information packs"
on public.information_packs
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create information packs" on public.information_packs;
create policy "Staff can create information packs"
on public.information_packs
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Staff can update information packs" on public.information_packs;
create policy "Staff can update information packs"
on public.information_packs
for update
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

grant select, insert, update on public.information_topics to authenticated;
grant select, insert, update on public.information_requests to authenticated;
grant select, insert, delete on public.information_request_topics to authenticated;
grant select, insert, update on public.information_packs to authenticated;

insert into public.information_topics (code, name, description, default_content, sort_order)
values
  (
    'project_overview',
    'Project Overview',
    'A plain-language introduction to the development, its location, purpose, and intended community.',
    'This section introduces the development, where it is located, the purpose of the project, and the opportunity available to prospective buyers. Staff must review the approved company and project wording before the pack is sent.',
    10
  ),
  (
    'current_lot_availability',
    'Current Lot Availability',
    'Current availability context with an explicit confirmation requirement before reservation.',
    'Lot availability changes as reservations, applications, and contracts progress. The pack shows the selected lot when one is recorded and provides a current availability snapshot. Availability must be confirmed by staff before a reservation or payment is accepted.',
    20
  ),
  (
    'pricing',
    'Pricing',
    'Current lot pricing or an approved price range with a validity date.',
    'Pricing is based on the selected lot, lot size, and approved company terms. Prices and fees must be reviewed before approval because the generated pack does not reserve a lot or lock a price.',
    30
  ),
  (
    'payment_plans',
    'Payment Plans',
    'Approved deposit, installment, and monthly-payment options.',
    'Available payment plans are included from the active installment-plan settings. A displayed plan is informational until staff confirms the selected lot, final purchase price, deposit, term, and contract terms.',
    40
  ),
  (
    'reservation_process',
    'Reservation Process',
    'How staff record buyer interest, temporary holds, expiry, and deposit readiness.',
    'A reservation records a temporary buyer-interest hold and its expiry or deposit expectations. It does not approve an application, create a contract, or confirm a payment. Staff must confirm the lot and current reservation terms.',
    50
  ),
  (
    'application_process',
    'Application Process',
    'The application steps, required information, and human review boundary.',
    'The buyer submits the required information and acknowledgements for staff review. Submission does not guarantee approval or lot allocation. A staff member reviews completeness, lot context, and the next required action.',
    60
  ),
  (
    'site_visit_information',
    'Site Visit Information',
    'How to arrange a visit and what a viewing appointment does and does not confirm.',
    'A site visit helps the buyer understand the location and available options. A visit does not reserve a lot, approve a buyer, confirm pricing, or record a deposit. Staff should confirm the visit date, location, and assigned representative.',
    70
  ),
  (
    'development_infrastructure',
    'Development and Infrastructure',
    'Approved information about roads, utilities, drainage, phases, and development progress.',
    'This section should contain only approved, current statements about development progress and infrastructure. Planned items must be clearly distinguished from completed items, and staff must remove unsupported promises before approval.',
    80
  ),
  (
    'land_use_information',
    'Land Use Information',
    'Approved land-use expectations, restrictions, and buyer responsibilities.',
    'Land-use information is provided as general project guidance. Buyers should receive the applicable agreement, restrictions, and professional advice before relying on this section for a legal or construction decision.',
    90
  ),
  (
    'frequently_asked_questions',
    'Frequently Asked Questions',
    'Approved answers to recurring buyer questions.',
    'This section answers common questions about availability, pricing, reservations, applications, visits, payments, and next steps. Staff should revise any answer that does not match the current project process.',
    100
  ),
  (
    'custom_information',
    'Custom Information',
    'A staff-reviewed response for a request that does not fit the standard topics.',
    'The custom request and response must be reviewed before approval. Do not include unsupported commitments, private customer information, credentials, full financial evidence, or legal conclusions.',
    110
  )
on conflict (code) do update
set
  name = excluded.name,
  description = excluded.description,
  default_content = excluded.default_content,
  sort_order = excluded.sort_order,
  updated_at = now();

comment on table public.information_topics is 'Reusable, staff-reviewed content topics available for branded prospect information packs.';
comment on table public.information_requests is 'Lead-linked requests for additional information. Generation, approval, sending, and follow-up remain staff-controlled.';
comment on table public.information_packs is 'Versioned branded information-pack snapshots. Draft and approved versions are retained without automatically sending messages.';
comment on column public.information_packs.content_snapshot is 'Point-in-time company, project, lead, lot, pricing, plan, and topic content used to render the generated pack.';
