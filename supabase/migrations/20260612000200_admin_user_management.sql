begin;

alter table public.admin_profiles
  add column if not exists email text;

create unique index if not exists uniq_admin_profiles_email
  on public.admin_profiles(lower(email))
  where email is not null;

commit;
