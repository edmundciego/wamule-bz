import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildSharedProjectLinks } from "../src/lib/sharedProjectLinks.mjs";

test("shared project links contain full tenant, project and selected phase slugs", () => {
  const links = buildSharedProjectLinks("https://staging.example.test/admin", {
    tenantSlug: "wamule",
    projectSlug: "synthetic-review",
    phaseSlug: "initial",
  });
  assert.deepEqual(links, {
    projectUrl: "https://staging.example.test/p/wamule/synthetic-review?phase=initial",
    mapUrl: "https://staging.example.test/p/wamule/synthetic-review/map?phase=initial",
  });
});

test("shared project links reject missing or malformed workspace slugs", () => {
  assert.throws(() => buildSharedProjectLinks("https://staging.example.test", {
    tenantSlug: "wamule",
    projectSlug: "../outside",
    phaseSlug: "initial",
  }), /invalid public slug/i);
});

test("walkthrough verifies a public Later page with its map and intake still closed", async () => {
  const walkthrough = await readFile(new URL("../scripts/run-tenant-walkthrough.mjs", import.meta.url), "utf8");
  assert.match(walkthrough, /otherMap\.response\.status === 404/);
  assert.match(walkthrough, /otherSite\.body\.publicApplication\?\.applications_open === false/);
  assert.match(walkthrough, /otherSubmission\.status === 403/);
});
