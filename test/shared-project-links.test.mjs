import test from "node:test";
import assert from "node:assert/strict";
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
