# Reservation Settings Phase D

Phase D adds configurable reservation workflow settings using the existing `business_settings` pattern.

## Storage

Settings are stored in `business_settings` under:

`reservation_workflow_settings`

No dedicated reservation settings table was added.

## Settings Added

Default values:

- `default_reservation_expiry_days`: `14`
- `default_deposit_due_days`: `7`
- `default_expected_deposit_amount`: `null`
- `require_expiry_date`: `false`
- `require_expected_deposit_amount`: `false`
- `default_reservation_status`: `draft`
- `default_deposit_status`: `not_requested`
- `prompt_release_alternates_after_deposit_confirmed`: `true`
- `prompt_release_alternates_after_contract_started`: `true`
- `show_reservation_explanations`: `true`

## Settings UI

Settings includes a compact **Reservation Settings** section.

The section explains that reservation settings control CRM workflow defaults and staff prompts only. They do not automate payments, approvals, contracts, lot status, or releases.

## Reservation Creation Behavior

New reservations created from Leads use the configured defaults for:

- Expiry date
- Deposit due date
- Expected deposit amount
- Reservation status
- Deposit status

New reservations created from Applications use the same defaults.

Existing reservations are not overwritten when edited.

## Validation Behavior

When `require_expiry_date` is enabled, staff must provide an expiry date before creating a new reservation.

When `require_expected_deposit_amount` is enabled, staff must provide an expected deposit amount before creating a new reservation.

Validation is intentionally scoped to new reservation creation. Existing incomplete records are not blocked from being viewed or edited.

## Staff Prompt Behavior

When enabled, reservation panels can show a non-mutating prompt when:

- A reservation has confirmed deposit readiness and related active alternates exist.
- A lead is in contract-started stage and related active alternates exist.

The prompt only reminds staff to consider releasing alternates. It does not release reservations automatically.

## Audit Behavior

Saving reservation settings writes an `audit_events` row when the audit helper is available.

The audit event uses:

- `entity_type`: `settings`
- `action`: `settings_changed`
- `title`: `Reservation settings updated`

Only the reservation workflow settings before/after values are stored. Secrets and unrelated sensitive data are not logged.

## What Settings Do Not Do

Reservation settings do not:

- Auto-expire reservations
- Auto-release reservations
- Change parcel status
- Confirm deposits
- Create payment records
- Change balances
- Approve applications
- Create contracts
- Send messages
- Create tasks
- Replace staff judgment

## Known Limitations

- Required-field enforcement is frontend-only in this phase.
- Contract-started alternate prompts use lead stage context where available; they do not infer from every possible contract relationship.
- Existing single-reservation quick release behavior remains separate from the release alternates RPC.
- There is no auto-expiry, auto-release, parcel automation, or payment automation.

## Recommended Future Improvements

- Add server-side validation if reservation settings become mandatory compliance controls.
- Add a dedicated settings history view filtered to `reservation_workflow_settings`.
- Consider optional settings for duplicate buyer-level holds only after staff workflow is validated.

## Stabilization QA Note

Verified behavior:

- `reservation_workflow_settings` is seeded in `business_settings`.
- The seeded JSON shape matches the frontend settings type.
- Missing setting objects and malformed status values fall back to safe defaults.
- Missing numeric keys fall back to defaults, while explicit empty/null numeric values remain unset.
- Boolean settings save and reload through the existing `business_settings` flow.
- Default reservation and deposit statuses are limited to known status values.
- Reservation Settings save only updates the `reservation_workflow_settings` key.
- Saving Reservation Settings attempts one minimal `audit_events` record with `settings_changed`.
- Audit failure is caught and does not block settings persistence.
- Audit payloads contain only reservation workflow settings before/after values and the settings key.

Defaults behavior:

- Leads-created reservations use configured defaults for expiry date, deposit due date, expected deposit amount, reservation status, and deposit status.
- Applications-created reservations use the same configured defaults.
- Existing reservations keep their existing values when edited.

Validation behavior:

- `require_expiry_date` blocks new reservation creation when no expiry date is available.
- `require_expected_deposit_amount` blocks new reservation creation when no expected deposit amount is available.
- Validation is scoped to frontend creation flows and does not alter existing records.

Staff prompt behavior:

- Release-alternates prompts are display-only.
- Prompts appear only when enabled and related active alternate reservations exist.
- Prompts do not release reservations or change parcel, payment, deposit, contract, application, or customer records.

What settings do not automate:

- No auto-release jobs
- No auto-expiry jobs
- No parcel status automation
- No deposit confirmation
- No payment creation or balance changes
- No application approval or contract creation
- No messages, notifications, tasks, or AI calls

Known limitations:

- Required-field checks are frontend-only.
- Authenticated browser QA depends on available admin/staff credentials and a migrated target environment.
- Contract-started prompts use available lead stage context and do not infer every possible contract relationship.

Release readiness:

- Reservation Settings are ready for demo/client review after the Phase D migration is applied and authenticated Settings/Leads/Applications smoke testing passes in the target environment.

Authenticated browser QA:

- Temporary QA credentials were available through the approved local handoff method. Credentials were not written to documentation or repo files.
- Tested Settings, Leads, and Applications at 360, 430, 768, and 1280 pixel widths.
- Reservation Settings loaded in Settings at all tested widths with no detected horizontal overflow.
- Reservation Settings helper copy wrapped safely and clearly stated that payments, approvals, contracts, lot status, and releases are not automated.
- A same-value Reservation Settings save completed and showed the saved toast.
- Leads and Applications rendered safely at all tested widths after the reservation settings integration.
- `/settings` redirected to `/login` after logout, confirming public users cannot access Reservation Settings through the protected route.
- No reservation release, payment, contract, parcel, application approval, customer creation, notification, or AI behavior was triggered during QA.
