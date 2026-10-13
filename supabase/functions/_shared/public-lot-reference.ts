/** Project-scoped public locator. It is an identifier, not a secret or an authorization token. */
export const PUBLIC_LOT_REFERENCE_VERSION = "plr1";

export type PublicLotReferenceParts = {
  projectSlug: string;
  lotNumber: string;
};

function validProjectSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,159}$/.test(value);
}

function validLotNumber(value: string): boolean {
  return value.length > 0 && value.length <= 120 && value === value.trim();
}

export function createPublicLotReference(projectSlug: string, lotNumber: string): string | null {
  if (!validProjectSlug(projectSlug) || !validLotNumber(lotNumber)) return null;
  return `${PUBLIC_LOT_REFERENCE_VERSION}:${encodeURIComponent(projectSlug)}:${encodeURIComponent(lotNumber)}`;
}

export function parsePublicLotReference(value: unknown): PublicLotReferenceParts | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const [version, rawProjectSlug, rawLotNumber, ...extra] = value.split(":");
  if (version !== PUBLIC_LOT_REFERENCE_VERSION || !rawProjectSlug || !rawLotNumber || extra.length) return null;
  try {
    const projectSlug = decodeURIComponent(rawProjectSlug);
    const lotNumber = decodeURIComponent(rawLotNumber);
    if (!validProjectSlug(projectSlug) || !validLotNumber(lotNumber)) return null;
    return { projectSlug, lotNumber };
  } catch {
    return null;
  }
}

/** Suppress ambiguous duplicate lot numbers instead of issuing colliding references. */
export function assignPublicLotReferences(
  projectSlug: string | null,
  lotNumbers: unknown[],
): Array<string | null> {
  if (!projectSlug || !validProjectSlug(projectSlug)) return lotNumbers.map(() => null);
  const counts = new Map<string, number>();
  for (const value of lotNumbers) {
    if (typeof value === "string" && validLotNumber(value)) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return lotNumbers.map((value) =>
    typeof value === "string" && counts.get(value) === 1
      ? createPublicLotReference(projectSlug, value)
      : null
  );
}
