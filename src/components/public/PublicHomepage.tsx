import { useEffect, type ComponentType } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { usePublicApplicationPlots } from "../../lib/publicApplicationPlots";
import type { PublicSiteTemplateId } from "../../lib/publicExperience.mjs";
import { applyPublicPageMetadata, publicCanonicalUrl } from "../../lib/publicPageMetadata";
import { getPublicApplicationAccess, type PublicPhaseOption, type PublicSiteData } from "../../lib/publicSiteExperience";
import { money } from "../../lib/utils";
import type { HomepageLayoutProps, HomepageModel } from "./homepage/HomepageModel";
import { RegularHomepageLayout } from "./homepage/RegularHomepageLayout";
import { ShowcaseHomepageLayout } from "./homepage/ShowcaseHomepageLayout";

const homepageLayouts: Record<PublicSiteTemplateId, ComponentType<HomepageLayoutProps>> = {
  "wamule-classic": RegularHomepageLayout,
  "hopkins-project": ShowcaseHomepageLayout,
};

export function PublicHomepage({
  data,
  hostname,
  phases,
  applicationHref,
  mapHref,
  applyWithOutline,
  onClearInitialOutline,
}: {
  data: PublicSiteData;
  hostname: string;
  phases: PublicPhaseOption[];
  applicationHref: string;
  mapHref: string;
  applyWithOutline?: (ref: string) => void;
  onClearInitialOutline?: () => void;
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
  const lots = showInventory && plots.isSuccess ? plots.data.parcels : [];
  const mapVisible = Boolean(modules.map && publishedMap && (
    publishedMap.masterplan_image_url || publishedMap.features?.length
    || publishedMap.parcels.some((parcel) => parcel.map_polygon && parcel.map_polygon.length >= 3)
  ));
  const referenceMap = publishedMap?.map_experience_mode === "demo";
  const prices = lots.map((lot) => lot.base_price).filter((price) => Number.isFinite(price) && price > 0);
  const companyName = company.company_name;
  const description = company.short_description;
  const phaseName = phases.find((phase) => phase.slug === scope.phaseSlug)?.name ?? scope.phaseSlug;
  const notice = (company.public_notice_text === settings.public_notice_text ? "" : company.public_notice_text)
    || (!modules.application ? settings.public_notice_text : "");
  const facts: HomepageModel["facts"] = [];
  if (company.location_address) facts.push({ label: "Location", value: company.location_address });
  if (phases.length > 1) facts.push({ label: "Phase", value: phaseName });
  if (settings.show_available_lot_count_publicly && lots.length > 0) {
    facts.push({ label: "Lots available", value: String(lots.length) });
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

  const model: HomepageModel = {
    scope,
    hostname,
    phases,
    projectName,
    headline: siteExperience.headline || projectName,
    company,
    facts,
    flags: {
      mapVisible,
      referenceMap,
      inquiryEnabled: modules.inquiry,
      pricingEnabled: modules.pricing,
      salesInquiry: purchase,
      showLotPrices,
      applicationsOpen: settings.applications_open,
      canSubmit,
    },
    hrefs: {
      map: "#map",
      inquiry: "#request-info",
      application: applicationHref,
      standaloneMap: referenceMap ? mapHref + "&view=tier" : mapHref,
    },
    lots,
    publishedMap,
    notice,
    application: modules.application ? data : null,
  };
  const Layout = homepageLayouts[siteExperience.templateId];

  return (
    <Layout
      model={model}
      onPhaseChange={changePhase}
      onApplyWithOutline={applyWithOutline}
      onClearInitialOutline={onClearInitialOutline}
    />
  );
}
