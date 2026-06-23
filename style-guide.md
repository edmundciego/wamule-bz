# Wamule SaaS Style Guide for Coding Agent

## 1. Product Direction

Wamule is a professional real estate CRM and housing project operations platform. It is currently built for one client, but the design system should be structured like a future SaaS product with tenant-level branding support.

The product should feel:

* Professional
* Trustworthy
* Modern
* Premium
* Intelligent
* Calm
* Warm and approachable

The interface should take inspiration from Property-xRM-style real estate CRM systems, especially around sales, post-sales automation, customer management, documents, agreements, payments, and pipeline visibility. However, Wamule should feel simpler, cleaner, and easier to use for local real estate teams moving away from spreadsheets, paper, WhatsApp-only tracking, and manual follow-ups.

## 2. Core Design Principle

The UI should communicate:

> “This is a serious real estate business system that helps teams manage buyers, lots, payments, sales, follow-ups, and post-sales operations with confidence.”

Avoid making the app feel like a generic AI-generated admin dashboard. It should feel like a polished real estate CRM with personality and calm authority.

## 3. Brand Personality

Use a design language that combines:

* **Real estate professionalism**: clean layouts, clear data, confident buttons, strong tables.
* **Land and growth**: greens, earth tones, warm neutrals.
* **Premium calm**: plenty of whitespace, restrained colors, soft surfaces.
* **Helpful intelligence**: AI features should feel assistive, not pushy or salesy.
* **Caribbean warmth**: subtle warmth in colors and imagery, but not overly tropical or playful.

The system should not feel cartoonish, loud, overly rounded, or overly corporate/cold.

## 4. Color System

Use design tokens so colors can be changed later per client.

### Default Wamule Palette

Primary direction: land green, earth brown, warm gold/yellow, calm neutrals.

Recommended default tokens:

```css
:root {
  --color-primary: #1F6B45;
  --color-primary-hover: #185437;
  --color-primary-soft: #E8F3EC;

  --color-secondary: #8A5A35;
  --color-secondary-hover: #704629;
  --color-secondary-soft: #F3E9DE;

  --color-accent: #D6A84F;
  --color-accent-hover: #B88A2E;
  --color-accent-soft: #FFF5D9;

  --color-background: #F7F5EF;
  --color-surface: #FFFFFF;
  --color-surface-muted: #FAF8F3;

  --color-text: #1F2933;
  --color-text-muted: #667085;
  --color-border: #E5E0D6;

  --color-success: #2F7D4E;
  --color-warning: #C88719;
  --color-danger: #B42318;
  --color-info: #2563EB;
}
```

### Tenant Branding Support

The app should support future tenant-level branding:

* Primary color
* Secondary color
* Logo
* Optional cover/project images
* Optional public plugin styling

For the internal CRM, use Wamule defaults unless a tenant override exists.

For the future public website/plugin, inherit the client’s primary and secondary colors when available.

## 5. Typography

Use a clean professional sans-serif font.

Recommended:

```css
--font-sans: Inter, Manrope, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

Typography should feel clean and business-focused.

Suggested scale:

```css
--text-xs: 12px;
--text-sm: 14px;
--text-base: 16px;
--text-lg: 18px;
--text-xl: 22px;
--text-2xl: 28px;
--text-3xl: 36px;
```

Guidelines:

* Page titles should feel confident, not oversized.
* Body text should be easy to scan.
* Use muted text for descriptions, helper text, secondary metadata, and timestamps.
* Avoid decorative fonts.

## 6. Buttons

Buttons should feel sharp, professional, and confident.

### Shape

Use slightly rounded corners, not pill-shaped.

```css
--radius-button: 6px;
```

Avoid fully rounded pill buttons unless used for badges or filters.

### Button Types

Use these standard variants:

1. **Primary Button**

   * Solid green
   * Used for main actions: Save, Generate Brief, Add Customer, Add Payment, Create Contract, Book Visit.
   * White text.
   * Optional icon when useful.

2. **Secondary Button**

   * Solid earth brown or muted neutral.
   * Used for secondary important actions.

3. **Accent Button**

   * Warm gold/yellow.
   * Used sparingly for highlighted sales actions such as “Schedule Visit” or “Collect Deposit.”

4. **Outline Button**

   * Border with transparent/white background.
   * Used for secondary actions like Cancel, View Details, Download, Export.

5. **Ghost Button**

   * No border.
   * Used in tables, dropdowns, and low-priority actions.

6. **Destructive Button**

   * Red.
   * Used only for delete, void, cancel contract, or destructive workflows.

### Hover Behavior

Buttons should have personality but remain professional.

On hover:

* Slight lift: `transform: translateY(-1px)`
* Subtle shadow
* Slight background darkening
* Optional soft highlight animation for primary/accent buttons

Example:

```css
.button {
  transition: background-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
}

.button:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 18px rgba(31, 41, 51, 0.12);
}
```

Do not use loud bounce animations or flashy effects.

### Icons in Buttons

Use icons only when they add meaning.

Good examples:

* Plus icon for Add
* Calendar icon for Schedule Visit
* File icon for Generate Contract
* Sparkle/wand icon for AI-generated summaries
* Upload icon for proof/documents
* Download icon for exports
* Check icon for approve/confirm

Do not place icons in every button by default.

## 7. Layout System

The app should use a clean CRM/admin layout:

* Sidebar navigation
* Top header with company/client context
* Dashboard cards
* Tables for operational data
* Detail pages for customers, lots, applications, contracts, and payments
* Right-side panels or modals for quick actions where helpful

The dashboard should remain calm and focused.

Avoid overcrowding. Use strong hierarchy and group related actions.

## 8. Dashboard Priority

The first screen after login should prioritize daily operational clarity.

Recommended dashboard sections:

1. Logo / brand area
2. Daily Brief
3. Alerts & Follow-ups
4. Sales Pipeline Summary
5. Lot Inventory Summary
6. Payments / Collections Summary
7. Pending Documents
8. Recently Active Customers or Leads

The user should immediately know:

* Who needs attention today
* Which buyers need follow-up
* Which payments are overdue or incomplete
* Which contracts/documents are missing
* Which lots are available, reserved, sold, or blocked
* Which leads are ready for a site visit or deposit

## 9. Cards

Cards should feel premium and calm.

Recommended card style:

```css
.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  box-shadow: 0 6px 18px rgba(31, 41, 51, 0.04);
}
```

Cards should use:

* Clear title
* Small muted subtitle
* Main metric or summary
* Optional icon
* Optional status badge
* Optional action link

Avoid heavy shadows and overly colorful cards.

## 10. Tables

Tables are important because this is a CRM.

Tables should be:

* Clean
* Easy to scan
* Sortable where useful
* Searchable where useful
* Filterable by status, project, sales stage, payment status, and assigned user

Use sticky or clear table headers where practical.

Table row hover should be subtle:

```css
.table-row:hover {
  background: var(--color-surface-muted);
}
```

Important row information should be visible without opening details:

* Customer name
* Project
* Lot
* Stage/status
* Balance
* Next due date
* Assigned staff
* Last activity
* Next action

## 11. Forms

Forms should feel structured and trustworthy.

Use:

* Clear labels
* Short helper text
* Inline validation
* Section grouping
* Required field indicators
* Good spacing between fields

Avoid massive ungrouped forms.

For longer workflows, use sections or steps:

* Buyer Information
* Lot Selection
* Payment Plan
* Documents
* Review
* Submit/Approve

## 12. Status Badges

Use badges heavily across the CRM. Badges should be sharp but slightly rounded.

```css
.badge {
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
}
```

Recommended statuses:

### Lot Status

* Available: green
* Reserved: amber
* Sold: slate/dark
* Blocked: brown/neutral
* Unavailable: red/gray

### Application Status

* New
* In Review
* Missing Info
* Approved
* Rejected
* Converted to Contract

### Sales Pipeline

* New Lead
* Contacted
* Interested
* Family Decision
* Site Visit Scheduled
* Deposit Pending
* Deposit Paid
* Contract Started
* Closed/Won
* Lost/Inactive

### Payment Status

* Current
* Due Soon
* Overdue
* Missing Proof
* Pending Review
* Completed

### Document Status

* Missing
* Uploaded
* Pending Review
* Approved
* Rejected

## 13. Sales and Post-Sales Terminology

Use standard, serious CRM terms so clients learn the language and trust the system.

Preferred terms:

* Leads
* Sales Pipeline
* Buyer Journey
* Follow-up Center
* Post-Sales Automation
* Collections Assistant
* Customer Profile
* Activity Timeline
* Next Action
* Site Visit
* Deposit
* Contract
* Payment Plan
* Documents
* Agreements

Avoid calling the AI a “Sales Assistant” for now because it may sound too forceful.

Use gentler language:

* AI Helper
* Smart Summary
* Recommended Actions
* Decision Support
* Buyer Insights
* Follow-up Suggestions

## 14. AI Feature Design

AI should be mostly behind the scenes for now.

AI features should appear as:

* Summaries
* Alerts
* Recommended actions
* Missing information detection
* Risk flags
* Follow-up suggestions
* Daily brief insights
* Buyer readiness notes

The AI should feel helpful, calm, and intelligent — not like it is trying to pressure the buyer.

Example AI panel title:

> Smart Summary

Example helper text:

> This summary highlights key buyer details, missing items, and recommended next actions for the team.

Avoid aggressive labels like:

* AI Closer
* Sales Bot
* Auto-Seller
* Push to Close

## 15. Public Website / Plugin Direction

The future public plugin should inherit the client’s branding where possible.

Plugin configuration should eventually support:

* Client logo
* Primary color
* Secondary color
* Project images
* Hero image
* Drone footage/video
* CTA button text
* Currency display
* Contact method
* Booking/site visit flow

The plugin should prioritize:

1. Beautiful project presentation
2. Drone footage or hero visuals
3. Clear lot availability
4. Payment/deposit clarity
5. Booking a site visit
6. Starting an inquiry/application
7. Deposit/payment intent

The buyer-facing flow should feel warm and helpful, not pushy.

Example CTA labels:

* Book a Site Visit
* View Available Lots
* Request More Details
* Start Application
* Reserve Interest
* Ask About Payment Plans

## 16. Buyer Journey Focus

The sales flow should support the reality that land/housing purchases involve family decisions and multiple steps.

Important buyer stages:

* Browsing
* Interested
* Needs Family Decision
* Needs Payment Plan Details
* Wants Site Visit
* Deposit Pending
* Application Started
* Contract Pending
* Active Customer
* In Collections / Payment Plan

The system should help staff know what to do next.

Examples:

* “Follow up with buyer about family decision.”
* “Send payment plan summary.”
* “Schedule site visit.”
* “Request missing ID.”
* “Review proof of deposit.”
* “Prepare agreement.”

## 17. Currency and Localization

Default currency should support USD, with tenant-level option to switch or display BZD.

Do not rely on a bare `$` symbol only. Where possible, display:

* USD $30,000
* BZD $60,000

Settings should eventually allow:

* Default currency: USD or BZD
* Optional secondary display
* Payment methods
* Bank transfer details
* Manual receipt numbers
* Local contact methods such as WhatsApp

## 18. Visual Style for Real Estate Content

Property/project pages should support premium real estate visuals:

* Large hero images
* Drone footage/video
* Project gallery
* Lot map
* Amenities
* Location highlights
* Payment/deposit information
* Site visit CTA

Internal admin pages should stay more functional and CRM-focused.

## 19. Navigation

Recommended main navigation:

* Dashboard
* Leads
* Applications
* Customers
* Projects
* Lots
* Contracts
* Payments
* Collections
* Documents
* Daily Briefs
* Reports
* Settings

Future additions:

* Follow-up Center
* Sales Pipeline
* Post-Sales Automation
* Public Plugin
* Portal Listings

## 20. Spacing and Density

Use a balanced density.

The app should not feel empty, but it should also not feel crowded.

Suggested spacing:

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 24px;
--space-6: 32px;
--space-7: 48px;
```

Use more whitespace on dashboards and detail pages.

Use tighter spacing in tables where users need to scan many records.

## 21. Border Radius

Use a professional sharp style.

Recommended:

```css
--radius-sm: 4px;
--radius-md: 6px;
--radius-lg: 10px;
--radius-card: 12px;
--radius-modal: 16px;
```

Avoid very round, playful components.

## 22. Shadows

Use soft, premium shadows.

```css
--shadow-sm: 0 2px 8px rgba(31, 41, 51, 0.06);
--shadow-md: 0 8px 24px rgba(31, 41, 51, 0.08);
--shadow-lg: 0 16px 40px rgba(31, 41, 51, 0.12);
```

Do not use harsh black shadows.

## 23. Motion

Use subtle motion only.

Good motion:

* Button hover lift
* Card hover shadow
* Smooth modal entrance
* Gentle loading shimmer
* Small success confirmation animation

Avoid:

* Bouncy animations
* Spinning decorative elements
* Distracting page transitions
* Heavy AI/glow effects everywhere

## 24. Implementation Rules for Coding Agent

1. Build from reusable design tokens, not one-off styles.
2. Avoid inline color values in components unless absolutely necessary.
3. Use semantic tokens: primary, secondary, accent, success, warning, danger, info.
4. Keep tenant branding override-ready.
5. Do not redesign the entire app at once unless requested.
6. Start by standardizing buttons, cards, tables, badges, forms, and dashboard widgets.
7. Existing layout can remain, but component styling should become consistent.
8. Use sharp, professional button styling with subtle hover animation.
9. Keep the CRM experience calm, premium, and trustworthy.
10. AI UI should be helpful and subtle, not loud or gimmicky.
11. Public plugin styling should support client branding and rich real estate visuals.
12. All new sales/post-sales features should use consistent CRM terminology.

## 25. Immediate Styling Priorities

Prioritize these first:

1. Global color tokens
2. Button system
3. Card system
4. Status badge system
5. Table styling
6. Form styling
7. Dashboard widget polish
8. AI summary panels
9. Sales pipeline cards
10. Public project presentation components

## 26. Preferred Product Feel

Final design target:

> Wamule should feel like a modern real estate CRM for serious housing developers: structured enough to manage sales, contracts, payments, and post-sales operations, but warm enough for Belizean and Caribbean businesses that are moving from spreadsheets into a proper digital system.
