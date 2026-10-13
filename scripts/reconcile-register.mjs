#!/usr/bin/env node
/**
 * Reconcile an owner-approved register to reviewed map detections.
 *
 * This is a report-only operation. OCR values are shown as discrepancy cues;
 * they never create links and the input lots.json is never modified.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  const allowed = new Set(["register", "review", "lots", "out"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/reconcile-register.mjs --register approved-register.json --review map-review.json --lots lots.json [--out report.json]");
      process.exit(0);
    }
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (!allowed.has(key)) fail(`unknown option: ${arg}`);
    if (Object.hasOwn(args, key)) fail(`option ${arg} may only be provided once`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${arg}`);
    args[key] = value;
    index += 1;
  }
  for (const key of ["register", "review", "lots"]) {
    if (!args[key]) fail(`--${key} is required`);
  }
  return args;
}

function readJson(path, label) {
  try {
    const bytes = readFileSync(path);
    return {
      value: JSON.parse(bytes.toString("utf8")),
      fingerprint: { name: basename(path), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    };
  } catch (error) {
    fail(`${label} could not be read as JSON: ${error.message}`);
  }
}

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireCanonicalText(value, label) {
  if (!nonBlank(value) || value !== value.trim()) {
    fail(`${label} must be non-empty and have no leading or trailing whitespace`);
  }
}

function requireSource(source, label) {
  if (!source || !nonBlank(source.document) || !nonBlank(source.revision) || !nonBlank(source.locator)) {
    fail(`register source '${label}' needs document, revision, and locator`);
  }
}

function requireReviewMetadata(row, label) {
  if (!nonBlank(row.reviewer) || !nonBlank(row.source) || !nonBlank(row.reviewed_at)) {
    fail(`${label} needs reviewer, reviewed_at, and source`);
  }
  requireTimestamp(row.reviewed_at, `${label}.reviewed_at`);
}

function requireTimestamp(value, label) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) fail(`${label} must be an ISO-8601 timestamp with timezone`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 23 || offsetMinute > 59 || !Number.isFinite(Date.parse(value))) {
    fail(`${label} must be a valid ISO-8601 timestamp with timezone`);
  }
}

function validateRegister(register) {
  if (register?.schema_version !== 1) fail("register schema_version must be 1");
  requireCanonicalText(register.project?.id, "register project id");
  if (!nonBlank(register.project?.name)) fail("register project name is required");
  requireCanonicalText(register.scope?.id, "register scope id");
  if (!nonBlank(register.scope?.name)) fail("register scope name is required");
  requireCanonicalText(register.revision, "register revision");
  if (register.approval?.status !== "approved" || !nonBlank(register.approval?.approved_by) || !nonBlank(register.approval?.approved_at)) {
    fail("register must have explicit approved status, approver, and approval timestamp");
  }
  requireTimestamp(register.approval.approved_at, "register approval.approved_at");
  requireReviewMetadata({ reviewer: register.approval.approved_by, reviewed_at: register.approval.approved_at,
    source: register.approval.source }, "register approval");
  for (const field of ["legal_identity", "area_unit", "tier", "price", "status"]) {
    requireSource(register.sources?.[field], field);
  }
  if (!Array.isArray(register.lots) || register.lots.length === 0) fail("register lots must be a non-empty array");

  const legalIds = new Set();
  for (const [index, row] of register.lots.entries()) {
    const label = `register row ${index + 1}`;
    requireCanonicalText(row.legal_lot_id, `${label}.legal_lot_id`);
    requireCanonicalText(row.display_lot_number, `${label}.display_lot_number`);
    if (legalIds.has(row.legal_lot_id)) fail(`duplicate legal_lot_id: ${row.legal_lot_id}`);
    legalIds.add(row.legal_lot_id);
    if (typeof row.area_value !== "number" || !Number.isFinite(row.area_value) || row.area_value <= 0) fail(`${label} area_value must be positive`);
    if (!nonBlank(row.area_unit) || !nonBlank(row.tier_key) || !nonBlank(row.status)) fail(`${label} area_unit, tier_key, and status are required`);
    const areaSqm = squareMetres(row);
    if (areaSqm === null) fail(`${label} area_unit is unsupported; use m², ft², acres, or hectares`);
    if (!Number.isFinite(areaSqm) || areaSqm <= 0) fail(`${label} area must convert to a finite positive square-metre value`);
    if (typeof row.price_amount !== "number" || !Number.isFinite(row.price_amount) || row.price_amount < 0 || !nonBlank(row.price_currency)) {
      fail(`${label} price_amount and price_currency are required`);
    }
    if (typeof row.in_scope !== "boolean") fail(`${label} in_scope must be boolean`);
  }
  if (!register.lots.some((row) => row.in_scope === true)) fail("register must include at least one in-scope lot");
}

function validateLots(lots) {
  if (!Array.isArray(lots) || lots.length === 0) fail("lots input must be a non-empty array");
  const ids = new Set();
  for (const [index, lot] of lots.entries()) {
    const id = lot?.lot_number;
    requireCanonicalText(id, `detection ${index + 1} lot_number`);
    if (ids.has(id)) fail(`duplicate detection_id: ${id}`);
    ids.add(id);
    const polygon = lot.polygon_pct;
    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.some((point) =>
      !Number.isFinite(point?.x) || !Number.isFinite(point?.y) || point.x < 0 || point.x > 100 || point.y < 0 || point.y > 100)) {
      fail(`detection ${id} has invalid polygon_pct geometry`);
    }
  }
}

function validateReview(review, register, lots) {
  if (review?.schema_version !== 1) fail("review schema_version must be 1");
  if (review.project_id !== register.project.id || review.scope_id !== register.scope.id) {
    fail("review project_id/scope_id must match the approved register");
  }
  if (!Array.isArray(review.links) || !Array.isArray(review.dispositions)) fail("review must include links and dispositions arrays");
  const legalIds = new Set(register.lots.map((row) => row.legal_lot_id));
  const detectionIds = new Set(lots.map((row) => row.lot_number));
  for (const [index, row] of review.links.entries()) {
    const label = `link ${index + 1}`;
    if (!detectionIds.has(row.detection_id)) fail(`${label} references unknown detection_id ${row.detection_id}`);
    if (!legalIds.has(row.legal_lot_id)) fail(`${label} references unknown legal_lot_id ${row.legal_lot_id}`);
    if (!["approved", "ambiguous", "rejected"].includes(row.decision)) fail(`${label} decision must be approved, ambiguous, or rejected`);
    requireReviewMetadata(row, label);
    if (["ambiguous", "rejected"].includes(row.decision) && !nonBlank(row.note)) fail(`${label} needs a note when not approved`);
  }
  for (const [index, row] of review.dispositions.entries()) {
    const label = `disposition ${index + 1}`;
    if (!detectionIds.has(row.detection_id)) fail(`${label} references unknown detection_id ${row.detection_id}`);
    if (!["sellable", "common_area", "out_of_scope", "ambiguous"].includes(row.disposition)) {
      fail(`${label} disposition must be sellable, common_area, out_of_scope, or ambiguous`);
    }
    if (!nonBlank(row.feature_type)) fail(`${label} feature_type is required`);
    requireReviewMetadata(row, label);
    if (row.disposition === "ambiguous" && !nonBlank(row.note)) fail(`${label} needs a note when ambiguous`);
  }
}

function squareMetres(row) {
  const unit = row.area_unit.trim().toLowerCase().replaceAll("²", "2").replaceAll(" ", "");
  const factors = { "m2": 1, sqm: 1, "sq.m": 1, "sqmeter": 1, "sqmeters": 1,
    "ft2": 0.09290304, sqft: 0.09290304, "sq.ft": 0.09290304,
    acre: 4046.8564224, acres: 4046.8564224, ha: 10000, hectare: 10000, hectares: 10000 };
  return factors[unit] === undefined ? null : row.area_value * factors[unit];
}

function reconcile(register, review, lots, fingerprints) {
  const inScope = register.lots.filter((row) => row.in_scope);
  const registerById = new Map(register.lots.map((row) => [row.legal_lot_id, row]));
  const approvedLinks = review.links.filter((row) => row.decision === "approved");
  const ambiguousLinks = review.links.filter((row) => row.decision === "ambiguous");
  const linksByDetection = new Map();
  const linksByLegalId = new Map();
  const decisionsByDetection = new Map();
  const decisionsByLegalId = new Map();
  for (const link of review.links) {
    decisionsByDetection.set(link.detection_id, [...(decisionsByDetection.get(link.detection_id) ?? []), link]);
    decisionsByLegalId.set(link.legal_lot_id, [...(decisionsByLegalId.get(link.legal_lot_id) ?? []), link]);
  }
  for (const link of approvedLinks) {
    linksByDetection.set(link.detection_id, [...(linksByDetection.get(link.detection_id) ?? []), link]);
    linksByLegalId.set(link.legal_lot_id, [...(linksByLegalId.get(link.legal_lot_id) ?? []), link]);
  }
  const dispositionsById = new Map();
  for (const row of review.dispositions) dispositionsById.set(row.detection_id, [...(dispositionsById.get(row.detection_id) ?? []), row]);

  const registerRows = register.lots.map((row) => {
    if (!row.in_scope) return { legal_lot_id: row.legal_lot_id, display_lot_number: row.display_lot_number, status: "out_of_scope" };
    const links = linksByLegalId.get(row.legal_lot_id) ?? [];
    const decisions = decisionsByLegalId.get(row.legal_lot_id) ?? [];
    const ambiguous = ambiguousLinks.some((link) => link.legal_lot_id === row.legal_lot_id);
    if (links.length && decisions.some((link) => link.decision !== "approved")) {
      return { legal_lot_id: row.legal_lot_id, display_lot_number: row.display_lot_number, status: "conflict", conflict: "contradictory link decisions" };
    }
    if (links.length > 1) return { legal_lot_id: row.legal_lot_id, display_lot_number: row.display_lot_number, status: "conflict", conflict: "multiple approved detections" };
    if (!links.length) return { legal_lot_id: row.legal_lot_id, display_lot_number: row.display_lot_number, status: ambiguous ? "ambiguous" : "missing" };
    const link = links[0];
    const reverseLinks = linksByDetection.get(link.detection_id) ?? [];
    const dispositionRows = dispositionsById.get(link.detection_id) ?? [];
    if (reverseLinks.length > 1 || dispositionRows.length !== 1) {
      return { legal_lot_id: row.legal_lot_id, display_lot_number: row.display_lot_number, detection_id: link.detection_id,
        status: "conflict", conflict: reverseLinks.length > 1 ? "one detection linked to multiple register rows" : "linked detection lacks exactly one reviewed disposition" };
    }
    if (dispositionRows[0].disposition !== "sellable") {
      return { legal_lot_id: row.legal_lot_id, display_lot_number: row.display_lot_number, detection_id: link.detection_id,
        status: "conflict", conflict: `register link conflicts with ${dispositionRows[0].disposition} disposition` };
    }
    return { legal_lot_id: row.legal_lot_id, display_lot_number: row.display_lot_number, detection_id: link.detection_id, status: "linked" };
  });

  const detectionRows = lots.map((lot) => {
    const id = lot.lot_number;
    const links = linksByDetection.get(id) ?? [];
    const decisions = decisionsByDetection.get(id) ?? [];
    const ambiguousLink = ambiguousLinks.some((link) => link.detection_id === id);
    const dispositionRows = dispositionsById.get(id) ?? [];
    const base = { detection_id: id, detected_tier_key: lot.tier_key ?? null,
      ocr_printed_lot_number: lot.printed_lot_number ?? null,
      ocr_printed_area_sqm: Number.isFinite(lot.printed_area_sqm) ? lot.printed_area_sqm : null };
    if (links.length > 1) return { ...base, status: "conflict", conflict: "detection linked to multiple register rows" };
    if (links.length && decisions.some((link) => link.decision !== "approved")) return { ...base, status: "conflict", conflict: "contradictory link decisions" };
    if (dispositionRows.length > 1) return { ...base, status: "conflict", conflict: "multiple dispositions" };
    const disposition = dispositionRows[0]?.disposition ?? null;
    if (links.length === 1) {
      const link = links[0];
      const legalLinks = linksByLegalId.get(link.legal_lot_id) ?? [];
      if (legalLinks.length > 1) return { ...base, status: "conflict", conflict: "register lot linked to multiple detections" };
      if (disposition !== "sellable") return { ...base, status: "conflict", conflict: `approved link conflicts with ${disposition ?? "missing"} disposition` };
      const registerRow = registerById.get(link.legal_lot_id);
      if (!registerRow.in_scope) return { ...base, legal_lot_id: link.legal_lot_id, status: "conflict", conflict: "approved link targets an out-of-scope register lot" };
      const discrepancies = [];
      if (lot.printed_lot_number != null && String(lot.printed_lot_number).trim() !== registerRow.display_lot_number.trim()) {
        discrepancies.push({ field: "ocr_printed_lot_number", register: registerRow.display_lot_number, detected: lot.printed_lot_number });
      }
      if (lot.tier_key && lot.tier_key !== registerRow.tier_key) discrepancies.push({ field: "tier_key", register: registerRow.tier_key, detected: lot.tier_key });
      const areaM2 = squareMetres(registerRow);
      if (areaM2 !== null && Number.isFinite(lot.printed_area_sqm) && Math.abs(areaM2 - lot.printed_area_sqm) > 0.005) {
        discrepancies.push({ field: "ocr_printed_area_sqm", register_sqm: Number(areaM2.toFixed(3)), detected_sqm: lot.printed_area_sqm });
      }
      return { ...base, legal_lot_id: link.legal_lot_id, status: "linked_sellable", discrepancies };
    }
    if (ambiguousLink && ["common_area", "out_of_scope"].includes(disposition)) {
      return { ...base, status: "conflict", conflict: `ambiguous lot link conflicts with ${disposition} disposition` };
    }
    if (disposition === "common_area") return { ...base, status: "common_area", feature_type: dispositionRows[0].feature_type };
    if (disposition === "out_of_scope") return { ...base, status: "out_of_scope", feature_type: dispositionRows[0].feature_type };
    if (disposition === "ambiguous" || ambiguousLink) return { ...base, status: "ambiguous", feature_type: dispositionRows[0]?.feature_type ?? null };
    if (disposition === "sellable") return { ...base, status: "sellable_unlinked", feature_type: dispositionRows[0].feature_type };
    return { ...base, status: "unclassified" };
  });

  const counts = (rows) => Object.fromEntries([...new Set(rows.map((row) => row.status))].sort()
    .map((status) => [status, rows.filter((row) => row.status === status).length]));
  const unresolvedRegister = registerRows.some((row) => row.status === "missing" || row.status === "ambiguous" || row.status === "conflict");
  const unresolvedDetections = detectionRows.some((row) => ["sellable_unlinked", "unclassified", "ambiguous", "conflict"].includes(row.status));
  const discrepancies = detectionRows.flatMap((row) => (row.discrepancies ?? []).map((item) => ({ detection_id: row.detection_id, ...item })));
  const complete = !unresolvedRegister && !unresolvedDetections && discrepancies.length === 0;
  return {
    schema_version: 1,
    report_type: "register-to-polygon-reconciliation",
    status: complete ? "reconciled_pending_owner_acceptance" : "needs_review",
    release_approval: false,
    project: register.project,
    scope: register.scope,
    register_revision: register.revision,
    sources: fingerprints,
    summary: {
      register: { in_scope: inScope.length, total: register.lots.length, statuses: counts(registerRows) },
      detections: { total: lots.length, statuses: counts(detectionRows) },
      discrepancy_count: discrepancies.length,
      approved_link_count: approvedLinks.length,
      ambiguous_link_count: ambiguousLinks.length,
    },
    register_rows: registerRows,
    detection_rows: detectionRows,
    discrepancies,
    note: "Report only. OCR fields are discrepancy cues, never automatic links. Input polygons and register were not modified.",
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const key of ["register", "review", "lots"]) {
    if (!existsSync(args[key])) fail(`${key} file not found: ${args[key]}`);
  }
  const registerFile = readJson(args.register, "register");
  const reviewFile = readJson(args.review, "review");
  const lotsFile = readJson(args.lots, "lots");
  validateRegister(registerFile.value);
  validateLots(lotsFile.value);
  validateReview(reviewFile.value, registerFile.value, lotsFile.value);
  const report = reconcile(registerFile.value, reviewFile.value, lotsFile.value, {
    register: registerFile.fingerprint,
    review: reviewFile.fingerprint,
    detections: lotsFile.fingerprint,
  });
  const output = resolve(args.out ?? "out/register-reconciliation.json");
  mkdirSync(dirname(output), { recursive: true });
  try {
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") fail(`refusing to overwrite report evidence: ${output}`);
    fail(`could not write report: ${error.message}`);
  }
  console.log(`reconciliation report: ${output}`);
  console.log(`status: ${report.status}; register in-scope: ${report.summary.register.in_scope}; detections: ${report.summary.detections.total}; discrepancies: ${report.summary.discrepancy_count}`);
}

main();
