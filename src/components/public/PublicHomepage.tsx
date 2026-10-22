import type { ComponentType, ReactNode } from "react";
import {
  resolvePublicSiteTemplateId,
  type PublicExperienceScope,
  type PublicSiteModuleId,
  type PublicSiteTemplateId,
} from "../../lib/publicExperience.mjs";
import {
  WamuleClassicBuildStamp,
  WamuleClassicHeader,
  WamuleClassicHero,
  WamuleClassicInfoTile,
  WamuleClassicNotice,
  WamuleClassicPanel,
} from "./WamuleClassicTemplate";

/** Tenant adapters supply content and workflow slots; this owns page composition. */
export type PublicHomepageProps = {
  templateId: PublicSiteTemplateId;
  scope: PublicExperienceScope;
  modules: Record<PublicSiteModuleId, boolean>;
  header: {
    companyName: string;
    logoUrl: string;
    homeHref?: string;
    mapLabel?: string;
  };
  banner?: ReactNode;
  hero: {
    badge: ReactNode;
    title: string;
    description: string;
    facts: Array<{ label: string; value: string }>;
    actions?: ReactNode;
    preferences: {
      title: string;
      description: string;
      trailing?: ReactNode;
      content: ReactNode;
    };
  };
  notice: { notice: ReactNode; companyName: string; location?: string | null };
  inquiry?: ReactNode;
  map?: ReactNode;
  application?: ReactNode;
  footer?: ReactNode;
};

function WamuleClassicHomepage({
  scope,
  modules,
  header,
  banner,
  hero,
  notice,
  inquiry,
  map,
  application,
  footer,
}: PublicHomepageProps) {
  return (
    <main
      data-site-template="wamule-classic"
      data-site-map={modules.map}
      data-public-tenant={scope.tenantSlug}
      data-public-project={scope.projectSlug}
      data-public-phase={scope.phaseSlug}
      className="min-h-screen bg-background"
    >
      <WamuleClassicHeader
        {...header}
        mapHref={modules.map && map ? "#lots" : "#lot-preferences"}
        showApply={modules.application}
      />
      {banner ? (
        <div className="mx-auto max-w-6xl px-4 pt-3">{banner}</div>
      ) : null}
      <WamuleClassicHero
        badge={hero.badge}
        title={hero.title}
        description={hero.description}
        facts={hero.facts.map((fact) => (
          <WamuleClassicInfoTile key={fact.label} {...fact} />
        ))}
        actions={hero.actions}
        sideContent={
          <WamuleClassicPanel
            id="lot-preferences"
            title={hero.preferences.title}
            description={hero.preferences.description}
            trailing={hero.preferences.trailing}
          >
            {hero.preferences.content}
          </WamuleClassicPanel>
        }
      />
      {modules.inquiry && inquiry ? (
        <section
          id="request-info"
          className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-5"
        >
          {inquiry}
        </section>
      ) : null}
      <WamuleClassicNotice {...notice} />
      {modules.map && map ? (
        <section id="lots" className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-8">
          {map}
        </section>
      ) : null}
      {modules.application ? application : null}
      <footer className="mx-auto flex max-w-6xl flex-col gap-2 border-t border-border px-4 py-5 text-xs leading-5 text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        {footer}
        <WamuleClassicBuildStamp scope={scope} />
      </footer>
    </main>
  );
}

const templates: Record<
  PublicSiteTemplateId,
  ComponentType<PublicHomepageProps>
> = {
  "wamule-classic": WamuleClassicHomepage,
};

export function PublicHomepage(props: PublicHomepageProps) {
  const Template = templates[resolvePublicSiteTemplateId(props.templateId)];
  return <Template {...props} />;
}
