import { ArrowDown, ArrowRight, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { PublicSiteTemplateId } from "../../../lib/publicExperience.mjs";
import { money } from "../../../lib/utils";
import { Select } from "../../ui/Field";
import { PublicInquiryPanel } from "../PublicInquiryPanel";
import { PublicLotMap } from "../PublicLotMap";
import type { HomepageLayoutProps, HomepageModel } from "./HomepageModel";

const primaryLink = "focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-hover";
const secondaryLink = "focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border bg-card px-4 py-2 text-sm font-semibold text-primary hover:bg-primary-soft";

export function HomepageFrame({ scope, templateId, children }: {
  scope: HomepageModel["scope"];
  templateId: PublicSiteTemplateId;
  children: ReactNode;
}) {
  return (
    <main
      id="home"
      data-site-template={templateId}
      data-public-tenant={scope.tenantSlug}
      data-public-project={scope.projectSlug}
      data-public-phase={scope.phaseSlug}
      className="min-h-screen bg-background"
    >
      {children}
    </main>
  );
}

export function HomepageNavigation({ model, onPhaseChange }: Pick<HomepageLayoutProps, "model" | "onPhaseChange">) {
  const { flags, hrefs, phases, scope } = model;
  return (
    <nav aria-label="Project navigation" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-medium text-primary">
      {flags.mapVisible ? <a className="py-2 hover:underline" href={hrefs.map}>Map</a> : null}
      {flags.inquiryEnabled ? <a className="py-2 hover:underline" href={hrefs.inquiry}>Contact</a> : null}
      {flags.canSubmit ? <Link className={primaryLink} to={hrefs.application}>Apply</Link> : null}
      {phases.length > 1 ? (
        <Select aria-label="Project phase" className="w-auto max-w-full" value={scope.phaseSlug} onChange={(event) => onPhaseChange(event.target.value)}>
          {phases.map((phase) => <option key={phase.slug} value={phase.slug}>{phase.name}</option>)}
        </Select>
      ) : null}
    </nav>
  );
}

export function HomepageActions({ model }: { model: HomepageModel }) {
  const { flags, hrefs } = model;
  if (!flags.mapVisible && !flags.inquiryEnabled && !flags.canSubmit) return null;

  return (
    <div className="mt-6 flex flex-wrap gap-3">
      {flags.mapVisible ? <a className={primaryLink} href={hrefs.map}>Explore map <ArrowDown aria-hidden="true" className="h-4 w-4" /></a> : null}
      {flags.inquiryEnabled ? <a className={flags.mapVisible ? secondaryLink : primaryLink} href={hrefs.inquiry}>Request information</a> : null}
      {flags.canSubmit ? (
        <Link className={flags.mapVisible || flags.inquiryEnabled ? secondaryLink : primaryLink} to={hrefs.application}>
          {flags.salesInquiry ? "Apply for a lot" : "Start application"}<ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      ) : null}
    </div>
  );
}

export function HomepageMap({ model, onApplyWithOutline }: Pick<HomepageLayoutProps, "model" | "onApplyWithOutline">) {
  const { flags, hrefs, hostname, scope, publishedMap } = model;
  if (!flags.mapVisible) return null;

  return (
    <section id="map" aria-labelledby="map-title" className="mx-auto max-w-6xl scroll-mt-5 sm:scroll-mt-24 px-4 py-10 sm:px-6 sm:py-12">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="map-title" className="font-display text-2xl font-semibold text-primary sm:text-3xl">Explore the project map</h2>
          {flags.referenceMap ? <p className="mt-2 text-sm text-muted-foreground">Outlines are plan references. Confirm availability with the project team.</p> : null}
        </div>
        <Link className={secondaryLink} to={hrefs.standaloneMap}>Open standalone map <ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>
      </div>
      <div className="h-[560px] overflow-hidden rounded-xl border border-border bg-card sm:h-[660px] lg:h-[740px]">
        <PublicLotMap
          hostname={hostname}
          tenantSlug={scope.tenantSlug}
          projectSlug={scope.projectSlug}
          phaseSlug={scope.phaseSlug}
          preloadedMap={publishedMap}
          showPrices={flags.referenceMap ? flags.pricingEnabled : flags.showLotPrices}
          enableInquiry={flags.inquiryEnabled}
          initialView={flags.referenceMap ? "tier" : "status"}
          onApplyWithPlot={onApplyWithOutline ? (parcel) => {
            if (parcel.map_feature_ref) onApplyWithOutline(parcel.map_feature_ref);
          } : undefined}
        />
      </div>
    </section>
  );
}

export function HomepageLots({ model }: { model: HomepageModel }) {
  const { lots, flags } = model;
  if (lots.length === 0) return null;

  return (
    <section id="lots" aria-labelledby="lots-title" className="mx-auto max-w-6xl scroll-mt-5 sm:scroll-mt-24 px-4 py-8 sm:px-6">
      <h2 id="lots-title" className="mb-4 font-display text-2xl font-semibold text-primary">Available lots</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {lots.slice(0, 4).map((lot) => (
          <li key={lot.public_ref} className="rounded-xl border border-border bg-card p-4">
            <p className="font-semibold text-primary">Lot {lot.lot_number}</p>
            {lot.dimensions ? <p className="mt-1 text-sm text-muted-foreground">{lot.dimensions}</p> : null}
            {flags.showLotPrices && lot.base_price > 0 ? <p className="mt-2 text-sm text-primary">{money(lot.base_price)}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function HomepageInquiry({ model }: { model: HomepageModel }) {
  const { company, flags, lots, projectName, scope } = model;
  if (!flags.inquiryEnabled) return null;

  return (
    <section id="request-info" aria-labelledby="inquiry-title" className="mx-auto max-w-6xl scroll-mt-5 sm:scroll-mt-24 px-4 py-8 sm:px-6 sm:py-10">
      <span id="interest" aria-hidden="true" />
      <PublicInquiryPanel
        scope={scope}
        company={company}
        projectName={projectName}
        salesInquiry={flags.salesInquiry}
        parcels={lots}
        showPrices={flags.showLotPrices}
      />
    </section>
  );
}

export function HomepageNotice({ model }: { model: HomepageModel }) {
  if (!model.notice) return null;

  return (
    <section id={model.hasApplication ? undefined : "notice"} aria-labelledby="site-notice-title" className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <div className="rounded-xl border border-border bg-card p-5">
        <h2 id="site-notice-title" className="font-display text-lg font-semibold text-primary">Important information</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{model.notice}</p>
      </div>
    </section>
  );
}

export function HomepageApplication({ model, application }: Pick<HomepageLayoutProps, "model" | "application">) {
  if (!model.hasApplication) return null;

  return application ?? null;
}

export function HomepageFooter({ company }: { company: HomepageModel["company"] }) {
  return (
    <footer className="border-t border-border bg-card">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-5 text-sm text-muted-foreground sm:px-6">
        <p>{company.company_name}</p>
        {company.website ? <a href={company.website} rel="noreferrer" target="_blank" className="font-medium text-primary hover:underline">Company website <ArrowUpRight aria-hidden="true" className="inline h-4 w-4" /></a> : null}
      </div>
    </footer>
  );
}
