# Legacy public inquiry adapter

`submit-public-inquiry` temporarily accepts only the exact seven-field payload sent by `ApplicationPage.tsx` at `90b3c86`: `name`, `email`, `phone`, `interests`, `specific_lot_id`, `message`, and `page_url`. Additional fields, including a Turnstile token, make it a different payload and the adapter will not accept it.

On production or any non-staging project, acceptance requires `WAMULE_LEGACY_INQUIRY_COMPAT_ENABLED=true` and all three server-side scope settings:

- `WAMULE_LEGACY_INQUIRY_TENANT_SLUG`
- `WAMULE_LEGACY_INQUIRY_PROJECT_SLUG`
- `WAMULE_LEGACY_INQUIRY_PHASE_SLUG`

For the exact staging project `kvocwmrcuhiaezlcgzjf`, the compatibility flag defaults on unless explicitly set to `false`, and the fallback scope is Wamule tenant `wamule`, project `wamule`, phase `default`. A staging override to another tenant, project, or phase disables the adapter. The shared resolver verifies tenant/project/phase ownership and requires the phase to be active. Numeric legacy lot IDs are resolved only inside that scope and must still appear in the current published public lot set. The legacy `page_url` is sanitized for lead context only; it does not choose scope or participate in the retry fingerprint.

Accepted legacy inquiries use the same Postgres lead-creation limit as modern inquiry modes: 100 new public inquiry leads per project in a rolling 24-hour window, shared across phases, hostnames, and entry points. They create the lead and follow-up in one transaction and always suppress buyer confirmation email. Retries that reuse an existing lead remain successful when the project is at its cap. Each adapter invocation logs request metadata, resolved scope IDs when available, and outcome; contact fields and submitted content are excluded.

Turn the compatibility flag off and remove the adapter and its deployment settings after the upgraded production inquiry form is verified to submit valid Turnstile tokens for its configured hostname and `public_inquiry` action. Do not remove it based only on a staging preview.
