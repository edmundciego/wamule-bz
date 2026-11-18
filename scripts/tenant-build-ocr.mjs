/** Build the OCR CLI sequence for a tenant build without inventing scale. */
export function validateScaleConfig(scale) {
  if (scale === null || scale === undefined) return null;
  if (!scale || typeof scale !== "object" || Array.isArray(scale)) {
    throw new Error("tenant.json scale must be null or an object");
  }
  if (!Number.isFinite(scale.road_width_ft) || scale.road_width_ft <= 0) {
    throw new Error("tenant.json scale.road_width_ft must be a positive finite number");
  }
  const band = scale.road_band;
  if (!Array.isArray(band) || ![2, 4].includes(band.length) || !band.every(Number.isFinite)) {
    throw new Error("tenant.json scale.road_band must be [x0,x1] or [x0,x1,y0,y1] in native pixels");
  }
  if (band[0] >= band[1] || (band.length === 4 && band[2] >= band[3])) {
    throw new Error("tenant.json scale.road_band coordinates must be ordered low-to-high");
  }
  return scale;
}

/** Validate the shared, versioned review contract; pending is deliberately unavailable. */
export function validateAreaValidationPolicy(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== 1) {
    throw new Error("area policy schema_version must be 1");
  }
  const approvalFields = ["policy_id", "policy_version", "tolerance_fraction", "approved_by",
    "approved_at", "basis", "evidence_reference"];
  if (value.status === "pending") {
    if (approvalFields.some((key) => value[key] !== null)) {
      throw new Error("pending area policy must set all approval fields to null");
    }
    return null;
  }
  if (value.status !== "approved") throw new Error("area policy status must be pending or approved");
  if (typeof value.policy_id !== "string" || value.policy_id !== value.policy_id.trim() ||
      !/^[a-z0-9][a-z0-9._-]*$/i.test(value.policy_id)) {
    throw new Error("approved area policy needs a stable policy_id");
  }
  if (!Number.isInteger(value.policy_version) || value.policy_version < 1) {
    throw new Error("approved area policy policy_version must be a positive integer");
  }
  if (!Number.isFinite(value.tolerance_fraction) || value.tolerance_fraction < 0 || value.tolerance_fraction >= 1) {
    throw new Error("approved area policy tolerance_fraction must be finite and in [0, 1)");
  }
  for (const key of ["approved_by", "basis", "evidence_reference"]) {
    if (typeof value[key] !== "string" || !value[key].trim()) {
      throw new Error(`approved area policy needs non-empty ${key}`);
    }
  }
  const day = typeof value.approved_at === "string" ? value.approved_at.slice(0, 10) : "";
  const [hour, minute, second] = typeof value.approved_at === "string"
    ? value.approved_at.slice(11, 19).split(":").map(Number)
    : [NaN, NaN, NaN];
  const dayTimestamp = day ? Date.parse(`${day}T00:00:00Z`) : NaN;
  if (typeof value.approved_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.approved_at) ||
      !Number.isFinite(Date.parse(value.approved_at)) || !Number.isFinite(dayTimestamp) ||
      new Date(dayTimestamp).toISOString().slice(0, 10) !== day ||
      hour > 23 || minute > 59 || second > 59) {
    throw new Error("approved area policy approved_at must be ISO-8601 with timezone");
  }
  return value;
}

export function planOcrCommands(outDir, tiersPath, engines, scale, areaPolicyPath = null) {
  if (!Array.isArray(engines) || engines.length === 0) {
    throw new Error("at least one OCR engine is required");
  }
  const selectedEngines = engines.length > 1 ? "both" : engines[0];
  const base = ["scripts/ocr-match.py", "--dir", outDir, "--tiers", tiersPath,
    "--engines", selectedEngines];

  if (!scale) {
    // S1 creates fresh source-bound tokens; S2 consumes those tokens. A direct
    // `--stage match` would look for an ocr.json that a fresh build lacks.
    return [
      { label: "ocr (S1)", args: [...base, "--stage", "ocr"] },
      { label: "ocr-match (S2)", args: [...base, "--stage", "match"] },
    ];
  }

  return [{
    label: "ocr-match (S1-S3)",
    args: [
      ...base,
      "--road-band", scale.road_band.join(","),
      "--road-width-ft", String(scale.road_width_ft),
      ...(areaPolicyPath ? ["--area-policy", areaPolicyPath] : []),
      "--stage", "all",
    ],
  }];
}
