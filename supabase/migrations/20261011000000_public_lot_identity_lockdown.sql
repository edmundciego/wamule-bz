begin;

-- Public parcel selection now uses the get-public-lots API and the
-- submit-public-application Edge Function. The legacy view contains internal
-- parcel ids and is no longer a public data boundary.
revoke select on table public.public_parcel_options from PUBLIC, anon, authenticated;

-- Public writes must resolve public lot references and derive tenant/status
-- server-side. Staff inserts remain available through their existing policy.
drop policy if exists "Public can submit applications" on public.applications;
revoke insert on table public.applications from anon;

comment on view public.public_parcel_options is
  'Legacy internal view; public anon/authenticated SELECT revoked in favor of get-public-lots public references.';

commit;
