import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ALLOWED_INQUIRY_INTERESTS,
  buildInquiryPayload,
  validateInquiryPayload,
} from "../supabase/functions/_shared/inquiry-contract.ts";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const UUID = "123e4567-e89b-42d3-a456-426614174000";

// The modal's exact payload shape validates clean.
test("modal payload matches the function validation schema", () => {
  const body = buildInquiryPayload({
    name: "Amara Test",
    email: "Amara.Test@Example.com",
    phone: "+5015550100",
    interests: ["Available lots", "A specific lot"],
    specificLotId: 49,
    message: "Interested in this lot.",
    pageUrl: "https://example.com/embed/wamule",
    tenant: "wamule",
    clientReferenceId: UUID,
  });
  assert.equal(body.specific_lot_id, 49);
  assert.equal(body.client_reference_id, UUID);
  const result = validateInquiryPayload(body);
  assert.ok(!("error" in result));
  assert.equal(result.email, "amara.test@example.com");
  assert.equal(result.specificLotId, 49);
  assert.equal(result.tenantSlug, "wamule");
});

// The application-page inquiry (no tenant, optional lot) validates clean,
// and absent optionals are dropped from the wire body.
test("application inquiry payload validates without tenant", () => {
  const body = buildInquiryPayload({
    name: "Amara Test",
    email: "amara@example.com",
    interests: ["Lot pricing"],
    specificLotId: null,
    message: "",
    pageUrl: "",
    clientReferenceId: UUID,
  });
  assert.ok(!("tenant" in body));
  assert.ok(!("specific_lot_id" in body));
  const result = validateInquiryPayload(body);
  assert.ok(!("error" in result));
  assert.equal(result.tenantSlug, null);
  assert.equal(result.specificLotId, null);
});

test("schema rejects bad interest, email, name, lot, and reference", () => {
  const base = {
    name: "Amara Test",
    email: "amara@example.com",
    interests: ["Available lots"],
    clientReferenceId: UUID,
  };
  assert.equal(
    validateInquiryPayload(buildInquiryPayload({ ...base, interests: ["Moon plots"] })).error,
    "Select a valid inquiry interest.",
  );
  assert.equal(
    validateInquiryPayload(buildInquiryPayload({ ...base, email: "not-an-email" })).error,
    "Enter a valid email address.",
  );
  assert.equal(
    validateInquiryPayload(buildInquiryPayload({ ...base, name: "  " })).error,
    "Name is required.",
  );
  for (const badLot of [0, -3, 1.5, "abc"]) {
    const result = validateInquiryPayload({ ...base, specific_lot_id: badLot });
    assert.equal(result.error, "Select a valid lot.", `lot ${String(badLot)}`);
  }
  assert.equal(
    validateInquiryPayload(buildInquiryPayload({ ...base, clientReferenceId: "x" })).error,
    "Invalid request reference. Please reload and try again.",
  );
});

// Both inquiry forms build their wire body with the shared builder, and
// every interest literal they can send is in the shared allow-list.
test("frontend forms share the contract (no drift)", async () => {
  const [modal, page] = await Promise.all([
    read("src/components/public/PublicInquiryModal.tsx"),
    read("src/pages/ApplicationPage.tsx"),
  ]);
  for (const [file, source] of [["modal", modal], ["page", page]]) {
    assert.match(source, /buildInquiryPayload\(/, `${file} must use the shared payload builder`);
    assert.match(source, /supabase\/functions\/_shared\/inquiry-contract/, `${file} must import the shared contract`);
  }
  const arrayBlock = (source, anchor) => {
    const start = source.indexOf(anchor);
    assert.ok(start >= 0, `anchor ${anchor} found`);
    return source.slice(start, source.indexOf("]", start));
  };
  const literals = new Set(
    [
      ...arrayBlock(modal, "interests: [").matchAll(/"([^"]+)"/g),
      ...arrayBlock(page, "const inquiryInterests = [").matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]),
  );
  assert.ok(literals.size > 0);
  for (const literal of literals) {
    assert.ok(
      ALLOWED_INQUIRY_INTERESTS.includes(literal),
      `interest literal ${JSON.stringify(literal)} not in shared allow-list`,
    );
  }
});
