/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PUBLIC_DEMO_MODE?: string;
}

interface PublicBuildInfo {
  commit: string;
  hasUncommittedChanges: boolean | null;
  buildTime: string;
  environment: string;
}

declare const __BUILD_INFO__: PublicBuildInfo;
