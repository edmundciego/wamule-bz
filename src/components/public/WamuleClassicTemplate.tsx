import type { ReactNode } from "react";
import { ArrowRight, ShieldCheck } from "lucide-react";

export function WamuleClassicHeader({
  companyName,
  logoUrl,
  homeHref = "/",
  noticeHref = "#notice",
  mapHref = "#lots",
  applyHref = "#application",
  applyLabel = "Apply",
  showApply = true,
  mapLabel = "Lots",
}: {
  companyName: string;
  logoUrl: string;
  homeHref?: string;
  noticeHref?: string;
  mapHref?: string;
  applyHref?: string;
  applyLabel?: string;
  showApply?: boolean;
  mapLabel?: string;
}) {
  const brandLabel = companyName.replace(/\s+Development$/i, "");
  const compactBrandOnMobile = brandLabel.length > 10;
  return (
    <header className="border-b border-primary/10 bg-card/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
        <a href={homeHref} className="flex min-w-0 items-center gap-2 sm:gap-3" aria-label={companyName}>
          <img src={logoUrl} alt="" className="h-12 w-12 shrink-0 rounded-md border border-secondary/30 bg-background object-cover shadow-sm" />
          <span className="min-w-0">
            <span className={`block truncate font-display font-semibold leading-tight text-primary ${compactBrandOnMobile ? "text-sm sm:text-xl" : "text-xl"}`}>{brandLabel}</span>
            <span className={`block text-xs font-semibold uppercase text-secondary ${compactBrandOnMobile ? "tracking-[0.2em] sm:tracking-[0.26em]" : "tracking-[0.26em]"}`}>Development</span>
          </span>
        </a>
        <nav aria-label="Main navigation" className="flex shrink-0 items-center gap-3 text-sm">
          <a className="hidden text-slate hover:text-primary sm:inline" href={noticeHref}>Notice</a>
          <a className="hidden text-slate hover:text-primary sm:inline" href={mapHref}>{mapLabel}</a>
          {showApply ? <a
            className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-px hover:bg-primary-hover hover:shadow-[var(--shadow-button)]"
            href={applyHref}
          >
            {applyLabel}<ArrowRight className="h-4 w-4" />
          </a> : null}
        </nav>
      </div>
    </header>
  );
}

export function WamuleClassicHero({
  badge,
  title,
  description,
  facts,
  actions,
  sideContent,
  sideAlignment = "center",
  showOrnament = true,
}: {
  badge: ReactNode;
  title: string;
  description: string;
  facts: ReactNode;
  actions?: ReactNode;
  sideContent: ReactNode;
  sideAlignment?: "center" | "start";
  showOrnament?: boolean;
}) {
  const sideAlignmentClass = sideAlignment === "start" ? "lg:items-start" : "lg:items-center";
  return (
    <section className={`mx-auto grid max-w-6xl gap-8 px-4 py-10 lg:grid-cols-[1.05fr_0.95fr] ${sideAlignmentClass} lg:py-14`}>
      <div className="min-w-0">
        {badge}
        <h1 className="mt-5 max-w-3xl break-words font-display text-4xl font-semibold tracking-normal text-primary sm:text-5xl">{title}</h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">{description}</p>
        {showOrnament ? <div aria-hidden="true" className="wave-rule mt-6 h-3 w-56" /> : null}
        <div className="mt-7 grid gap-3 sm:grid-cols-3">{facts}</div>
        {actions ? <div className="mt-7 flex flex-wrap gap-3">{actions}</div> : null}
      </div>
      <div className="min-w-0">{sideContent}</div>
    </section>
  );
}

export function WamuleClassicInfoTile({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={compact ? "min-w-0 rounded-lg border bg-card px-3 py-2.5 shadow-[var(--shadow-card)]" : "rounded-lg border bg-card p-4 shadow-[var(--shadow-card)]"}>
      <p className={compact ? "text-[10px] font-semibold uppercase tracking-[0.14em] text-secondary" : "text-xs font-semibold uppercase tracking-[0.18em] text-secondary"}>{label}</p>
      <p className={compact ? "mt-0.5 break-words font-display text-base font-semibold leading-5 text-primary sm:text-lg" : "mt-1 font-display text-xl font-semibold text-primary"}>{value}</p>
    </div>
  );
}

export function WamuleClassicBuildStamp({ scope }: { scope: { tenantSlug: string; projectSlug: string; phaseSlug: string } }) {
  const params = new URLSearchParams({ tenant: scope.tenantSlug, project: scope.projectSlug, phase: scope.phaseSlug });
  const commit = __BUILD_INFO__.commit || "unavailable";
  const revisionState = __BUILD_INFO__.hasUncommittedChanges === null
    ? "change state unavailable"
    : __BUILD_INFO__.hasUncommittedChanges ? "local changes included" : "clean revision";
  return (
    <p className="text-[11px] leading-4 text-muted-foreground">
      Build {commit.slice(0, 8)} · {revisionState} · {__BUILD_INFO__.environment} · <a href={`/version?${params.toString()}`} className="font-semibold text-primary underline underline-offset-2">Version details</a>
    </p>
  );
}

export function WamuleClassicPanel({
  id,
  title,
  description,
  trailing,
  children,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div id={id} className="min-w-0 overflow-hidden rounded-lg border bg-card shadow-[var(--shadow-card)]">
      <div aria-hidden="true" className="brand-pattern h-4 border-b" />
      <div className="p-4">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="font-display text-xl font-semibold text-primary">{title}</div>
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {trailing}
        </div>
        {children}
      </div>
    </div>
  );
}

export function WamuleClassicNotice({
  notice,
  companyName,
  location,
  title = "Important Notice",
}: {
  notice: ReactNode;
  companyName: string;
  location?: string | null;
  title?: string;
}) {
  return (
    <section className="mx-auto max-w-6xl px-4 pb-4" id="notice">
      <div className="grid gap-4 rounded-xl border border-secondary/20 bg-card p-5 shadow-sm shadow-secondary/5 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
        <div className="flex items-start gap-3 lg:block">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-secondary-soft">
            <ShieldCheck aria-hidden="true" className="h-5 w-5 text-secondary" />
          </div>
          <div className="min-w-0 lg:mt-3">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-secondary">Before you apply</p>
            <h2 className="mt-1 font-display text-2xl font-semibold text-primary">{title}</h2>
          </div>
        </div>
        <div className="grid gap-3">
          <div className="max-w-3xl text-sm leading-6 text-foreground">{notice}</div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs font-medium text-muted-foreground">
            <span>Owner/Developer: {companyName}</span>
            {location ? <span>Location: {location}</span> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
