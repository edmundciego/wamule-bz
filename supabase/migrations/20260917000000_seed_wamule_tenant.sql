-- Seed first live tenant: Wamule Development (wamule.com).
--
-- The multi-tenant foundation (20260915) backfilled every existing production
-- row to the placeholder tenant 'default-client'
-- ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'). That placeholder IS the live
-- Wamule data, so this migration RENAMES it instead of inserting a second
-- row (a second row would orphan all live lots, customers, and payments).
--
-- - slug: 'wamule' (public tenant identifier for wamule.com)
-- - inbound_alias: left untouched (NULL unless previously set)
-- - gemini_api_key: left untouched (per-tenant override, NULL = master key)
-- - Idempotent: safe to rerun via `supabase db push`.
-- - Apply to staging first, verify, then production (after backup).

begin;

-- Insert on fresh envs, rename on envs that already have the placeholder.
insert into public.organizations (id, name, slug, is_active)
values ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Wamule Development', 'wamule', true)
on conflict (id) do update set
  name = excluded.name,
  slug = excluded.slug,
  is_active = true,
  updated_at = now();

-- Guard: if some other row already claimed slug 'wamule' (manual insert),
-- merge intent is ambiguous -- fail fast instead of violating UNIQUE.
do $$
declare
  v_conflicts integer;
begin
  select count(*) into v_conflicts
  from public.organizations
  where slug = 'wamule'
    and id <> 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid;
  if v_conflicts > 0 then
    raise exception 'Slug wamule is already claimed by another organization row. Resolve manually before retrying.';
  end if;
end;
$$;

comment on table public.organizations is 'Tenants sharing one database with RLS isolation. First live tenant: Wamule Development (wamule).';

commit;
