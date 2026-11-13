import test from "node:test";
import assert from "node:assert/strict";
import { assertTargetIdentity, projectRefFromUrl } from "../scripts/lib/tenant-provisioning-service.mjs";

test("the Supabase CLI Edge Runtime gateways resolve to the disposable local project", () => {
  assert.equal(projectRefFromUrl("http://kong:8000"), "local");
  assert.equal(projectRefFromUrl("http://api-gw:8000"), "local");
  assert.equal(assertTargetIdentity({ supabaseUrl: "http://kong:8000", expectedProjectRef: "local", apply: true }), "local");
});

test("only loopback and the known local gateway host/port are treated as local", () => {
  assert.equal(projectRefFromUrl("http://127.0.0.1:54321"), "local");
  assert.equal(projectRefFromUrl("http://localhost:54321"), "local");
  for (const url of [
    "http://kong:54321",
    "https://kong:8000",
    "https://api-gw:8000",
    "https://custom.example.test",
  ]) {
    assert.throws(() => projectRefFromUrl(url), /custom hosts require a reviewed resolver/, url);
  }
});

test("the target guard still pins staging and blocks production", () => {
  assert.equal(
    assertTargetIdentity({ supabaseUrl: "https://kvocwmrcuhiaezlcgzjf.supabase.co", expectedProjectRef: "kvocwmrcuhiaezlcgzjf", apply: true }),
    "kvocwmrcuhiaezlcgzjf",
  );
  assert.throws(
    () => assertTargetIdentity({ supabaseUrl: "http://kong:8000", expectedProjectRef: "kvocwmrcuhiaezlcgzjf", apply: true }),
    /Target mismatch: configured project local does not match expected kvocwmrcuhiaezlcgzjf/,
  );
  assert.throws(
    () => assertTargetIdentity({ supabaseUrl: "https://mtjlvzrtihslcftxnlso.supabase.co", expectedProjectRef: "mtjlvzrtihslcftxnlso", apply: true }),
    /production Wamule project is blocked/,
  );
});
