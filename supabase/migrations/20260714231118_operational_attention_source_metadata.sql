-- Source-backed operational attention metadata for Daily Brief revalidation.
-- Existing brief action history is preserved; new fields are nullable for legacy rows.

alter table public.brief_action_items
  add column if not exists attention_kind text,
  add column if not exists source_entity_type text,
  add column if not exists source_entity_id text,
  add column if not exists related_entity_id text,
  add column if not exists generated_status text,
  add column if not exists generated_due_at timestamptz,
  add column if not exists generated_source_updated_at timestamptz,
  add column if not exists destination_route text;

create index if not exists idx_brief_action_items_attention_kind
  on public.brief_action_items(attention_kind);

create index if not exists idx_brief_action_items_source_entity
  on public.brief_action_items(source_entity_type, source_entity_id);

comment on column public.brief_action_items.generated_status is
  'Status captured when the Daily Brief item was generated; display must revalidate the live source record.';

comment on column public.brief_action_items.destination_route is
  'Safe internal route to the source record or filtered operational queue.';
