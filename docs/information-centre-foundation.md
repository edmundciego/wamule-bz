# Information Centre Foundation

## Purpose

The Information Centre completes the staff-controlled workflow from buyer interest to a branded information pack and follow-up:

```text
Lead
→ Information request
→ Topic selection
→ Versioned draft snapshot
→ Staff review
→ Approval
→ Printable PDF
→ Manual sending
→ Sent history
→ Follow-up task
```

The platform coordinates and records the work. It does not automatically email, text, or message the prospect.

## Private feature flag

The feature is hidden unless the frontend environment includes:

```text
VITE_ENABLE_INFORMATION_CENTRE=true
```

Keep the flag false in the client production environment until the migration, content review, role testing, PDF review, and end-to-end workflow test are complete.

When the flag is false:

- The Information Centre navigation item is not shown.
- The `/information-centre` route is not registered.
- The printable information-pack route is not registered.
- Existing client workflows are unchanged.

## Migration

Apply:

```text
supabase/migrations/20260715050000_information_centre_foundation.sql
```

The migration adds:

- `information_topics`
- `information_requests`
- `information_request_topics`
- `information_packs`
- Internal RLS policies
- Updated-at triggers
- Initial approved-topic placeholders

The migration does not:

- Send messages
- Create public pages
- Modify lead pipeline stages
- Modify customer, application, reservation, contract, payment, or collection behavior
- Upload files
- Create a newsletter or mailing-list provider integration

## Generated content

A generated pack stores a point-in-time JSON snapshot containing:

- Company branding and contact information
- Project name, description, and location
- Prospect name and contact context
- Optional selected lot
- Current available-lot count and price range
- Selected information topics
- Active installment-plan examples when pricing or payment plans are requested
- Custom request text
- Recommended next action

This prevents later settings changes from silently altering an already reviewed version.

## Versioning

Each regeneration creates a new pack version and document number.

```text
INFO-YYYYMMDD-REQUESTID-VERSION
```

Previously approved versions are marked `superseded` when a new draft is generated. Records are not hard-deleted through the UI.

## Manual sending boundary

After approval, staff can:

- Open the printable preview
- Print or save it as PDF
- Copy a suggested email subject
- Copy a suggested email body
- Copy a short message for WhatsApp, SMS, or Messenger

Staff must manually verify and send the information through the chosen business channel.

Only after sending should staff choose **Mark Sent & Create Follow-Up**. That action:

- Marks the request sent
- Records the channel
- Adds a lead activity
- Changes communication status to `waiting_for_customer`
- Creates a follow-up task due two days later

## Required QA

Before enabling the feature in production, verify:

1. Apply the migration in a safe environment.
2. Create a fictional lead with a fictional email and phone number.
3. Create a request with several standard topics and a custom request.
4. Generate version 1.
5. Confirm company, buyer, lot, pricing, availability, and payment-plan snapshots.
6. Review print layout at Letter and A4 sizes.
7. Approve the pack.
8. Copy the email and short-message templates.
9. Mark the pack sent through a fictional channel.
10. Confirm the lead activity and follow-up task.
11. Generate version 2 and confirm prior approved versions become superseded.
12. Test Super Admin, Admin, Staff, and Read Only permissions.
13. Confirm the feature remains invisible when the environment flag is false.

## Next phase

After the foundation is verified, the next refinement should add an Admin content-library editor so approved project, infrastructure, land-use, and FAQ wording can be maintained without SQL changes.
