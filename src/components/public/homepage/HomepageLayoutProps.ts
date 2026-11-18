import type { ReactNode } from "react";

export type HomepageLayoutProps = {
  companyName: string;
  projectName: string;
  headline: string;
  logoUrl: string;
  description: string;
  facts: Array<{ label: string; value: string }>;
  navigation: ReactNode;
  actions: ReactNode;
  map: ReactNode;
  lots: ReactNode;
  inquiry: ReactNode;
  notice: ReactNode;
  application: ReactNode;
  footer: ReactNode;
};
