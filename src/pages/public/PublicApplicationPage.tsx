import { ArrowLeft } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { applyPublicPageMetadata, publicCanonicalUrl } from "../../lib/publicPageMetadata";
import type { PublicSiteData } from "../../lib/publicSiteExperience";

export function PublicApplicationPage({ data, projectHref, children }: {
  data: PublicSiteData;
  projectHref: string;
  children: ReactNode;
}) {
  const { company, projectName } = data;
  const { pathname, search } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  useEffect(() => applyPublicPageMetadata({
    title: `Application | ${projectName}`,
    description: `Apply to ${projectName} through ${company.company_name}.`,
    url: publicCanonicalUrl(window.location.href),
  }), [company.company_name, pathname, projectName, search]);

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-primary/10 bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4">
          <div className="flex min-w-0 items-center gap-3">
            {company.logo_url ? <img src={company.logo_url} alt="" className="h-12 w-12 shrink-0 rounded-md object-contain" /> : null}
            <p className="break-words font-display text-xl font-semibold text-primary">{company.company_name}</p>
          </div>
          <Link to={projectHref} className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" /> Back to project
          </Link>
        </div>
      </header>
      {children ?? <section className="mx-auto max-w-6xl px-4 py-10">
        <h1 className="font-display text-3xl font-semibold text-primary">Applications are unavailable</h1>
        <p className="mt-3 text-sm text-muted-foreground">{projectName} is currently closed for applications.</p>
      </section>}
    </main>
  );
}
