export const DAILY_BRIEF_SOURCE_TABLES: readonly string[];

export function resolveDailyBriefSourceTable(
  entityType: string | null | undefined,
  relatedTable: string | null | undefined,
): string | null;
