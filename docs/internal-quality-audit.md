# Internal Quality Audit — Wamuale Development Platform

**Scope:** production-readiness pass focused on responsive containment, shared layout, customer financial truth, AI freshness, and controlled financial corrections.

## Authoritative record hierarchy

1. Current customer record
2. Current active contract (`is_active` and `status = active`)
3. Current reservation
4. Recorded transactions
5. Payment requests
6. Post-sales records
7. AI summaries

Financial cards, statements, and operational status use records 1–6. AI output is advisory only. A customer Smart Summary is marked **Update available** when the customer, contract, transaction, payment request, reservation, or post-sales checklist changed after it was generated. Its stored account-status, balance, and payment claims are then suppressed until regeneration.

## Shared definitions

- **Active contract:** `is_active = true` and `status = active`.
- **Recorded land payments:** transactions whose type is `Down Payment` or `Land Installment`.
- **Remaining land balance:** active contract purchase price minus recorded land payments, never AI text.
- **Next due date:** the shared account due-date helper applied to the active contract.
- **Overdue:** a live next due date before today while a remaining balance exists.
- **Payment removal:** Admin/Super Admin-only controlled removal with a required reason and immutable audit snapshot; it is not a routine correction tool.

## Route inventory and QA matrix

| Route | Access | Source review | Responsive/manual result | Empty & populated state | Fix / remaining concern |
| --- | --- | --- | --- | --- | --- |
| `/` and `/apply` | Public | Reviewed | Requires live 1536–390px pass | Public settings/lot absence handled | Branding waits for Company Profile; verify live public data at all widths. |
| `/login` | Public | Reviewed | Requires live 1536–390px pass | Settings loading/unavailable handled | Branding comes from Company Profile. |
| `/dashboard` | Protected | Route reviewed | Manual viewport verification pending | Query states present | Verify live dashboard insight freshness. |
| `/briefs` | Protected | Route reviewed | Manual viewport verification pending | Loading/error states present | Daily Brief remains advisory; do not rely on generated text for live financial truth. |
| `/emails` | Admin/Super Admin | Reviewed | Manual viewport verification pending | Outbox states present | Test-email copy now uses Company Profile. |
| `/leads` | Protected | Reviewed | Manual viewport verification pending | Detail/list states present | Smart summaries remain advisory. |
| `/lots` | Protected | Route reviewed | Manual viewport verification pending | Query states present | Verify dense list/table at mobile widths. |
| `/applications` | Protected | Route reviewed | Manual viewport verification pending | Query states present | Verify AI review freshness against application updates. |
| `/customers` | Protected | Route reviewed | Manual viewport verification pending | Query states present | Verify no table causes document-level overflow. |
| `/customers/:id` | Protected | Repaired | Source-reviewed; live screenshots still required | Contract/reservation/payment absence handled | Rail flow, stat widths, action hierarchy, wrapping, and stale Smart Summary repaired. |
| `/contracts` and `/contracts/:id` | Protected | Route reviewed | Manual viewport verification pending | Query states present | Verify active-contract definition is shared with Customer Detail. |
| `/payments` | Protected | Repaired | Source-reviewed; live screenshots pending | Ledger empty state should be verified | Controlled payment removal added; migration must be applied. |
| `/collections` | Protected | Route reviewed | Manual viewport verification pending | Query states present | Verify overdue values come from live contract/payment calculations. |
| `/reports` | Protected | Route reviewed | Manual viewport verification pending | Export/list states present | Verify scroll remains inside intentional table wrapper. |
| `/audit-trail` | Protected | Route reviewed | Manual viewport verification pending | Query states present | Confirm payment-removal audit events are visible after migration. |
| `/settings` | Protected; privileged sections vary | Reviewed | Manual viewport verification pending | Query states present | Company Profile invalidates shared brand query immediately after save. |
| `/documents/:kind/:id` | Protected | Reviewed | Manual print/mobile verification pending | Loading/error states present | Document branding waits for Company Profile. |
| `/logout` | Public/session route | Route reviewed | Manual verification pending | N/A | Confirm redirect after session clear. |

## Customer Detail findings and repairs

- **Rail overlap / tabs:** the rail is now a bounded grid column at `xl` and ordinary document flow at all sizes; sticky positioning was removed. It stacks under the main content below `xl`.
- **Narrow statistic cells:** five status cells now appear only at `2xl`; intermediate widths use a two-column layout.
- **Long data:** hero email uses `break-all`; phone/address and cards use shrinkable containers and natural wrapping.
- **Duplicated actions:** the right-rail Record Actions panel was removed. The header cluster remains the single contextual action group.
- **Ledger contradiction:** live ledger and operational summary remain record-based. Stale AI status/balance/payment assertions become **Update available** and are not shown as current.

## Required authenticated manual checks

Use test records only and capture Customer Detail at **1440px, 1024px, and 390px**:

1. Customer without a contract, with a reservation, and with no payments.
2. Customer with one active contract and recorded land payment.
3. Customer whose contract or payment changes after Smart Summary generation.
4. Super Admin, Admin, Staff, and Read Only views of actions and payment removal.
5. All routes at 1536, 1440, 1280, 1024, 768, 430, and 390px; verify no document-level horizontal scrolling.

The attached screenshot was described in the request but was not available in this workspace, so before/after image capture requires an authenticated test account and safe sample data.

## Remaining business decisions

- Decide whether a removed payment’s retained supporting-document file should be purged by a separately approved retention procedure.
- Confirm whether payment removal is available to Admin as well as Super Admin (current implementation allows both).
- Verify that the live database applies the controlled-payment-removal migration before exposing the action to users.
