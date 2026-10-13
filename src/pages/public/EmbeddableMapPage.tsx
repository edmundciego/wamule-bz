import { useParams, useSearchParams } from "react-router-dom";
import { PublicLotMap, type PublicLotColourView, type PublicLotFilter } from "../../components/public/PublicLotMap";

export function EmbeddableMapPage() {
  const { tenant_slug = "", project_slug } = useParams<{ tenant_slug: string; project_slug?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialFilter: PublicLotFilter = searchParams.get("filter") === "available" ? "available" : "all";
  const initialView: PublicLotColourView = searchParams.get("view") === "tier" ? "tier" : "status";
  const initialLot = searchParams.get("lot") ?? undefined;
  // Demo fixtures are dev-only. `?demo=1` is the synthetic test fixture;
  // `?demo=hopkins` is the local candidate-geometry review using the sales
  // plat. Vite's serve-only fixture middleware and this DEV branch are both
  // absent from production output, so neither source files nor this route
  // can reach dist/.
  const demoMode = searchParams.get("demo");
  const demoDataUrl = import.meta.env.DEV && demoMode
    ? demoMode === "hopkins" ? "/demo-hopkins-map" : "/demo-map"
    : undefined;

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-background" style={{ width: "100vw", height: "100vh" }}>
      <PublicLotMap
        tenantSlug={tenant_slug}
        projectSlug={project_slug}
        enableInquiry
        showPrices
        initialFilter={initialFilter}
        initialView={initialView}
        initialLotNumber={initialLot}
        demoDataUrl={demoDataUrl}
        onClearSelection={() => {
          const params = Object.fromEntries(searchParams.entries());
          delete params.lot;
          setSearchParams(params, { replace: true });
        }}
        onSelectLot={(parcel) => {
          const params = Object.fromEntries(searchParams.entries());
          params.lot = parcel.lot_number;
          setSearchParams(params, { replace: true });
        }}
      />
    </main>
  );
}
