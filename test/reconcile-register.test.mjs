import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);

function makeFixture({ includeSecondRegisterLot = false, includeLink = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "register-reconciliation-"));
  const source = (document) => ({ document, revision: "rev A", locator: "sheet 1" });
  const register = {
    schema_version: 1,
    project: { id: "hopkins-grove", name: "Hopkins Grove" },
    scope: { id: "full-plan", name: "Full plan" },
    revision: "register rev A",
    approval: { status: "approved", approved_by: "Owner", approved_at: "2026-10-11T12:00:00Z", source: "Signed register cover" },
    sources: {
      legal_identity: source("legal register"),
      area_unit: source("approved area schedule"),
      tier: source("sales plat legend"),
      price: source("approved price list"),
      status: source("availability report"),
    },
    lots: [
      { legal_lot_id: "LEGAL-07", display_lot_number: "07", area_value: 100, area_unit: "m²", tier_key: "standard", price_amount: 25000, price_currency: "BZD", status: "available", in_scope: true },
      ...(includeSecondRegisterLot ? [{ legal_lot_id: "LEGAL-08", display_lot_number: "08", area_value: 120, area_unit: "ft²", tier_key: "premium", price_amount: 30000, price_currency: "BZD", status: "available", in_scope: true }] : []),
    ],
  };
  const review = {
    schema_version: 1,
    project_id: "hopkins-grove",
    scope_id: "full-plan",
    links: includeLink ? [{ detection_id: "D-001", legal_lot_id: "LEGAL-07", decision: "approved", reviewer: "Map reviewer", reviewed_at: "2026-10-11T13:00:00Z", source: "Manual polygon inspection" }] : [],
    dispositions: [
      { detection_id: "D-001", disposition: "sellable", feature_type: "lot", reviewer: "Map reviewer", reviewed_at: "2026-10-11T13:00:00Z", source: "Manual polygon inspection" },
      { detection_id: "D-002", disposition: "common_area", feature_type: "road", reviewer: "Map reviewer", reviewed_at: "2026-10-11T13:05:00Z", source: "Recorded plat legend" },
    ],
  };
  const lots = [
    { lot_number: "D-001", tier_key: "standard", polygon_pct: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }], printed_lot_number: "07", printed_area_sqm: 100, match_status: "matched" },
    { lot_number: "D-002", tier_key: "road", polygon_pct: [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 6 }], printed_lot_number: null, printed_area_sqm: null, match_status: "unmatched" },
  ];
  for (const [name, value] of [["register.json", register], ["review.json", review], ["lots.json", lots]]) {
    writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
  }
  return { dir, lots };
}

function run(data, out = join(data.dir, "report.json"), extraArgs = []) {
  execFileSync("node", ["scripts/reconcile-register.mjs",
    "--register", join(data.dir, "register.json"),
    "--review", join(data.dir, "review.json"),
    "--lots", join(data.dir, "lots.json"),
    "--out", out,
    ...extraArgs,
  ], { cwd: root.pathname, encoding: "utf8" });
  return JSON.parse(readFileSync(out, "utf8"));
}

test("report-only reconciliation separates linked lots, missing register rows, and common areas", () => {
  const data = makeFixture({ includeSecondRegisterLot: true });
  const originalLots = readFileSync(join(data.dir, "lots.json"), "utf8");
  const report = run(data);

  assert.equal(report.status, "needs_review");
  assert.equal(report.release_approval, false);
  assert.equal(report.summary.register.statuses.linked, 1);
  assert.equal(report.summary.register.statuses.missing, 1);
  assert.equal(report.summary.detections.statuses.linked_sellable, 1);
  assert.equal(report.summary.detections.statuses.common_area, 1);
  assert.equal(report.register_rows[1].legal_lot_id, "LEGAL-08");
  assert.equal(report.register_rows[1].status, "missing");
  assert.deepEqual(JSON.parse(readFileSync(join(data.dir, "lots.json"), "utf8")), JSON.parse(originalLots));
  assert.match(report.note, /never automatic links/);
});

test("complete reviewed coverage remains pending owner acceptance", () => {
  const data = makeFixture();
  const report = run(data);
  assert.equal(report.status, "reconciled_pending_owner_acceptance");
  assert.equal(report.release_approval, false);
  assert.equal(report.summary.register.in_scope, 1);
  assert.equal(report.summary.detections.statuses.linked_sellable, 1);
  assert.equal(report.summary.detections.statuses.common_area, 1);
  assert.match(report.sources.register.sha256, /^[a-f0-9]{64}$/);
});

test("repeated display numbers remain distinct by canonical legal lot ID", () => {
  const data = makeFixture({ includeSecondRegisterLot: true });
  const registerPath = join(data.dir, "register.json");
  const register = JSON.parse(readFileSync(registerPath, "utf8"));
  register.lots[1].display_lot_number = register.lots[0].display_lot_number;
  writeFileSync(registerPath, JSON.stringify(register));

  const report = run(data);
  assert.equal(report.summary.register.total, 2);
  assert.equal(report.register_rows[0].legal_lot_id, "LEGAL-07");
  assert.equal(report.register_rows[1].legal_lot_id, "LEGAL-08");
  assert.equal(report.register_rows[0].display_lot_number, "07");
  assert.equal(report.register_rows[1].display_lot_number, "07");
  assert.equal(report.register_rows[1].status, "missing");
});

test("OCR agreement alone never links a register lot to a polygon", () => {
  const data = makeFixture({ includeLink: false });
  const report = run(data);
  assert.equal(report.status, "needs_review");
  assert.equal(report.register_rows[0].status, "missing");
  assert.equal(report.detection_rows[0].status, "sellable_unlinked");
});

test("contradictory approved and ambiguous link decisions become a conflict", () => {
  const data = makeFixture();
  const reviewPath = join(data.dir, "review.json");
  const review = JSON.parse(readFileSync(reviewPath, "utf8"));
  review.links.push({ detection_id: "D-001", legal_lot_id: "LEGAL-07", decision: "ambiguous",
    reviewer: "Map reviewer", reviewed_at: "2026-10-11T13:10:00Z", source: "Second review", note: "Conflicting drawing label" });
  writeFileSync(reviewPath, JSON.stringify(review));
  const report = run(data);
  assert.equal(report.register_rows[0].status, "conflict");
  assert.equal(report.detection_rows[0].status, "conflict");
});

test("unapproved register data is rejected before any report is written", () => {
  const data = makeFixture();
  const registerPath = join(data.dir, "register.json");
  const register = JSON.parse(readFileSync(registerPath, "utf8"));
  register.approval.status = "draft";
  writeFileSync(registerPath, JSON.stringify(register));
  const out = join(data.dir, "report.json");
  assert.throws(() => run(data, out), (error) =>
    error.status === 2 && String(error.stderr).includes("explicit approved status"));
  assert.throws(() => readFileSync(out, "utf8"), { code: "ENOENT" });
});

test("owner-input templates remain pending and cannot produce a reconciliation report", () => {
  const data = makeFixture();
  const register = JSON.parse(readFileSync(new URL("../docs/implementation/approved-register.template.json", import.meta.url), "utf8"));
  const review = JSON.parse(readFileSync(new URL("../docs/implementation/map-review.template.json", import.meta.url), "utf8"));
  assert.equal(register.approval.status, "pending");
  assert.equal(review.links[0].decision, "pending");
  assert.equal(review.dispositions[0].disposition, "pending");
  register.project = { id: "template-test", name: "Template test" };
  register.scope = { id: "template-scope", name: "Template scope" };
  register.revision = "template revision";
  register.approval.approved_by = "Test reviewer";
  register.approval.approved_at = "2026-10-11T12:00:00Z";
  register.approval.source = "Test source";
  writeFileSync(join(data.dir, "register.json"), JSON.stringify(register));
  writeFileSync(join(data.dir, "review.json"), JSON.stringify(review));

  const out = join(data.dir, "report.json");
  assert.throws(() => run(data, out), (error) =>
    error.status === 2 && String(error.stderr).includes("explicit approved status"));
  assert.throws(() => readFileSync(out, "utf8"), { code: "ENOENT" });
});

test("unknown options are rejected before any report is written", () => {
  const data = makeFixture();
  const out = join(data.dir, "report.json");
  assert.throws(() => run(data, out, ["--regitser", "typo.json"]), (error) =>
    error.status === 2 && String(error.stderr).includes("unknown option: --regitser"));
  assert.throws(() => readFileSync(out, "utf8"), { code: "ENOENT" });
});

test("area unit conversion overflow is rejected before any report is written", () => {
  const data = makeFixture();
  const registerPath = join(data.dir, "register.json");
  const register = JSON.parse(readFileSync(registerPath, "utf8"));
  register.lots[0].area_value = Number.MAX_VALUE;
  register.lots[0].area_unit = "hectares";
  writeFileSync(registerPath, JSON.stringify(register));
  const out = join(data.dir, "report.json");
  assert.throws(() => run(data, out), (error) =>
    error.status === 2 && String(error.stderr).includes("area must convert to a finite positive square-metre value"));
  assert.throws(() => readFileSync(out, "utf8"), { code: "ENOENT" });
});

test("duplicate options are rejected before any report is written", () => {
  const data = makeFixture();
  const out = join(data.dir, "report.json");
  assert.throws(() => run(data, out, ["--out", join(data.dir, "unexpected.json")]), (error) =>
    error.status === 2 && String(error.stderr).includes("option --out may only be provided once"));
  assert.throws(() => readFileSync(out, "utf8"), { code: "ENOENT" });
  assert.throws(() => readFileSync(join(data.dir, "unexpected.json"), "utf8"), { code: "ENOENT" });
});

test("register and detection identities reject leading or trailing whitespace", () => {
  const registerData = makeFixture();
  const registerPath = join(registerData.dir, "register.json");
  const register = JSON.parse(readFileSync(registerPath, "utf8"));
  register.lots[0].legal_lot_id = " LEGAL-07";
  writeFileSync(registerPath, JSON.stringify(register));
  assert.throws(() => run(registerData), (error) =>
    error.status === 2 && String(error.stderr).includes("legal_lot_id must be non-empty and have no leading or trailing whitespace"));
  assert.throws(() => readFileSync(join(registerData.dir, "report.json"), "utf8"), { code: "ENOENT" });

  const detectionData = makeFixture();
  const lotsPath = join(detectionData.dir, "lots.json");
  const lots = JSON.parse(readFileSync(lotsPath, "utf8"));
  lots[0].lot_number = "D-001 ";
  writeFileSync(lotsPath, JSON.stringify(lots));
  assert.throws(() => run(detectionData), (error) =>
    error.status === 2 && String(error.stderr).includes("lot_number must be non-empty and have no leading or trailing whitespace"));
  assert.throws(() => readFileSync(join(detectionData.dir, "report.json"), "utf8"), { code: "ENOENT" });
});

test("approval and review timestamps require valid timezone-qualified ISO-8601", () => {
  const data = makeFixture();
  const registerPath = join(data.dir, "register.json");
  const register = JSON.parse(readFileSync(registerPath, "utf8"));
  register.approval.approved_at = "10/11/2026 12:00:00Z";
  writeFileSync(registerPath, JSON.stringify(register));
  assert.throws(() => run(data), (error) =>
    error.status === 2 && String(error.stderr).includes("register approval.approved_at must be an ISO-8601 timestamp with timezone"));
  assert.throws(() => readFileSync(join(data.dir, "report.json"), "utf8"), { code: "ENOENT" });

  const invalidDateData = makeFixture();
  const reviewPath = join(invalidDateData.dir, "review.json");
  const review = JSON.parse(readFileSync(reviewPath, "utf8"));
  review.links[0].reviewed_at = "2026-02-30T12:00:00Z";
  writeFileSync(reviewPath, JSON.stringify(review));
  assert.throws(() => run(invalidDateData), (error) =>
    error.status === 2 && String(error.stderr).includes("link 1.reviewed_at must be a valid ISO-8601 timestamp with timezone"));
  assert.throws(() => readFileSync(join(invalidDateData.dir, "report.json"), "utf8"), { code: "ENOENT" });
});
