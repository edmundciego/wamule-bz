import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Hopkins public map labels use plain language while preserving printed-number uncertainty", async () => {
  const [map, page, wizard] = await Promise.all([
    read("../src/components/public/PublicLotMap.tsx"),
    read("../src/pages/public/HopkinsPublicPage.tsx"),
    read("../src/pages/public/HopkinsApplicationWizard.tsx"),
  ]);
  const publicSources = `${map}\n${page}\n${wizard}`;
  for (const label of ["Map reference", "Plot category", "Plot category colors", "Search printed plan numbers or map references", "Possible printed plan number", "not confirmed against the plan"]) {
    assert.ok(publicSources.includes(label), `missing buyer-facing label: ${label}`);
  }
  for (const obsolete of ["Generated map reference", "Printed-number OCR candidate", "Search source number candidates or generated map references", "raster map detections · review/display only", "Source price colors"]) {
    assert.ok(!publicSources.includes(obsolete), `obsolete buyer-facing label remains: ${obsolete}`);
  }
  assert.match(map, /Map references are separate from printed numbers and do not indicate parcel allocation or availability/);
  assert.match(map, /aria-label=\{correctionMapLayer \? "Detected polygons on the map" : localPreviewMode \? "Hopkins Grove demo plots" : isHopkinsHostedMap \? "Hopkins Grove map outlines"/);
  assert.match(page, /Independent demonstration\. Not affiliated with or endorsed by Ceiba\. Demo submissions are not sent to Ceiba\./);
});

test("public submission calls are bypassed by local and explicit staging-preview mode", async () => {
  const [mode, modal, page, wizard, app] = await Promise.all([
    read("../src/lib/publicSubmissionMode.ts"),
    read("../src/components/public/PublicInquiryModal.tsx"),
    read("../src/pages/public/HopkinsPublicPage.tsx"),
    read("../src/pages/public/HopkinsApplicationWizard.tsx"),
    read("../src/pages/ApplicationPage.tsx"),
  ]);
  assert.match(mode, /import\.meta\.env\.DEV \|\| import\.meta\.env\.VITE_PUBLIC_DEMO_MODE === "true"/);
  assert.ok(modal.indexOf("if (localDemoOnly)") < modal.indexOf('supabase.functions.invoke("submit-public-inquiry"'));
  assert.ok(wizard.indexOf("if (localDemoOnly)") < wizard.indexOf("await submitPublicFunction"));
  assert.ok(app.indexOf("if (isLocalOnlySubmission)") < app.indexOf("await submitPublicFunction"));
  assert.match(page, /localDemoOnly=\{localDemoOnly\}/);
});

test("the restriction control is explicitly identified as an incomplete UI-only gate", async () => {
  const [settings, publicPage, migration] = await Promise.all([
    read("../src/components/admin/settings/PublicExperienceTemplateSettings.tsx"),
    read("../src/pages/public/HopkinsPublicPage.tsx"),
    read("../supabase/migrations/20261017090000_public_site_ui_restriction_flag.sql"),
  ]);
  const publicRoutes = await read("../src/pages/public/PublicExperienceRoute.tsx");
  assert.match(publicRoutes, /if \(experience\.uiRestrictedAccess\)/);
  assert.match(settings, /UI-only restricted preview · incomplete/);
  assert.match(settings, /server-side enforcement is not implemented/);
  assert.match(publicPage, /Its map and company endpoints are still public/);
  assert.match(migration, /does not enforce server-side access control/);
});
