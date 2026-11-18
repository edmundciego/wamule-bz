import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const splitSource = await readFile(new URL("../src/lib/mapPolygonSplit.ts", import.meta.url), "utf8");
const splitJavascript = ts.transpile(splitSource, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 });
const splitModule = await import(`data:text/javascript;base64,${Buffer.from(splitJavascript).toString("base64")}`);
const approvalSource = await readFile(new URL("../src/lib/mapApprovalFlow.ts", import.meta.url), "utf8");
const approvalJavascript = ts.transpile(approvalSource, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 })
  .replace('from "./mapPolygonSplit"', `from "data:text/javascript;base64,${Buffer.from(splitJavascript).toString("base64")}"`);
const approval = await import(`data:text/javascript;base64,${Buffer.from(approvalJavascript).toString("base64")}`);

const context = {
  benchmark_id: "synthetic-v1",
  benchmark_manifest_sha256: "manifest-fingerprint",
  source_image_sha256: "source-fingerprint",
};
const parent = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 10 }, { x: 0, y: 10 }];
const children = [
  [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 10 }, { x: 0, y: 10 }],
  [{ x: 4, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 10 }, { x: 4, y: 10 }],
  [{ x: 8, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 10 }, { x: 8, y: 10 }],
];

function draft(id, status = "accepted-draft", revision = 1, geometry = children) {
  return {
    draft_id: id,
    source_kind: id === "manual-six" ? "manual" : "plat-digitizer",
    status,
    parent_detection_id: id === "manual-six" ? "FIX-006" : "FIX-002",
    parent_polygon_pct: parent,
    source_image_sha256: context.source_image_sha256,
    proposal_fingerprint: id === "manual-six" ? null : "proposal-sha",
    detection_source_sha256: id === "manual-six" ? null : "detection-sha",
    created_by: "QA reviewer",
    created_at: "2026-10-14T12:00:00.000Z",
    updated_at: "2026-10-14T12:00:00.000Z",
    active_points: [],
    drawing_enabled: false,
    children: geometry.map((polygon, index) => ({
      id: `${id}-child-${index + 1}`,
      parent_detection_id: id === "manual-six" ? "FIX-006" : "FIX-002",
      polygon_pct: polygon,
      geometry_source: "opencv-contour",
      proposed_printed_number: id === "manual-six" ? null : String(901 + index),
      number_provider: "synthetic-fixture",
      number_model_version: "fixture-v1",
      number_confidence_note: "Unverified test suggestion.",
      review: { status: "draft", printed_number: "", reviewer: "", reviewed_at: null },
      geometry_validation: { valid: true, errors: [], warnings: [] },
      geometry_history: [],
    })),
    unassigned_area_percent: 0,
    proposal_validation: { valid: true, errors: [], warnings: [] },
    edit_history: [],
    revision,
  };
}

test("merge writes by stable ID and preserves a separate six-child manual draft", () => {
  const manual = draft("manual-six", "in-progress", 3, Array.from({ length: 6 }, (_, index) => children[index % 3]));
  const proposal = draft("plat-proposal", "proposal-review", 1);
  const store = { schema_version: 1, ...context, drafts: [manual], approved_snapshots: [] };
  const merged = approval.mergeDraftUpdate(store, proposal, null);
  assert.deepEqual(merged.drafts.map((entry) => entry.draft_id), ["manual-six", "plat-proposal"]);
  assert.equal(merged.drafts[0].children.length, 6);
  assert.equal(merged.drafts[0].status, "in-progress");
});

test("stale same-ID writes are refused instead of overwriting newer browser-local work", () => {
  const saved = draft("plat-proposal", "accepted-draft", 4);
  const store = { schema_version: 1, ...context, drafts: [saved], approved_snapshots: [] };
  assert.throws(() => approval.mergeDraftUpdate(store, { ...saved, updated_at: "later" }, 3), /changed in another tab/);
});

test("approval snapshots are idempotent and keep all printed labels blank and pending", async () => {
  const accepted = draft("plat-proposal");
  const revision = await approval.draftRevisionFingerprint(accepted);
  const snapshot = approval.buildApprovedPreviewSnapshot(accepted, revision, {
    reviewer: "Owner Reviewer",
    note: "Source geometry reviewed for the internal preview only.",
    waiver: null,
    approvedAt: "2026-10-14T12:30:00.000Z",
    parentMapReference: "TEST-002",
  });
  assert.deepEqual(snapshot.children.map((child) => [child.printed_number, child.label_status]), Array.from({ length: 3 }, () => ["", "pending"]));
  const store = { schema_version: 1, ...context, drafts: [accepted], approved_snapshots: [] };
  const once = approval.persistApprovalSnapshot(store, accepted.draft_id, revision, accepted, snapshot);
  const twice = approval.persistApprovalSnapshot(once, accepted.draft_id, revision, accepted, snapshot);
  assert.equal(once.approved_snapshots.length, 1);
  assert.equal(twice.approved_snapshots.length, 1);
  assert.equal(twice.drafts[0].status, "approved-preview");
  assert.throws(() => approval.persistApprovalSnapshot(store, accepted.draft_id, "stale-revision", accepted, snapshot), /stale/);
});

test("invalid overlaps remain blocked by geometry validation", () => {
  const overlap = [children[0], [{ x: 3, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 10 }, { x: 3, y: 10 }], children[2]];
  const invalid = draft("plat-invalid", "accepted-draft", 1, overlap);
  const store = { schema_version: 1, ...context, drafts: [invalid], approved_snapshots: [] };
  const revision = "expected";
  const snapshot = approval.buildApprovedPreviewSnapshot(invalid, revision, { reviewer: "Reviewer", note: "Checked", waiver: null, approvedAt: "now", parentMapReference: "TEST-002" });
  assert.throws(() => approval.persistApprovalSnapshot(store, invalid.draft_id, revision, invalid, snapshot), /overlap or cross/);
});
