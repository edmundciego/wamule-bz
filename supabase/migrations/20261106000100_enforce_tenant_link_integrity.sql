-- M3.2: enforce tenant-consistent links across sales, payments, inventory and related records.
-- Forward-only: preserve the applied migration ledger. Composite foreign keys make
-- tenant agreement authoritative for direct writes, service-role inserts and RPCs.
-- Nullable references use MATCH SIMPLE (default) with non-null tenant_id; only the
-- relationship column is nulled on parent deletion. Existing project/phase keys stay.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Composite parent keys are redundant with globally unique IDs, but PostgreSQL
-- requires an exact unique key for every tenant-aware foreign key.
CREATE UNIQUE INDEX IF NOT EXISTS customers_id_tenant_scope_uq
  ON public.customers (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS contracts_id_tenant_scope_uq
  ON public.contracts (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS contracts_id_tenant_customer_scope_uq
  ON public.contracts (id, tenant_id, customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS contracts_id_tenant_parcel_scope_uq
  ON public.contracts (id, tenant_id, parcel_id);
CREATE UNIQUE INDEX IF NOT EXISTS contracts_id_tenant_customer_parcel_scope_uq
  ON public.contracts (id, tenant_id, customer_id, parcel_id);
CREATE UNIQUE INDEX IF NOT EXISTS parcels_id_tenant_scope_uq
  ON public.parcels (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_id_tenant_scope_uq
  ON public.transactions (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_id_tenant_customer_scope_uq
  ON public.transactions (id, tenant_id, customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS lot_reservations_id_tenant_scope_uq
  ON public.lot_reservations (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS leads_id_tenant_scope_uq
  ON public.leads (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS masterplan_versions_id_tenant_scope_uq
  ON public.masterplan_versions (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS lot_sizes_id_tenant_scope_uq
  ON public.lot_sizes (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS post_sales_checklists_id_tenant_scope_uq
  ON public.post_sales_checklists (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS post_sales_tasks_id_tenant_scope_uq
  ON public.post_sales_tasks (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS information_requests_id_tenant_scope_uq
  ON public.information_requests (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS follow_up_tasks_id_tenant_scope_uq
  ON public.follow_up_tasks (id, tenant_id);

-- applications_id_tenant_scope_unique and information_topics_id_tenant_unique
-- already provide their required (id, tenant_id) parent keys.

ALTER TABLE public.application_ai_reviews DROP CONSTRAINT IF EXISTS application_ai_reviews_application_id_fkey;
ALTER TABLE public.application_ai_reviews ADD CONSTRAINT application_ai_reviews_application_id_fkey
  FOREIGN KEY (application_id, tenant_id)
  REFERENCES public.applications (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE public.applications DROP CONSTRAINT IF EXISTS applications_parcel_id_fkey;
ALTER TABLE public.applications ADD CONSTRAINT applications_parcel_id_fkey
  FOREIGN KEY (parcel_id, tenant_id)
  REFERENCES public.parcels (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE public.contract_void_resolutions DROP CONSTRAINT IF EXISTS contract_void_resolutions_contract_id_fkey;
ALTER TABLE public.contract_void_resolutions ADD CONSTRAINT contract_void_resolutions_contract_id_fkey
  FOREIGN KEY (contract_id, tenant_id)
  REFERENCES public.contracts (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE public.contract_void_resolutions DROP CONSTRAINT IF EXISTS contract_void_resolutions_customer_id_fkey;
ALTER TABLE public.contract_void_resolutions ADD CONSTRAINT contract_void_resolutions_customer_id_fkey
  FOREIGN KEY (customer_id, tenant_id)
  REFERENCES public.customers (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE public.contract_void_resolutions DROP CONSTRAINT IF EXISTS contract_void_resolutions_parcel_id_fkey;
ALTER TABLE public.contract_void_resolutions ADD CONSTRAINT contract_void_resolutions_parcel_id_fkey
  FOREIGN KEY (parcel_id, tenant_id)
  REFERENCES public.parcels (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE public.contract_void_resolutions DROP CONSTRAINT IF EXISTS contract_void_resolutions_reservation_id_fkey;
ALTER TABLE public.contract_void_resolutions ADD CONSTRAINT contract_void_resolutions_reservation_id_fkey
  FOREIGN KEY (reservation_id, tenant_id)
  REFERENCES public.lot_reservations (id, tenant_id) ON DELETE SET NULL (reservation_id);

ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_customer_id_fkey;
ALTER TABLE public.contracts ADD CONSTRAINT contracts_customer_id_fkey
  FOREIGN KEY (customer_id, tenant_id)
  REFERENCES public.customers (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_parcel_id_fkey;
ALTER TABLE public.contracts ADD CONSTRAINT contracts_parcel_id_fkey
  FOREIGN KEY (parcel_id, tenant_id)
  REFERENCES public.parcels (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE public.customer_ai_summaries DROP CONSTRAINT IF EXISTS customer_ai_summaries_customer_id_fkey;
ALTER TABLE public.customer_ai_summaries ADD CONSTRAINT customer_ai_summaries_customer_id_fkey
  FOREIGN KEY (customer_id, tenant_id)
  REFERENCES public.customers (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_application_id_fkey;
ALTER TABLE public.customers ADD CONSTRAINT customers_application_id_fkey
  FOREIGN KEY (application_id, tenant_id)
  REFERENCES public.applications (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE public.follow_up_tasks DROP CONSTRAINT IF EXISTS follow_up_tasks_application_id_fkey;
ALTER TABLE public.follow_up_tasks ADD CONSTRAINT follow_up_tasks_application_id_fkey
  FOREIGN KEY (application_id, tenant_id)
  REFERENCES public.applications (id, tenant_id) ON DELETE SET NULL (application_id);

ALTER TABLE public.follow_up_tasks DROP CONSTRAINT IF EXISTS follow_up_tasks_customer_id_fkey;
ALTER TABLE public.follow_up_tasks ADD CONSTRAINT follow_up_tasks_customer_id_fkey
  FOREIGN KEY (customer_id, tenant_id)
  REFERENCES public.customers (id, tenant_id) ON DELETE SET NULL (customer_id);

ALTER TABLE public.follow_up_tasks DROP CONSTRAINT IF EXISTS follow_up_tasks_lead_id_fkey;
ALTER TABLE public.follow_up_tasks ADD CONSTRAINT follow_up_tasks_lead_id_fkey
  FOREIGN KEY (lead_id, tenant_id)
  REFERENCES public.leads (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE public.information_packs DROP CONSTRAINT IF EXISTS information_packs_request_id_fkey;
ALTER TABLE public.information_packs ADD CONSTRAINT information_packs_request_id_fkey
  FOREIGN KEY (request_id, tenant_id)
  REFERENCES public.information_requests (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE public.information_request_topics DROP CONSTRAINT IF EXISTS information_request_topics_request_id_fkey;
ALTER TABLE public.information_request_topics ADD CONSTRAINT information_request_topics_request_id_fkey
  FOREIGN KEY (request_id, tenant_id)
  REFERENCES public.information_requests (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE public.information_request_topics DROP CONSTRAINT IF EXISTS information_request_topics_topic_id_fkey;
ALTER TABLE public.information_request_topics ADD CONSTRAINT information_request_topics_topic_id_fkey
  FOREIGN KEY (topic_id, tenant_id)
  REFERENCES public.information_topics (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE public.information_requests DROP CONSTRAINT IF EXISTS information_requests_follow_up_task_id_fkey;
ALTER TABLE public.information_requests ADD CONSTRAINT information_requests_follow_up_task_id_fkey
  FOREIGN KEY (follow_up_task_id, tenant_id)
  REFERENCES public.follow_up_tasks (id, tenant_id) ON DELETE SET NULL (follow_up_task_id);

ALTER TABLE public.information_requests DROP CONSTRAINT IF EXISTS information_requests_lead_id_fkey;
ALTER TABLE public.information_requests ADD CONSTRAINT information_requests_lead_id_fkey
  FOREIGN KEY (lead_id, tenant_id)
  REFERENCES public.leads (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE public.information_requests DROP CONSTRAINT IF EXISTS information_requests_parcel_id_fkey;
ALTER TABLE public.information_requests ADD CONSTRAINT information_requests_parcel_id_fkey
  FOREIGN KEY (parcel_id, tenant_id)
  REFERENCES public.parcels (id, tenant_id) ON DELETE SET NULL (parcel_id);

ALTER TABLE public.lead_activities DROP CONSTRAINT IF EXISTS lead_activities_lead_id_fkey;
ALTER TABLE public.lead_activities ADD CONSTRAINT lead_activities_lead_id_fkey
  FOREIGN KEY (lead_id, tenant_id)
  REFERENCES public.leads (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE public.lead_ai_summaries DROP CONSTRAINT IF EXISTS lead_ai_summaries_lead_id_fkey;
ALTER TABLE public.lead_ai_summaries ADD CONSTRAINT lead_ai_summaries_lead_id_fkey
  FOREIGN KEY (lead_id, tenant_id)
  REFERENCES public.leads (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_application_id_fkey;
ALTER TABLE public.leads ADD CONSTRAINT leads_application_id_fkey
  FOREIGN KEY (application_id, tenant_id)
  REFERENCES public.applications (id, tenant_id) ON DELETE SET NULL (application_id);

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_customer_id_fkey;
ALTER TABLE public.leads ADD CONSTRAINT leads_customer_id_fkey
  FOREIGN KEY (customer_id, tenant_id)
  REFERENCES public.customers (id, tenant_id) ON DELETE SET NULL (customer_id);

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_parcel_id_fkey;
ALTER TABLE public.leads ADD CONSTRAINT leads_parcel_id_fkey
  FOREIGN KEY (parcel_id, tenant_id)
  REFERENCES public.parcels (id, tenant_id) ON DELETE SET NULL (parcel_id);

ALTER TABLE public.lot_reservations DROP CONSTRAINT IF EXISTS lot_reservations_application_id_fkey;
ALTER TABLE public.lot_reservations ADD CONSTRAINT lot_reservations_application_id_fkey
  FOREIGN KEY (application_id, tenant_id)
  REFERENCES public.applications (id, tenant_id) ON DELETE SET NULL (application_id);

ALTER TABLE public.lot_reservations DROP CONSTRAINT IF EXISTS lot_reservations_converted_application_id_fkey;
ALTER TABLE public.lot_reservations ADD CONSTRAINT lot_reservations_converted_application_id_fkey
  FOREIGN KEY (converted_application_id, tenant_id)
  REFERENCES public.applications (id, tenant_id) ON DELETE SET NULL (converted_application_id);

ALTER TABLE public.lot_reservations DROP CONSTRAINT IF EXISTS lot_reservations_converted_contract_id_fkey;
ALTER TABLE public.lot_reservations ADD CONSTRAINT lot_reservations_converted_contract_id_fkey
  FOREIGN KEY (converted_contract_id, tenant_id)
  REFERENCES public.contracts (id, tenant_id) ON DELETE SET NULL (converted_contract_id);

ALTER TABLE public.lot_reservations DROP CONSTRAINT IF EXISTS lot_reservations_customer_id_fkey;
ALTER TABLE public.lot_reservations ADD CONSTRAINT lot_reservations_customer_id_fkey
  FOREIGN KEY (customer_id, tenant_id)
  REFERENCES public.customers (id, tenant_id) ON DELETE SET NULL (customer_id);

ALTER TABLE public.lot_reservations DROP CONSTRAINT IF EXISTS lot_reservations_lead_id_fkey;
ALTER TABLE public.lot_reservations ADD CONSTRAINT lot_reservations_lead_id_fkey
  FOREIGN KEY (lead_id, tenant_id)
  REFERENCES public.leads (id, tenant_id) ON DELETE SET NULL (lead_id);

ALTER TABLE public.lot_reservations DROP CONSTRAINT IF EXISTS lot_reservations_parcel_id_fkey;
ALTER TABLE public.lot_reservations ADD CONSTRAINT lot_reservations_parcel_id_fkey
  FOREIGN KEY (parcel_id, tenant_id)
  REFERENCES public.parcels (id, tenant_id) ON DELETE SET NULL (parcel_id);

ALTER TABLE public.lot_reservations DROP CONSTRAINT IF EXISTS lot_reservations_payment_id_fkey;
ALTER TABLE public.lot_reservations ADD CONSTRAINT lot_reservations_payment_id_fkey
  FOREIGN KEY (payment_id, tenant_id)
  REFERENCES public.transactions (id, tenant_id) ON DELETE SET NULL (payment_id);

ALTER TABLE public.parcels DROP CONSTRAINT IF EXISTS fk_parcels_masterplan_version_id;
ALTER TABLE public.parcels ADD CONSTRAINT fk_parcels_masterplan_version_id
  FOREIGN KEY (masterplan_version_id, tenant_id)
  REFERENCES public.masterplan_versions (id, tenant_id) ON DELETE SET NULL (masterplan_version_id);

ALTER TABLE public.parcels DROP CONSTRAINT IF EXISTS parcels_lot_size_id_fkey;
ALTER TABLE public.parcels ADD CONSTRAINT parcels_lot_size_id_fkey
  FOREIGN KEY (lot_size_id, tenant_id)
  REFERENCES public.lot_sizes (id, tenant_id) ON DELETE SET NULL (lot_size_id);

ALTER TABLE public.payment_documents DROP CONSTRAINT IF EXISTS payment_documents_customer_id_fkey;
ALTER TABLE public.payment_documents ADD CONSTRAINT payment_documents_customer_id_fkey
  FOREIGN KEY (customer_id, tenant_id)
  REFERENCES public.customers (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE public.payment_documents DROP CONSTRAINT IF EXISTS payment_documents_transaction_id_fkey;
ALTER TABLE public.payment_documents ADD CONSTRAINT payment_documents_transaction_id_fkey
  FOREIGN KEY (transaction_id, tenant_id, customer_id)
  REFERENCES public.transactions (id, tenant_id, customer_id) ON DELETE SET NULL (transaction_id);

ALTER TABLE public.payment_requests DROP CONSTRAINT IF EXISTS payment_requests_contract_id_fkey;
ALTER TABLE public.payment_requests ADD CONSTRAINT payment_requests_contract_id_fkey
  FOREIGN KEY (contract_id, tenant_id, customer_id)
  REFERENCES public.contracts (id, tenant_id, customer_id) ON DELETE SET NULL (contract_id);

ALTER TABLE public.payment_requests DROP CONSTRAINT IF EXISTS payment_requests_customer_id_fkey;
ALTER TABLE public.payment_requests ADD CONSTRAINT payment_requests_customer_id_fkey
  FOREIGN KEY (customer_id, tenant_id)
  REFERENCES public.customers (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE public.post_sales_activities DROP CONSTRAINT IF EXISTS post_sales_activities_application_id_fkey;
ALTER TABLE public.post_sales_activities ADD CONSTRAINT post_sales_activities_application_id_fkey
  FOREIGN KEY (application_id, tenant_id)
  REFERENCES public.applications (id, tenant_id) ON DELETE SET NULL (application_id);

ALTER TABLE public.post_sales_activities DROP CONSTRAINT IF EXISTS post_sales_activities_checklist_id_fkey;
ALTER TABLE public.post_sales_activities ADD CONSTRAINT post_sales_activities_checklist_id_fkey
  FOREIGN KEY (checklist_id, tenant_id)
  REFERENCES public.post_sales_checklists (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE public.post_sales_activities DROP CONSTRAINT IF EXISTS post_sales_activities_contract_id_fkey;
ALTER TABLE public.post_sales_activities ADD CONSTRAINT post_sales_activities_contract_id_fkey
  FOREIGN KEY (contract_id, tenant_id)
  REFERENCES public.contracts (id, tenant_id) ON DELETE SET NULL (contract_id);

ALTER TABLE public.post_sales_activities DROP CONSTRAINT IF EXISTS post_sales_activities_customer_id_fkey;
ALTER TABLE public.post_sales_activities ADD CONSTRAINT post_sales_activities_customer_id_fkey
  FOREIGN KEY (customer_id, tenant_id)
  REFERENCES public.customers (id, tenant_id) ON DELETE SET NULL (customer_id);

ALTER TABLE public.post_sales_activities DROP CONSTRAINT IF EXISTS post_sales_activities_task_id_fkey;
ALTER TABLE public.post_sales_activities ADD CONSTRAINT post_sales_activities_task_id_fkey
  FOREIGN KEY (task_id, tenant_id)
  REFERENCES public.post_sales_tasks (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE public.post_sales_ai_summaries DROP CONSTRAINT IF EXISTS post_sales_ai_summaries_application_id_fkey;
ALTER TABLE public.post_sales_ai_summaries ADD CONSTRAINT post_sales_ai_summaries_application_id_fkey
  FOREIGN KEY (application_id, tenant_id)
  REFERENCES public.applications (id, tenant_id) ON DELETE SET NULL (application_id);

ALTER TABLE public.post_sales_ai_summaries DROP CONSTRAINT IF EXISTS post_sales_ai_summaries_checklist_id_fkey;
ALTER TABLE public.post_sales_ai_summaries ADD CONSTRAINT post_sales_ai_summaries_checklist_id_fkey
  FOREIGN KEY (checklist_id, tenant_id)
  REFERENCES public.post_sales_checklists (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE public.post_sales_ai_summaries DROP CONSTRAINT IF EXISTS post_sales_ai_summaries_contract_id_fkey;
ALTER TABLE public.post_sales_ai_summaries ADD CONSTRAINT post_sales_ai_summaries_contract_id_fkey
  FOREIGN KEY (contract_id, tenant_id)
  REFERENCES public.contracts (id, tenant_id) ON DELETE SET NULL (contract_id);

ALTER TABLE public.post_sales_ai_summaries DROP CONSTRAINT IF EXISTS post_sales_ai_summaries_customer_id_fkey;
ALTER TABLE public.post_sales_ai_summaries ADD CONSTRAINT post_sales_ai_summaries_customer_id_fkey
  FOREIGN KEY (customer_id, tenant_id)
  REFERENCES public.customers (id, tenant_id) ON DELETE SET NULL (customer_id);

ALTER TABLE public.post_sales_ai_summaries DROP CONSTRAINT IF EXISTS post_sales_ai_summaries_lead_id_fkey;
ALTER TABLE public.post_sales_ai_summaries ADD CONSTRAINT post_sales_ai_summaries_lead_id_fkey
  FOREIGN KEY (lead_id, tenant_id)
  REFERENCES public.leads (id, tenant_id) ON DELETE SET NULL (lead_id);

ALTER TABLE public.post_sales_ai_summaries DROP CONSTRAINT IF EXISTS post_sales_ai_summaries_reservation_id_fkey;
ALTER TABLE public.post_sales_ai_summaries ADD CONSTRAINT post_sales_ai_summaries_reservation_id_fkey
  FOREIGN KEY (reservation_id, tenant_id)
  REFERENCES public.lot_reservations (id, tenant_id) ON DELETE SET NULL (reservation_id);

ALTER TABLE public.post_sales_checklists DROP CONSTRAINT IF EXISTS post_sales_checklists_application_id_fkey;
ALTER TABLE public.post_sales_checklists ADD CONSTRAINT post_sales_checklists_application_id_fkey
  FOREIGN KEY (application_id, tenant_id)
  REFERENCES public.applications (id, tenant_id) ON DELETE SET NULL (application_id);

ALTER TABLE public.post_sales_checklists DROP CONSTRAINT IF EXISTS post_sales_checklists_contract_id_fkey;
ALTER TABLE public.post_sales_checklists ADD CONSTRAINT post_sales_checklists_contract_id_fkey
  FOREIGN KEY (contract_id, tenant_id)
  REFERENCES public.contracts (id, tenant_id) ON DELETE SET NULL (contract_id);

ALTER TABLE public.post_sales_checklists DROP CONSTRAINT IF EXISTS post_sales_checklists_customer_id_fkey;
ALTER TABLE public.post_sales_checklists ADD CONSTRAINT post_sales_checklists_customer_id_fkey
  FOREIGN KEY (customer_id, tenant_id)
  REFERENCES public.customers (id, tenant_id) ON DELETE SET NULL (customer_id);

ALTER TABLE public.post_sales_checklists DROP CONSTRAINT IF EXISTS post_sales_checklists_lead_id_fkey;
ALTER TABLE public.post_sales_checklists ADD CONSTRAINT post_sales_checklists_lead_id_fkey
  FOREIGN KEY (lead_id, tenant_id)
  REFERENCES public.leads (id, tenant_id) ON DELETE SET NULL (lead_id);

ALTER TABLE public.post_sales_checklists DROP CONSTRAINT IF EXISTS post_sales_checklists_reservation_id_fkey;
ALTER TABLE public.post_sales_checklists ADD CONSTRAINT post_sales_checklists_reservation_id_fkey
  FOREIGN KEY (reservation_id, tenant_id)
  REFERENCES public.lot_reservations (id, tenant_id) ON DELETE SET NULL (reservation_id);

ALTER TABLE public.post_sales_tasks DROP CONSTRAINT IF EXISTS post_sales_tasks_application_id_fkey;
ALTER TABLE public.post_sales_tasks ADD CONSTRAINT post_sales_tasks_application_id_fkey
  FOREIGN KEY (application_id, tenant_id)
  REFERENCES public.applications (id, tenant_id) ON DELETE SET NULL (application_id);

ALTER TABLE public.post_sales_tasks DROP CONSTRAINT IF EXISTS post_sales_tasks_contract_id_fkey;
ALTER TABLE public.post_sales_tasks ADD CONSTRAINT post_sales_tasks_contract_id_fkey
  FOREIGN KEY (contract_id, tenant_id)
  REFERENCES public.contracts (id, tenant_id) ON DELETE SET NULL (contract_id);

ALTER TABLE public.post_sales_tasks DROP CONSTRAINT IF EXISTS post_sales_tasks_customer_id_fkey;
ALTER TABLE public.post_sales_tasks ADD CONSTRAINT post_sales_tasks_customer_id_fkey
  FOREIGN KEY (customer_id, tenant_id)
  REFERENCES public.customers (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE public.post_sales_tasks DROP CONSTRAINT IF EXISTS post_sales_tasks_lead_id_fkey;
ALTER TABLE public.post_sales_tasks ADD CONSTRAINT post_sales_tasks_lead_id_fkey
  FOREIGN KEY (lead_id, tenant_id)
  REFERENCES public.leads (id, tenant_id) ON DELETE SET NULL (lead_id);

ALTER TABLE public.post_sales_tasks DROP CONSTRAINT IF EXISTS post_sales_tasks_reservation_id_fkey;
ALTER TABLE public.post_sales_tasks ADD CONSTRAINT post_sales_tasks_reservation_id_fkey
  FOREIGN KEY (reservation_id, tenant_id)
  REFERENCES public.lot_reservations (id, tenant_id) ON DELETE SET NULL (reservation_id);

ALTER TABLE public.receipt_jobs DROP CONSTRAINT IF EXISTS receipt_jobs_transaction_id_fkey;
ALTER TABLE public.receipt_jobs ADD CONSTRAINT receipt_jobs_transaction_id_fkey
  FOREIGN KEY (transaction_id, tenant_id)
  REFERENCES public.transactions (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE public.reservation_activities DROP CONSTRAINT IF EXISTS reservation_activities_reservation_id_fkey;
ALTER TABLE public.reservation_activities ADD CONSTRAINT reservation_activities_reservation_id_fkey
  FOREIGN KEY (reservation_id, tenant_id)
  REFERENCES public.lot_reservations (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE public.site_visits DROP CONSTRAINT IF EXISTS site_visits_application_id_fkey;
ALTER TABLE public.site_visits ADD CONSTRAINT site_visits_application_id_fkey
  FOREIGN KEY (application_id, tenant_id)
  REFERENCES public.applications (id, tenant_id) ON DELETE SET NULL (application_id);

ALTER TABLE public.site_visits DROP CONSTRAINT IF EXISTS site_visits_customer_id_fkey;
ALTER TABLE public.site_visits ADD CONSTRAINT site_visits_customer_id_fkey
  FOREIGN KEY (customer_id, tenant_id)
  REFERENCES public.customers (id, tenant_id) ON DELETE SET NULL (customer_id);

ALTER TABLE public.site_visits DROP CONSTRAINT IF EXISTS site_visits_lead_id_fkey;
ALTER TABLE public.site_visits ADD CONSTRAINT site_visits_lead_id_fkey
  FOREIGN KEY (lead_id, tenant_id)
  REFERENCES public.leads (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE public.site_visits DROP CONSTRAINT IF EXISTS site_visits_parcel_id_fkey;
ALTER TABLE public.site_visits ADD CONSTRAINT site_visits_parcel_id_fkey
  FOREIGN KEY (parcel_id, tenant_id)
  REFERENCES public.parcels (id, tenant_id) ON DELETE SET NULL (parcel_id);

ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_contract_id_fkey;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_contract_id_fkey
  FOREIGN KEY (contract_id, tenant_id, customer_id)
  REFERENCES public.contracts (id, tenant_id, customer_id) ON DELETE RESTRICT;

ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_customer_id_fkey;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_customer_id_fkey
  FOREIGN KEY (customer_id, tenant_id)
  REFERENCES public.customers (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_reversal_of_transaction_id_fkey;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_reversal_of_transaction_id_fkey
  FOREIGN KEY (reversal_of_transaction_id, tenant_id)
  REFERENCES public.transactions (id, tenant_id) ON DELETE RESTRICT;

-- Optional reservation payments always have the tenant check above.
-- These additional keys also require a matching customer/contract context when those
-- optional customer fields are present; MATCH SIMPLE skips only the nullable context.
ALTER TABLE public.lot_reservations
  DROP CONSTRAINT IF EXISTS lot_reservations_payment_customer_fkey;
ALTER TABLE public.lot_reservations
  ADD CONSTRAINT lot_reservations_payment_customer_fkey
  FOREIGN KEY (payment_id, tenant_id, customer_id)
  REFERENCES public.transactions (id, tenant_id, customer_id)
  ON DELETE SET NULL (payment_id);

ALTER TABLE public.lot_reservations
  DROP CONSTRAINT IF EXISTS lot_reservations_converted_contract_customer_fkey;
ALTER TABLE public.lot_reservations
  ADD CONSTRAINT lot_reservations_converted_contract_customer_fkey
  FOREIGN KEY (converted_contract_id, tenant_id, customer_id)
  REFERENCES public.contracts (id, tenant_id, customer_id)
  ON DELETE SET NULL (converted_contract_id);

ALTER TABLE public.lot_reservations
  DROP CONSTRAINT IF EXISTS lot_reservations_converted_contract_parcel_fkey;
ALTER TABLE public.lot_reservations
  ADD CONSTRAINT lot_reservations_converted_contract_parcel_fkey
  FOREIGN KEY (converted_contract_id, tenant_id, parcel_id)
  REFERENCES public.contracts (id, tenant_id, parcel_id)
  ON DELETE SET NULL (converted_contract_id);

-- A void resolution's contract, customer and parcel must describe the same sale.
ALTER TABLE public.contract_void_resolutions
  DROP CONSTRAINT IF EXISTS contract_void_resolutions_contract_context_fkey;
ALTER TABLE public.contract_void_resolutions
  ADD CONSTRAINT contract_void_resolutions_contract_context_fkey
  FOREIGN KEY (contract_id, tenant_id, customer_id, parcel_id)
  REFERENCES public.contracts (id, tenant_id, customer_id, parcel_id)
  ON DELETE RESTRICT;

COMMIT;
