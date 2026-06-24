# Workflow Terms and Reservation Settings

This document summarizes the lightweight in-product explanations added for staff. It is not a full Help Center and does not add automation.

## Workflow Definitions

### Lead

A Lead is a person who has shown interest in a project or lot but may not yet be an applicant or customer.

### Follow-up

A Follow-up is an internal task reminding staff what action should happen next with a lead, applicant, or customer.

### Site Visit

A Site Visit is an appointment for the buyer to view the project, land, or lot.

Site Visits are not the same as reservations.

### Reservation

A Reservation is an internal lot hold or buyer interest hold.

It helps the team track when a buyer is serious about a specific lot while deposit, application, family decision, or contract next steps are being handled.

A Reservation does not automatically change lot status, confirm payment, create a contract, or approve an application.

### Deposit Readiness

Deposit Readiness tracks whether a deposit is pending, submitted, confirmed, waived, overdue, or cancelled.

It is a sales/readiness status only.

It does not create payments, change balances, confirm proof, or replace the payment ledger.

### Application

An Application is the formal buyer/application record submitted or reviewed by staff.

### Customer

A Customer is a buyer who has been converted into an active account or contract relationship.

### Post-Sales Checklist

The Post-Sales Checklist tracks what needs to happen after approval, contract start, or customer setup, such as documents, agreement review, payment setup, and collections handoff.

### Smart Summary / Smart Insights

Smart summaries and insights are staff review aids.

They do not make decisions, approve applications, confirm deposits, change contracts, or send messages.

### Reports

Reports are read-only summaries for management review. They do not update records or trigger workflow changes.

## Site Visit vs Reservation

Site Visits are buyer appointments to view a project, land, or lot.

Reservations are internal buyer-interest holds for a specific lot while the team handles deposit, application, family decision, or contract next steps.

A Site Visit does not reserve a lot. A Reservation does not automatically schedule a visit.

## Deposit Readiness vs Payment Records

Deposit Readiness is CRM status tracking for staff. It helps staff see whether a deposit is pending, overdue, proof-submitted, confirmed, waived, or cancelled.

Payment records and balances remain managed separately in Payments and Collections. Deposit readiness does not create payment records, confirm proof, update balances, or replace the payment ledger.

## In-Product Explanations Added

Lightweight helper copy was added to:

- Leads
- Lead follow-up and site visit sections
- Lead reservation and deposit readiness sections
- Lots active reservation display
- Applications linked lead/reservation sections
- Customer Detail overview, reservation/deposit readiness, and post-sales sections
- Daily Briefs
- Reports
- Settings CRM Workflow Guide

The copy is intended to clarify terms without turning the app into a documentation portal.

## Reservation Settings

Reservation settings were reviewed against the current settings patterns.

The app has a `business_settings` table and existing settings UI for company and public application settings. However, there is not yet a dedicated reservation settings key, seed, migration, or workflow integration for reservation defaults.

Because the request preferred not forcing a migration, reservation settings were not implemented as active persisted settings in this pass.

## Reservation Settings Deferred

Recommended future reservation settings:

- Default reservation expiry days
- Default deposit due days
- Default expected deposit amount
- Whether deposit amount is required when creating a reservation
- Whether expiry date is required when creating a reservation
- Whether active duplicate reservations for the same lot are blocked
- Default reservation status
- Default deposit status

These settings should control CRM workflow defaults only. They should not automate payments, approvals, contracts, parcel status changes, or deposit confirmation.

## What Reservation Settings Must Not Do

Future reservation settings must not:

- Auto-expire reservations
- Automatically change parcel status
- Confirm deposits
- Create payments
- Change payment balances
- Approve applications
- Create contracts
- Change collections calculations
- Send emails, WhatsApp messages, or calendar invitations
- Create tasks automatically

## Behavior Boundaries

This pass added explanatory UI and documentation only.

It did not change:

- Payment behavior or calculations
- Contract behavior or calculations
- Collections calculations
- Application approval behavior
- Customer creation behavior
- Auth, roles, or permissions
- Reservation status behavior
- Post-sales workflow behavior
- AI behavior
- Edge Functions
- Database schema
