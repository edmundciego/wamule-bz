import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { PublicInquiryPanel } from "../ApplicationPage";
import { HopkinsApplicationWizard } from "./HopkinsApplicationWizard";
import { PublicLotMap, type PublicLotParcel } from "../../components/public/PublicLotMap";
import { Badge } from "../../components/ui/Badge";
import { ErrorState, LoadingState } from "../../components/ui/State";
import { WamuleClassicBuildStamp, WamuleClassicHeader, WamuleClassicHero, WamuleClassicInfoTile, WamuleClassicNotice, WamuleClassicPanel } from "../../components/public/WamuleClassicTemplate";
import hopkinsTierSource from "../../../map-input/hopkins.tiers.json";
import { isHopkinsPublicHost } from "../../lib/publicHosts";
import { hasSupabaseConfig } from "../../lib/supabase";
import { defaultPublicExperience, type PublicSiteModuleId } from "../../lib/publicExperience.mjs";
import { publicMapReferenceLabel } from "../../lib/hopkinsDemoLabels";
import { usePublicSiteExperience } from "../../lib/publicSiteExperience";
import { readPublicMapPreferences, retainKnownMapPreferences, writePublicMapPreferences } from "../../lib/publicDraftState.mjs";

const HOPKINS_SCOPE = { tenant: "hopkins-grove", project: "hopkins-grove", phase: "initial" } as const;
const HOPKINS_SITE_SCOPE = { tenantSlug: "hopkins-grove", projectSlug: "hopkins-grove", phaseSlug: "initial" } as const;
const MAP_URL = "/embed/hopkins-grove/hopkins-grove?phase=initial";
const localDemoOnly = import.meta.env.DEV || import.meta.env.VITE_PUBLIC_DEMO_MODE === "true";
const hopkinsResidentialStartingPrice = Math.min(
  ...Object.values(hopkinsTierSource.tiers)
    .filter((tier) => tier.group === "Residential")
    .map((tier) => tier.price),
);
const hopkinsStartingPriceLabel = hopkinsTierSource.source_pricing.currency_symbol
  + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(hopkinsResidentialStartingPrice)
  + " / ¼ acre";
const hopkinsHomesiteSizeLabel = "Quarter-acre homesites";

type PublicProjectPage = {
  tenant: { name: string; slug: string };
  project: { name: string; slug: string; mapExperienceMode: "sales" | "demo" };
  phase: { name: string; slug: string };
  company: {
    name: string;
    email: string;
    phone: string;
    website: string;
    location: string;
    description: string;
    publicNotice: string;
  };
  applicationSettings: {
    applicationsOpen: boolean;
    noticeVersion: string;
    publicNotice: string;
    acknowledgmentText: string;
    intendedUses: string[];
    maxMapPreferences: number;
    confirmationMessage: string;
  };
};

async function loadPublicProjectPage(): Promise<PublicProjectPage> {
  const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "");
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!baseUrl || !anonKey) throw new Error("The public project page is not configured.");

  const response = await fetch(`${baseUrl}/functions/v1/get-public-project-page`, {
    method: "GET",
    headers: { apikey: anonKey, Accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as PublicProjectPage & { error?: string };
  if (!response.ok || body.tenant?.slug !== HOPKINS_SCOPE.tenant
    || body.project?.slug !== HOPKINS_SCOPE.project || body.phase?.slug !== HOPKINS_SCOPE.phase
    || !body.company?.name || !body.company?.email || !body.company?.publicNotice
    || !body.applicationSettings?.noticeVersion || !body.applicationSettings?.publicNotice
    || !body.applicationSettings?.acknowledgmentText || !Array.isArray(body.applicationSettings?.intendedUses)) {
    throw new Error(body.error || "Hopkins public information could not be verified.");
  }
  return body;
}

export function HopkinsPublicPage({
  enabledModules: selectedModules,
}: {
  enabledModules?: Record<PublicSiteModuleId, boolean>;
} = {}) {
  const location = useLocation();
  const { data: siteExperience } = usePublicSiteExperience(HOPKINS_SITE_SCOPE);
  const experience = siteExperience ?? defaultPublicExperience(HOPKINS_SITE_SCOPE);
  const modules = selectedModules ?? experience.enabledModules;
  const { data: page, isLoading, isError, error } = useQuery({
    queryKey: ["public-project-page", HOPKINS_SCOPE.tenant, HOPKINS_SCOPE.project, HOPKINS_SCOPE.phase],
    queryFn: loadPublicProjectPage,
    enabled: hasSupabaseConfig,
    retry: false,
    staleTime: 60_000,
  });
  const [selectedMapFeatureRefs, setSelectedMapFeatureRefs] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    return readPublicMapPreferences(window.localStorage, HOPKINS_SITE_SCOPE);
  });
  const [mapFeatureLabels, setMapFeatureLabels] = useState<Array<{ ref: string; label: string }>>([]);
  const [mapPreferenceError, setMapPreferenceError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    writePublicMapPreferences(window.localStorage, HOPKINS_SITE_SCOPE, selectedMapFeatureRefs);
  }, [selectedMapFeatureRefs]);

  useEffect(() => {
    const priorTitle = document.title;
    const descriptionMeta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const applicationMeta = document.querySelector<HTMLMetaElement>('meta[name="application-name"]');
    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const priorDescription = descriptionMeta?.content;
    const priorApplicationName = applicationMeta?.content;
    const priorTheme = themeMeta?.content;
    const iconLinks = [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')];
    const priorIcons = iconLinks.map((link) => link.href);
    document.title = "Hopkins Grove | Ceiba Realty & Development";
    if (descriptionMeta) descriptionMeta.content = "Explore the Hopkins Grove project map and contact Ceiba Realty & Development for current information.";
    if (applicationMeta) applicationMeta.content = "Hopkins Grove";
    if (themeMeta) themeMeta.content = "#173f2d";
    iconLinks.forEach((link) => { link.href = "/favicon/hopkins-grove.svg"; });
    return () => {
      document.title = priorTitle;
      if (descriptionMeta && priorDescription !== undefined) descriptionMeta.content = priorDescription;
      if (applicationMeta && priorApplicationName !== undefined) applicationMeta.content = priorApplicationName;
      if (themeMeta && priorTheme !== undefined) themeMeta.content = priorTheme;
      iconLinks.forEach((link, index) => { link.href = priorIcons[index] ?? link.href; });
    };
  }, []);

  useEffect(() => {
    if (!page) return;
    if (location.pathname === "/hopkins/application") {
      window.requestAnimationFrame(() => document.getElementById("application")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      return;
    }
    if (location.pathname !== "/hopkins/apply" && !(isHopkinsPublicHost(window.location.hostname) && location.pathname === "/apply")) return;
    window.requestAnimationFrame(() => document.getElementById("interest")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [location.pathname, page, modules.map]);

  function toggleMapFeature(parcel: PublicLotParcel) {
    const ref = parcel.map_feature_ref;
    if (!ref) return;
    setMapPreferenceError(null);
    if (selectedMapFeatureRefs.includes(ref)) {
      setSelectedMapFeatureRefs((current) => current.filter((item) => item !== ref));
      return;
    }
    const limit = page?.applicationSettings.maxMapPreferences ?? 5;
    if (selectedMapFeatureRefs.length >= limit) {
      setMapPreferenceError(`Choose no more than ${limit} map outlines.`);
      return;
    }
    setSelectedMapFeatureRefs((current) => current.includes(ref) ? current : [...current, ref]);
  }

  function updateMapFeatures(features: PublicLotParcel[]) {
    const nextLabels = features.flatMap((feature) => feature.map_feature_ref
      ? [{ ref: feature.map_feature_ref, label: publicMapReferenceLabel(feature.demo_label) }]
      : []);
    const allowedRefs = nextLabels.map((feature) => feature.ref);
    setMapFeatureLabels(nextLabels);
    setSelectedMapFeatureRefs((current) => retainKnownMapPreferences(current, allowedRefs));
  }

  if (isLoading) return <main className="min-h-screen bg-[#fffdf8] px-4 py-20"><LoadingState label="Loading Hopkins Grove information" /></main>;
  if (experience.uiRestrictedAccess) return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-10">
      <section className="grid max-w-xl gap-3 rounded-xl border border-warning/30 bg-card p-6 shadow-sm" data-testid="ui-only-restricted-preview" role="status">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-warning-foreground">UI-only restriction · incomplete</p>
        <h1 className="font-display text-2xl font-semibold text-primary">This public preview is hidden</h1>
        <p className="text-sm leading-6 text-muted-foreground">This tenant/project flag hides the page in the interface only. Its map and company endpoints are still public; server-side access enforcement has not been implemented.</p>
        <Link to="/version?tenant=hopkins-grove&project=hopkins-grove&phase=initial" className="w-fit text-sm font-semibold text-primary underline">Build and map diagnostics</Link>
      </section>
    </main>
  );

  if (isError || !page) return <main className="mx-auto grid min-h-screen max-w-3xl content-center gap-4 bg-[#fffdf8] px-4 py-12"><h1 className="font-display text-3xl font-semibold text-[#173f2d]">Hopkins Grove information is temporarily unavailable</h1><ErrorState message={error instanceof Error ? error.message : "Please contact Ceiba Realty & Development directly."} /><a className="text-sm font-semibold text-[#173f2d] underline" href="mailto:properties@ceibabelize.com">Contact the project team</a></main>;

  return <HopkinsWamuleClassicPage
    page={page}
    modules={modules}
    selectedMapFeatureRefs={selectedMapFeatureRefs}
    mapFeatureLabels={mapFeatureLabels}
    mapPreferenceError={mapPreferenceError}
    onToggleMapFeature={toggleMapFeature}
    onRemoveMapFeature={(ref) => {
      setSelectedMapFeatureRefs((current) => current.filter((item) => item !== ref));
      setMapPreferenceError(null);
    }}
    onParcelsLoaded={updateMapFeatures}
    localDemoOnly={localDemoOnly}
    hasSupabaseConfig={hasSupabaseConfig}
  />;
}

function HopkinsWamuleClassicPage({
  page,
  modules,
  selectedMapFeatureRefs,
  mapFeatureLabels,
  mapPreferenceError,
  onToggleMapFeature,
  onRemoveMapFeature,
  onParcelsLoaded,
  localDemoOnly,
  hasSupabaseConfig,
}: {
  page: PublicProjectPage;
  modules: Record<PublicSiteModuleId, boolean>;
  selectedMapFeatureRefs: string[];
  mapFeatureLabels: Array<{ ref: string; label: string }>;
  mapPreferenceError: string | null;
  onToggleMapFeature: (parcel: PublicLotParcel) => void;
  onRemoveMapFeature: (ref: string) => void;
  onParcelsLoaded: (features: PublicLotParcel[]) => void;
  localDemoOnly: boolean;
  hasSupabaseConfig: boolean;
}) {
  const selectedMapPreferences = selectedMapFeatureRefs.map((ref) => ({
    ref,
    label: mapFeatureLabels.find((item) => item.ref === ref)?.label ?? "Map reference",
  }));
  return (
    <main data-site-template="wamule-classic" data-public-tenant="hopkins-grove" className="min-h-screen bg-background">
      <WamuleClassicHeader
        companyName={page.company.name}
        logoUrl="/favicon/hopkins-grove.svg"
        homeHref={isHopkinsPublicHost(window.location.hostname) ? "/" : "/hopkins"}
        mapHref="#lots"
        applyHref="#application"
        applyLabel="Apply"
        showApply={modules.application}
        mapLabel="Project map"
      />

      <div className="mx-auto max-w-6xl px-4 pt-3">
        <p className="rounded-md border border-primary/10 bg-primary-soft/35 px-3 py-2 text-xs leading-5 text-primary" role="note" data-testid="independent-demo-banner">
          Independent demonstration. Not affiliated with or endorsed by Ceiba. Demo submissions are not sent to Ceiba.
          {localDemoOnly ? <span className="block font-medium">In this local preview, form entries stay in memory and are not sent to a hosted service.</span> : null}
        </p>
      </div>

      <WamuleClassicHero
        badge={<Badge tone={page.applicationSettings.applicationsOpen ? "green" : "amber"}>{page.phase.name} applications {page.applicationSettings.applicationsOpen ? "open" : "closed"}</Badge>}
        title={page.project.name + " Project Application"}
        description={page.company.description}
        facts={<>
          <WamuleClassicInfoTile label="Starting price" value={hopkinsStartingPriceLabel} />
          <WamuleClassicInfoTile label="Lot sizes" value={hopkinsHomesiteSizeLabel} />
          <WamuleClassicInfoTile label="Project phase" value={page.phase.name} />
        </>}
        actions={modules.application ? <a className="focus-ring inline-flex h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-px hover:bg-primary-hover hover:shadow-[var(--shadow-button)]" href="#application">
          Start application <ArrowRight className="h-4 w-4" />
        </a> : null}
        sideContent={<WamuleClassicPanel
          title="Available Lot Preferences"
          description="Choose optional map references in the project map below."
          trailing={<Badge tone="slate">Map preferences</Badge>}
        >
          {selectedMapPreferences.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {selectedMapPreferences.map(({ ref, label }) => (
                <div key={ref} className="min-w-0 rounded-lg border border-primary/15 bg-primary-soft/45 p-3 text-sm">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <strong className="min-w-0 break-words text-primary">{label}</strong>
                    <span className="shrink-0 rounded-full border border-primary/15 bg-card px-2 py-1 text-xs font-semibold text-primary">Preference</span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">Map reference only · not confirmed availability</p>
                  <button
                    type="button"
                    className="focus-ring mt-2 inline-flex min-h-9 items-center rounded-md px-2 text-xs font-semibold text-secondary underline underline-offset-2"
                    aria-label={"Remove map preference " + label}
                    onClick={() => onRemoveMapFeature(ref)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-dashed bg-muted p-5 text-sm leading-6 text-muted-foreground">
              No map references selected yet. Choose an outline in the project map below to add an optional preference here.
            </div>
          )}
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            Map references are preferences only. They are not saleable parcel inventory, do not confirm availability, and do not reserve or allocate land.
          </p>
        </WamuleClassicPanel>}
      />

      {modules.inquiry ? <section id="interest" className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-6">
        <PublicInquiryPanel
          companyName={page.company.name}
          tenantSlug={HOPKINS_SCOPE.tenant}
          projectSlug={HOPKINS_SCOPE.project}
          phaseSlug={HOPKINS_SCOPE.phase}
          parcels={[]}
          showPrices={false}
          hasSupabaseConfig={hasSupabaseConfig}
          localDemoOnly={localDemoOnly}
          interestOptions={["General project interest", "Map outline question", "Site visit", "Buying process"]}
          introPrompt="Not ready to apply yet?"
          introDescription={"Have questions about " + page.project.name + ", the project map, or visiting the site? Tell Ceiba Realty & Development what you would like to know."}
          introNotice="This inquiry is for information only. It does not allocate a map outline, create parcel inventory, or reserve a lot."
          confirmationNote="Your request was saved for Hopkins. It does not assign a map outline or create parcel inventory."
          footerNote="Map references are not parcel inventory; this inquiry does not allocate or reserve land."
          mapHref="#lots"
        />
      </section> : null}

      <WamuleClassicNotice
        notice={page.company.publicNotice}
        companyName={page.company.name}
        location={page.company.location}
      />

      {modules.map ? <section id="lots" className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-8">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl font-semibold text-primary">Hopkins Grove project map</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              Select an outline for published source information. Outline references remain separate from saleable parcel inventory.
            </p>
          </div>
          <a className="text-sm font-semibold text-primary underline underline-offset-4" href={MAP_URL}>Open standalone map</a>
        </div>
        <div className="min-w-0 overflow-visible rounded-lg border bg-card shadow-[var(--shadow-card)]">
          <PublicLotMap
            tenantSlug={HOPKINS_SCOPE.tenant}
            projectSlug={HOPKINS_SCOPE.project}
            phaseSlug={HOPKINS_SCOPE.phase}
            showPrices={modules.pricing}
            enableInquiry
            initialView="tier"
            initialFit="outlines"
            detailsPlacement="below"
            localDemoOnly={localDemoOnly}
            selectedMapFeatureRefs={selectedMapFeatureRefs}
            onToggleMapFeature={onToggleMapFeature}
            onParcelsLoaded={onParcelsLoaded}
          />
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">Source pricing is informational. Selection records an optional map-outline preference only.</p>
      </section> : null}

      {modules.application ? <HopkinsApplicationWizard
        projectName={page.project.name}
        applicationSettings={page.applicationSettings}
        modules={modules}
        selectedMapFeatureRefs={selectedMapFeatureRefs}
        mapFeatureLabels={mapFeatureLabels}
        mapPreferenceError={mapPreferenceError}
        onToggleMapFeature={onToggleMapFeature}
        onRemoveMapFeature={onRemoveMapFeature}
        onParcelsLoaded={onParcelsLoaded}
        localDemoOnly={localDemoOnly}
      /> : null}

      <footer className="mx-auto flex max-w-6xl flex-col gap-1 border-t border-border px-4 py-5 text-xs leading-5 text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p><span className="font-semibold text-primary">{page.project.name}</span> · {page.company.name}</p>
        <div className="flex flex-col gap-1 text-left sm:items-end sm:text-right">
          <p>Public project preview · <Link to={MAP_URL} className="font-semibold text-primary underline underline-offset-2">Standalone map</Link></p>
          <WamuleClassicBuildStamp scope={HOPKINS_SITE_SCOPE} />
        </div>
      </footer>
    </main>
  );
}
