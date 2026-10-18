export type PublicDraftScope = { tenantSlug: string; projectSlug: string; phaseSlug: string };
export function publicMapPreferencesStorageKey(scope: PublicDraftScope): string;
export function publicWizardStepStorageKey(scope: PublicDraftScope): string;
export function readPublicMapPreferences(storage: Storage, scope: PublicDraftScope): string[];
export function writePublicMapPreferences(storage: Storage, scope: PublicDraftScope, refs: string[]): boolean;
export function retainKnownMapPreferences(refs: string[], knownRefs: string[]): string[];
export function readPublicWizardStep(storage: Storage, scope: PublicDraftScope, stepCount: number): number;
export function writePublicWizardStep(storage: Storage, scope: PublicDraftScope, step: number, stepCount: number): boolean;
