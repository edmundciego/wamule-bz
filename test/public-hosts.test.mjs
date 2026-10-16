import assert from "node:assert/strict";
import test from "node:test";
import { isHopkinsPublicHost } from "../src/lib/publicHosts.ts";

test("Hopkins public root host is prepared without changing the staging root", () => {
  assert.equal(isHopkinsPublicHost("hopkinsgrove.ceiba.bz"), true);
  assert.equal(isHopkinsPublicHost("HOPKINSGROVE.CEIBA.BZ:443"), true);
  assert.equal(isHopkinsPublicHost("wamule-staging.netlify.app"), false);
});
