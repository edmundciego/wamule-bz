# SYSTEM_ARCHITECTURE_BRIEF.md

## Executive Summary & Core Paradigm

This document defines the architectural specification for **home-services.bz** and its tenant/dealer land parcel and masterplan update platform. The platform uses a **Data-First Paradigm**:

* **Canonical Lot Identity**: Lot records (`parcels`) are created via standard tabular register imports (CSV/XLSX) with attributes like sqft, tier, base price, and status.
* **Visual Layer**: Masterplan raster drawings and auto-detected geometry serve strictly as visual layers that link to canonical lot records.
* **Zero Legacy Debt**: This is a fresh, multi-tenant deployment. No backfills or legacy schema migrations from single-tenant iterations are required.

---

## 1. Domain Resolution & Multi-Entry Routing Matrix

The system dynamically resolves incoming HTTP requests using the `Host` header across four distinct entry modes:

```
                                  ┌─ Custom Domain ─────► sagana-heights.ceiba.com ──┐
                                  ├─ Subdomain ─────────► hopkins.home-services.bz ──┼─► [ Project Interactive Engine ]
Incoming Request (Host Header) ───┼─ Path Route ────────► home-services.bz/p/hopkins ┘
                                  │
                                  └─ Root / Directory ──► home-services.bz ─────────► [ Central Marketplace ]

```

### Database Mapping Table (`domain_mappings`)

```sql
CREATE TABLE public.domain_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    hostname TEXT UNIQUE NOT NULL, -- e.g., 'sagana-heights.ceiba.com' or 'hopkins.home-services.bz'
    is_primary BOOLEAN DEFAULT true NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_domain_mappings_hostname ON public.domain_mappings(hostname);

```

### Resolution Strategy

1. **Custom Domain / Subdomain Lookup**: The edge middleware checks the incoming `Host` header against `domain_mappings.hostname`.
2. **Path Route Fallback**: If hosted on `home-services.bz/p/[project_slug]`, the route extracts `project_slug` directly.
3. **Context Injection**: Sets `tenant_id` and `project_id` on app context before invoking API routes or public lot queries.
4. **Central Marketplace (`home-services.bz`)**: Resolves public, published lots and home service listings across projects while strictly respecting database tenant boundaries.

---

## 2. Single-Project Dashboard Scope & Multi-Project Hierarchy

To maintain focus for dealers operating single developments while supporting enterprise dealers with multiple projects (e.g., Ceiba):

```
Organization (Tenant / Dealer)
  └── Projects / Developments (e.g., "Hopkins Grove Phase 1", "Sagana Heights")
        ├── Domain Mappings (`domain_mappings`)
        ├── Canonical Lot Register (`parcels`)
        ├── Lot Tiers & Pricing Rules (`lot_tiers`)
        ├── Development Updates (`development_updates`)
        └── Masterplan Versions & Maps (`masterplan_versions`)

```

### Access & UI Rules

* **Scoped Admin Context**: Every admin route must be explicitly scoped by `project_id` (e.g., `/admin/projects/[projectId]/parcels`).
* **Project Switcher Dropdown**: Dealers managing multiple developments toggle active `project_id` in the top admin bar without needing separate accounts or distinct logins.
* **Database Foreign Keys**: Every record created within a project (`parcels`, `leads`, `masterplan_versions`) must populate both `tenant_id` and `project_id` with `NOT NULL` constraints.

---

## 3. Visual Linking Toolchain & Ingestion Pipeline

Map generation follows a strict three-stage ingestion process:

### Stage 1: Tabular Lot Register Import (`/admin/projects/[id]/parcels/import`)

* Admin uploads CSV/XLSX containing: `lot_number`, `block`, `size_sqft`, `tier_key`, `base_price_dollars`, `status`.
* Row data is upserted into `parcels` with `geometry_source = NULL` or `'unlinked'`. Lots exist immediately for accounting and CRM before map geometries exist.

### Stage 2: Masterplan Polygon Detection & Split-Screen Linking (`/admin/projects/[id]/linking`)

* **Left View (Canvas)**: Interactive raster map displaying auto-detected polygon shapes (`geometry_source = 'raster-auto'`).
* **Right View (Drawer)**: List of unlinked lot records alongside unlinked map polygon IDs.
* **Auto-Matching Engine**: Centroid label OCR / spatial text matching links polygon shapes to lot numbers automatically where matching labels exist.
* **Manual Point-and-Click Matching**: Operator clicks a polygon outline on the canvas, then selects the corresponding lot record from the register to bind `parcels.map_polygon`.

### Stage 3: Publish Gate Rules

A masterplan version cannot be published (`is_active = true`) until the automated publish gate passes:

* **Rule A**: 100% of sellable lots in the project register must be linked to exactly one map polygon.
* **Rule B**: Zero detected map polygons may be assigned to multiple lot records.
* **Rule C**: A pre-apply JSON snapshot (`snapshot-<timestamp>.json`) must be created prior to database commits.

---

## 4. Masterplan Update Logic ("Redraw, Don't Delete")

When revised survey files or updated engineering drawings are produced:

1. **New Version Draft**: Uploading a revised masterplan creates a new draft in `masterplan_versions` without mutating live parcel records.
2. **Spatial Re-Anchoring**: Existing canonical lot records retain all lead histories, financial records, contract statuses, and price overrides.
3. **Auto-Restamping SQL Trigger**: Activating a new masterplan version automatically updates active parcel records to point to the new `masterplan_version_id`:

```sql
CREATE OR REPLACE FUNCTION public.sync_active_masterplan_parcels()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_active = true AND (OLD.is_active = false OR OLD.is_active IS NULL) THEN
    -- Deactivate other masterplans for this project
    UPDATE public.masterplan_versions
    SET is_active = false
    WHERE project_id = NEW.project_id AND id <> NEW.id;

    -- Auto-restamp parcels linked to raster auto-detection
    UPDATE public.parcels
    SET masterplan_version_id = NEW.id
    WHERE project_id = NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

```

---

## 5. Security & Isolation Standard

### RLS Policies for Public (`anon`) Access

Public queries must be scoped to project and tenant parameters supplied via valid domain contexts:

```sql
-- Parcel visibility rule for public role
CREATE POLICY "Public can view published parcels for active project"
ON public.parcels FOR SELECT
TO anon
USING (
  project_id IN (
    SELECT project_id FROM public.domain_mappings WHERE hostname = current_setting('request.headers', true)::json->>'host'
  )
);

```

### Lead & Inbound Inquiry Scope

* CRM inquiries (`submit-public-inquiry`) must accept `tenant_id`, `project_id`, and `parcel_id`.
* Duplicate customer detection (e.g., checking for existing email/phone) must strictly scope checks `WHERE tenant_id = v_tenant_id` to eliminate cross-dealer data leakage.

---

## 6. Staging-First Infrastructure Boundaries

To build immediately without incurring early subscription costs on Supabase Pro and Vercel Pro:

1. **Staging Engine**: Implement all features using standard open-source Supabase primitives and Netlify hosting.
2. **Abstracted Middleware**: Use standard headers for domain matching so switching to Vercel Pro Edge Middleware requires zero schema or API rewrites.
3. **Production Cutover Readiness**: Moving to production will require only provisioning the Supabase Pro instance, applying this clean migration track, connecting domains on Vercel Pro, and deploying the Edge Functions.