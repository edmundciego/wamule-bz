import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { PublicLotMap, type PublicLotColourView, type PublicLotFilter } from "../../components/public/PublicLotMap";
import type { PublicExperienceScope } from "../../lib/publicExperience.mjs";
import type { PublicPhaseOption } from "../../lib/publicSiteExperience";

export function EmbeddableMapPage({
  hostname,
  scope,
  phases,
}: {
  hostname: string;
  scope: PublicExperienceScope;
  phases: PublicPhaseOption[];
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const initialFilter: PublicLotFilter = searchParams.get("filter") === "available" ? "available" : "all";
  const initialView: PublicLotColourView = searchParams.get("view") === "tier" ? "tier" : "status";
  const initialLot = searchParams.get("lot") ?? undefined;
  const initialFeatureRef = searchParams.get("feature") ?? undefined;
  const requestedPhase = searchParams.get("phase") ?? scope.phaseSlug;

  function changePhase(phaseSlug: string) {
    const params = new URLSearchParams(location.search);
    params.set("phase", phaseSlug);
    navigate(`${location.pathname}?${params.toString()}`);
  }

  return (
    <main className="relative flex h-screen w-screen flex-col overflow-hidden bg-background" style={{ width: "100vw", height: "100vh" }}>
      {phases.length > 1 ? <label className="absolute left-4 top-4 z-50 flex items-center gap-2 rounded-md border bg-card/95 px-3 py-2 text-sm shadow-sm">
        <span>Phase</span>
        <select aria-label="Project phase" value={scope.phaseSlug} onChange={(event) => changePhase(event.target.value)} className="bg-transparent font-semibold">
          {phases.map((phase) => <option key={phase.slug} value={phase.slug}>{phase.name}</option>)}
        </select>
      </label> : null}
      <PublicLotMap
        key={`${hostname}/${scope.tenantSlug}/${scope.projectSlug}/${scope.phaseSlug}`}
        hostname={hostname}
        tenantSlug={scope.tenantSlug}
        projectSlug={scope.projectSlug}
        phaseSlug={requestedPhase}
        initialFilter={initialFilter}
        initialView={initialView}
        initialLotNumber={initialLot}
        initialFeatureRef={initialFeatureRef}
        onClearSelection={() => {
          const params = Object.fromEntries(searchParams.entries());
          delete params.lot;
          delete params.feature;
          setSearchParams(params, { replace: true });
        }}
        onSelectLot={(parcel) => {
          const params = Object.fromEntries(searchParams.entries());
          params.lot = parcel.demo_label ?? parcel.lot_number;
          if (parcel.map_feature_ref) params.feature = parcel.map_feature_ref;
          setSearchParams(params, { replace: true });
        }}
      />
    </main>
  );
}
