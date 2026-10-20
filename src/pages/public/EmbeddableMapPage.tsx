import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { PublicLotMap, type PublicLotColourView, type PublicLotFilter } from "../../components/public/PublicLotMap";
import { demoPlotLabel } from "../../lib/hopkinsDemoLabels";
import { isLocalOnlySubmissionForProject } from "../../lib/publicSubmissionMode";

export function EmbeddableMapPage() {
  const { tenant_slug = "", project_slug } = useParams<{ tenant_slug: string; project_slug?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialFilter: PublicLotFilter = searchParams.get("filter") === "available" ? "available" : "all";
  const initialView: PublicLotColourView = searchParams.get("view") === "tier" ? "tier" : "status";
  const initialLot = searchParams.get("lot") ?? undefined;
  // Dev-only Hopkins fixture and correction manifest. The normal Hopkins
  // demo route shares the canonical project/phase preview store; the former
  // preview=local query remains a backward-compatible alias.
  const demoMode = searchParams.get("demo");
  const demoDataUrl = import.meta.env.DEV
    ? demoMode === "hopkins" ? "/demo-hopkins-map" : demoMode === "1" ? "/demo-map" : undefined
    : undefined;
  const isHopkinsDemoRoute = (tenant_slug === "demo" && !project_slug)
    || (tenant_slug === "hopkins-grove" && (!project_slug || project_slug === "map-review"));
  const localPreviewEnabled = import.meta.env.DEV && demoMode === "hopkins" && isHopkinsDemoRoute;
  const requestedPhase = searchParams.get("phase") ?? "default";
  const publicPhaseSlug = searchParams.get("phase") ?? undefined;
  const localMapPreviewScope = useMemo(() => {
    if (!localPreviewEnabled) return undefined;
    const phaseSlug = /^[a-z0-9][a-z0-9-]{0,62}$/.test(requestedPhase) ? requestedPhase : "default";
    return { tenantSlug: "hopkins-grove", projectSlug: "map-review", phaseSlug };
  }, [localPreviewEnabled, requestedPhase]);

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-background" style={{ width: "100vw", height: "100vh" }}>
      <PublicLotMap
        tenantSlug={tenant_slug}
        projectSlug={project_slug}
        phaseSlug={publicPhaseSlug}
        showPrices={!localPreviewEnabled}
        enableInquiry={!localPreviewEnabled}
        localDemoOnly={isLocalOnlySubmissionForProject(tenant_slug, project_slug)}
        initialFilter={initialFilter}
        initialView={initialView}
        initialLotNumber={initialLot}
        demoDataUrl={demoDataUrl}
        demoCorrectionManifestUrl={localPreviewEnabled && demoDataUrl ? `${demoDataUrl}/local-corrections.json` : undefined}
        localMapPreviewScope={localMapPreviewScope}
        onClearSelection={() => {
          const params = Object.fromEntries(searchParams.entries());
          delete params.lot;
          setSearchParams(params, { replace: true });
        }}
        onSelectLot={(parcel) => {
          const params = Object.fromEntries(searchParams.entries());
          params.lot = localPreviewEnabled ? demoPlotLabel(parcel) : parcel.demo_label ?? parcel.lot_number;
          if (parcel.is_studio_feature && parcel.map_feature_ref) params.lot = parcel.map_feature_ref;
          setSearchParams(params, { replace: true });
        }}
      />
    </main>
  );
}
