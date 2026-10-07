// Aspect-ratio drift detection for masterplan versions.
// Maps are expected to cover the same site extent, so a draft whose aspect
// ratio differs from the active map means percentage-based polygon
// coordinates will land on distorted positions after activation. Callers
// should warn when the relative variance exceeds 2%.

export const ASPECT_DRIFT_THRESHOLD_PERCENT = 2;

export function calculateAspectDrift(
  draft: { width: number; height: number } | null,
  active: { width: number; height: number } | null,
): number | null {
  if (!draft || !active) return null;
  const draftWidth = Number(draft.width);
  const draftHeight = Number(draft.height);
  const activeWidth = Number(active.width);
  const activeHeight = Number(active.height);
  if (
    !Number.isFinite(draftWidth) || !Number.isFinite(draftHeight) ||
    !Number.isFinite(activeWidth) || !Number.isFinite(activeHeight) ||
    draftWidth <= 0 || draftHeight <= 0 || activeWidth <= 0 || activeHeight <= 0
  ) {
    return null;
  }
  const draftRatio = draftWidth / draftHeight;
  const activeRatio = activeWidth / activeHeight;
  if (!Number.isFinite(draftRatio) || !Number.isFinite(activeRatio) || activeRatio === 0) return null;
  const driftPercent = Math.abs(draftRatio - activeRatio) / activeRatio * 100;
  return driftPercent > ASPECT_DRIFT_THRESHOLD_PERCENT ? driftPercent : null;
}
