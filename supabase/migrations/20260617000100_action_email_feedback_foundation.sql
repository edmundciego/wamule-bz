-- Daily Brief action tracking, email notification outbox, and developer feedback foundation.

create table if not exists public.brief_action_items (
  id bigint generated always as identity primary key,
  brief_id bigint references public.ai_daily_briefs(id) on delete set null,
  source_type text not null default 'Other',
  source_key text not null,
  title text not null,
  details text not null default '',
  severity text not null default 'Info',
  status text not null default 'Open',
  related_table text,
  related_record_id text,
  first_seen_on date not null default current_date,
  last_seen_on date not null default current_date,
  resolved_at timestamptz,
  dismissed_at timestamptz,
  assigned_to uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint brief_action_items_status_valid check (status in ('Open', 'In Progress', 'Done', 'Dismissed')),
  constraint brief_action_items_severity_valid check (severity in ('Info', 'Amber', 'Red'))
);

create index if not exists idx_brief_action_items_brief_id on public.brief_action_items(brief_id);
create index if not exists idx_brief_action_items_status on public.brief_action_items(status);
create index if not exists idx_brief_action_items_source_key on public.brief_action_items(source_key);
create index if not exists idx_brief_action_items_last_seen_on on public.brief_action_items(last_seen_on desc);
create unique index if not exists uniq_open_brief_action_items_source_key
on public.brief_action_items(source_key)
where status in ('Open', 'In Progress');

create table if not exists public.email_notifications (
  id bigint generated always as identity primary key,
  recipient_email text not null,
  recipient_name text,
  subject text not null,
  body text not null,
  notification_type text not null,
  related_table text,
  related_record_id text,
  status text not null default 'Pending',
  error_message text,
  sent_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_notifications_status_valid check (status in ('Pending', 'Sent', 'Failed', 'Cancelled')),
  constraint email_notifications_type_valid check (
    notification_type in (
      'New Application',
      'Application Confirmation',
      'Payment Request',
      'Payment Received',
      'Balance Statement',
      'Daily Brief',
      'Developer Feedback',
      'Test Email'
    )
  )
);

create index if not exists idx_email_notifications_status on public.email_notifications(status);
create index if not exists idx_email_notifications_created_at on public.email_notifications(created_at desc);
create index if not exists idx_email_notifications_type on public.email_notifications(notification_type);

create table if not exists public.notification_settings (
  id bigint generated always as identity primary key,
  notification_type text not null,
  send_to_admin boolean not null default true,
  send_to_customer boolean not null default false,
  admin_email text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_settings_type_valid check (
    notification_type in (
      'New Application',
      'Application Confirmation',
      'Payment Request',
      'Payment Received',
      'Balance Statement',
      'Daily Brief',
      'Developer Feedback',
      'Test Email'
    )
  )
);

create unique index if not exists uniq_notification_settings_type on public.notification_settings(notification_type);

create table if not exists public.developer_feedback (
  id bigint generated always as identity primary key,
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_by_email text,
  feedback_type text not null,
  priority text not null default 'Normal',
  page_url text,
  message text not null,
  status text not null default 'New',
  developer_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint developer_feedback_type_valid check (feedback_type in ('Bug', 'Question', 'Feature Request', 'Data Issue', 'Other')),
  constraint developer_feedback_priority_valid check (priority in ('Low', 'Normal', 'High', 'Urgent')),
  constraint developer_feedback_status_valid check (status in ('New', 'Reviewing', 'Resolved', 'Closed'))
);

create index if not exists idx_developer_feedback_status on public.developer_feedback(status);
create index if not exists idx_developer_feedback_created_at on public.developer_feedback(created_at desc);
create index if not exists idx_developer_feedback_submitted_by on public.developer_feedback(submitted_by);

drop trigger if exists trg_brief_action_items_updated_at on public.brief_action_items;
create trigger trg_brief_action_items_updated_at
before update on public.brief_action_items
for each row execute function public.set_updated_at();

drop trigger if exists trg_email_notifications_updated_at on public.email_notifications;
create trigger trg_email_notifications_updated_at
before update on public.email_notifications
for each row execute function public.set_updated_at();

drop trigger if exists trg_notification_settings_updated_at on public.notification_settings;
create trigger trg_notification_settings_updated_at
before update on public.notification_settings
for each row execute function public.set_updated_at();

drop trigger if exists trg_developer_feedback_updated_at on public.developer_feedback;
create trigger trg_developer_feedback_updated_at
before update on public.developer_feedback
for each row execute function public.set_updated_at();

insert into public.notification_settings (notification_type, send_to_admin, send_to_customer, admin_email, is_active)
values
  ('Developer Feedback', true, false, null, true),
  ('Daily Brief', true, false, null, true),
  ('Test Email', true, false, null, true)
on conflict (notification_type) do nothing;

alter table public.brief_action_items enable row level security;
alter table public.email_notifications enable row level security;
alter table public.notification_settings enable row level security;
alter table public.developer_feedback enable row level security;

drop policy if exists "Internal can read brief action items" on public.brief_action_items;
create policy "Internal can read brief action items"
on public.brief_action_items
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Admins can create brief action items" on public.brief_action_items;
create policy "Admins can create brief action items"
on public.brief_action_items
for insert
to authenticated
with check (public.is_admin_user());

drop policy if exists "Admins can update brief action items" on public.brief_action_items;
create policy "Admins can update brief action items"
on public.brief_action_items
for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

drop policy if exists "Admins can read email notifications" on public.email_notifications;
create policy "Admins can read email notifications"
on public.email_notifications
for select
to authenticated
using (public.is_admin_user());

drop policy if exists "Admins can create email notifications" on public.email_notifications;
create policy "Admins can create email notifications"
on public.email_notifications
for insert
to authenticated
with check (public.is_admin_user());

drop policy if exists "Admins can update email notifications" on public.email_notifications;
create policy "Admins can update email notifications"
on public.email_notifications
for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

drop policy if exists "Admins can read notification settings" on public.notification_settings;
create policy "Admins can read notification settings"
on public.notification_settings
for select
to authenticated
using (public.is_admin_user());

drop policy if exists "Admins can manage notification settings" on public.notification_settings;
create policy "Admins can manage notification settings"
on public.notification_settings
for all
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

drop policy if exists "Internal can create developer feedback" on public.developer_feedback;
create policy "Internal can create developer feedback"
on public.developer_feedback
for insert
to authenticated
with check (public.is_internal_user() and submitted_by = auth.uid());

drop policy if exists "Internal can read own developer feedback" on public.developer_feedback;
create policy "Internal can read own developer feedback"
on public.developer_feedback
for select
to authenticated
using (public.is_admin_user() or submitted_by = auth.uid());

drop policy if exists "Admins can update developer feedback" on public.developer_feedback;
create policy "Admins can update developer feedback"
on public.developer_feedback
for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

grant select, insert, update on public.brief_action_items to authenticated;
grant select, insert, update on public.email_notifications to authenticated;
grant select, insert, update, delete on public.notification_settings to authenticated;
grant select, insert, update on public.developer_feedback to authenticated;

comment on table public.brief_action_items is 'Manual admin action tracking created from Daily Brief recommendations. Only this table may be updated by the Action Center.';
comment on table public.email_notifications is 'Admin-controlled notification outbox. Emails are sent only through explicit admin action.';
comment on table public.developer_feedback is 'Internal feedback, bug, question, and feature request submissions from Wamule admins.';
