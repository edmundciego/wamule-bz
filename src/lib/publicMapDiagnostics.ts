export type PublicMapDiagnosticsScope = {
  tenantSlug: string;
  projectSlug: string;
  phaseSlug: string;
};

export type PublicMapDiagnostics = {
  tenantName: string | null;
  projectName: string | null;
  phaseName: string | null;
  activeMasterplanVersionId: string | null;
  masterplanImageUrl: string | null;
  phonePreviewUrl: string | null;
  displayedImageUrl: string | null;
  displayedImageKind: "phone preview" | "full masterplan" | "unavailable";
  imageWidth: number | null;
  imageHeight: number | null;
  loadedOutlineCount: number | null;
};

type MapEndpointResponse = {
  tenant?: { name?: unknown; slug?: unknown };
  project?: { name?: unknown; slug?: unknown } | null;
  phase?: { name?: unknown; slug?: unknown } | null;
  masterplan_version_id?: unknown;
  masterplan_image_url?: unknown;
  masterplan_preview_url?: unknown;
  features?: Array<{ map_polygon?: unknown }>;
  parcels?: Array<{ map_polygon?: unknown }>;
  error?: unknown;
};

function safeMapUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, window.location.origin);
    return `${url.origin}${url.pathname}${url.search ? " (query parameters hidden)" : ""}`;
  } catch {
    return null;
  }
}

function countLoadedOutlines(body: MapEndpointResponse): number {
  const rows = Array.isArray(body.features) ? body.features : Array.isArray(body.parcels) ? body.parcels : [];
  return rows.filter((row) => Array.isArray(row.map_polygon) && row.map_polygon.length >= 3).length;
}

function probeImageDimensions(url: string | null): Promise<{ width: number; height: number } | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    const timer = window.setTimeout(() => resolve(null), 8000);
    image.onload = () => {
      window.clearTimeout(timer);
      resolve(image.naturalWidth > 0 && image.naturalHeight > 0
        ? { width: image.naturalWidth, height: image.naturalHeight }
        : null);
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    image.src = url;
  });
}

/** Load only the public map response for one explicit tenant/project/phase. */
export async function loadPublicMapDiagnostics(
  scope: PublicMapDiagnosticsScope,
  viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth,
): Promise<PublicMapDiagnostics> {
  const endpoint = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "");
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!endpoint || !anonKey) throw new Error("The public map service is not configured.");

  const params = new URLSearchParams({ tenant: scope.tenantSlug, project: scope.projectSlug, phase: scope.phaseSlug });
  const response = await fetch(`${endpoint}/functions/v1/get-public-lots?${params}`, {
    method: "GET",
    headers: { apikey: anonKey, Accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as MapEndpointResponse;
  if (!response.ok || body.tenant?.slug !== scope.tenantSlug
    || body.project?.slug !== scope.projectSlug || body.phase?.slug !== scope.phaseSlug) {
    throw new Error(typeof body.error === "string" ? body.error : "The scoped public map response could not be verified.");
  }

  const masterplanUrl = typeof body.masterplan_image_url === "string" ? body.masterplan_image_url : null;
  const previewUrl = typeof body.masterplan_preview_url === "string" ? body.masterplan_preview_url : null;
  const usePhonePreview = viewportWidth < 768 && Boolean(previewUrl);
  const imageUrl = usePhonePreview ? previewUrl : masterplanUrl;
  const dimensions = await probeImageDimensions(imageUrl);

  return {
    tenantName: typeof body.tenant?.name === "string" ? body.tenant.name : null,
    projectName: typeof body.project?.name === "string" ? body.project.name : null,
    phaseName: typeof body.phase?.name === "string" ? body.phase.name : null,
    activeMasterplanVersionId: typeof body.masterplan_version_id === "string" ? body.masterplan_version_id : null,
    masterplanImageUrl: safeMapUrl(masterplanUrl),
    phonePreviewUrl: safeMapUrl(previewUrl),
    displayedImageUrl: safeMapUrl(imageUrl),
    displayedImageKind: imageUrl ? usePhonePreview ? "phone preview" : "full masterplan" : "unavailable",
    imageWidth: dimensions?.width ?? null,
    imageHeight: dimensions?.height ?? null,
    loadedOutlineCount: countLoadedOutlines(body),
  };
}
