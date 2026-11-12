export function getOrCreateSummaryGenerationId(
  scope: string,
  storage?: Pick<Storage, "getItem" | "setItem">,
  createId?: () => string,
): string;

export function completeSummaryGeneration(
  scope: string,
  storage?: Pick<Storage, "removeItem">,
): void;
