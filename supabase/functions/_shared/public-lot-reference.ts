/** A public locator is an identifier, not a secret or an authorization token. */
export const PUBLIC_LOT_REFERENCE_VERSION = "plr2";
export const LEGACY_PUBLIC_LOT_REFERENCE_VERSION = "plr1";

export type PublicLotReferenceParts = {
  version: "plr1" | "plr2";
  projectSlug: string;
  /** Null only for the backward-compatible, phase-blind plr1 format. */
  phaseSlug: string | null;
  lotNumber: string;
};

function validSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,159}$/.test(value);
}

function validLotNumber(value: string): boolean {
  return value.length > 0 && value.length <= 120 && value === value.trim();
}

/** New references always name the exact project, phase, and printed lot label. */
export function createPublicLotReference(projectSlug: string, phaseSlug: string, lotNumber: string): string | null {
  if (!validSlug(projectSlug) || !validSlug(phaseSlug) || !validLotNumber(lotNumber)) return null;
  return `${PUBLIC_LOT_REFERENCE_VERSION}:${encodeURIComponent(projectSlug)}:${encodeURIComponent(phaseSlug)}:${encodeURIComponent(lotNumber)}`;
}

/** Parse both the current phase-qualified format and old project/lot links. */
export function parsePublicLotReference(value: unknown): PublicLotReferenceParts | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const segments = value.split(":");
  try {
    if (segments.length === 4 && segments[0] === PUBLIC_LOT_REFERENCE_VERSION) {
      const projectSlug = decodeURIComponent(segments[1]);
      const phaseSlug = decodeURIComponent(segments[2]);
      const lotNumber = decodeURIComponent(segments[3]);
      if (!validSlug(projectSlug) || !validSlug(phaseSlug) || !validLotNumber(lotNumber)) return null;
      return { version: "plr2", projectSlug, phaseSlug, lotNumber };
    }
    if (segments.length === 3 && segments[0] === LEGACY_PUBLIC_LOT_REFERENCE_VERSION) {
      const projectSlug = decodeURIComponent(segments[1]);
      const lotNumber = decodeURIComponent(segments[2]);
      if (!validSlug(projectSlug) || !validLotNumber(lotNumber)) return null;
      return { version: "plr1", projectSlug, phaseSlug: null, lotNumber };
    }
    return null;
  } catch {
    return null;
  }
}

/** Suppress duplicate printed labels within a phase instead of issuing colliding references. */
export function assignPublicLotReferences(
  projectSlug: string | null,
  phaseSlug: string | null,
  lotNumbers: unknown[],
): Array<string | null> {
  if (!projectSlug || !phaseSlug || !validSlug(projectSlug) || !validSlug(phaseSlug)) {
    return lotNumbers.map(() => null);
  }
  const counts = new Map<string, number>();
  for (const value of lotNumbers) {
    if (typeof value === "string" && validLotNumber(value)) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return lotNumbers.map((value) =>
    typeof value === "string" && counts.get(value) === 1
      ? createPublicLotReference(projectSlug, phaseSlug, value)
      : null
  );
}
