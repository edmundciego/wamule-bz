import assert from "node:assert/strict";
import test from "node:test";
import {
  createStagingBuildEnv,
  STAGING_SUBMISSION_SCOPE,
  STAGING_PROJECT_REF,
  STAGING_SUPABASE_URL,
} from "../scripts/staging-build-config.mjs";

const anonKeyFor = (ref) =>
  `header.${Buffer.from(JSON.stringify({ ref, role: "anon" })).toString("base64url")}.signature`;

test("staging build pins the backend and allows only the isolated map test project", () => {
  const env = createStagingBuildEnv({
    VITE_SUPABASE_URL: STAGING_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: anonKeyFor(STAGING_PROJECT_REF),
    VITE_PUBLIC_STAGING_SUBMISSION_SCOPES: "another-tenant/another-project",
    VITE_PUBLIC_DEMO_MODE: "false",
  });

  assert.equal(env.VITE_SUPABASE_URL, STAGING_SUPABASE_URL);
  assert.equal(env.VITE_BUILD_ENV, "staging-preview");
  assert.equal(env.VITE_PUBLIC_DEMO_MODE, "true");
  assert.equal(env.VITE_PUBLIC_STAGING_SUBMISSION_SCOPES, STAGING_SUBMISSION_SCOPE);
});

test("staging build rejects a non-staging Supabase URL", () => {
  assert.throws(
    () => createStagingBuildEnv({
      VITE_SUPABASE_URL: "https://production-project.supabase.co",
      VITE_SUPABASE_ANON_KEY: anonKeyFor("production-project"),
    }),
    /verified staging project/,
  );
});

test("staging build pins the backend when the site has no URL variable", () => {
  const env = createStagingBuildEnv({
    VITE_SUPABASE_ANON_KEY: anonKeyFor(STAGING_PROJECT_REF),
  });
  assert.equal(env.VITE_SUPABASE_URL, STAGING_SUPABASE_URL);
});

test("staging build rejects a missing browser-safe anon key", () => {
  assert.throws(
    () =>
      createStagingBuildEnv({
        VITE_SUPABASE_URL: STAGING_SUPABASE_URL,
      }),
    /browser-safe Supabase anon key/,
  );
});

test("staging build rejects an anon key issued for another project", () => {
  assert.throws(
    () =>
      createStagingBuildEnv({
        VITE_SUPABASE_ANON_KEY: anonKeyFor("production-project"),
      }),
    /does not match the verified staging project/,
  );
});
