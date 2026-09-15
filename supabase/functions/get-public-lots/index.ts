import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Open CORS: permits external fetches from WordPress domains embedding the lot map.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

type MapPoint = { x: number; y: number };

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

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // -- Tenant lookup: slug first, then inbound alias. Inactive/missing -> 404.
  // -- Service-role reads stay server-side; only public-safe fields are returned.
  const organization = await resolveOrganization(supabase, tenantParam);
  if (!organization) {
    return json({ error: "Tenant not found or inactive." }, 404);
  }

  const [{ data: parcels, error: parcelsError }, branding] = await Promise.all([
    supabase
      .from("parcels")
      .select("id, lot_number, status, base_price, dimensions, zoning, map_polygon")
      .eq("tenant_id", organization.id)
      .order("lot_number", { ascending: true }),
    loadBranding(supabase, organization),
  ]);

  if (parcelsError) {
    console.error("get-public-lots parcels query failed", parcelsError.message);
    return json({ error: "Could not load lot availability." }, 500);
  }

  return json({
    tenant: { name: organization.name, slug: organization.slug },
    masterplan_image_url: branding.masterplanImageUrl,
    branding: branding.public,
    parcels: (parcels ?? []).map((parcel) => ({
      id: parcel.id,
      lot_number: parcel.lot_number,
      status: parcel.status,
      price: Number(parcel.base_price ?? 0),
      dimensions: parcel.dimensions,
      map_polygon: sanitizePolygon(parcel.map_polygon),
    })),
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
  let masterplanImageUrl = org.masterplan_image_url;
  let companyProfile: Record<string, unknown> = {};

  const { data: settings, error } = await supabase
    .from("business_settings")
    .select("key, value")
    .eq("tenant_id", org.id)
    .in("key", ["company_profile", "masterplan_image_url"]);
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
    }
  }

  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    masterplanImageUrl,
    public: {
      company_name: text(companyProfile.company_name) || org.name,
      logo_url: text(companyProfile.logo_url),
      short_description: text(companyProfile.short_description),
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
