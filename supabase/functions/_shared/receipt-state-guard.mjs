/**
 * Recheck workspace state immediately before a receipt worker's external or
 * business-record side effects. Storage and Postgres cannot share a
 * transaction, so the caller must document the remaining concurrency window.
 */
export async function runIfReceiptScopeActive(validateScope, performSideEffects) {
  const current = await validateScope();
  if (!current?.ok) return { allowed: false };
  await performSideEffects();
  return { allowed: true };
}
