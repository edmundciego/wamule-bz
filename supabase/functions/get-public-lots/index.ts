import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { allowlistTheme } from "../../../src/lib/theme.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Open CORS: permits external fetches from WordPress domains embedding the lot map.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

type MapPoint = { x: number; y: number };

// Public payload allowlist: ONLY these keys may ever appear in a parcel
// object returned by this endpoint. Tier display fields (tier_key, label,
// colour) plus the effective price are public; QA/ops columns
// (price_override_cents, confidence, needs_review, geometry_source,
// masterplan_version_id) and everything else (AI provider keys,
// authorization metadata, internal notes, creator columns, tenant scoping,
// zoning, ...) are stripped by toPublicParcel before serialization.
const PUBLIC_PARCEL_FIELDS = [
  "id",
  "lot_number",
  "status",
  "price",
  "dimensions",
  "map_polygon",
  "tier_key",
  "tier_label",
  "tier_color_hex",
  "is_corner",
  "effective_price_cents",
] as const;

type TierRow = {
  tier_key: string;
  label: string;
  price_cents: number;
  corner_premium_cents: number;
  color_hex: string;
};

/**
 * Effective lot price in cents. TypeScript mirror of SQL
 * public.parcel_effective_price_cents(bigint, bigint, bigint, boolean, numeric):
 * per-lot override wins, else tier price (+ corner premium for corner lots),
 * else legacy base_price fallback so unclassified rows keep serving.
 */
function computeEffectivePriceCents(input: {
  priceOverrideCents: number | null;
  tierPriceCents: number | null;
  tierCornerPremiumCents: number | null;
  isCorner: boolean;
  basePrice: number;
}): number {
  if (input.priceOverrideCents !== null && Number.isFinite(input.priceOverrideCents)) {
    return Math.round(input.priceOverrideCents);
  }
  if (input.tierPriceCents !== null && Number.isFinite(input.tierPriceCents)) {
    const premium = input.isCorner ? Math.round(input.tierCornerPremiumCents ?? 0) : 0;
    return Math.round(input.tierPriceCents) + premium;
  }
  return Math.round(Number(input.basePrice ?? 0) * 100);
}

function toPublicParcel(parcel: Record<string, unknown>, tiersByKey: Map<string, TierRow>) {
  const tierKey = typeof parcel.tier_key === "string" ? parcel.tier_key : null;
  const tier = (tierKey && tiersByKey.get(tierKey)) || null;
  const isCorner = parcel.is_corner === true;
  const overrideRaw = parcel.price_override_cents;
  const effectiveCents = computeEffectivePriceCents({
    priceOverrideCents: typeof overrideRaw === "number" ? overrideRaw : null,
    tierPriceCents: tier ? Number(tier.price_cents) : null,
    tierCornerPremiumCents: tier ? Number(tier.corner_premium_cents) : null,
    isCorner,
    basePrice: Number(parcel.base_price ?? 0),
  });
  const source: Record<string, unknown> = {
    id: parcel.id,
    lot_number: parcel.lot_number,
    status: parcel.status,
    // Legacy `price` key (dollars) is now the effective price so catalogue
    // edits flow to embeds without re-ingest.
    price: Number((effectiveCents / 100).toFixed(2)),
    dimensions: parcel.dimensions,
    map_polygon: sanitizePolygon(parcel.map_polygon),
    tier_key: tierKey,
    tier_label: tier ? tier.label : null,
    tier_color_hex: tier ? tier.color_hex : null,
    is_corner: isCorner,
    effective_price_cents: effectiveCents,
  };
  // Defensive allowlist serialization: strips any key not in
  // PUBLIC_PARCEL_FIELDS regardless of how it arrived.
  const output: Record<string, unknown> = {};
  for (const field of PUBLIC_PARCEL_FIELDS) {
    output[field] = source[field];
  }
  return output;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "GET") {
    return json({ error: "Method not allowed. Use GET /get-public-lots?tenant=<slug>." }, 405);
  }

  const url = new URL(request.url);
  const tenantParam = (url.searchParams.get("tenant") ?? "").trim().toLowerCase();
  if (!tenantParam) {
    return json({ error: "Missing required query parameter: tenant (organization slug or inbound alias)." }, 400);
  }
  // Optional project slug (?project=): explicit lookup scoped to the tenant.
  // Absent = alias to the tenant's default project (see resolveProject).
  const projectParam = (url.searchParams.get("project") ?? "").trim().toLowerCase() || null;

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // -- Tenant lookup: slug first, then inbound alias. Inactive/missing -> 404.
  // -- Service-role reads stay server-side; only public-safe fields are returned.
  const organization = await resolveOrganization(supabase, tenantParam);
  if (!organization) {
    return json({ error: "Tenant not found or inactive." }, 404);
  }

  const [{ data: parcels, error: parcelsError }, branding, tiersByKey, activeVersionId] = await Promise.all([
    supabase
      .from("parcels")
      .select("id, lot_number, status, base_price, dimensions, map_polygon, tier_key, is_corner, price_override_cents, masterplan_version_id, project_id")
      .eq("tenant_id", organization.id)
      .order("lot_number", { ascending: true }),
    loadBranding(supabase, organization),
    loadTiers(supabase, organization.id),
    loadActiveVersionId(supabase, organization.id),
  ]);

  if (parcelsError) {
    console.error("get-public-lots parcels query failed", parcelsError.message);
    return json({ error: "Could not load lot availability." }, 500);
  }

  // Project scoping: explicit slug resolves (404 when unknown); absent
  // aliases the default project, else the oldest project, else unscoped
  // (no projects yet = legacy single-map behavior). Legacy rows with NULL
  // project_id render under the default project only.
  const project = await resolveProject(supabase, organization.id, projectParam);
  if (projectParam && !project) {
    return json({ error: "Project not found." }, 404);
  }
  const inProject = (parcel: Record<string, unknown>) => {
    const pid = parcel.project_id;
    if (!project) return true;
    if (pid === null || pid === undefined) return project.isDefault;
    return String(pid) === project.id;
  };

  // Version scoping: rows aligned to a superseded map stay hidden; NULL
  // (legacy/unversioned) rows always stay visible so existing tenants' maps
  // never blank on deploy. Strict equality alone would hide every legacy lot.
  const visible = (parcels ?? []).filter(
    (parcel) =>
      inProject(parcel as Record<string, unknown>) &&
      ((parcel as Record<string, unknown>).masterplan_version_id == null ||
        (parcel as Record<string, unknown>).masterplan_version_id === activeVersionId),
  );

  const theme = await loadTheme(supabase, organization.id);

  return json({
    tenant: { name: organization.name, slug: organization.slug },
    project: project ? { slug: project.slug, name: project.name } : null,
    masterplan_image_url: branding.masterplanImageUrl,
    masterplan_preview_url: branding.masterplanPreviewUrl,
    branding: branding.public,
    theme,
    parcels: visible.map((parcel) => toPublicParcel(parcel as Record<string, unknown>, tiersByKey)),
  });
});

async function resolveOrganization(
  supabase: ReturnType<typeof createClient>,
  tenantParam: string,
) {
  const bySlug = await supabase
    .from("organizations")
    .select("id, name, slug, inbound_alias, masterplan_image_url, is_active")
    .eq("slug", tenantParam)
    .eq("is_active", true)
    .maybeSingle();
  if (bySlug.data) return bySlug.data as OrganizationRow;

  const byAlias = await supabase
    .from("organizations")
    .select("id, name, slug, inbound_alias, masterplan_image_url, is_active")
    .eq("inbound_alias", tenantParam)
    .eq("is_active", true)
    .maybeSingle();
  if (byAlias.error) console.error("get-public-lots alias lookup failed", byAlias.error.message);
  return (byAlias.data ?? null) as OrganizationRow | null;
}

type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  inbound_alias: string | null;
  masterplan_image_url: string | null;
  is_active: boolean;
};

async function loadBranding(supabase: ReturnType<typeof createClient>, org: OrganizationRow) {
  // Masterplan prefers the tenant record; business_settings mirror is fallback.
  // The mobile-capped preview rendition is optional: when unset, clients use
  // the full image at every viewport.
  let masterplanImageUrl = org.masterplan_image_url;
  let masterplanPreviewUrl: string | null = null;
  let companyProfile: Record<string, unknown> = {};

  const { data: settings, error } = await supabase
    .from("business_settings")
    .select("key, value")
    .eq("tenant_id", org.id)
    .in("key", ["company_profile", "masterplan_image_url", "masterplan_preview_url"]);
  if (error) {
    console.error("get-public-lots settings query failed", error.message);
  } else {
    for (const row of settings ?? []) {
      if (row.key === "company_profile" && row.value && typeof row.value === "object") {
        companyProfile = row.value as Record<string, unknown>;
      }
      if (row.key === "masterplan_image_url" && !masterplanImageUrl) {
        const mirror = (row.value as Record<string, unknown> | null)?.url;
        if (typeof mirror === "string" && mirror) masterplanImageUrl = mirror;
      }
      if (row.key === "masterplan_preview_url") {
        const mirror = (row.value as Record<string, unknown> | null)?.url;
        if (typeof mirror === "string" && mirror) masterplanPreviewUrl = mirror;
      }
    }
  }

  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    masterplanImageUrl,
    masterplanPreviewUrl,
    public: {
      company_name: text(companyProfile.company_name) || org.name,
      logo_url: text(companyProfile.logo_url),
      short_description: text(companyProfile.short_description),
    },
  };
}

async function loadTiers(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
): Promise<Map<string, TierRow>> {
  // Tier select is display-safe only: no tenant_id, no audit/creator columns.
  const { data, error } = await supabase
    .from("lot_tiers")
    .select("tier_key, label, price_cents, corner_premium_cents, color_hex")
    .eq("tenant_id", tenantId)
    .eq("is_active", true);
  if (error) {
    // Graceful degradation for deploy ordering (function before migration):
    // fall back to legacy base_price instead of 500ing the public map.
    console.error("get-public-lots tiers query failed", error.message);
    return new Map();
  }
  return new Map((data ?? []).map((row) => [(row as TierRow).tier_key, row as TierRow]));
}

async function loadActiveVersionId(  supabase: ReturnType<typeof createClient>,
  tenantId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("masterplan_versions")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    console.error("get-public-lots active version lookup failed", error.message);
    return null;
  }
  const id = (data as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
}

type ResolvedProject = { id: string; slug: string; name: string; isDefault: boolean } | null;

/**
 * Explicit project lookup scoped to the tenant (never by Host header).
 * slug=null → default project → oldest project → null (unscoped legacy).
 */
async function resolveProject(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  slug: string | null,
): Promise<ResolvedProject> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, slug, name, is_default, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("get-public-lots project lookup failed", error.message);
    return null;
  }
  const rows = ((data ?? []) as Array<{ id: string; slug: string; name: string; is_default: boolean }>);
  if (slug) return rows.find((row) => row.slug.toLowerCase() === slug) ?? null;
  return rows.find((row) => row.is_default) ?? rows[0] ?? null;
}

/**
 * Tenant theme, allowlisted server-side (unknown keys dropped, colors
 * hex-gated, texts stripped). Null when the tenant never published one —
 * clients fall back to built-in defaults.
 */
async function loadTheme(supabase: ReturnType<typeof createClient>, tenantId: string) {
  const { data, error } = await supabase
    .from("business_settings")
    .select("value")
    .eq("tenant_id", tenantId)
    .eq("key", "tenant_theme")
    .maybeSingle();
  if (error || !data) {
    if (error) console.error("get-public-lots theme lookup failed", error.message);
    return null;
  }
  const value = (data as { value?: unknown } | null)?.value as Record<string, unknown> | undefined;
  const cssUrl = typeof value?.css_url === "string" ? (value.css_url as string) : null;
  return allowlistTheme(value, cssUrl);
}

function sanitizePolygon(value: unknown): MapPoint[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((p): p is MapPoint =>
      Boolean(p) && typeof p === "object" &&
      Number.isFinite((p as MapPoint).x) && Number.isFinite((p as MapPoint).y)
    )
    .map((p) => ({
      x: Math.min(100, Math.max(0, Number(p.x))),
      y: Math.min(100, Math.max(0, Number(p.y))),
    }))
    .slice(0, 200);
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: { ...corsHeaders, "Cache-Control": "public, max-age=60" },
  });
}
