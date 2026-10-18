const STORAGE_PREFIX = "wamule:public-experience:v1";

function scopeSuffix(scope) {
  return [scope?.tenantSlug, scope?.projectSlug, scope?.phaseSlug]
    .map((part) => encodeURIComponent(String(part ?? "").trim().toLowerCase()))
    .join(":");
}

export function publicMapPreferencesStorageKey(scope) {
  return `${STORAGE_PREFIX}:map-preferences:${scopeSuffix(scope)}`;
}

export function publicWizardStepStorageKey(scope) {
  return `${STORAGE_PREFIX}:wizard-step:${scopeSuffix(scope)}`;
}

export function readPublicMapPreferences(storage, scope) {
  try {
    const parsed = JSON.parse(storage.getItem(publicMapPreferencesStorageKey(scope)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((ref) => typeof ref === "string" && ref.length <= 100 && ref.trim()))].slice(0, 20);
  } catch {
    return [];
  }
}

export function writePublicMapPreferences(storage, scope, refs) {
  try {
    const safeRefs = [...new Set((Array.isArray(refs) ? refs : [])
      .filter((ref) => typeof ref === "string" && ref.length <= 100 && ref.trim()))].slice(0, 20);
    storage.setItem(publicMapPreferencesStorageKey(scope), JSON.stringify(safeRefs));
    return true;
  } catch {
    return false;
  }
}

export function retainKnownMapPreferences(refs, knownRefs) {
  const known = new Set(knownRefs);
  return [...new Set((Array.isArray(refs) ? refs : []).filter((ref) => typeof ref === "string" && known.has(ref)))];
}

export function readPublicWizardStep(storage, scope, stepCount) {
  try {
    const value = Number(storage.getItem(publicWizardStepStorageKey(scope)));
    return Number.isInteger(value) && value >= 0 && value < stepCount ? value : 0;
  } catch {
    return 0;
  }
}

export function writePublicWizardStep(storage, scope, step, stepCount) {
  if (!Number.isInteger(step) || step < 0 || step >= stepCount) return false;
  try {
    storage.setItem(publicWizardStepStorageKey(scope), String(step));
    return true;
  } catch {
    return false;
  }
}
