/* Correction workspace (slice 1): Numbers mode + Tier mode on detection units.
 *
 * Data contract (canonical fixture shape; Hopkins shapes adapted in-code):
 *   lots.json  [{lot_number, polygon_pct:[{x,y 0-100}], tier_key|null}]
 *   tiers.json {tenant, project, tiers:{key:{label,color,price,sellable}}}
 *   units.json {units:{lot_number:{number,area_sqm,suspect[],centroid[]}}}
 *   plan image: plan.png, fallback masterplan_background.webp
 *
 * Embed legend contract: buildLegend() returns [{key,label,color,price,
 * sellable,count}] — the same shape the public embed's tier chips consume
 * (PublicLotMap tierOptions). The workspace legend preview renders it.
 *
 * Pure functions below touch no DOM and are covered by test/
 * correction-workspace.test.mjs. Browser wiring lives at the bottom behind
 * `typeof document !== 'undefined'`.
 */

export const LOT_STATUS = {
  SUGGESTED: "suggested",
  CONFIRMED: "confirmed",
  LOCKED: "locked",
};

/** Onboarding state machine: stage -> {artifacts, gate} for the transition
 *  OUT of that stage. Stored per tenant/project; operator console renders it.
 *  Slice 1 drives read > correct > validate; later slices own the rest. */
export const ONBOARDING_STAGES = [
  "intake",
  "classify",
  "legend",
  "read",
  "correct",
  "validate",
  "preview",
  "sign-off",
  "live",
  "operate",
];

export const STAGE_GATES = {
  intake: { artifacts: ["tenant record", "plan raster"], gate: "raster readable, tenant exists" },
  classify: { artifacts: ["tier catalogue draft"], gate: ">=1 tier with label + color" },
  legend: { artifacts: ["legend sign-off"], gate: "swatches match plan fills within tolerance" },
  read: { artifacts: ["detection units file"], gate: "area-anchored run complete, units present" },
  correct: { artifacts: ["confirmed lots / waivers"], gate: "0 unreviewed uncertain lots or explicit waivers; duplicates resolved or waived" },
  validate: { artifacts: ["draft map snapshot (inactive)"], gate: "drift gate clean (geometry/tiers/prices within tolerance)" },
  preview: { artifacts: ["signed expiring preview link"], gate: "tenant sign-off recorded (actor + time)" },
  "sign-off": { artifacts: ["published snapshot"], gate: "embed URL resolves, legend matches catalogue" },
  live: { artifacts: ["handover + inquiry round-trip"], gate: "first inquiry round-trip OK" },
  operate: { artifacts: ["steady-state drafts"], gate: "edits are drafts until publish" },
};

let batchSeq = 0;

export function createInitialState({ lots, tiers, units, actor = "operator", tenant = "local", project = "default" }) {
  const state = {
    tenant,
    project,
    actor, // slice 1: single local actor (roles stubbed — see plan)
    lots: {},
    tiers: JSON.parse(JSON.stringify(tiers)),
    log: [],
    pointer: 0, // applied prefix length of log; undo moves it back
    publishedAt: null,
    waivers: [],
  };
  for (const lot of lots) {
    const u = units[lot.lot_number];
    state.lots[lot.lot_number] = {
      status: LOT_STATUS.SUGGESTED,
      number: u?.number ?? null,
      area: u?.area_sqm ?? null,
      tier_key: lot.tier_key ?? null,
      suspect: u?.suspect ? [...u.suspect] : [],
      polygon: lot.polygon_pct,
      hasUnit: Boolean(u),
    };
  }
  return state;
}

function pushEntries(state, entries) {
  // Truncate any undone tail before pushing (standard undo semantics).
  state.log.length = state.pointer;
  const batchId = `b${++batchSeq}`;
  for (const e of entries) {
    state.log.push({ seq: state.log.length + 1, batchId, time: new Date().toISOString(), ...e });
  }
  state.pointer = state.log.length;
  return batchId;
}

/** Record one field edit. Returns the log entry. */
export function applyEdit(state, { actor, lot, field, before, after }) {
  pushEntries(state, [{ actor, lot, field, before, after }]);
  state.lots[lot][field] = after;
  return state.log[state.log.length - 1];
}

/** Record a same-action multi-lot batch (one undo unit). Returns batchId. */
export function applyBatch(state, { actor, edits }) {
  const batchId = pushEntries(
    state,
    edits.map((e) => ({ actor, lot: e.lot, field: e.field, before: e.before, after: e.after })),
  );
  for (const e of edits) state.lots[e.lot][e.field] = e.after;
  return batchId;
}

/** Undo the most recent batch. Returns reverted entries (newest first). */
export function undoLast(state) {
  if (state.pointer === 0) return [];
  const batchId = state.log[state.pointer - 1].batchId;
  const reverted = [];
  while (state.pointer > 0 && state.log[state.pointer - 1].batchId === batchId) {
    const entry = state.log[state.pointer - 1];
    state.lots[entry.lot][entry.field] = entry.before;
    reverted.push(entry);
    state.pointer -= 1;
  }
  return reverted;
}

/**
 * Re-run merge: detection output must never overwrite confirmed/locked lots.
 * Writes number/area only onto suggested lots (or lots without values).
 * Returns {applied: [lot], skipped: [{lot, status, reason}]}.
 */
export function applyDetection(state, { actor, detected }) {
  const applied = [];
  const skipped = [];
  const edits = [];
  for (const [lotNumber, unit] of Object.entries(detected)) {
    const slot = state.lots[lotNumber];
    if (!slot) {
      skipped.push({ lot: lotNumber, status: "unknown-lot", reason: "not in workspace" });
      continue;
    }
    if (slot.status === LOT_STATUS.CONFIRMED || slot.status === LOT_STATUS.LOCKED) {
      skipped.push({ lot: lotNumber, status: slot.status, reason: "human value preserved" });
      continue;
    }
    if (unit.number != null && slot.number !== unit.number) {
      edits.push({ lot: lotNumber, field: "number", before: slot.number, after: unit.number });
    }
    if (unit.area != null && slot.area !== unit.area) {
      edits.push({ lot: lotNumber, field: "area", before: slot.area, after: unit.area });
    }
    applied.push(lotNumber);
  }
  if (edits.length) applyBatch(state, { actor, edits });
  return { applied, skipped };
}

/** Live duplicate detection over current numbers. {value: [lotNumbers]} for dupes. */
export function findDuplicates(state) {
  const byValue = new Map();
  for (const [lotNumber, slot] of Object.entries(state.lots)) {
    if (slot.number == null || slot.number === "") continue;
    const key = String(slot.number);
    if (!byValue.has(key)) byValue.set(key, []);
    byValue.get(key).push(lotNumber);
  }
  const dups = {};
  for (const [value, lots] of byValue) {
    if (lots.length > 1) dups[value] = [...lots].sort();
  }
  return dups;
}

/** Gap detection over the global min-max printed-number range. Never auto-corrects. */
export function findGaps(state) {
  const nums = Object.values(state.lots)
    .map((s) => (s.number == null || s.number === "" ? null : Number(s.number)))
    .filter((n) => Number.isInteger(n));
  if (!nums.length) return [];
  const have = new Set(nums);
  const gaps = [];
  for (let n = Math.min(...nums); n <= Math.max(...nums); n++) {
    if (!have.has(n)) gaps.push(n);
  }
  return gaps;
}

/** Legend rows from the tier catalogue + live counts (embed contract). */
export function buildLegend(state) {
  const counts = {};
  let unassigned = 0;
  for (const slot of Object.values(state.lots)) {
    if (slot.tier_key == null) unassigned += 1;
    else counts[slot.tier_key] = (counts[slot.tier_key] ?? 0) + 1;
  }
  const rows = Object.entries(state.tiers).map(([key, t]) => ({
    key,
    label: t.label,
    color: t.color,
    price: t.price,
    sellable: t.sellable !== false,
    count: counts[key] ?? 0,
  }));
  return { rows, unassigned, total: Object.keys(state.lots).length };
}

/** Uncertain-first queue: suspect/dup/area-only/unassembled, then the rest. */
export function uncertainQueue(state) {
  const dups = findDuplicates(state);
  const dupLots = new Set(Object.values(dups).flat());
  const scored = [];
  for (const [lotNumber, slot] of Object.entries(state.lots)) {
    let rank = 3;
    if (!slot.hasUnit) rank = 0;
    else if (slot.suspect.length || dupLots.has(lotNumber)) rank = 1;
    else if (slot.number == null) rank = 2;
    if (slot.status !== LOT_STATUS.SUGGESTED) rank += 10;
    scored.push([rank, lotNumber]);
  }
  scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
  return scored.map(([, lotNumber]) => lotNumber);
}

/** Confident fill preview: non-suspect suggested lots with units. No writes. */
export function previewConfidentFill(state) {
  const dups = findDuplicates(state);
  const dupLots = new Set(Object.values(dups).flat());
  return Object.entries(state.lots)
    .filter(
      ([lotNumber, slot]) =>
        slot.status === LOT_STATUS.SUGGESTED &&
        slot.hasUnit &&
        slot.suspect.length === 0 &&
        !dupLots.has(lotNumber),
    )
    .map(([lotNumber]) => lotNumber)
    .sort();
}

/* ---------- data adapters (canonical fixture <-> Hopkins shapes) ---------- */

export function adaptLots(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .filter((l) => l && typeof l.lot_number === "string" && Array.isArray(l.polygon_pct))
    .map((l) => ({ lot_number: l.lot_number, polygon_pct: l.polygon_pct, tier_key: l.tier_key ?? null }));
}

export function adaptTiers(raw) {
  // Canonical: {tenant, project, tiers:{key:{label,color,price,sellable}}}
  // Hopkins:   {tenant?, tiers:{key:{label,price,legend,...}}}
  const out = { tenant: "local", project: "default", tiers: {} };
  if (!raw || typeof raw !== "object") return out;
  if (typeof raw.tenant === "string") out.tenant = raw.tenant;
  if (typeof raw.project === "string") out.project = raw.project;
  const src = raw.tiers && typeof raw.tiers === "object" ? raw.tiers : {};
  for (const [key, t] of Object.entries(src)) {
    out.tiers[key] = {
      label: t.label ?? key,
      color: t.color ?? t.legend ?? "#999999",
      price: Number(t.price ?? 0),
      sellable: t.sellable !== false,
    };
  }
  return out;
}

export function adaptUnits(raw) {
  // Canonical: {units:{lot:{number,area_sqm,suspect[],centroid[]}}}
  // Hopkins area-anchored.json: {assembled_units:{lot:{number,area_sqm,suspect[],centroid_full[]}}}
  if (!raw || typeof raw !== "object") return {};
  const src = raw.units && typeof raw.units === "object" ? raw.units : raw.assembled_units ?? {};
  const out = {};
  for (const [lot, u] of Object.entries(src ?? {})) {
    if (!u || typeof u !== "object") continue;
    out[lot] = {
      number: u.number ?? null,
      area_sqm: u.area_sqm ?? null,
      suspect: Array.isArray(u.suspect) ? [...u.suspect] : [],
      centroid: u.centroid ?? u.centroid_full ?? null,
    };
  }
  return out;
}

export function lotCentroid(polygon) {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

export function lotBBox(polygon) {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/* ============================ browser app ============================ */

if (typeof document !== "undefined") {
  boot().catch((err) => {
    document.getElementById("cw-status").textContent = `Failed to load workspace data: ${err.message}`;
    console.error(err);
  });

  async function boot() {
    const params = new URLSearchParams(location.search);
    const dataBase = (params.get("data") ?? "./data/").replace(/\/?$/, "/");
    // NOTE: dev servers may SPA-fallback unknown paths to index.html with
    // HTTP 200, so a fetch is only trusted when it is actually JSON.
    async function fetchJson(name) {
      const r = await fetch(dataBase + name);
      const ct = r.headers.get("content-type") ?? "";
      if (!r.ok || !ct.includes("json")) return null;
      return r.json();
    }
    async function requireJson(name) {
      const v = await fetchJson(name);
      if (v == null) throw new Error(`${name} not found under ${dataBase}`);
      return v;
    }
    const [lotsRaw, tiersRaw] = await Promise.all([requireJson("lots.json"), requireJson("tiers.json")]);
    const unitsSrc = (await fetchJson("units.json")) ?? (await fetchJson("area-anchored.json"));
    const adaptedTiers = adaptTiers(tiersRaw);
    const state = createInitialState({
      lots: adaptLots(lotsRaw),
      tiers: adaptedTiers.tiers,
      units: adaptUnits(unitsSrc ?? {}),
      actor: "operator",
      tenant: adaptedTiers.tenant,
      project: adaptedTiers.project,
    });
    // Restore local drafts (same tenant/project key only).
    const storeKey = `cw:${state.tenant}:${state.project}`;
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey) ?? "null");
      if (saved && saved.lots && saved.tiers) {
        for (const [k, v] of Object.entries(saved.lots)) if (state.lots[k]) state.lots[k] = v;
        state.tiers = saved.tiers;
        state.log = Array.isArray(saved.log) ? saved.log : [];
        state.pointer = Math.min(saved.pointer ?? state.log.length, state.log.length);
        state.publishedAt = saved.publishedAt ?? null;
      }
    } catch {
      /* corrupted draft ignored */
    }
    const persist = () =>
      localStorage.setItem(
        storeKey,
        JSON.stringify({ lots: state.lots, tiers: state.tiers, log: state.log, pointer: state.pointer, publishedAt: state.publishedAt }),
      );

    // Plan image for Numbers-mode crops (plan.png, fallback masterplan_background.webp).
    const planImg = new Image();
    planImg.id = "cw-plan-img";
    planImg.style.display = "none";
    document.body.appendChild(planImg);
    const planReady = new Promise((resolve) => {
      planImg.onload = () => resolve(true);
      planImg.onerror = () => {
        if (!planImg.dataset.fallback) {
          planImg.dataset.fallback = "1";
          planImg.src = dataBase + "masterplan_background.webp";
        } else {
          resolve(false);
        }
      };
      planImg.src = dataBase + "plan.png";
    });

    const ui = buildShell(state);
    wireNumbers(state, ui, persist);
    wireTiers(state, ui, persist);
    wireLog(state, ui, persist);
    refreshAll(state, ui, persist);
    await planReady;
    drawCrop(state, ui);
    drawTierMap(state, ui, persist);
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else node.setAttribute(k, v);
    }
    for (const c of children) node.append(c);
    return node;
  }

  function buildShell(state) {
    document.getElementById("cw-status").textContent =
      `${state.tenant} / ${state.project} — ${Object.keys(state.lots).length} lots. Roles: operator (stub). Edits are drafts until publish.`;
    const tabs = document.getElementById("cw-tabs");
    const modes = [
      ["numbers", "Numbers"],
      ["tiers", "Tiers"],
      ["log", "Log"],
    ];
    let mode = "numbers";
    const setMode = (m) => {
      mode = m;
      for (const btn of tabs.querySelectorAll("button")) {
        const on = btn.dataset.mode === m;
        btn.setAttribute("aria-selected", on ? "true" : "false");
        btn.classList.toggle("active", on);
      }
      document.getElementById("cw-mode-numbers").hidden = m !== "numbers";
      document.getElementById("cw-mode-tiers").hidden = m !== "tiers";
      document.getElementById("cw-mode-log").hidden = m !== "log";
    };
    for (const [key, label] of modes) {
      const btn = el("button", { type: "button", role: "tab", "data-mode": key, text: label });
      btn.addEventListener("click", () => setMode(key));
      tabs.append(btn);
    }
    setMode("numbers");
    return {
      getMode: () => mode,
      setMode,
      queue: document.getElementById("cw-queue"),
      dupPanel: document.getElementById("cw-dups"),
      crop: document.getElementById("cw-crop"),
      numInput: document.getElementById("cw-number"),
      areaInput: document.getElementById("cw-area"),
      lotTitle: document.getElementById("cw-lot-title"),
      lotFlags: document.getElementById("cw-lot-flags"),
      stepper: document.getElementById("cw-stepper"),
      fillBtn: document.getElementById("cw-fill"),
      fillPreview: document.getElementById("cw-fill-preview"),
      tierMap: document.getElementById("cw-tiermap"),
      tierList: document.getElementById("cw-tierlist"),
      legend: document.getElementById("cw-legend"),
      unassigned: document.getElementById("cw-unassigned"),
      logTable: document.getElementById("cw-logtable"),
      undoBtn: document.getElementById("cw-undo"),
      publishBtn: document.getElementById("cw-publish"),
      toast: document.getElementById("cw-toast"),
    };
  }

  function toast(ui, msg) {
    ui.toast.textContent = msg;
    ui.toast.classList.add("show");
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(() => ui.toast.classList.remove("show"), 2200);
  }

  function currentLot(state, ui) {
    return ui._current ?? uncertainQueue(state)[0] ?? Object.keys(state.lots)[0];
  }

  function refreshAll(state, ui, persist) {
    persist();
    renderStepper(state, ui);
    renderQueue(state, ui);
    renderDups(state, ui);
    renderTierList(state, ui, persist);
    renderLegend(state, ui);
    renderLog(state, ui);
    drawTierMap(state, ui, persist);
    showLot(state, ui, currentLot(state, ui));
  }

  function renderStepper(state, ui) {
    const uncertain = uncertainQueue(state).filter((l) => state.lots[l].status === LOT_STATUS.SUGGESTED);
    const dups = Object.keys(findDuplicates(state)).length;
    const steps = [
      { id: "read", label: "Read", done: Object.values(state.lots).some((s) => s.hasUnit) },
      { id: "correct", label: "Correct", done: uncertain.length === 0, hint: uncertain.length ? `${uncertain.length} uncertain` : "queue clear" },
      { id: "validate", label: "Validate", done: dups === 0, hint: dups ? `${dups} duplicates` : "no duplicates" },
    ];
    ui.stepper.innerHTML = "";
    for (const s of steps) {
      const chip = el("span", { class: `step${s.done ? " done" : ""}`, text: `${s.done ? "✓ " : ""}${s.label}${s.hint ? ` (${s.hint})` : ""}` });
      ui.stepper.append(chip);
    }
  }

  function flagChips(slot) {
    const chips = [];
    if (!slot.hasUnit) chips.push("no-unit");
    if (slot.number == null) chips.push("no-number");
    for (const f of slot.suspect) chips.push(f);
    if (slot.status !== LOT_STATUS.SUGGESTED) chips.push(slot.status);
    return chips;
  }

  function renderQueue(state, ui) {
    const q = uncertainQueue(state);
    ui.queue.innerHTML = "";
    for (const lotNumber of q) {
      const slot = state.lots[lotNumber];
      const btn = el("button", { type: "button", class: "qrow" + (lotNumber === ui._current ? " current" : "") });
      const left = el("span", {}, [
        el("strong", { text: `Lot ${slot.number ?? "?"}` }),
        el("span", { class: "qid", text: ` ${lotNumber}` }),
      ]);
      const right = el("span", { class: "qflags", text: flagChips(slot).join(" · ") || slot.status });
      btn.append(left, right);
      btn.addEventListener("click", () => showLot(state, ui, lotNumber));
      ui.queue.append(btn);
    }
  }

  function renderDups(state, ui) {
    const dups = findDuplicates(state);
    const gaps = findGaps(state);
    ui.dupPanel.innerHTML = "";
    const keys = Object.keys(dups).sort((a, b) => Number(a) - Number(b));
    ui.dupPanel.append(
      el("div", { text: keys.length ? `Duplicates live: ${keys.map((k) => `${k} (${dups[k].join(", ")})`).join("; ")}` : "Duplicates live: none" }),
      el("div", { text: gaps.length ? `Gaps (flagged, never auto-filled): ${gaps.slice(0, 20).join(", ")}${gaps.length > 20 ? ` +${gaps.length - 20} more` : ""}` : "Gaps: none in range" }),
    );
    ui.dupPanel.classList.toggle("warn", keys.length > 0);
  }

  function drawCrop(state, ui) {
    const lotNumber = currentLot(state, ui);
    const slot = state.lots[lotNumber];
    const canvas = ui.crop;
    const ctx = canvas.getContext("2d");
    const img = document.getElementById("cw-plan-img") ?? window.__cwPlanImg;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#f4f2ec";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!slot) return;
    const [x0, y0, x1, y1] = lotBBox(slot.polygon);
    // Bbox + 30% margin in plan-% units (blind-sheet convention).
    const mx = Math.max(160 / 57, 0.3 * (x1 - x0)) / 2;
    const my = Math.max(160 / 48, 0.3 * (y1 - y0)) / 2;
    const bx0 = Math.max(0, x0 - mx);
    const by0 = Math.max(0, y0 - my);
    const bx1 = Math.min(100, x1 + mx);
    const by1 = Math.min(100, y1 + my);
    if (img && img.naturalWidth) {
      const sx = (bx0 / 100) * img.naturalWidth;
      const sy = (by0 / 100) * img.naturalHeight;
      const sw = ((bx1 - bx0) / 100) * img.naturalWidth;
      const sh = ((by1 - by0) / 100) * img.naturalHeight;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = "#666";
      ctx.font = "14px sans-serif";
      ctx.fillText("plan image not loaded", 12, 24);
    }
  }

  function showLot(state, ui, lotNumber) {
    if (!state.lots[lotNumber]) return;
    ui._current = lotNumber;
    const slot = state.lots[lotNumber];
    ui.lotTitle.textContent = `Lot ${slot.number ?? "?"} — ${lotNumber}`;
    ui.lotFlags.textContent = flagChips(slot).join(" · ") || slot.status;
    ui.numInput.value = slot.number ?? "";
    ui.areaInput.value = slot.area ?? "";
    validateInputs(ui);
    renderQueue(state, ui);
    drawCrop(state, ui);
    ui.numInput.focus();
    ui.numInput.select();
  }

  function validateInputs(ui) {
    for (const [input, pattern] of [
      [ui.numInput, /^\d*$/],
      [ui.areaInput, /^\d*(\.\d*)?$/],
    ]) {
      const ok = pattern.test(input.value.trim());
      input.classList.toggle("invalid", !ok);
      input.classList.toggle("valid", ok && input.value.trim() !== "");
    }
  }

  function commitField(state, ui, persist, field) {
    const lotNumber = currentLot(state, ui);
    const slot = state.lots[lotNumber];
    const raw = field === "number" ? ui.numInput.value.trim() : ui.areaInput.value.trim();
    if (field === "number" && raw !== "" && !/^\d+$/.test(raw)) return;
    if (field === "area" && raw !== "" && !/^\d+(\.\d+)?$/.test(raw)) return;
    const after = raw === "" ? null : field === "number" ? raw : Number(raw);
    if (after === slot[field]) return;
    applyEdit(state, { actor: state.actor, lot: lotNumber, field, before: slot[field], after });
    refreshAll(state, ui, persist);
    showLot(state, ui, lotNumber);
  }

  function stepQueue(state, ui, dir) {
    const q = uncertainQueue(state);
    const idx = q.indexOf(currentLot(state, ui));
    const next = q[(idx + dir + q.length) % q.length];
    showLot(state, ui, next ?? currentLot(state, ui));
  }

  function wireNumbers(state, ui, persist) {
    ui.numInput.addEventListener("input", () => validateInputs(ui));
    ui.areaInput.addEventListener("input", () => validateInputs(ui));
    ui.numInput.addEventListener("change", () => commitField(state, ui, persist, "number"));
    ui.areaInput.addEventListener("change", () => commitField(state, ui, persist, "area"));
    document.addEventListener("keydown", (e) => {
      if (ui.getMode() !== "numbers") return;
      const tag = e.target.tagName;
      if (tag === "INPUT") {
        if (e.key === "Enter") {
          e.preventDefault();
          commitField(state, ui, persist, e.target === ui.numInput ? "number" : "area");
          stepQueue(state, ui, 1);
        }
        return;
      }
      if (e.key === "Enter" || e.key === "ArrowRight") stepQueue(state, ui, 1);
      else if (e.key === "ArrowLeft") stepQueue(state, ui, -1);
      else if (e.key === "n" || e.key === "N") {
        ui.numInput.focus();
        ui.numInput.select();
      } else if (e.key === "a" || e.key === "A") {
        ui.areaInput.focus();
        ui.areaInput.select();
      } else if (e.key === "c" || e.key === "C") confirmLot(state, ui, persist);
      else if (e.key === "u" || e.key === "U") {
        // Unreadable: clear proposal, keep suggested, log the review pass.
        const lotNumber = currentLot(state, ui);
        applyEdit(state, { actor: state.actor, lot: lotNumber, field: "number", before: state.lots[lotNumber].number, after: null });
        refreshAll(state, ui, persist);
        showLot(state, ui, lotNumber);
        stepQueue(state, ui, 1);
      }
    });
    document.getElementById("cw-confirm").addEventListener("click", () => confirmLot(state, ui, persist));
    document.getElementById("cw-lock").addEventListener("click", () => {
      const lotNumber = currentLot(state, ui);
      applyEdit(state, { actor: state.actor, lot: lotNumber, field: "status", before: state.lots[lotNumber].status, after: LOT_STATUS.LOCKED });
      toast(ui, `${lotNumber} locked`);
      refreshAll(state, ui, persist);
      showLot(state, ui, lotNumber);
    });
    ui.fillBtn.addEventListener("click", () => {
      const list = previewConfidentFill(state);
      ui.fillPreview.innerHTML = "";
      if (!list.length) {
        ui.fillPreview.append(el("p", { text: "Nothing confident to fill — every remaining lot is suspect, duplicate, or already reviewed." }));
      } else {
        ui.fillPreview.append(el("p", { text: `Would confirm ${list.length} lots: ${list.slice(0, 12).join(", ")}${list.length > 12 ? ` +${list.length - 12} more` : ""}` }));
        const apply = el("button", { type: "button", class: "btn primary", text: `Confirm ${list.length} lots` });
        apply.addEventListener("click", () => {
          applyBatch(state, {
            actor: state.actor,
            edits: list.map((lot) => ({ lot, field: "status", before: state.lots[lot].status, after: LOT_STATUS.CONFIRMED })),
          });
          ui.fillPreview.innerHTML = "";
          toast(ui, `${list.length} lots confirmed`);
          refreshAll(state, ui, persist);
        });
        const cancel = el("button", { type: "button", class: "btn", text: "Cancel" });
        cancel.addEventListener("click", () => {
          ui.fillPreview.innerHTML = "";
        });
        ui.fillPreview.append(apply, cancel);
      }
    });
    document.getElementById("cw-reimport").addEventListener("click", async () => {
      // Re-runs never overwrite confirmed/locked lots: applyDetection writes
      // suggested lots only; everything else lands on the skip list below.
      const params = new URLSearchParams(location.search);
      const dataBase = (params.get("data") ?? "./data/").replace(/\/?$/, "/");
      const fresh =
        (await fetch(dataBase + "units.json").then((r) => (r.ok ? r.json() : null))) ??
        (await fetch(dataBase + "area-anchored.json").then((r) => (r.ok ? r.json() : null)));
      ui.fillPreview.innerHTML = "";
      if (!fresh) {
        ui.fillPreview.append(el("p", { text: "No detection file reachable — nothing re-imported." }));
        return;
      }
      const detected = {};
      for (const [lot, u] of Object.entries(adaptUnits(fresh))) {
        detected[lot] = { number: u.number, area: u.area_sqm };
      }
      const { applied, skipped } = applyDetection(state, { actor: state.actor, detected });
      const kept = skipped.filter((s) => s.reason === "human value preserved");
      ui.fillPreview.append(
        el("p", { text: `Re-import: ${applied.length} suggested lots updated, ${kept.length} confirmed/locked preserved.` }),
        ...(kept.length
          ? [el("p", { class: "qid", text: `Preserved: ${kept.map((s) => `${s.lot} (${s.status})`).join(", ")}` })]
          : []),
      );
      toast(ui, `Re-imported (${applied.length} applied, ${kept.length} preserved)`);
      refreshAll(state, ui, persist);
    });
  }

  function confirmLot(state, ui, persist) {
    const lotNumber = currentLot(state, ui);
    commitField(state, ui, persist, "number");
    commitField(state, ui, persist, "area");
    if (state.lots[lotNumber].status === LOT_STATUS.SUGGESTED) {
      applyEdit(state, { actor: state.actor, lot: lotNumber, field: "status", before: LOT_STATUS.SUGGESTED, after: LOT_STATUS.CONFIRMED });
    }
    refreshAll(state, ui, persist);
    stepQueue(state, ui, 1);
  }

  /* ----- Tier mode ----- */

  function tierColor(state, key) {
    if (key == null) return "#e5e5e5";
    return state.tiers[key]?.color ?? "#999999";
  }

  function drawTierMap(state, ui, persist) {
    const svg = ui.tierMap;
    const NS = "http://www.w3.org/2000/svg";
    svg.innerHTML = "";
    const aspect = window.__cwPlanAspect ?? 100 / 84;
    const vbH = 100 / aspect;
    svg.setAttribute("viewBox", `0 0 100 ${vbH}`);
    for (const [lotNumber, slot] of Object.entries(state.lots)) {
      const poly = document.createElementNS(NS, "polygon");
      poly.setAttribute("points", slot.polygon.map((p) => `${p.x},${p.y / aspect}`).join(" "));
      poly.setAttribute("fill", tierColor(state, slot.tier_key));
      poly.setAttribute("fill-opacity", slot.status === LOT_STATUS.SUGGESTED ? "0.55" : "0.85");
      poly.setAttribute("stroke", ui._activeTier != null && slot.tier_key === ui._activeTier ? "#111" : "#fff");
      poly.setAttribute("stroke-width", "0.25");
      poly.dataset.lot = lotNumber;
      const [cx, cy] = lotCentroid(slot.polygon);
      const title = document.createElementNS(NS, "title");
      title.textContent = `${lotNumber} — ${slot.number ?? "?"} — ${slot.tier_key ?? "unassigned"} (${slot.status})`;
      poly.append(title);
      poly.addEventListener("pointerdown", (e) => tierPointerDown(e, state, ui, persist, lotNumber));
      poly.addEventListener("click", (e) => {
        if (ui._lassoMoved) return;
        paintLots(state, ui, persist, [lotNumber], e.altKey ? "block" : "click");
      });
      svg.append(poly);
    }
    // Lasso overlay rect.
    const box = document.createElementNS(NS, "rect");
    box.id = "cw-lasso";
    box.setAttribute("fill", "rgba(29,78,216,0.12)");
    box.setAttribute("stroke", "#1d4ed8");
    box.setAttribute("stroke-width", "0.3");
    box.setAttribute("visibility", "hidden");
    svg.append(box);
  }

  function svgPoint(svg, e) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  function tierPointerDown(e, state, ui, persist, lotNumber) {
    // Lasso starts on background drag; single-lot clicks are handled by click.
    if (e.altKey) return; // block mode handled in click
    const svg = ui.tierMap;
    const start = svgPoint(svg, e);
    let moved = false;
    ui._lassoMoved = false;
    const box = svg.querySelector("#cw-lasso");
    const aspect = window.__cwPlanAspect ?? 100 / 84;
    const move = (ev) => {
      const p = svgPoint(svg, ev);
      if (Math.hypot(p.x - start.x, p.y - start.y) * 4 < 4) return;
      moved = true;
      ui._lassoMoved = true;
      const x = Math.min(start.x, p.x);
      const y = Math.min(start.y, p.y);
      box.setAttribute("x", String(x));
      box.setAttribute("y", String(y));
      box.setAttribute("width", String(Math.abs(p.x - start.x)));
      box.setAttribute("height", String(Math.abs(p.y - start.y)));
      box.setAttribute("visibility", "visible");
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      box.setAttribute("visibility", "hidden");
      if (!moved) return;
      const p = svgPoint(svg, ev);
      const rx0 = Math.min(start.x, p.x);
      const rx1 = Math.max(start.x, p.x);
      const ry0 = Math.min(start.y, p.y);
      const ry1 = Math.max(start.y, p.y);
      const inside = Object.entries(state.lots)
        .filter(([, s]) => {
          const [cx, cy] = lotCentroid(s.polygon);
          return cx >= rx0 && cx <= rx1 && cy / aspect >= ry0 && cy / aspect <= ry1;
        })
        .map(([lot]) => lot);
      if (inside.length) paintLots(state, ui, persist, inside, "lasso");
      window.setTimeout(() => {
        ui._lassoMoved = false;
      }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function paintLots(state, ui, persist, lotNumbers, how) {
    const tier = ui._activeTier;
    if (tier == null) {
      toast(ui, "Pick a tier first");
      return;
    }
    let targets = lotNumbers;
    if (how === "block") {
      // Block = every lot sharing the clicked lot's current tier.
      const sourceTier = state.lots[lotNumbers[0]].tier_key;
      targets = Object.entries(state.lots)
        .filter(([, s]) => s.tier_key === sourceTier)
        .map(([lot]) => lot);
    }
    const edits = [];
    for (const lot of targets) {
      if (state.lots[lot].tier_key !== tier) {
        edits.push({ lot, field: "tier_key", before: state.lots[lot].tier_key, after: tier });
      }
    }
    if (!edits.length) {
      toast(ui, "Already that tier");
      return;
    }
    const batchId = applyBatch(state, { actor: state.actor, edits });
    toast(ui, `${how === "block" ? `Block (${edits.length})` : `${edits.length} lot${edits.length > 1 ? "s" : ""}`} → ${state.tiers[tier]?.label ?? tier} (undo: ${batchId})`);
    refreshAll(state, ui, persist);
  }

  function renderTierList(state, ui, persist) {
    const { rows, unassigned, total } = buildLegend(state);
    ui.tierList.innerHTML = "";
    for (const row of rows) {
      const item = el("div", { class: "tierow" + (ui._activeTier === row.key ? " active" : "") });
      const swatch = el("span", { class: "swatch" });
      swatch.style.backgroundColor = row.color;
      const name = el("span", {}, [
        el("strong", { text: row.label }),
        el("span", { class: "qid", text: ` ${row.key} · ${row.count} lots · $${row.price.toLocaleString()}${row.sellable ? "" : " · not sellable"}` }),
      ]);
      const paint = el("button", { type: "button", class: "btn small", text: "Paint" });
      paint.setAttribute("aria-label", `Paint with ${row.label}`);
      paint.addEventListener("click", () => {
        ui._activeTier = row.key;
        renderTierList(state, ui, persist);
        drawTierMap(state, ui, persist);
      });
      item.addEventListener("click", (e) => {
        if (e.target === paint) return;
        ui._activeTier = row.key;
        renderTierList(state, ui, persist);
        drawTierMap(state, ui, persist);
      });
      item.append(swatch, name, paint);
      ui.tierList.append(item);
    }
    ui.unassigned.textContent = `Unassigned: ${unassigned} / ${total}`;
    if (ui._activeTier == null && rows.length) ui._activeTier = rows[0].key;
  }

  function renderLegend(state, ui) {
    // Embed legend preview: same buildLegend() contract the public embed
    // consumes (tier key/label/color/price + counts). Slice 1 renders it
    // here; promotion swaps this preview for PublicLotMap tier chips.
    const { rows } = buildLegend(state);
    ui.legend.innerHTML = "";
    ui.legend.append(el("strong", { text: "Embed legend preview" }));
    for (const row of rows) {
      if (!row.sellable) continue;
      const chip = el("span", { class: "chip" });
      const dot = el("span", { class: "dot" });
      dot.style.backgroundColor = row.color;
      chip.append(dot, el("span", { text: `${row.label} (${row.count})` }));
      ui.legend.append(chip);
    }
  }

  function wireTiers(state, ui, persist) {
    document.getElementById("cw-tier-add").addEventListener("click", () => {
      const key = document.getElementById("cw-tier-key").value.trim().toLowerCase();
      const label = document.getElementById("cw-tier-label").value.trim();
      const price = Number(document.getElementById("cw-tier-price").value);
      const color = document.getElementById("cw-tier-color").value.trim();
      const sellable = document.getElementById("cw-tier-sellable").checked;
      if (!/^[a-z0-9_]+$/.test(key)) return toast(ui, "Tier key: lowercase, digits, underscores");
      if (!label) return toast(ui, "Tier label required");
      if (!Number.isFinite(price) || price < 0) return toast(ui, "Price must be >= 0");
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) return toast(ui, "Color must be #rrggbb");
      if (state.tiers[key]) return toast(ui, "Tier key exists");
      state.tiers[key] = { label, color, price, sellable };
      pushEntries(state, [{ actor: state.actor, lot: "—", field: "tier/add", before: null, after: key }]);
      document.getElementById("cw-tier-key").value = "";
      document.getElementById("cw-tier-label").value = "";
      document.getElementById("cw-tier-price").value = "";
      refreshAll(state, ui, persist);
      toast(ui, `Tier ${key} added`);
    });
    document.getElementById("cw-tier-save").addEventListener("click", () => {
      const key = ui._activeTier;
      if (key == null || !state.tiers[key]) return toast(ui, "Pick a tier first");
      const label = document.getElementById("cw-tier-label").value.trim();
      const price = Number(document.getElementById("cw-tier-price").value);
      const color = document.getElementById("cw-tier-color").value.trim();
      const sellable = document.getElementById("cw-tier-sellable").checked;
      const cur = state.tiers[key];
      const edits = [];
      if (label && label !== cur.label) edits.push({ field: "label", before: cur.label, after: label });
      if (Number.isFinite(price) && price >= 0 && price !== cur.price) edits.push({ field: "price", before: cur.price, after: price });
      if (/^#[0-9a-fA-F]{6}$/.test(color) && color !== cur.color) edits.push({ field: "color", before: cur.color, after: color });
      if (sellable !== cur.sellable) edits.push({ field: "sellable", before: cur.sellable, after: sellable });
      if (!edits.length) return toast(ui, "No changes");
      // Catalogue edits are logged against the catalogue itself (lot "—").
      pushEntries(state, edits.map((e) => ({ actor: state.actor, lot: "—", field: `tier/${key}/${e.field}`, before: e.before, after: e.after })));
      for (const e of edits) cur[e.field] = e.after;
      refreshAll(state, ui, persist);
      toast(ui, `Tier ${key} saved`);
    });
    // Plan aspect for the tier map (mirrors PublicLotMap's aspect probe).
    const probe = new Image();
    probe.onload = () => {
      if (probe.naturalWidth && probe.naturalHeight) {
        window.__cwPlanAspect = probe.naturalWidth / probe.naturalHeight;
        drawTierMap(state, ui, persist);
      }
    };
    const params = new URLSearchParams(location.search);
    const dataBase = (params.get("data") ?? "./data/").replace(/\/?$/, "/");
    probe.src = dataBase + "plan.png";
  }

  function wireLog(state, ui, persist) {
    ui.undoBtn.addEventListener("click", () => {
      const reverted = undoLast(state);
      toast(ui, reverted.length ? `Undid ${reverted[0].batchId} (${reverted.length} edit${reverted.length > 1 ? "s" : ""})` : "Nothing to undo");
      refreshAll(state, ui, persist);
      showLot(state, ui, currentLot(state, ui));
    });
    ui.publishBtn.addEventListener("click", () => {
      const snapshot = {
        tenant: state.tenant,
        project: state.project,
        exportedAt: new Date().toISOString(),
        actor: state.actor,
        stage: "correct",
        lots: Object.fromEntries(
          Object.entries(state.lots).map(([k, s]) => [k, { status: s.status, number: s.number, area: s.area, tier_key: s.tier_key }]),
        ),
        tiers: state.tiers,
        logEntries: state.log.length,
      };
      const blob = new Blob([JSON.stringify(snapshot, null, 1)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `correction-snapshot-${state.tenant}-${state.project}.json`;
      a.click();
      URL.revokeObjectURL(url);
      state.publishedAt = snapshot.exportedAt;
      persist();
      toast(ui, "Snapshot exported (local stub for backend publish)");
    });
  }

  function renderLog(state, ui) {
    const table = ui.logTable;
    table.innerHTML = "";
    const rows = [...state.log].slice(state.pointer - 60, state.pointer).reverse();
    if (!rows.length) {
      table.append(el("p", { text: "No edits yet." }));
      return;
    }
    for (const e of rows) {
      table.append(
        el("div", { class: "logrow" }, [
          el("span", { class: "qid", text: `#${e.seq} ${e.batchId}` }),
          el("span", { text: `${e.actor} · ${e.lot} · ${e.field}` }),
          el("span", { text: `${JSON.stringify(e.before)} → ${JSON.stringify(e.after)}` }),
        ]),
      );
    }
    ui.undoBtn.disabled = state.pointer === 0;
  }
}
