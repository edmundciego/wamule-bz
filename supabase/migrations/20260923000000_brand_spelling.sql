-- Brand spelling: "Wamule" is canonical (domain, repo, tenant record,
-- CANONICAL_COMPANY_NAME, check-brand gate). Some business_settings rows
-- were seeded with the legacy "Wamuale" spelling, which surfaces in the
-- public map header via company_profile.company_name. Replace the legacy
-- spelling wherever present; rows already correct are untouched.
update public.business_settings
set value = replace(value::text, 'Wamuale Development', 'Wamule Development')::jsonb,
    updated_at = now()
where key in ('company_profile', 'public_application')
  and value::text like '%Wamuale Development%';
