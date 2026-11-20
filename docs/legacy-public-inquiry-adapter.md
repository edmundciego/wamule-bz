# Legacy public inquiry adapter

`submit-public-inquiry` temporarily accepts the exact seven-field payload sent by `ApplicationPage.tsx` at `90b3c86`: `name`, `email`, `phone`, `interests`, `specific_lot_id`, `message`, and `page_url`. It adapts only that shape when no tenant, project, phase, hostname, or address selector is present. Any explicit scope selector uses the strict public scope resolver. The legacy `page_url` is sanitized for lead context only; it does not choose scope or participate in the retry fingerprint.

The adapter reads the Wamule default scope from Edge Function deployment configuration:

- `WAMULE_LEGACY_INQUIRY_TENANT_SLUG`
- `WAMULE_LEGACY_INQUIRY_PROJECT_SLUG`
- `WAMULE_LEGACY_INQUIRY_PHASE_SLUG`

All three values are required. The shared resolver verifies tenant/project/phase ownership and requires the phase to be active. Missing or invalid configuration fails closed. Numeric legacy lot IDs are resolved only inside that scope and must still appear in the current published public lot set. Submissions use the existing scoped inquiry RPC and semantic retry fingerprint.

Each invocation emits one `legacy_public_inquiry_adapter` event containing only request metadata, resolved scope IDs when available, and the outcome. It excludes contact fields and submitted content.

Remove this adapter and its deployment settings after the upgraded inquiry form is live and has passed verification on `wamuledevelopment.com`.
