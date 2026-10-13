import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { allowlistTheme } from "../../../src/lib/theme.ts";
import { safeTenantThemeCssUrl } from "./public-theme.mjs";
import { assignPublicLotReferences } from "../_shared/public-lot-reference.ts";
import {
  applyActiveVersionProjectScope,
  applyProjectAndVersionScope,
  chooseResolvedProject,
  normalizeActiveMapLookup,
  projectAllowsTenantFallback,
} from "./project-scope.mjs";

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
// object returned by this endpoint. The project-scoped public_ref replaces
// the internal database id; tier display fields and effective price are
// public; QA/ops columns
// (price_override_cents, confidence, needs_review, geometry_source,
// masterplan_version_id) and everything else (AI provider keys,
// authorization metadata, internal notes, creator columns, tenant scoping,
// zoning, ...) are stripped by toPublicParcel before serialization.
const PUBLIC_PARCEL_FIELDS = [
  "public_ref",
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

function toPublicParcel(
  parcel: Record<string, unknown>,
  tiersByKey: Map<string, TierRow>,
  publicRef: string | null,
) {
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
    public_ref: publicRef,
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

  const projectResolution = await resolveProject(supabase, organization.id, projectParam);
  if (!projectResolution.ok) {
    return json({ error: "Could not resolve project map." }, 500);
  }
  const project = projectResolution.project;
  if (projectParam && !project) {
    return json({ error: "Project not found." }, 404);
  }

  const [activeVersionResolution, settingsResolution] = await Promise.all([
    loadActiveVersion(supabase, organization.id, project?.id ?? null),
    loadPublicSettings(supabase, organization.id, project),
  ]);
  if (!activeVersionResolution.ok || !settingsResolution.ok) {
    return json({ error: "Could not resolve project map settings." }, 500);
  }
  const activeVersion = activeVersionResolution.version;
  const publicSettings = settingsResolution.settings;

  // Project and active-version scoping happen in the database query so the
  // service-role function never loads unrelated tenant parcels into memory.
  const parcelQuery = applyProjectAndVersionScope(
    supabase
      .from("parcels")
      .select("lot_number, status, base_price, dimensions, map_polygon, tier_key, is_corner, price_override_cents, masterplan_version_id, project_id")
      .eq("tenant_id", organization.id),
    project,
    activeVersion?.id ?? null,
  ).order("lot_number", { ascending: true });
  const [{ data: parcels, error: parcelsError }, tiersResolution] = await Promise.all([
    parcelQuery,
    loadTiers(supabase, organization.id, project),
  ]);

  if (parcelsError) {
    console.error("get-public-lots parcels query failed", parcelsError.message);
    return json({ error: "Could not load lot availability." }, 500);
  }
  if (!tiersResolution.ok) {
    return json({ error: "Could not resolve project tier catalogue." }, 500);
  }

  const branding = buildBranding(organization, project, activeVersion, publicSettings);
  const tiersByKey = tiersResolution.tiers;
  const theme = buildTheme(publicSettings, organization.id, project);

  const publicReferences = assignPublicLotReferences(
    project?.slug ?? null,
    (parcels ?? []).map((parcel) => (parcel as Record<string, unknown>).lot_number),
  );

  return json({
    tenant: { name: organization.name, slug: organization.slug },
    project: project ? { slug: project.slug, name: project.name } : null,
    masterplan_image_url: branding.masterplanImageUrl,
    masterplan_preview_url: branding.masterplanPreviewUrl,
    branding: branding.public,
    theme,
    parcels: (parcels ?? []).map((parcel, index) =>
      toPublicParcel(parcel as Record<string, unknown>, tiersByKey, publicReferences[index] ?? null)
    ),
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

async function loadTiers(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  project: ResolvedProject | null,
): Promise<{ ok: true; tiers: Map<string, TierRow> } | { ok: false; tiers: Map<string, TierRow> }> {
  const tierFields = "tier_key, label, price_cents, corner_premium_cents, color_hex";
  const scoped = project
    ? await supabase.from("project_lot_tiers").select(`${tierFields}, is_active`)
      .eq("tenant_id", tenantId).eq("project_id", project.id)
    : { data: null, error: null };
  if (scoped.error) {
    console.error("get-public-lots project tiers query failed", scoped.error.message);
    return { ok: false, tiers: new Map() };
  }
  const scopedRows = scoped.data ?? [];
  let rows = scopedRows.filter((row) => (row as TierRow & { is_active?: boolean }).is_active !== false);
  // Only the default project may use the old tenant-level catalogue. A
  // non-default project never silently inherits another phase's prices.
  if (scopedRows.length === 0 && projectAllowsTenantFallback(project)) {
    const legacy = await supabase.from("lot_tiers").select(tierFields)
      .eq("tenant_id", tenantId).eq("is_active", true);
    if (legacy.error) {
      console.error("get-public-lots legacy tiers query failed", legacy.error.message);
      return { ok: false, tiers: new Map() };
    }
    rows = legacy.data ?? [];
  }
  return {
    ok: true,
    tiers: new Map(rows.map((row) => [(row as TierRow).tier_key, row as TierRow])),
  };
}

type ActiveVersion = { id: string; imageUrl: string | null; previewUrl: string | null };
type ActiveVersionResolution = { ok: true; version: ActiveVersion | null } | { ok: false; version: null };

async function loadActiveVersion(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  projectId: string | null,
): Promise<ActiveVersionResolution> {
  const { data, error } = await applyActiveVersionProjectScope(
    supabase.from("masterplan_versions").select("id, image_url, preview_url"),
    tenantId,
    projectId,
  ).maybeSingle();
  if (error) {
    console.error("get-public-lots active version lookup failed", error.message);
    return normalizeActiveMapLookup(null, error);
  }
  return normalizeActiveMapLookup(data as { id?: unknown } | null, null);
}

type ResolvedProject = { id: string; slug: string; name: string; isDefault: boolean };
type ProjectResolution = { ok: true; project: ResolvedProject | null } | { ok: false };

/**
 * Explicit project lookup scoped to the tenant (never by Host header).
 * slug=null → default project; no project rows → legacy tenant-level map.
 */
async function resolveProject(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  slug: string | null,
): Promise<ProjectResolution> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, slug, name, is_default, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("get-public-lots project lookup failed", error.message);
    return { ok: false };
  }
  const rows = ((data ?? []) as Array<{ id: string; slug: string; name: string; is_default: boolean }>);
  if (!slug && rows.length > 0 && !rows.some((row) => row.is_default)) {
    console.error("get-public-lots tenant has projects but no default project");
    return { ok: false };
  }
  return { ok: true, project: chooseResolvedProject(rows, slug) };
}

/**
 * Tenant theme, allowlisted server-side (unknown keys dropped, colors
 * hex-gated, texts stripped). Null when the tenant never published one —
 * clients fall back to built-in defaults.
 */
type PublicSettings = Record<string, unknown>;
type SettingsResolution = { ok: true; settings: PublicSettings } | { ok: false; settings: PublicSettings };

async function loadPublicSettings(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  project: ResolvedProject | null,
): Promise<SettingsResolution> {
  const settings: PublicSettings = {};
  if (project) {
    const scoped = await supabase.from("project_settings").select("key, value")
      .eq("tenant_id", tenantId).eq("project_id", project.id)
      .in("key", ["tenant_theme", "company_profile"]);
    if (scoped.error) {
      console.error("get-public-lots project settings query failed", scoped.error.message);
      return { ok: false, settings };
    }
    for (const row of scoped.data ?? []) settings[row.key] = row.value;
  }

  // Legacy/default-only compatibility. For non-default projects this query
  // must not happen: tenant settings describe the default map, not this phase.
  if (projectAllowsTenantFallback(project)) {
    const legacy = await supabase.from("business_settings").select("key, value")
      .eq("tenant_id", tenantId)
      .in("key", ["tenant_theme", "company_profile", "masterplan_image_url", "masterplan_preview_url"]);
    if (legacy.error) {
      console.error("get-public-lots legacy settings query failed", legacy.error.message);
      return { ok: false, settings };
    }
    for (const row of legacy.data ?? []) {
      const key = row.key === "tenant_theme" ? "tenant_theme" : row.key;
      if (settings[key] === undefined) settings[key] = row.value;
    }
  }
  return { ok: true, settings };
}

function recordSetting(settings: PublicSettings, key: string): Record<string, unknown> {
  const value = settings[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function buildTheme(settings: PublicSettings, tenantId: string, project: ResolvedProject | null) {
  const value = recordSetting(settings, "tenant_theme");
  // tenant-publish stores the shared theme contract's camelCase `cssUrl`.
  // Read the legacy snake_case spelling only for older rows, then constrain
  // either value to this tenant's published public Storage CSS asset.
  const storedCssUrl = typeof value?.cssUrl === "string"
    ? value.cssUrl
    : typeof value?.css_url === "string" ? value.css_url : null;
  // overrides.css currently scopes selectors to the tenant wrapper, not a
  // project wrapper. Do not load project-specific CSS into pages that may
  // contain multiple project embeds; project token/card settings stay scoped.
  const cssUrl = projectAllowsTenantFallback(project)
    ? safeTenantThemeCssUrl(storedCssUrl, supabaseUrl, tenantId)
    : null;
  if (storedCssUrl && !cssUrl) console.error("get-public-lots omitted unsupported or unsafe project theme CSS URL");
  return allowlistTheme(value, cssUrl);
}

function buildBranding(
  organization: OrganizationRow,
  project: ResolvedProject | null,
  activeVersion: ActiveVersion | null,
  settings: PublicSettings,
) {
  const profile = recordSetting(settings, "company_profile");
  const legacyMap = recordSetting(settings, "masterplan_image_url");
  const legacyPreview = recordSetting(settings, "masterplan_preview_url");
  const imageFallback = projectAllowsTenantFallback(project)
    ? (organization.masterplan_image_url || (typeof legacyMap.url === "string" ? legacyMap.url : null))
    : null;
  const previewFallback = projectAllowsTenantFallback(project) && typeof legacyPreview.url === "string"
    ? legacyPreview.url
    : null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    masterplanImageUrl: activeVersion?.imageUrl ?? imageFallback,
    masterplanPreviewUrl: activeVersion ? activeVersion.previewUrl : previewFallback,
    public: {
      company_name: text(profile.company_name) || organization.name,
      logo_url: text(profile.logo_url),
      short_description: text(profile.short_description),
    },
  };
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
