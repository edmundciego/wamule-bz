import type { HomepageLayoutProps } from "./HomepageLayoutProps";

export function ShowcaseHomepageLayout({
  companyName,
  projectName,
  headline,
  logoUrl,
  description,
  facts,
  navigation,
  actions,
  map,
  lots,
  inquiry,
  notice,
  application,
  footer,
}: HomepageLayoutProps) {
  return (
    <div className="bg-[#fffdf8]">
      <header className="z-30 border-b border-[#173f2d]/10 bg-[#fffdf8]/95 backdrop-blur sm:sticky sm:top-0">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
          <a href="#home" className="flex min-w-0 items-center gap-3">
            {logoUrl ? <img src={logoUrl} alt="" className="h-12 w-12 shrink-0 rounded-full border border-[#173f2d]/15 bg-white object-contain" /> : null}
            <span className="min-w-0">
              {companyName !== projectName ? <span className="block break-words text-xs font-semibold uppercase tracking-wider text-[#78502e]">{companyName}</span> : null}
              <span className="block break-words font-display text-xl font-semibold leading-tight text-[#173f2d]">{projectName}</span>
            </span>
          </a>
          {navigation}
        </div>
      </header>

      <section aria-labelledby="project-title" className="border-b border-[#173f2d]/10 bg-[radial-gradient(ellipse_at_78%_20%,rgba(194,130,86,0.20),transparent_38%),linear-gradient(115deg,#fffdf8_0%,#f6f4e8_54%,#edf1e9_100%)]">
        <div className={`mx-auto grid max-w-6xl items-end gap-8 px-4 py-16 sm:px-6 sm:py-24 ${facts.length ? "lg:grid-cols-[1.5fr_1fr] lg:gap-14" : ""}`}>
          <div className="min-w-0">
            <h1 id="project-title" className="break-words font-display text-5xl font-semibold leading-[1.04] tracking-tight text-[#173f2d] sm:text-6xl lg:text-7xl">{headline}</h1>
            {description ? <p className="mt-5 max-w-xl text-base leading-7 text-[#52635a] sm:text-lg">{description}</p> : null}
            {actions}
          </div>
          {facts.length > 0 ? (
            <dl className="grid gap-x-5 gap-y-4 rounded-2xl border border-[#173f2d]/10 bg-white/75 p-5 shadow-sm sm:grid-cols-2 sm:p-6">
              {facts.map(({ label, value }) => (
                <div key={label} className="min-w-0">
                  <dt className="text-xs font-semibold uppercase tracking-wider text-[#78502e]">{label}</dt>
                  <dd className="mt-1 break-words font-display text-lg font-semibold text-[#173f2d]">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </section>

      {map}
      {inquiry ? <div className="border-y border-[#173f2d]/10 bg-[#edf1e9]">{inquiry}</div> : null}
      {lots}
      {notice}
      {application}
      {footer}
    </div>
  );
}
