import assert from "node:assert/strict";
import test from "node:test";
import { getNetlifyBuildScript } from "../scripts/netlify-build-target.mjs";

test("Netlify staging branch uses the guarded staging build", () => {
  assert.equal(
    getNetlifyBuildScript({ NETLIFY: "true", BRANCH: "staging" }),
    "build:staging",
  );
});

test("other branches retain the normal application build", () => {
  assert.equal(getNetlifyBuildScript({ NETLIFY: "true", BRANCH: "main" }), "build");
  assert.equal(getNetlifyBuildScript({ NETLIFY: "true", BRANCH: "review/demo" }), "build");
});

test("Netlify refuses to guess when its source branch is missing", () => {
  assert.throws(
    () => getNetlifyBuildScript({ NETLIFY_CONTEXT: "production" }),
    /missing its source branch/,
  );
});
