import type { CSSProperties } from "react";
import { buildShowcaseHomepageCssVars } from "../../../lib/theme";
import type { HomepageLayoutProps } from "./HomepageModel";
import {
  HomepageActions,
  HomepageApplication,
  HomepageFooter,
  HomepageFrame,
  HomepageInquiry,
  HomepageLots,
  HomepageMap,
  HomepageNavigation,
  HomepageNotice,
} from "./HomepageWidgets";

export function ShowcaseHomepageLayout({
  model,
  onPhaseChange,
  onApplyWithOutline,
  onClearInitialOutline,
}: HomepageLayoutProps) {
  const { company, projectName, headline, facts, flags, scope } = model;
  const { company_name: companyName, logo_url: logoUrl, short_description: description } = company;
  const colors = buildShowcaseHomepageCssVars(scope.tenantSlug) as CSSProperties;

  return (
    <HomepageFrame scope={scope} templateId="hopkins-project">
      <div className="bg-[color:var(--showcase-background)]" style={colors}>
        <header className="z-30 border-b border-[color:var(--showcase-divider)] bg-[color:var(--showcase-header)] backdrop-blur sm:sticky sm:top-0">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
            <a href="#home" className="flex min-w-0 items-center gap-3">
              {logoUrl ? <img src={logoUrl} alt="" className="h-12 w-12 shrink-0 rounded-full border border-[color:var(--showcase-logo-border)] bg-[color:var(--showcase-card)] object-contain" /> : null}
              <span className="min-w-0">
                {companyName !== projectName ? <span className="block break-words text-xs font-semibold uppercase tracking-wider text-[color:var(--showcase-accent)]">{companyName}</span> : null}
                <span className="block break-words font-display text-xl font-semibold leading-tight text-[color:var(--showcase-primary)]">{projectName}</span>
              </span>
            </a>
            <HomepageNavigation model={model} onPhaseChange={onPhaseChange} />
          </div>
        </header>

        <section aria-labelledby="project-title" className="border-b border-[color:var(--showcase-divider)] bg-[radial-gradient(ellipse_at_78%_20%,var(--showcase-hero-highlight),transparent_38%),linear-gradient(115deg,var(--showcase-background)_0%,var(--showcase-hero-midpoint)_54%,var(--showcase-soft-background)_100%)]">
          <div className={`mx-auto grid max-w-6xl items-end gap-8 px-4 py-16 sm:px-6 sm:py-24 ${facts.length ? "lg:grid-cols-[1.5fr_1fr] lg:gap-14" : ""}`}>
            <div className="min-w-0">
              <h1 id="project-title" className="break-words font-display text-5xl font-semibold leading-[1.04] tracking-tight text-[color:var(--showcase-primary)] sm:text-6xl lg:text-7xl">{headline}</h1>
              {description ? <p className="mt-5 max-w-xl text-base leading-7 text-[color:var(--showcase-muted)] sm:text-lg">{description}</p> : null}
              <HomepageActions model={model} />
            </div>
            {facts.length > 0 ? (
              <dl className="grid gap-x-5 gap-y-4 rounded-2xl border border-[color:var(--showcase-divider)] bg-[color:var(--showcase-facts-surface)] p-5 shadow-sm sm:grid-cols-2 sm:p-6">
                {facts.map(({ label, value }) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-xs font-semibold uppercase tracking-wider text-[color:var(--showcase-accent)]">{label}</dt>
                    <dd className="mt-1 break-words font-display text-lg font-semibold text-[color:var(--showcase-primary)]">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        </section>

        <HomepageMap model={model} onApplyWithOutline={onApplyWithOutline} />
        {flags.inquiryEnabled ? (
          <div className="border-y border-[color:var(--showcase-divider)] bg-[color:var(--showcase-soft-background)]">
            <HomepageInquiry model={model} />
          </div>
        ) : null}
        <HomepageLots model={model} />
        <HomepageNotice model={model} />
        <HomepageApplication model={model} onClearInitialOutline={onClearInitialOutline} />
        <HomepageFooter company={company} />
      </div>
    </HomepageFrame>
  );
}
