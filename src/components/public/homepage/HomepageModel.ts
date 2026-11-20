import type { ReactNode } from "react";
import type { PublicParcelOption } from "../../../lib/publicApplicationPlots";
import type { PublicExperienceScope } from "../../../lib/publicExperience.mjs";
import type { PublicPhaseOption, PublicSiteData } from "../../../lib/publicSiteExperience";
import type { MapPayload } from "../PublicLotMap";

export type HomepageModel = {
  scope: PublicExperienceScope;
  hostname: string;
  phases: PublicPhaseOption[];
  projectName: string;
  headline: string;
  company: PublicSiteData["company"];
  facts: Array<{ label: string; value: string }>;
  flags: {
    mapVisible: boolean;
    referenceMap: boolean;
    inquiryEnabled: boolean;
    pricingEnabled: boolean;
    salesInquiry: boolean;
    showLotPrices: boolean;
    applicationsOpen: boolean;
    canSubmit: boolean;
  };
  hrefs: {
    map: string;
    inquiry: string;
    application: string;
    standaloneMap: string;
  };
  lots: PublicParcelOption[];
  publishedMap: MapPayload | undefined;
  notice: string;
  hasApplication: boolean;
};

export type HomepageLayoutProps = {
  model: HomepageModel;
  application?: ReactNode;
  onPhaseChange: (phaseSlug: string) => void;
  onApplyWithOutline?: (ref: string) => void;
};
