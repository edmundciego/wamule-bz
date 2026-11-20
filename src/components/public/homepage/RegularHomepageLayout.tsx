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

export function RegularHomepageLayout({
  model,
  application,
  onPhaseChange,
  onApplyWithOutline,
}: HomepageLayoutProps) {
  const { company, projectName, headline, facts, scope } = model;
  const { company_name: companyName, logo_url: logoUrl, short_description: description } = company;

  return (
    <HomepageFrame scope={scope} templateId="wamule-classic">
      <header className="border-b border-primary/10 bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
          <a href="#home" className="flex min-w-0 items-center gap-3">
            {logoUrl ? <img src={logoUrl} alt="" className="h-11 w-11 shrink-0 rounded-md border border-border object-contain" /> : null}
            <span className="min-w-0">
              <span className="block break-words font-display text-lg font-semibold leading-tight text-primary">{projectName}</span>
              {companyName !== projectName ? <span className="block text-sm text-muted-foreground">{companyName}</span> : null}
            </span>
          </a>
          <HomepageNavigation model={model} onPhaseChange={onPhaseChange} />
        </div>
      </header>

      <section aria-labelledby="project-title" className="border-b border-primary/10 bg-gradient-to-br from-card via-background to-primary-soft/70">
        <div className={`mx-auto grid max-w-6xl items-end gap-8 px-4 py-12 sm:px-6 sm:py-16 lg:py-20 ${facts.length ? "lg:grid-cols-[1.3fr_0.7fr]" : ""}`}>
          <div className="min-w-0">
            <h1 id="project-title" className="break-words font-display text-4xl font-semibold leading-tight text-primary sm:text-5xl lg:text-6xl">{headline}</h1>
            {description ? <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">{description}</p> : null}
            <HomepageActions model={model} />
          </div>
          {facts.length > 0 ? (
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              {facts.map(({ label, value }) => (
                <div key={label} className="rounded-xl border border-border bg-card/90 px-4 py-3 shadow-sm">
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd className="mt-1 break-words font-semibold text-primary">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </section>

      <HomepageMap model={model} onApplyWithOutline={onApplyWithOutline} />
      <HomepageLots model={model} />
      <HomepageInquiry model={model} />
      <HomepageNotice model={model} />
      <HomepageApplication model={model} application={application} />
      <HomepageFooter company={company} />
    </HomepageFrame>
  );
}
