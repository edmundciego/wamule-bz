import { ArrowDown, ArrowRight, ArrowUpRight } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { usePublicApplicationPlots } from "../../lib/publicApplicationPlots";
import { applyPublicPageMetadata, publicCanonicalUrl } from "../../lib/publicPageMetadata";
import { getPublicApplicationAccess, type PublicPhaseOption, type PublicSiteData } from "../../lib/publicSiteExperience";
import { money } from "../../lib/utils";
import { Select } from "../ui/Field";
import { PublicInquiryPanel } from "./PublicInquiryPanel";
import { PublicLotMap } from "./PublicLotMap";

const primaryLink = "focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-hover";
const secondaryLink = "focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border bg-card px-4 py-2 text-sm font-semibold text-primary hover:bg-primary-soft";

export function PublicHomepage({
  data,
  hostname,
  phases,
  application,
  applicationHref,
  mapHref,
  applyWithOutline,
}: {
  data: PublicSiteData;
  hostname: string;
  phases: PublicPhaseOption[];
  application: ReactNode;
  applicationHref: string;
  mapHref: string;
  applyWithOutline?: (ref: string) => void;
}) {
  const { scope, company, projectName, publicApplication: settings, siteExperience } = data;
  const modules = siteExperience.enabledModules;
  const purchase = siteExperience.applicationType === "land_purchase";
  const { canSubmit } = getPublicApplicationAccess(data, hostname);
  const [searchParams, setSearchParams] = useSearchParams();
  const { pathname, search } = useLocation();
  const showLotPrices = modules.pricing && settings.show_lot_prices_publicly;
  const showInventory = purchase && (modules.map || modules.inquiry || showLotPrices || settings.show_available_lot_count_publicly);
  const plots = usePublicApplicationPlots(hostname, scope, modules.map || showInventory);
  const publishedMap = plots.isSuccess ? plots.data.map : undefined;
  const availableLots = showInventory && plots.isSuccess ? plots.data.parcels : [];
  const mapVisible = modules.map && publishedMap && (
    Boolean(publishedMap.masterplan_image_url) || Boolean(publishedMap.features?.length)
    || publishedMap.parcels.some((parcel) => parcel.map_polygon && parcel.map_polygon.length >= 3)
  );
  const referenceMap = publishedMap?.map_experience_mode === "demo";
  const prices = availableLots.map((lot) => lot.base_price).filter((price) => Number.isFinite(price) && price > 0);
  const companyName = company.company_name;
  const description = company.short_description;
  const phaseName = phases.find((phase) => phase.slug === scope.phaseSlug)?.name ?? scope.phaseSlug;
  const siteNotice = (company.public_notice_text === settings.public_notice_text ? "" : company.public_notice_text)
    || (!application ? settings.public_notice_text : "");
  const applyLabel = purchase ? "Apply for a lot" : "Start application";
  const facts: Array<{ label: string; value: string }> = [];
  if (company.location_address) facts.push({ label: "Location", value: company.location_address });
  if (phases.length > 1) facts.push({ label: "Phase", value: phaseName });
  if (settings.show_available_lot_count_publicly && availableLots.length > 0) {
    facts.push({ label: "Lots available", value: String(availableLots.length) });
  }
  if (showLotPrices && prices.length > 0) facts.push({ label: "Starting price", value: money(Math.min(...prices)) });

  useEffect(() => applyPublicPageMetadata({
    title: projectName === companyName ? projectName : `${projectName} | ${companyName}`,
    description: description || `Explore ${projectName} and contact the project team.`,
    url: publicCanonicalUrl(window.location.href),
  }), [companyName, description, pathname, projectName, search]);

  function changePhase(phaseSlug: string) {
    const next = new URLSearchParams(searchParams);
    next.set("phase", phaseSlug);
    next.delete("apply_feature");
    setSearchParams(next);
  }

  return (
    <main
      id="home"
      data-site-template={siteExperience.templateId}
      data-public-tenant={scope.tenantSlug}
      data-public-project={scope.projectSlug}
      data-public-phase={scope.phaseSlug}
      className="min-h-screen bg-background"
    >
      <header className="border-b border-primary/10 bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
          <a href="#home" className="flex min-w-0 items-center gap-3">
            {company.logo_url ? <img src={company.logo_url} alt="" className="h-11 w-11 shrink-0 rounded-md border border-border object-contain" /> : null}
            <span className="min-w-0">
              <span className="block break-words font-display text-lg font-semibold leading-tight text-primary">{projectName}</span>
              {companyName !== projectName ? <span className="block text-sm text-muted-foreground">{companyName}</span> : null}
            </span>
          </a>
          <nav aria-label="Project navigation" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-medium text-primary">
            {mapVisible ? <a className="py-2 hover:underline" href="#map">Map</a> : null}
            {modules.inquiry ? <a className="py-2 hover:underline" href="#request-info">Contact</a> : null}
            {canSubmit ? <Link className={primaryLink} to={applicationHref}>Apply</Link> : null}
            {phases.length > 1 ? (
              <Select aria-label="Project phase" className="w-auto max-w-full" value={scope.phaseSlug} onChange={(event) => changePhase(event.target.value)}>
                {phases.map((phase) => <option key={phase.slug} value={phase.slug}>{phase.name}</option>)}
              </Select>
            ) : null}
          </nav>
        </div>
      </header>

      <section aria-labelledby="project-title" className="border-b border-primary/10 bg-gradient-to-br from-card via-background to-primary-soft/70">
        <div className={`mx-auto grid max-w-6xl items-end gap-8 px-4 py-12 sm:px-6 sm:py-16 lg:py-20 ${facts.length ? "lg:grid-cols-[1.3fr_0.7fr]" : ""}`}>
          <div className="min-w-0">
            <h1 id="project-title" className="break-words font-display text-4xl font-semibold leading-tight text-primary sm:text-5xl lg:text-6xl">{projectName}</h1>
            {description ? <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">{description}</p> : null}
            {mapVisible || modules.inquiry || canSubmit ? <div className="mt-6 flex flex-wrap gap-3">
              {mapVisible ? <a className={primaryLink} href="#map">Explore map <ArrowDown aria-hidden="true" className="h-4 w-4" /></a> : null}
              {modules.inquiry ? <a className={mapVisible ? secondaryLink : primaryLink} href="#request-info">Request information</a> : null}
              {canSubmit ? (
                <Link className={mapVisible || modules.inquiry ? secondaryLink : primaryLink} to={applicationHref}>
                  {applyLabel}<ArrowRight aria-hidden="true" className="h-4 w-4" />
                </Link>
              ) : null}
            </div> : null}
          </div>
          {facts.length > 0 ? (
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              {facts.map((fact) => <ProjectFact key={fact.label} {...fact} />)}
            </dl>
          ) : null}
        </div>
      </section>

      {mapVisible ? (
        <section id="map" aria-labelledby="map-title" className="mx-auto max-w-6xl scroll-mt-5 px-4 py-10 sm:px-6 sm:py-12">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="map-title" className="font-display text-2xl font-semibold text-primary sm:text-3xl">Explore the project map</h2>
              {referenceMap ? <p className="mt-2 text-sm text-muted-foreground">Outlines are plan references. Confirm availability with the project team.</p> : null}
            </div>
            <Link className={secondaryLink} to={referenceMap ? mapHref + "&view=tier" : mapHref}>Open standalone map <ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>
          </div>
          <div className="h-[560px] overflow-hidden rounded-xl border border-border bg-card sm:h-[660px] lg:h-[740px]">
            <PublicLotMap
              hostname={hostname}
              tenantSlug={scope.tenantSlug}
              projectSlug={scope.projectSlug}
              phaseSlug={scope.phaseSlug}
              preloadedMap={publishedMap}
              showPrices={referenceMap ? modules.pricing : showLotPrices}
              enableInquiry={modules.inquiry}
              initialView={referenceMap ? "tier" : "status"}
              onApplyWithPlot={applyWithOutline ? (parcel) => {
                if (parcel.map_feature_ref) applyWithOutline(parcel.map_feature_ref);
              } : undefined}
            />
          </div>
        </section>
      ) : null}

      {availableLots.length > 0 ? (
        <section id="lots" aria-labelledby="lots-title" className="mx-auto max-w-6xl scroll-mt-5 px-4 py-8 sm:px-6">
          <h2 id="lots-title" className="mb-4 font-display text-2xl font-semibold text-primary">Available lots</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {availableLots.slice(0, 4).map((lot) => (
              <li key={lot.public_ref} className="rounded-xl border border-border bg-card p-4">
                <p className="font-semibold text-primary">Lot {lot.lot_number}</p>
                {lot.dimensions ? <p className="mt-1 text-sm text-muted-foreground">{lot.dimensions}</p> : null}
                {showLotPrices && lot.base_price > 0 ? <p className="mt-2 text-sm text-primary">{money(lot.base_price)}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {modules.inquiry ? (
        <section id="request-info" aria-labelledby="inquiry-title" className="mx-auto max-w-6xl scroll-mt-5 px-4 py-8 sm:px-6 sm:py-10">
          <span id="interest" aria-hidden="true" />
          <PublicInquiryPanel
            scope={scope}
            company={company}
            projectName={projectName}
            salesInquiry={purchase}
            parcels={availableLots}
            showPrices={showLotPrices}
          />
        </section>
      ) : null}

      {siteNotice ? (
        <section id={application ? undefined : "notice"} aria-labelledby="site-notice-title" className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
          <div className="rounded-xl border border-border bg-card p-5">
            <h2 id="site-notice-title" className="font-display text-lg font-semibold text-primary">Important information</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{siteNotice}</p>
          </div>
        </section>
      ) : null}

      {application}

      <footer className="border-t border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-5 text-sm text-muted-foreground sm:px-6">
          <p>{companyName}</p>
          {company.website ? <a href={company.website} rel="noreferrer" target="_blank" className="font-medium text-primary hover:underline">Company website <ArrowUpRight aria-hidden="true" className="inline h-4 w-4" /></a> : null}
        </div>
      </footer>
    </main>
  );
}

function ProjectFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/90 px-4 py-3 shadow-sm">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-semibold text-primary">{value}</dd>
    </div>
  );
}
