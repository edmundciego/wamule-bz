-- NO-OP: This timestamp previously introduced a destructive Super Admin
-- contact-purge workflow. It was never applied to the Wamule database and is
-- unrelated to the Batch 1 financial-integrity release.
--
-- Keep this documented no-op so chronological migration history is stable for
-- existing checkouts. Do not add purge functions, delete policies, or data
-- cleanup actions here. Financial records must remain immutable; any future
-- maintenance capability requires a separately approved manual process.
do $$
begin
  raise notice 'Skipping retired destructive data-management migration; no database objects created.';
end;
$$;
