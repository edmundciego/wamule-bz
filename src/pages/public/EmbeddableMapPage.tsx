import { useParams, useSearchParams } from "react-router-dom";
import { PublicLotMap, type PublicLotColourView, type PublicLotFilter } from "../../components/public/PublicLotMap";

export function EmbeddableMapPage() {
  const { tenant_slug = "", project_slug } = useParams<{ tenant_slug: string; project_slug?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialFilter: PublicLotFilter = searchParams.get("filter") === "available" ? "available" : "all";
  const initialView: PublicLotColourView = searchParams.get("view") === "tier" ? "tier" : "status";
  const initialLot = searchParams.get("lot") ?? undefined;
  // ?demo=1 serves the static /demo-map fixture (dev/test only: the vite
  // fixture plugin serves it in `serve` mode and DEMO-gating below is
  // eliminated from production bundles, so neither the files nor this
  // branch can reach dist/). Hermetic Playwright runs, zero DB writes.
  // Local-only runs against real pipeline output:
  // E2E_FIXTURE_DIR=e2e/fixtures/hopkins. Never linked in production UI.
  const demoDataUrl = import.meta.env.DEV && searchParams.get("demo") ? "/demo-map" : undefined;

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
        onSelectLot={(parcel) => {
          const params = Object.fromEntries(searchParams.entries());
          params.lot = parcel.lot_number;
          setSearchParams(params, { replace: true });
        }}
      />
    </main>
  );
}
