const memoryFallback = new Map();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storageKey(scope) {
  return `wamule:summary-generation:${scope}`;
}

function currentStorage() {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function createUuid() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Reuse the pending generation ID until the caller confirms success. */
export function getOrCreateSummaryGenerationId(scope, storage = currentStorage(), createId = createUuid) {
  const key = storageKey(scope);
  try {
    const stored = storage?.getItem(key);
    if (stored && UUID_PATTERN.test(stored)) {
      memoryFallback.set(key, stored);
      return stored;
    }
  } catch {
    // Continue with the per-page fallback when browser storage is unavailable.
  }

  const remembered = memoryFallback.get(key);
  if (remembered && UUID_PATTERN.test(remembered)) return remembered;

  const generationId = createId();
  if (!UUID_PATTERN.test(generationId)) throw new Error("Summary generation ID source must return a UUID.");
  memoryFallback.set(key, generationId);
  try {
    storage?.setItem(key, generationId);
  } catch {
    // The module fallback keeps retries stable until this page is closed.
  }
  return generationId;
}

/** Clear only after success so the next intentional generation gets a new ID. */
export function completeSummaryGeneration(scope, storage = currentStorage()) {
  const key = storageKey(scope);
  memoryFallback.delete(key);
  try {
    storage?.removeItem(key);
  } catch {
    // The in-memory copy is already cleared.
  }
}
