-- Tenant RPC, provider-secret, and private-application-document hardening.
--
-- This follows the reviewed tenant and project/phase migrations. It fails
-- closed on an unreconciled baseline. Do not use migration repair to bypass
-- that preflight; the same SQL must first be rehearsed on an isolated branch.

begin;

do $$
begin
  if to_regclass('public.organizations') is null
     or to_regclass('public.admin_profiles') is null
     or to_regclass('public.applications') is null
     or to_regclass('public.parcels') is null
     or to_regclass('public.customers') is null
     or to_regclass('public.contracts') is null
     or to_regclass('public.transactions') is null
     or to_regclass('public.lot_reservations') is null
     or to_regclass('public.contract_void_resolutions') is null
     or to_regclass('storage.objects') is null then
    raise exception 'Tenant security migration prerequisites are missing; reconcile the schema baseline before applying.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='organizations' and column_name='gemini_api_key'
  ) then
    raise exception 'organizations.gemini_api_key is absent; verify the tenant-secret migration baseline before applying.';
  end if;
  if exists (
    select 1 from public.applications a
    left join public.parcels p on p.id=a.parcel_id
    where a.parcel_id is not null and (p.id is null or p.tenant_id is distinct from a.tenant_id)
  ) then
    raise exception 'Application/parcel tenant references conflict; reconcile these records before applying.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tenant-specific model-provider secrets. Values move directly from the old
-- column into Vault inside this transaction; neither query results nor logs
-- contain the key. If Vault is unavailable, the transaction fails before the
-- plaintext column is removed.
-- ---------------------------------------------------------------------------

create schema if not exists vault;
create extension if not exists supabase_vault with schema vault;
revoke usage on schema vault from public, anon, authenticated;
revoke all on vault.decrypted_secrets from public, anon, authenticated;

create table if not exists public.organization_secret_refs (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  purpose text not null check (purpose in ('gemini_api_key')),
  vault_secret_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, purpose),
  unique (vault_secret_id)
);
alter table public.organization_secret_refs enable row level security;
revoke all on public.organization_secret_refs from public, anon, authenticated, service_role;

do $$
declare
  v_org record;
  v_secret_id uuid;
  v_secret_name text;
begin
  for v_org in
    select id, gemini_api_key
    from public.organizations
    where nullif(trim(gemini_api_key), '') is not null
  loop
    if not exists (
      select 1 from public.organization_secret_refs r
      where r.tenant_id=v_org.id and r.purpose='gemini_api_key'
    ) then
      v_secret_name := 'organization-' || v_org.id::text || '-gemini-api-key';
      v_secret_id := vault.create_secret(
        v_org.gemini_api_key,
        v_secret_name,
        'Server-only Gemini key for one Wamule tenant; migrated without returning plaintext.'
      );
      insert into public.organization_secret_refs(tenant_id, purpose, vault_secret_id)
      values (v_org.id, 'gemini_api_key', v_secret_id);
    end if;
  end loop;
end;
$$;

create or replace function public.get_organization_gemini_api_key(p_tenant_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_secret text;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'This secret lookup is restricted to server-side service credentials.';
  end if;
  select ds.decrypted_secret into v_secret
  from public.organization_secret_refs r
  join vault.decrypted_secrets ds on ds.id=r.vault_secret_id
  where r.tenant_id=p_tenant_id and r.purpose='gemini_api_key'
  limit 1;
  return v_secret;
end;
$$;
revoke all on function public.get_organization_gemini_api_key(uuid) from public, anon, authenticated;
grant execute on function public.get_organization_gemini_api_key(uuid) to service_role;
comment on function public.get_organization_gemini_api_key(uuid) is
  'Server-only tenant Gemini secret lookup. EXECUTE is restricted to service_role; clients receive configuration status only.';

alter table public.organizations drop column gemini_api_key;

-- ---------------------------------------------------------------------------
-- Strong tenant application-document relation. Legacy files are retained but
-- remain inaccessible unless an authoritative application relationship is
-- present; a filename or client-controlled Storage metadata is not proof.
-- ---------------------------------------------------------------------------

create unique index if not exists applications_id_tenant_scope_unique
  on public.applications(id, tenant_id);

create table if not exists public.application_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  application_id bigint not null,
  object_name text generated always as
    (tenant_id::text || '/' || application_id::text || '/' || id::text) stored,
  original_file_name text not null,
  content_type text,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint application_documents_application_tenant_fkey
    foreign key (application_id, tenant_id)
    references public.applications(id, tenant_id) on delete restrict,
  constraint application_documents_file_name_present
    check (length(trim(original_file_name)) > 0),
  constraint application_documents_object_name_unique unique (object_name)
);
create index if not exists idx_application_documents_tenant_application
  on public.application_documents(tenant_id, application_id, created_at desc);
alter table public.application_documents enable row level security;
revoke all on public.application_documents from public, anon;
grant select, insert, update on public.application_documents to authenticated;
revoke delete on public.application_documents from authenticated;

create or replace function public.prevent_application_document_reparenting()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.application_id is distinct from old.application_id then
    raise exception 'An application document cannot be moved to a different identity or application.';
  end if;
  return new;
end;
$$;
revoke all on function public.prevent_application_document_reparenting() from public, anon, authenticated, service_role;
drop trigger if exists prevent_application_document_reparenting on public.application_documents;
create trigger prevent_application_document_reparenting
  before update on public.application_documents
  for each row execute function public.prevent_application_document_reparenting();

create or replace function public.can_read_application_document(p_tenant_id uuid, p_application_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.admin_profiles ap
    join public.applications a on a.tenant_id=p_tenant_id and a.id=p_application_id
    where ap.user_id=auth.uid()
      and ap.role::text in ('Super Admin','Admin','Staff','Read Only')
      and (ap.role::text='Super Admin' or ap.tenant_id=p_tenant_id)
  );
$$;
revoke all on function public.can_read_application_document(uuid, bigint) from public, anon;
grant execute on function public.can_read_application_document(uuid, bigint) to authenticated;

create or replace function public.can_write_application_document(p_tenant_id uuid, p_application_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.admin_profiles ap
    join public.applications a on a.tenant_id=p_tenant_id and a.id=p_application_id
    where ap.user_id=auth.uid()
      and ap.role::text in ('Super Admin','Admin','Staff')
      and (ap.role::text='Super Admin' or ap.tenant_id=p_tenant_id)
  );
$$;
revoke all on function public.can_write_application_document(uuid, bigint) from public, anon;
grant execute on function public.can_write_application_document(uuid, bigint) to authenticated;

drop policy if exists application_documents_tenant_read on public.application_documents;
create policy application_documents_tenant_read on public.application_documents
  for select to authenticated
  using (public.can_read_application_document(tenant_id, application_id));
drop policy if exists application_documents_tenant_insert on public.application_documents;
create policy application_documents_tenant_insert on public.application_documents
  for insert to authenticated
  with check (
    public.can_write_application_document(tenant_id, application_id)
    and (uploaded_by is null or uploaded_by=auth.uid())
  );
drop policy if exists application_documents_tenant_update on public.application_documents;
create policy application_documents_tenant_update on public.application_documents
  for update to authenticated
  using (public.can_write_application_document(tenant_id, application_id))
  with check (
    public.can_write_application_document(tenant_id, application_id)
    and (uploaded_by is null or uploaded_by=auth.uid())
  );
drop policy if exists application_documents_tenant_delete on public.application_documents;

-- Backfill only records already represented by a verified relational source.
-- This product has no legacy application-file path column or application-file
-- metadata table, so old objects are intentionally retained without linkage.
do $$
declare v_unlinked bigint;
begin
  select count(*) into v_unlinked
  from storage.objects o
  where o.bucket_id='application-documents'
    and not exists (select 1 from public.application_documents d where d.object_name=o.name);
  if v_unlinked > 0 then
    raise notice '% existing application document object(s) retained, unlinked, and inaccessible pending verified ownership mapping', v_unlinked;
  end if;
end;
$$;

-- Storage SELECT also governs list/download/signed-URL authorization. The
-- metadata row must exist before upload, and it is the stable owner relation.
drop policy if exists "Wamule private file tenant boundary read" on storage.objects;
create policy "Wamule private file tenant boundary read" on storage.objects
  as restrictive for select to authenticated using (
    storage.objects.bucket_id not in ('contracts','receipts','application-documents','payment-documents')
    or (storage.objects.bucket_id='contracts' and exists (
      select 1 from public.contracts c
      where public.user_has_tenant_access(c.tenant_id) and c.signed_contract_file_path=storage.objects.name
    ))
    or (storage.objects.bucket_id='receipts' and exists (
      select 1 from public.transactions t
      where public.user_has_tenant_access(t.tenant_id)
        and (t.customer_id::text || '/' || t.receipt_number || '.pdf')=storage.objects.name
    ))
    or (storage.objects.bucket_id='payment-documents' and exists (
      select 1 from public.payment_documents d
      where public.user_has_tenant_access(d.tenant_id) and d.file_path=storage.objects.name
    ))
    or (storage.objects.bucket_id='application-documents' and exists (
      select 1 from public.application_documents d
      where d.object_name=storage.objects.name
        and public.can_read_application_document(d.tenant_id,d.application_id)
    ))
  );

drop policy if exists "Wamule private file tenant boundary insert" on storage.objects;
create policy "Wamule private file tenant boundary insert" on storage.objects
  as restrictive for insert to authenticated with check (
    storage.objects.bucket_id not in ('contracts','receipts','application-documents','payment-documents')
    or (storage.objects.bucket_id in ('contracts','payment-documents')
      and public.can_write_admin_data()
      and exists (select 1 from public.customers c
        where public.user_has_tenant_access(c.tenant_id)
          and c.id::text=(storage.foldername(storage.objects.name))[1]))
    or (storage.objects.bucket_id='application-documents' and exists (
      select 1 from public.application_documents d
      where d.object_name=storage.objects.name
        and public.can_write_application_document(d.tenant_id,d.application_id)
    ))
  );

drop policy if exists "Wamule private file tenant boundary update" on storage.objects;
create policy "Wamule private file tenant boundary update" on storage.objects
  as restrictive for update to authenticated using (
    storage.objects.bucket_id not in ('contracts','receipts','application-documents','payment-documents')
    or (storage.objects.bucket_id='contracts' and exists (select 1 from public.contracts c
      where public.user_has_tenant_access(c.tenant_id) and c.signed_contract_file_path=storage.objects.name))
    or (storage.objects.bucket_id='payment-documents' and exists (select 1 from public.payment_documents d
      where public.user_has_tenant_access(d.tenant_id) and d.file_path=storage.objects.name))
    or (storage.objects.bucket_id='application-documents' and exists (
      select 1 from public.application_documents d where d.object_name=storage.objects.name
        and public.can_write_application_document(d.tenant_id,d.application_id)))
  ) with check (
    storage.objects.bucket_id not in ('contracts','receipts','application-documents','payment-documents')
    or (storage.objects.bucket_id in ('contracts','payment-documents') and public.can_write_admin_data()
      and exists (select 1 from public.customers c
        where public.user_has_tenant_access(c.tenant_id)
          and c.id::text=(storage.foldername(storage.objects.name))[1]))
    or (storage.objects.bucket_id='application-documents' and exists (
      select 1 from public.application_documents d where d.object_name=storage.objects.name
        and public.can_write_application_document(d.tenant_id,d.application_id)))
  );

drop policy if exists "Wamule private file tenant boundary delete" on storage.objects;
create policy "Wamule private file tenant boundary delete" on storage.objects
  as restrictive for delete to authenticated using (
    storage.objects.bucket_id not in ('contracts','receipts','application-documents','payment-documents')
    or (storage.objects.bucket_id='contracts' and exists (select 1 from public.contracts c
      where public.user_has_tenant_access(c.tenant_id) and c.signed_contract_file_path=storage.objects.name))
    or (storage.objects.bucket_id='payment-documents' and exists (select 1 from public.payment_documents d
      where public.user_has_tenant_access(d.tenant_id) and d.file_path=storage.objects.name))
    or (storage.objects.bucket_id='application-documents' and exists (
      select 1 from public.application_documents d where d.object_name=storage.objects.name
        and public.can_write_application_document(d.tenant_id,d.application_id)))
  );

drop policy if exists "Tenant staff read linked private files" on storage.objects;
create policy "Tenant staff read linked private files" on storage.objects
  for select to authenticated using (
    (storage.objects.bucket_id='contracts' and exists (select 1 from public.contracts c
      where public.user_has_tenant_access(c.tenant_id) and c.signed_contract_file_path=storage.objects.name))
    or (storage.objects.bucket_id='receipts' and exists (select 1 from public.transactions t
      where public.user_has_tenant_access(t.tenant_id)
        and (t.customer_id::text || '/' || t.receipt_number || '.pdf')=storage.objects.name))
    or (storage.objects.bucket_id='payment-documents' and exists (select 1 from public.payment_documents d
      where public.user_has_tenant_access(d.tenant_id) and d.file_path=storage.objects.name))
    or (storage.objects.bucket_id='application-documents' and exists (
      select 1 from public.application_documents d where d.object_name=storage.objects.name
        and public.can_read_application_document(d.tenant_id,d.application_id)))
  );
drop policy if exists "Tenant staff upload linked private files" on storage.objects;
create policy "Tenant staff upload linked private files" on storage.objects
  for insert to authenticated with check (
    (storage.objects.bucket_id in ('contracts','payment-documents') and public.can_write_admin_data()
      and exists (select 1 from public.customers c where public.user_has_tenant_access(c.tenant_id)
        and c.id::text=(storage.foldername(storage.objects.name))[1]))
    or (storage.objects.bucket_id='application-documents' and exists (
      select 1 from public.application_documents d where d.object_name=storage.objects.name
        and public.can_write_application_document(d.tenant_id,d.application_id)))
  );
drop policy if exists "Tenant admins update linked private files" on storage.objects;
create policy "Tenant admins update linked private files" on storage.objects
  for update to authenticated using (
    (storage.objects.bucket_id='contracts' and public.is_admin_user() and exists (select 1 from public.contracts c
      where public.user_has_tenant_access(c.tenant_id) and c.signed_contract_file_path=storage.objects.name))
    or (storage.objects.bucket_id='payment-documents' and public.is_admin_user() and exists (select 1 from public.payment_documents d
      where public.user_has_tenant_access(d.tenant_id) and d.file_path=storage.objects.name))
    or (storage.objects.bucket_id='application-documents' and exists (
      select 1 from public.application_documents d where d.object_name=storage.objects.name
        and public.can_write_application_document(d.tenant_id,d.application_id)))
  ) with check (
    (storage.objects.bucket_id in ('contracts','payment-documents') and public.is_admin_user()
      and exists (select 1 from public.customers c where public.user_has_tenant_access(c.tenant_id)
        and c.id::text=(storage.foldername(storage.objects.name))[1]))
    or (storage.objects.bucket_id='application-documents' and exists (
      select 1 from public.application_documents d where d.object_name=storage.objects.name
        and public.can_write_application_document(d.tenant_id,d.application_id)))
  );
drop policy if exists "Tenant admins delete linked private files" on storage.objects;
create policy "Tenant admins delete linked private files" on storage.objects
  for delete to authenticated using (
    (storage.objects.bucket_id in ('contracts','payment-documents') and public.is_admin_user()
      and exists (select 1 from public.customers c where public.user_has_tenant_access(c.tenant_id)
        and c.id::text=(storage.foldername(storage.objects.name))[1]))
    or (storage.objects.bucket_id='application-documents' and exists (
      select 1 from public.application_documents d where d.object_name=storage.objects.name
        and public.can_write_application_document(d.tenant_id,d.application_id)))
  );

-- ---------------------------------------------------------------------------
-- Private helper: authorize a role for exactly one tenant. Functions below
-- call it before any mutation and then validate every referenced row's tenant.
-- It is not an RPC surface for browser roles.
-- ---------------------------------------------------------------------------

create or replace function public._assert_tenant_actor(p_tenant_id uuid, p_allowed_roles text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_role text; v_actor_tenant uuid;
begin
  if auth.uid() is null or p_tenant_id is null then
    raise exception 'An authenticated tenant-scoped user is required.';
  end if;
  select ap.role::text, ap.tenant_id into v_role, v_actor_tenant
  from public.admin_profiles ap where ap.user_id=auth.uid();
  if not found or not (v_role = any(p_allowed_roles)) then
    raise exception 'The caller does not have permission for this operation.';
  end if;
  if v_role <> 'Super Admin' and v_actor_tenant is distinct from p_tenant_id then
    raise exception 'The referenced record belongs to another tenant.';
  end if;
end;
$$;
revoke all on function public._assert_tenant_actor(uuid, text[]) from public, anon, authenticated, service_role;

-- Both historical overloads are kept for compatibility. Each verifies both
-- the application and the chosen lot, plus the existing relationships that
-- the operation will retain or replace, before updating either row.
create or replace function public.approve_application(p_application_id bigint, p_parcel_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_application public.applications%rowtype; v_parcel public.parcels%rowtype;
begin
  select * into v_application from public.applications a where a.id=p_application_id for update;
  if not found then raise exception 'Application not found.'; end if;
  perform public._assert_tenant_actor(v_application.tenant_id, array['Admin','Staff','Super Admin']);
  select * into v_parcel from public.parcels p where p.id=p_parcel_id for update;
  if not found then raise exception 'Selected lot does not exist.'; end if;
  if v_parcel.tenant_id is distinct from v_application.tenant_id then
    raise exception 'Selected lot belongs to a different tenant than the application.';
  end if;
  if v_application.parcel_id is not null and not exists (
    select 1 from public.parcels oldp where oldp.id=v_application.parcel_id
      and oldp.tenant_id=v_application.tenant_id
  ) then raise exception 'Existing application lot reference has a tenant mismatch.'; end if;
  if exists (select 1 from public.customers c where c.application_id=v_application.id
      and c.tenant_id is distinct from v_application.tenant_id) then
    raise exception 'Existing customer record for this application belongs to a different tenant.';
  end if;
  if v_parcel.status <> 'Available' then raise exception 'Selected lot is not available.'; end if;

  update public.applications set status='Approved', parcel_id=p_parcel_id, updated_at=now()
  where id=v_application.id;
  insert into public.customers(tenant_id,application_id,first_name,last_name,phone,email,address)
  values (v_application.tenant_id,v_application.id,v_application.first_name,v_application.last_name,
    v_application.phone,v_application.email,v_application.applicant_address)
  on conflict (application_id) do update set
    tenant_id=excluded.tenant_id, first_name=excluded.first_name, last_name=excluded.last_name,
    phone=excluded.phone, email=excluded.email, address=excluded.address, updated_at=now();
  update public.parcels set status='Reserved',updated_at=now() where id=v_parcel.id;
end;
$$;

create or replace function public.approve_application(p_application_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_application public.applications%rowtype; v_parcel public.parcels%rowtype;
begin
  select * into v_application from public.applications a where a.id=p_application_id for update;
  if not found then raise exception 'Application not found.'; end if;
  perform public._assert_tenant_actor(v_application.tenant_id, array['Admin','Staff','Super Admin']);
  if v_application.parcel_id is null then raise exception 'Select a lot before approving this application.'; end if;
  select * into v_parcel from public.parcels p where p.id=v_application.parcel_id for update;
  if not found or v_parcel.tenant_id is distinct from v_application.tenant_id then
    raise exception 'Application lot is missing or belongs to a different tenant.';
  end if;
  if exists (select 1 from public.customers c where c.application_id=v_application.id
      and c.tenant_id is distinct from v_application.tenant_id) then
    raise exception 'Existing customer record for this application belongs to a different tenant.';
  end if;
  if v_parcel.status <> 'Available' then raise exception 'Selected lot is not available.'; end if;

  update public.applications set status='Approved',updated_at=now() where id=v_application.id;
  insert into public.customers(tenant_id,application_id,first_name,last_name,phone,email,address)
  values (v_application.tenant_id,v_application.id,v_application.first_name,v_application.last_name,
    v_application.phone,v_application.email,v_application.applicant_address)
  on conflict (application_id) do update set
    tenant_id=excluded.tenant_id, first_name=excluded.first_name, last_name=excluded.last_name,
    phone=excluded.phone, email=excluded.email, address=excluded.address, updated_at=now();
  update public.parcels set status='Reserved',updated_at=now() where id=v_parcel.id;
end;
$$;

-- Payment void: ensure the transaction, customer, optional contract and every
-- attached document are in the same tenant before changing its immutable state.
create or replace function public.void_payment_record(p_transaction_id bigint,p_reason text)
returns public.transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.transactions%rowtype;
  v_updated public.transactions%rowtype;
  v_actor record;
  v_documents jsonb;
begin
  select * into v_payment from public.transactions t where t.id=p_transaction_id for update;
  if not found then raise exception 'Payment record not found.'; end if;
  perform public._assert_tenant_actor(v_payment.tenant_id,array['Admin','Super Admin']);
  perform 1 from public.customers c where c.id=v_payment.customer_id and c.tenant_id=v_payment.tenant_id for key share;
  if not found then raise exception 'Payment customer is missing or belongs to another tenant.'; end if;
  if v_payment.contract_id is not null then
    perform 1 from public.contracts c where c.id=v_payment.contract_id
      and c.tenant_id=v_payment.tenant_id and c.customer_id=v_payment.customer_id for key share;
    if not found then raise exception 'Payment contract is missing or belongs to another tenant or customer.'; end if;
  end if;
  if exists (select 1 from public.payment_documents d where d.transaction_id=v_payment.id
      and (d.tenant_id is distinct from v_payment.tenant_id
        or not exists(select 1 from public.customers c where c.id=d.customer_id
          and c.tenant_id=v_payment.tenant_id and c.id=v_payment.customer_id))) then
    raise exception 'A linked payment document belongs to a different tenant or customer.';
  end if;
  if coalesce(trim(p_reason),'')='' then raise exception 'A void reason is required.'; end if;
  if v_payment.status <> 'posted' then raise exception 'Only posted payments may be voided.'; end if;

  select full_name,email into v_actor from public.admin_profiles where user_id=auth.uid();
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'document_type',document_type,
    'original_file_name',original_file_name,'file_path',file_path) order by created_at),'[]'::jsonb)
  into v_documents from public.payment_documents where transaction_id=v_payment.id and tenant_id=v_payment.tenant_id;
  perform set_config('app.payment_correction','void_payment_record',true);
  update public.transactions set status='voided',voided_at=now(),voided_by=auth.uid(),
    void_reason=trim(p_reason),correction_notes=coalesce(correction_notes,'')
  where id=v_payment.id returning * into v_updated;
  insert into public.audit_events(tenant_id,entity_type,entity_id,action,title,summary,before_data,after_data,metadata,
    actor_user_id,actor_name,actor_email)
  values(v_payment.tenant_id,'payment',v_payment.id::text,'voided','Payment voided',
    'Payment remains in history and is excluded from current account totals.',to_jsonb(v_payment),to_jsonb(v_updated),
    jsonb_build_object('customer_id',v_payment.customer_id,'contract_id',v_payment.contract_id,
      'amount',v_payment.amount,'collection_method',v_payment.collection_method,
      'transaction_type',v_payment.transaction_type,'created_at',v_payment.created_at,
      'bank_reference',v_payment.bank_reference,'receipt_number',v_payment.receipt_number,
      'manual_receipt_number',v_payment.manual_receipt_number,'documents',v_documents,'reason',trim(p_reason)),
    auth.uid(),v_actor.full_name,v_actor.email);
  return v_updated;
end;
$$;

-- Contract void: the contract's customer/lot and every linked payment must
-- belong to the same tenant before the contract or resolution/audit rows change.
create or replace function public.void_contract(p_contract_id bigint,p_void_reason text)
returns public.contracts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contract public.contracts%rowtype;
  v_updated public.contracts%rowtype;
  v_resolution public.contract_void_resolutions%rowtype;
  v_actor record;
  v_reason text;
  v_payment_count integer;
  v_payment_total numeric(12,2);
begin
  select * into v_contract from public.contracts c where c.id=p_contract_id for update;
  if not found then raise exception 'Contract not found.'; end if;
  perform public._assert_tenant_actor(v_contract.tenant_id,array['Admin','Super Admin']);
  perform 1 from public.customers cu where cu.id=v_contract.customer_id and cu.tenant_id=v_contract.tenant_id for key share;
  if not found then raise exception 'Contract customer is missing or belongs to another tenant.'; end if;
  if v_contract.parcel_id is not null then
    perform 1 from public.parcels p where p.id=v_contract.parcel_id and p.tenant_id=v_contract.tenant_id for key share;
    if not found then raise exception 'Contract lot is missing or belongs to another tenant.'; end if;
  end if;
  if exists (select 1 from public.transactions t where t.contract_id=v_contract.id
      and (t.tenant_id is distinct from v_contract.tenant_id
        or t.customer_id is distinct from v_contract.customer_id
        or not exists(select 1 from public.customers cu where cu.id=t.customer_id and cu.tenant_id=v_contract.tenant_id))) then
    raise exception 'A linked payment or customer has a tenant or contract mismatch.';
  end if;
  v_reason:=nullif(trim(p_void_reason),'');
  if v_reason is null then raise exception 'Void reason is required.'; end if;
  if v_contract.status <> 'active' or v_contract.is_active is not true then
    raise exception 'Only active contracts may be voided.';
  end if;

  select full_name,email into v_actor from public.admin_profiles where user_id=auth.uid();
  select count(*),coalesce(sum(amount),0) into v_payment_count,v_payment_total
  from public.transactions where contract_id=v_contract.id and tenant_id=v_contract.tenant_id and status='posted';
  update public.contracts set status='voided',is_active=false,void_reason=v_reason,
    voided_at=now(),voided_by=auth.uid() where id=v_contract.id returning * into v_updated;
  insert into public.contract_void_resolutions(tenant_id,contract_id,customer_id,parcel_id,status)
  values(v_contract.tenant_id,v_contract.id,v_contract.customer_id,v_contract.parcel_id,'pending')
  returning * into v_resolution;
  insert into public.audit_events(tenant_id,entity_type,entity_id,action,title,summary,before_data,after_data,metadata,
    actor_user_id,actor_name,actor_email)
  values(v_contract.tenant_id,'contract',v_contract.id::text,'voided','Contract voided — resolution required',
    'The contract remains in history. Lot and linked payment review are required before another contract can use the lot.',
    to_jsonb(v_contract),to_jsonb(v_updated),jsonb_build_object('customer_id',v_contract.customer_id,
      'parcel_id',v_contract.parcel_id,'final_purchase_price',v_contract.final_purchase_price,
      'linked_posted_payment_count',v_payment_count,'linked_posted_payment_total',v_payment_total,
      'void_reason',v_reason,'pending_resolution_id',v_resolution.id),
    auth.uid(),v_actor.full_name,v_actor.email);
  return v_updated;
end;
$$;

-- Contract resolution protects all stored links, including an optional
-- reservation, before releasing a lot or changing reservation state.
create or replace function public.resolve_contract_void_resolution(
  p_resolution_id uuid,p_resolution_type text,p_reason text default null,p_reservation_id uuid default null
)
returns public.contract_void_resolutions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_resolution public.contract_void_resolutions%rowtype;
  v_updated public.contract_void_resolutions%rowtype;
  v_previous_status text;
  v_actor record;
begin
  select * into v_resolution from public.contract_void_resolutions r where r.id=p_resolution_id for update;
  if not found then raise exception 'Pending contract void resolution not found.'; end if;
  perform public._assert_tenant_actor(v_resolution.tenant_id,array['Admin','Super Admin']);
  perform 1 from public.contracts c where c.id=v_resolution.contract_id and c.tenant_id=v_resolution.tenant_id for key share;
  if not found then raise exception 'Resolution contract is missing or belongs to another tenant.'; end if;
  if not exists (select 1 from public.contracts c where c.id=v_resolution.contract_id
      and c.tenant_id=v_resolution.tenant_id and c.customer_id=v_resolution.customer_id
      and c.parcel_id=v_resolution.parcel_id) then
    raise exception 'Resolution customer or lot does not match the referenced contract.';
  end if;
  perform 1 from public.customers cu where cu.id=v_resolution.customer_id and cu.tenant_id=v_resolution.tenant_id for key share;
  if not found then raise exception 'Resolution customer is missing or belongs to another tenant.'; end if;
  perform 1 from public.parcels p where p.id=v_resolution.parcel_id and p.tenant_id=v_resolution.tenant_id for update;
  if not found then raise exception 'Resolution lot is missing or belongs to another tenant.'; end if;
  if v_resolution.status <> 'pending' then raise exception 'Pending contract void resolution not found.'; end if;
  if p_resolution_type not in ('release_lot','return_to_reservation','retain_sold') then
    raise exception 'Choose a valid resolution type.';
  end if;
  if p_resolution_type='retain_sold' and coalesce(trim(p_reason),'')='' then
    raise exception 'A reason is required to retain a lot as sold.';
  end if;
  if p_reservation_id is not null then
    perform 1 from public.lot_reservations r
    where r.id=p_reservation_id and r.tenant_id=v_resolution.tenant_id
      and r.parcel_id=v_resolution.parcel_id and r.customer_id=v_resolution.customer_id for key share;
    if not found then raise exception 'The selected reservation is missing or belongs to another tenant, customer, or lot.'; end if;
    if exists (select 1 from public.lot_reservations r where r.id=p_reservation_id and r.tenant_id=v_resolution.tenant_id and (
      (r.lead_id is not null and not exists(select 1 from public.leads l where l.id=r.lead_id and l.tenant_id=r.tenant_id))
      or (r.application_id is not null and not exists(select 1 from public.applications a where a.id=r.application_id and a.tenant_id=r.tenant_id))
      or (r.payment_id is not null and not exists(select 1 from public.transactions t where t.id=r.payment_id and t.tenant_id=r.tenant_id and (r.customer_id is null or t.customer_id=r.customer_id)))
      or (r.converted_application_id is not null and not exists(select 1 from public.applications a where a.id=r.converted_application_id and a.tenant_id=r.tenant_id))
      or (r.converted_contract_id is not null and not exists(select 1 from public.contracts c where c.id=r.converted_contract_id and c.tenant_id=r.tenant_id and (r.customer_id is null or c.customer_id=r.customer_id) and (r.parcel_id is null or c.parcel_id=r.parcel_id)))
    )) then
      raise exception 'The selected reservation has a missing or cross-tenant related record.';
    end if;
  end if;
  if exists (select 1 from public.contracts c where c.parcel_id=v_resolution.parcel_id and c.tenant_id is distinct from v_resolution.tenant_id)
     or exists (select 1 from public.lot_reservations r where r.parcel_id=v_resolution.parcel_id and r.tenant_id is distinct from v_resolution.tenant_id) then
    raise exception 'A related contract or reservation has a tenant mismatch; reconcile it before resolving.';
  end if;

  select status::text into v_previous_status from public.parcels where id=v_resolution.parcel_id;
  select full_name,email into v_actor from public.admin_profiles where user_id=auth.uid();
  if p_resolution_type='release_lot' then
    if exists (select 1 from public.contracts where parcel_id=v_resolution.parcel_id and tenant_id=v_resolution.tenant_id and is_active and status='active')
       or exists (select 1 from public.lot_reservations where parcel_id=v_resolution.parcel_id and tenant_id=v_resolution.tenant_id
          and status in ('reserved','deposit_pending','deposit_submitted','deposit_confirmed')) then
      raise exception 'The lot cannot be released while an active contract or reservation exists.';
    end if;
    update public.parcels set status='Available',updated_at=now() where id=v_resolution.parcel_id;
  elsif p_resolution_type='return_to_reservation' then
    if p_reservation_id is null or not exists (
      select 1 from public.lot_reservations r where r.id=p_reservation_id and r.tenant_id=v_resolution.tenant_id
        and r.parcel_id=v_resolution.parcel_id and r.customer_id=v_resolution.customer_id
        and r.status in ('reserved','deposit_pending','deposit_submitted','deposit_confirmed','expired','cancelled','released')
    ) then raise exception 'A valid historical or active reservation for this customer and lot is required.'; end if;
    if exists (select 1 from public.lot_reservations r where r.parcel_id=v_resolution.parcel_id
        and r.tenant_id=v_resolution.tenant_id and r.id<>p_reservation_id
        and r.status in ('reserved','deposit_pending','deposit_submitted','deposit_confirmed')) then
      raise exception 'Another active reservation already requires this lot.';
    end if;
    update public.lot_reservations set status='reserved',reserved_at=coalesce(reserved_at,now()),released_at=null
      where id=p_reservation_id and tenant_id=v_resolution.tenant_id;
    update public.parcels set status='Reserved',updated_at=now() where id=v_resolution.parcel_id;
  end if;
  update public.contract_void_resolutions set status='resolved',resolution_type=p_resolution_type,
    reservation_id=p_reservation_id,resolution_reason=nullif(trim(p_reason),''),resolved_by=auth.uid(),resolved_at=now()
    where id=v_resolution.id returning * into v_updated;
  insert into public.audit_events(tenant_id,entity_type,entity_id,action,title,summary,before_data,after_data,metadata,
    actor_user_id,actor_name,actor_email)
  values(v_resolution.tenant_id,'parcel',v_resolution.parcel_id::text,'status_changed','Voided contract lot resolution',
    'Resolution completed for a voided contract lot.',
    jsonb_build_object('parcel_status',v_previous_status,'resolution_status','pending'),
    jsonb_build_object('resolution_status','resolved','resolution_type',p_resolution_type),
    jsonb_build_object('contract_id',v_resolution.contract_id,'customer_id',v_resolution.customer_id,
      'reservation_id',p_reservation_id,'reason',nullif(trim(p_reason),'')),
    auth.uid(),v_actor.full_name,v_actor.email);
  return v_updated;
end;
$$;

-- Release all selected alternates only after a preflight proves that every
-- existing requested row and its customer/lead/application/lot references
-- belong to the primary reservation's tenant. A forged cross-tenant ID fails
-- the whole call before the first row is changed.
create or replace function public.release_alternate_reservations(
  p_primary_reservation_id uuid,p_reservation_ids uuid[],p_release_reason text
)
returns table(released_reservation_ids uuid[],skipped_reservations jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_primary public.lot_reservations%rowtype;
  v_reservation public.lot_reservations%rowtype;
  v_updated public.lot_reservations%rowtype;
  v_actor record;
  v_reason text;
  v_released uuid[]:=array[]::uuid[];
  v_skipped jsonb:='[]'::jsonb;
  v_id uuid;
  v_active_statuses text[]:=array['draft','reserved','deposit_pending','deposit_submitted','deposit_confirmed'];
begin
  select * into v_primary from public.lot_reservations r where r.id=p_primary_reservation_id for update;
  if not found then raise exception 'Primary reservation not found.'; end if;
  perform public._assert_tenant_actor(v_primary.tenant_id,array['Admin','Staff','Super Admin']);
  if not (v_primary.lead_id is not null or v_primary.application_id is not null or v_primary.customer_id is not null) then
    raise exception 'Primary reservation does not have buyer context for matching alternates.';
  end if;
  if v_primary.status <> all(v_active_statuses) then raise exception 'Primary reservation must be active before releasing alternates.'; end if;
  if v_primary.customer_id is not null and not exists(select 1 from public.customers c where c.id=v_primary.customer_id and c.tenant_id=v_primary.tenant_id) then
    raise exception 'Primary reservation customer is missing or belongs to another tenant.';
  end if;
  if v_primary.lead_id is not null and not exists(select 1 from public.leads l where l.id=v_primary.lead_id and l.tenant_id=v_primary.tenant_id) then
    raise exception 'Primary reservation lead is missing or belongs to another tenant.';
  end if;
  if v_primary.application_id is not null and not exists(select 1 from public.applications a where a.id=v_primary.application_id and a.tenant_id=v_primary.tenant_id) then
    raise exception 'Primary reservation application is missing or belongs to another tenant.';
  end if;
  if v_primary.parcel_id is not null and not exists(select 1 from public.parcels p where p.id=v_primary.parcel_id and p.tenant_id=v_primary.tenant_id) then
    raise exception 'Primary reservation lot is missing or belongs to another tenant.';
  end if;
  if v_primary.payment_id is not null and not exists(select 1 from public.transactions t
      where t.id=v_primary.payment_id and t.tenant_id=v_primary.tenant_id
        and (v_primary.customer_id is null or t.customer_id=v_primary.customer_id)) then
    raise exception 'Primary reservation payment is missing or does not belong to its tenant/customer.';
  end if;
  if v_primary.converted_application_id is not null and not exists(select 1 from public.applications a
      where a.id=v_primary.converted_application_id and a.tenant_id=v_primary.tenant_id) then
    raise exception 'Primary reservation converted application is missing or belongs to another tenant.';
  end if;
  if v_primary.converted_contract_id is not null and not exists(select 1 from public.contracts c
      where c.id=v_primary.converted_contract_id and c.tenant_id=v_primary.tenant_id
        and (v_primary.customer_id is null or c.customer_id=v_primary.customer_id)
        and (v_primary.parcel_id is null or c.parcel_id=v_primary.parcel_id)) then
    raise exception 'Primary reservation converted contract is missing or belongs to a different tenant/customer/lot.';
  end if;
  v_reason:=nullif(trim(p_release_reason),'');
  if v_reason is null then raise exception 'Release reason is required.'; end if;
  if p_reservation_ids is null or cardinality(p_reservation_ids)=0 then raise exception 'Select at least one reservation to release.'; end if;

  if exists(select 1 from public.lot_reservations r where r.id=any(p_reservation_ids)
      and r.tenant_id is distinct from v_primary.tenant_id) then
    raise exception 'One or more selected reservations belong to another tenant.';
  end if;
  if exists(select 1 from public.lot_reservations r where r.id=any(p_reservation_ids) and r.tenant_id=v_primary.tenant_id and (
      (r.customer_id is not null and not exists(select 1 from public.customers c where c.id=r.customer_id and c.tenant_id=r.tenant_id))
      or (r.lead_id is not null and not exists(select 1 from public.leads l where l.id=r.lead_id and l.tenant_id=r.tenant_id))
      or (r.application_id is not null and not exists(select 1 from public.applications a where a.id=r.application_id and a.tenant_id=r.tenant_id))
      or (r.parcel_id is not null and not exists(select 1 from public.parcels p where p.id=r.parcel_id and p.tenant_id=r.tenant_id))
      or (r.payment_id is not null and not exists(select 1 from public.transactions t where t.id=r.payment_id and t.tenant_id=r.tenant_id and (r.customer_id is null or t.customer_id=r.customer_id)))
      or (r.converted_application_id is not null and not exists(select 1 from public.applications a where a.id=r.converted_application_id and a.tenant_id=r.tenant_id))
      or (r.converted_contract_id is not null and not exists(select 1 from public.contracts c where c.id=r.converted_contract_id and c.tenant_id=r.tenant_id and (r.customer_id is null or c.customer_id=r.customer_id) and (r.parcel_id is null or c.parcel_id=r.parcel_id)))
    )) then raise exception 'A selected reservation has a missing or cross-tenant buyer/lot reference.'; end if;
  select full_name,email into v_actor from public.admin_profiles where user_id=auth.uid();

  foreach v_id in array p_reservation_ids loop
    if v_id=p_primary_reservation_id then
      v_skipped:=v_skipped || jsonb_build_array(jsonb_build_object('reservation_id',v_id,'reason','Primary reservation cannot be released by this action.'));
      continue;
    end if;
    select * into v_reservation from public.lot_reservations r where r.id=v_id and r.tenant_id=v_primary.tenant_id for update;
    if not found then
      v_skipped:=v_skipped || jsonb_build_array(jsonb_build_object('reservation_id',v_id,'reason','Reservation not found.'));
      continue;
    end if;
    if v_reservation.status <> all(v_active_statuses) then
      v_skipped:=v_skipped || jsonb_build_array(jsonb_build_object('reservation_id',v_id,'reason','Reservation is already inactive or historical.'));
      continue;
    end if;
    if v_primary.parcel_id is not null and v_reservation.parcel_id=v_primary.parcel_id then
      v_skipped:=v_skipped || jsonb_build_array(jsonb_build_object('reservation_id',v_id,'reason','Reservation is on the same lot as the primary reservation.'));
      continue;
    end if;
    if not ((v_primary.lead_id is not null and v_reservation.lead_id=v_primary.lead_id)
      or (v_primary.application_id is not null and v_reservation.application_id=v_primary.application_id)
      or (v_primary.customer_id is not null and v_reservation.customer_id=v_primary.customer_id)) then
      v_skipped:=v_skipped || jsonb_build_array(jsonb_build_object('reservation_id',v_id,'reason','Reservation does not share lead, application, or customer context.'));
      continue;
    end if;
    update public.lot_reservations set status='released',released_at=now(),
      notes=case when coalesce(trim(notes),'')='' then 'Released: '||v_reason else notes||E'\n\nReleased: '||v_reason end
      where id=v_id and tenant_id=v_primary.tenant_id returning * into v_updated;
    insert into public.reservation_activities(tenant_id,reservation_id,activity_type,title,description,metadata,created_by)
    values(v_primary.tenant_id,v_id,'reservation_released','Reservation released',
      'Released as an alternate to primary reservation '||p_primary_reservation_id::text||'. Reason: '||v_reason,
      jsonb_build_object('primary_reservation_id',p_primary_reservation_id,'release_reason',v_reason),auth.uid());
    insert into public.audit_events(tenant_id,entity_type,entity_id,action,title,summary,before_data,after_data,metadata,
      actor_user_id,actor_name,actor_email)
    values(v_primary.tenant_id,'reservation',v_id::text,'released','Reservation released',
      'Alternate reservation released after buyer confirmed another lot.',
      jsonb_build_object('status',v_reservation.status,'deposit_status',v_reservation.deposit_status,'released_at',v_reservation.released_at),
      jsonb_build_object('status',v_updated.status,'released_at',v_updated.released_at),
      jsonb_build_object('primary_reservation_id',p_primary_reservation_id,'release_reason',v_reason,
        'lead_id',v_reservation.lead_id,'application_id',v_reservation.application_id,
        'customer_id',v_reservation.customer_id,'parcel_id',v_reservation.parcel_id),
      auth.uid(),v_actor.full_name,v_actor.email);
    v_released:=array_append(v_released,v_id);
  end loop;
  released_reservation_ids:=v_released;
  skipped_reservations:=v_skipped;
  return next;
end;
$$;

revoke all on function public._assert_tenant_actor(uuid,text[]) from public, anon, authenticated, service_role;
revoke all on function public.approve_application(bigint) from public, anon;
revoke all on function public.approve_application(bigint,bigint) from public, anon;
revoke all on function public.void_contract(bigint,text) from public, anon;
revoke all on function public.void_payment_record(bigint,text) from public, anon;
revoke all on function public.resolve_contract_void_resolution(uuid,text,text,uuid) from public, anon;
revoke all on function public.release_alternate_reservations(uuid,uuid[],text) from public, anon;
revoke all on function public.approve_application(bigint) from service_role;
revoke all on function public.approve_application(bigint,bigint) from service_role;
revoke all on function public.void_contract(bigint,text) from service_role;
revoke all on function public.void_payment_record(bigint,text) from service_role;
revoke all on function public.resolve_contract_void_resolution(uuid,text,text,uuid) from service_role;
revoke all on function public.release_alternate_reservations(uuid,uuid[],text) from service_role;
grant execute on function public.approve_application(bigint) to authenticated;
grant execute on function public.approve_application(bigint,bigint) to authenticated;
grant execute on function public.void_contract(bigint,text) to authenticated;
grant execute on function public.void_payment_record(bigint,text) to authenticated;
grant execute on function public.resolve_contract_void_resolution(uuid,text,text,uuid) to authenticated;
grant execute on function public.release_alternate_reservations(uuid,uuid[],text) to authenticated;

commit;
