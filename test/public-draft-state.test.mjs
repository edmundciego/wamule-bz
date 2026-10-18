import assert from "node:assert/strict";
import test from "node:test";
import {
  publicMapPreferencesStorageKey,
  publicWizardStepStorageKey,
  readPublicMapPreferences,
  readPublicWizardStep,
  retainKnownMapPreferences,
  writePublicMapPreferences,
  writePublicWizardStep,
} from "../src/lib/publicDraftState.mjs";

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

const hopkins = { tenantSlug: "hopkins-grove", projectSlug: "hopkins-grove", phaseSlug: "initial" };
const wamule = { tenantSlug: "wamule", projectSlug: "wamule", phaseSlug: "default" };

test("public map references and wizard step persist only in tenant/project/phase scoped keys", () => {
  const storage = memoryStorage();
  writePublicMapPreferences(storage, hopkins, ["feature-a", "feature-a", "feature-b"]);
  assert.deepEqual(readPublicMapPreferences(storage, hopkins), ["feature-a", "feature-b"]);
  assert.deepEqual(readPublicMapPreferences(storage, wamule), []);
  assert.notEqual(publicMapPreferencesStorageKey(hopkins), publicMapPreferencesStorageKey(wamule));

  assert.equal(writePublicWizardStep(storage, hopkins, 2, 5), true);
  assert.equal(readPublicWizardStep(storage, hopkins, 5), 2);
  assert.equal(readPublicWizardStep(storage, wamule, 5), 0);
  assert.notEqual(publicWizardStepStorageKey(hopkins), publicWizardStepStorageKey(wamule));
});

test("persisted preferences are revalidated against current scoped map references", () => {
  assert.deepEqual(retainKnownMapPreferences(["old", "kept", "kept"], ["kept", "new"]), ["kept"]);
});

test("applicant contact data is not part of public draft persistence", () => {
  const storage = memoryStorage();
  writePublicMapPreferences(storage, hopkins, ["map-ref-392"]);
  writePublicWizardStep(storage, hopkins, 3, 5);
  const persisted = [...storage.values.entries()];
  assert.deepEqual(persisted.map(([key]) => key).sort(), [publicMapPreferencesStorageKey(hopkins), publicWizardStepStorageKey(hopkins)].sort());
  assert.doesNotMatch(JSON.stringify(persisted), /applicant|email|phone|address|signature|@/i);
});
