#!/usr/bin/env node
/**
 * Per-tenant interactive lot map pipeline — Stage 2 orchestrator (build).
 *
 *   npm run map:build -- --tenant hopkins-grove \
 *     --source "./2026 Hopkins Map.pdf" \
 *     --tiers ./map-input/hopkins.tiers.json \
 *     --out ./out/hopkins-grove
 *
 * Steps:
 *   1. Run scripts/detect-lots.py (Stage 1) -> lots.json + ingest-report.json.
 *   2. Extract the plat raster (PDF: single-image pypdfium2 extract only,
 *      never a pdfimages page-range dump) and convert to
 *      masterplan_background.webp (<=10MB, MasterplanUpload limit).
 *   3. Aspect-drift gate vs the active map dims (>2% fails closed, mirrors
 *      src/lib/masterplan.ts calculateAspectDrift).
 *   4. Node-side schema re-validation (defence in depth) + poc.html QA viewer
 *      (external image href, never base64) + merged ingest-report.json.
 *
 * Exit codes: 0 ok, 2 validation gate failed / bad usage.
 * No network, no DB writes — publishing is scripts/publish-lots.mjs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // matches MasterplanUpload.tsx
const ASPECT_DRIFT_THRESHOLD_PERCENT = 2; // matches src/lib/masterplan.ts

function usage() {
  return `Usage:
  node scripts/build-interactive-map.mjs --tenant <slug> --source <pdf|image> --tiers <tiers.json> --out <dir>
    [--work-width 2000] [--min-area 60] [--expected-min 700] [--expected-max 1000]
    [--pdf-image-index 0] [--webp-quality 80] [--webp-max-width 3000]
    [--active-width <px> --active-height <px>] [--skip-detect]
    [  --alignment-min 0.8] [--skip-alignment-check] [--alignment-edge-ratio 1.2]

  --active-width/--active-height: dims of the live masterplan image. When given,
    aspect drift >2% fails closed. When omitted, a warning is recorded and the
    operator must verify alignment in the preview modal before publishing.
  --development <slug>: shorthand resolving tenant/source/tiers/out from
    map-input/developments.json. E.g. --development hopkins-grove replaces
    all four flags (explicit flags win, except a conflicting --tenant).
  --alignment-min: interior-sample agreement rate below which the build
    refuses (default 0.8). --skip-alignment-check bypasses it for iteration.`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}\n${usage()}`);
    const key = a.slice(2);
    if (key === "skip-detect" || key === "help" || key === "h") {
      out[key] = true;
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) throw new Error(`missing value for ${a}\n${usage()}`);
    out[key] = val;
    i++;
  }
  return out;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

/** Fill --tenant/--source/--tiers/--out from map-input/developments.json via --development. */
function applyDevelopment(args) {
  if (!args.development) return args;
  const regPath = resolve("map-input/developments.json");
  if (!existsSync(regPath)) fail(`--development needs ${regPath} (run from the repo root)`);
  const reg = JSON.parse(readFileSync(regPath, "utf8"));
  const dev = reg.developments?.[args.development];
  if (!dev) fail(`unknown development ${JSON.stringify(args.development)} — see map-input/developments.json`);
  if (args.tenant && args.tenant.trim().toLowerCase() !== dev.tenant) {
    fail(`--tenant ${JSON.stringify(args.tenant)} conflicts with registry tenant ${JSON.stringify(dev.tenant)} for development ${JSON.stringify(args.development)}`);
  }
  return {
    ...args,
    tenant: dev.tenant,
    source: args.source || dev.source,
    tiers: args.tiers || (dev.tiers ? `map-input/${dev.tiers}` : undefined),
    out: args.out || `out/${args.development}`,
  };
}

function num(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`${name} must be a number (got ${JSON.stringify(value)})`);
  return n;
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return res;
}

/** Percentage-space aspect drift, same formula as src/lib/masterplan.ts. */
function aspectDrift(draft, active) {
  if (!draft || !active) return null;
  if (draft.width <= 0 || draft.height <= 0 || active.width <= 0 || active.height <= 0) return null;
  const drift = (Math.abs(draft.width / draft.height - active.width / active.height) / (active.width / active.height)) * 100;
  return drift > ASPECT_DRIFT_THRESHOLD_PERCENT ? drift : null;
}

function loadTiers(tiersPath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(tiersPath, "utf8"));
  } catch (e) {
    fail(`cannot read tiers file ${tiersPath}: ${e.message}`);
  }
  const tiers = raw.tiers ?? raw;
  if (!tiers || typeof tiers !== "object") fail(`no tier catalogue in ${tiersPath}`);
  return tiers;
}

/** Node-side re-validation of lots.json. Returns {errors, warnings}. */
function validateLots(lots, tiers, expectedMin, expectedMax) {
  const errors = [];
  const warnings = [];
  const tierKeys = Object.keys(tiers);
  if (!Array.isArray(lots)) return { errors: ["lots.json is not an array"], warnings };
  if (lots.length < expectedMin || lots.length > expectedMax) {
    errors.push(`lot count ${lots.length} outside expected [${expectedMin},${expectedMax}]`);
  }
  const seen = new Set();
  let badGeom = 0;
  let badSchema = 0;
  const priceBad = [];
  const unknownTier = new Set();
  for (const lot of lots) {
    if (!lot || typeof lot !== "object") {
      badSchema++;
      continue;
    }
    if (typeof lot.lot_number !== "string" || !lot.lot_number) badSchema++;
    else if (seen.has(lot.lot_number)) errors.push(`duplicate lot_number ${lot.lot_number}`);
    else seen.add(lot.lot_number);
    if (!tierKeys.includes(lot.tier_key)) unknownTier.add(String(lot.tier_key));
    else if (lot.price !== Number(tiers[lot.tier_key]?.price)) priceBad.push(lot.lot_number);
    const pts = lot.polygon_pct;
    if (!Array.isArray(pts) || pts.length < 3 || pts.length > 200) {
      badGeom++;
    } else {
      const ok = pts.every(
        (p) =>
          p && typeof p.x === "number" && typeof p.y === "number" &&
          Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100,
      );
      if (!ok) badGeom++;
    }
    if (
      typeof lot.confidence !== "number" || !Number.isFinite(lot.confidence) ||
      lot.confidence < 0 || lot.confidence > 1 ||
      typeof lot.needs_review !== "boolean" || lot.source !== "raster-auto"
    ) {
      badSchema++;
    }
  }
  if (badGeom) errors.push(`${badGeom} lots with invalid polygon_pct (need 3..200 pts in 0..100)`);
  if (badSchema) errors.push(`${badSchema} lots with invalid confidence/needs_review/lot_number/source schema`);
  if (unknownTier.size) errors.push(`unknown tier_key(s): ${[...unknownTier].slice(0, 5).join(", ")}`);
  if (priceBad.length) errors.push(`${priceBad.length} lots with price != tier catalogue (e.g. ${priceBad.slice(0, 3).join(", ")})`);
  const counts = {};
  for (const lot of lots) counts[lot.tier_key] = (counts[lot.tier_key] ?? 0) + 1;
  for (const k of tierKeys) {
    if (!counts[k]) warnings.push(`tier ${JSON.stringify(k)} detected 0 lots`);
  }
  const low = lots.filter((l) => l && l.needs_review).length;
  if (lots.length && low / lots.length > 0.75) {
    warnings.push(`needs_review fraction high: ${Math.round((low / lots.length) * 100)}% (${low}/${lots.length})`);
  }
  return { errors, warnings, counts, needsReview: low };
}

/** Extract single PDF image to a temp PNG via pypdfium2. Returns {path,width,height}. */
function extractPdfImage(pdfPath, imageIndex, tmpPath) {
  const script = [
    "import glob, json, sys",
    "import pypdfium2 as pdfium",
    "from PIL import Image",
    "src, idx, dest = sys.argv[1], int(sys.argv[2]), sys.argv[3]",
    "pdf = pdfium.PdfDocument(src)",
    "page = pdf[0]",
    "objs = [o for o in page.get_objects() if isinstance(o, pdfium.PdfImage)]",
    "assert 0 <= idx < len(objs), f'image index {idx} out of range 0..{len(objs)-1}'",
    "prefix = dest + '.img'",
    "objs[idx].extract(prefix)",
    "cands = sorted(glob.glob(prefix + '.*'))",
    "assert cands, 'extract produced no file'",
    "im = Image.open(cands[0]).convert('RGB')",
    "im.save(dest, 'PNG')",
    "import os",
    "os.unlink(cands[0])",
    "print(json.dumps({'path': dest, 'width': im.size[0], 'height': im.size[1]}))",
  ].join("\n");
  const res = run("python3", ["-c", script, pdfPath, String(imageIndex), tmpPath]);
  if (res.status !== 0) fail(`PDF image extract failed: ${(res.stderr || res.stdout || "").trim()}`);
  try {
    return JSON.parse(res.stdout.trim().split("\n").pop());
  } catch {
    fail(`PDF image extract returned unreadable output: ${(res.stdout || "").slice(0, 300)}`);
  }
}

function probeImage(imagePath) {
  const res = run("python3", ["-c", "from PIL import Image\nimport sys, json\nim = Image.open(sys.argv[1])\nprint(json.dumps({'width': im.size[0], 'height': im.size[1]}))", imagePath]);
  if (res.status !== 0) fail(`cannot probe image ${imagePath}: ${(res.stderr || "").trim()}`);
  return JSON.parse(res.stdout.trim().split("\n").pop());
}

function findCwebp() {
  if (process.env.CWEBP_BIN && existsSync(process.env.CWEBP_BIN)) return process.env.CWEBP_BIN;
  for (const p of ["/usr/local/bin/cwebp", "/Applications/XAMPP/xamppfiles/bin/cwebp"]) {
    if (existsSync(p)) return p;
  }
  const probe = run("cwebp", ["-version"]);
  if (probe.status === 0) return "cwebp";
  return null;
}

/** Convert src image to webp at outPath with quality/maxWidth. Uses cwebp, else Pillow. */
function convertToWebp(srcPath, outPath, quality, maxWidth) {
  const cwebp = findCwebp();
  if (cwebp) {
    const args = ["-q", String(quality), srcPath, "-o", outPath];
    const res = run(cwebp, args);
    if (res.status !== 0) fail(`cwebp failed: ${(res.stderr || res.stdout || "").trim()}`);
    if (maxWidth) {
      const dims = probeImage(outPath);
      if (dims.width > maxWidth) {
        // cwebp has no resize flag; fall through to Pillow resize below.
        pilToWebp(srcPath, outPath, quality, maxWidth);
      }
    }
    return;
  }
  pilToWebp(srcPath, outPath, quality, maxWidth);
}

function pilToWebp(srcPath, outPath, quality, maxWidth) {
  const script = [
    "from PIL import Image",
    "import sys",
    "src, dest, q, mw = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])",
    "im = Image.open(src).convert('RGB')",
    "w, h = im.size",
    "cap = mw if mw > 0 else w",
    "cap = min(cap, w)",
    "if w > cap:",
    "    im = im.resize((cap, round(h * cap / w)), Image.LANCZOS)",
    "im.save(dest, 'WEBP', quality=q, method=6)",
  ].join("\n");
  const res = run("python3", ["-c", script, srcPath, outPath, String(quality), String(maxWidth ?? 0)]);
  if (res.status !== 0) fail(`webp conversion failed: ${(res.stderr || res.stdout || "").trim()}`);
}

/** Interior-sample alignment check: lots.json polygons vs the built background.
 *
 * Centre-sampling is invalid on plats with printed lot labels (centres land
 * on text). Instead this samples a 6x6 interior grid per polygon, discards
 * text/grid pixels (dark <100, paper-white >240), and requires >=60% of the
 * remaining samples to match the lot's tier fill. Returns {rate, checked}.
 * A low rate means the polygons and background have different extents, and
 * the build must refuse — percentages only line up when detection runs on
 * the exact file served.
 *
 * Interior colour alone cannot catch sub-lot shifts (neighbours share tier
 * colours), so a second metric measures mean Sobel gradient along polygon
 * borders: correct borders sit on colour discontinuities, shifted borders
 * cut through uniform fills. The gate requires the unshifted strength to
 * exceed the best of four +/-0.35% probes by --alignment-edge-ratio.
 */
function checkAlignment(lotsPath, tiersPath, bgPath, edgeRatioMin) {
  const script = [
    "import json, sys",
    "import numpy as np",
    "from PIL import Image",
    "lots_path, tiers_path, bg_path = sys.argv[1], sys.argv[2], sys.argv[3]",
    "lots = json.load(open(lots_path))",
    "raw = json.load(open(tiers_path))",
    "tiers = raw.get('tiers', raw)",
    "def hexrgb(h):",
    "    h = h.strip().lstrip('#')",
    "    return np.array([int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)], float)",
    "fills = {k: hexrgb(t['fill']) for k, t in tiers.items()}",
    "tols = {k: float(t.get('tolerance', 60)) for k, t in tiers.items()}",
    "img = Image.open(bg_path).convert('RGB')",
    "W, H = img.size",
    "a = np.asarray(img).astype(float)",
    "def tier_of(px):",
    "    best, bk = 1e9, None",
    "    for k, f in fills.items():",
    "        d = float(np.sqrt(((px - f) ** 2).sum()))",
    "        if d <= tols[k] and d < best: best, bk = d, k",
    "    return bk",
    "def inside(px, py, poly):",
    "    ins = False",
    "    n = len(poly)",
    "    for i in range(n):",
    "        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % n]",
    "        if ((y1 > py) != (y2 > py)) and (px < (x2 - x1) * (py - y1) / (y2 - y1 + 1e-12) + x1): ins = not ins",
    "    return ins",
    "ok_lots = checked = 0",
    "for lot in lots:",
    "    pts = [(p['x'] / 100 * W, p['y'] / 100 * H) for p in lot.get('polygon_pct', [])]",
    "    if len(pts) < 3: continue",
    "    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]",
    "    hits = good = 0",
    "    for gx in np.linspace(min(xs), max(xs), 6):",
    "        for gy in np.linspace(min(ys), max(ys), 6):",
    "            if not inside(gx, gy, pts): continue",
    "            px = a[min(H - 1, max(0, int(gy))), min(W - 1, max(0, int(gx)))]",
    "            m = float(px.mean())",
    "            if m < 100 or m > 240: continue",
    "            hits += 1",
    "            if tier_of(px) == lot.get('tier_key'): good += 1",
    "    if hits >= 3:",
    "        checked += 1",
    "        if good / hits >= 0.6: ok_lots += 1",
    "    from scipy import ndimage as ndi",
    "    EW = 1500",
    "    EH = int(EW * H / W)",
    "    eimg = img.convert('L').resize((EW, EH))",
    "    ea = np.asarray(eimg).astype(float)",
    "    gx = ndi.sobel(ea, axis=1); gy = ndi.sobel(ea, axis=0)",
    "    grad = np.hypot(gx, gy)",
    "    def edge_strength(dx, dy, n=16):",
    "        tot = 0.0; nl = 0",
    "        for lot in lots[::3]:",
    "            pts = lot.get('polygon_pct', [])",
    "            if len(pts) < 3: continue",
    "            s = 0.0",
    "            for i in range(n):",
    "                t = i / n * len(pts); j = int(t) % len(pts); f = t - int(t)",
    "                p1, p2 = pts[j], pts[(j + 1) % len(pts)]",
    "                x = ((p1['x'] + (p2['x'] - p1['x']) * f) + dx) / 100 * EW",
    "                y = ((p1['y'] + (p2['y'] - p1['y']) * f) + dy) / 100 * EH",
    "                s += grad[min(EH - 1, max(0, int(y))), min(EW - 1, max(0, int(x)))]",
    "            tot += s / n; nl += 1",
    "        return tot / max(1, nl)",
    "    g0 = edge_strength(0, 0)",
    "    probes = [edge_strength(dx, dy) for dx, dy in [(0.35, 0), (-0.35, 0), (0, 0.35), (0, -0.35)]]",
    "    best_probe = max(probes) if probes else 0.0",
    "    edge_ratio = (g0 / best_probe) if best_probe > 0 else 0.0",
    "    print(json.dumps({'rate': (ok_lots / checked) if checked else 0.0, 'checked': checked, 'passed': ok_lots, 'edge_ratio': edge_ratio, 'edge_zero': g0, 'edge_probe_best': best_probe}))",
  ].join("\n");
  const res = run("python3", ["-c", script, lotsPath, tiersPath, bgPath]);
  if (res.status !== 0) fail(`alignment check crashed: ${(res.stderr || res.stdout || "").trim().slice(0, 300)}`);
  try {
    return JSON.parse(res.stdout.trim().split("\n").pop());
  } catch {
    fail(`alignment check returned unreadable output: ${(res.stdout || "").slice(0, 200)}`);
  }
}

/** Build the QA viewer html. Lots + tiers are inlined; background stays an external href. */
function buildQaHtml({ tenant, lots, tiers, report }) {
  const tierEntries = Object.entries(tiers);
  const chips = tierEntries
    .map(([key, t]) => `<button class="chip on" data-tier="${key}" type="button"><i style="background:${t.legend || t.fill}"></i>${t.label} ($${Number(t.price).toLocaleString()})</button>`)
    .join("\n");
  const perTier = report?.gates?.per_tier ?? {};
  const summaryRows = tierEntries
    .map(([key, t]) => `<div class="kv"><span>${t.label}</span><strong>${perTier[key] ?? 0} lots · $${Number(t.price).toLocaleString()}</strong></div>`)
    .join("\n");
  const template = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TENANT__ – Lot Map QA</title>
<style>
:root{box-sizing:border-box;--bg:#f6f4ee;--card:#fff;--ink:#1d2b22;--mute:#667064;--line:#d9d5c8;--acc:#2f6b45}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--ink);font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column}
header{padding:10px 14px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
header h1{font-size:16px;margin:0;font-family:Georgia,serif}.pill{font-size:11px;background:var(--acc);color:#fff;border-radius:99px;padding:2px 8px}
.bar{display:flex;gap:6px;flex-wrap:wrap;padding:8px 14px;border-bottom:1px solid var(--line);align-items:center}
button,.chip{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:5px 10px;font:inherit;cursor:pointer}
button.on,.chip.on{background:var(--acc);color:#fff;border-color:var(--acc)}
.chip{display:flex;gap:6px;align-items:center;font-size:12px}.chip i{width:12px;height:12px;border-radius:3px;border:1px solid #0003}
.chip.off{opacity:.45}
#search{margin-left:auto;padding:5px 10px;border:1px solid var(--line);border-radius:8px;font:inherit}
main{flex:1;min-height:0;display:flex;flex-direction:column}
@media(min-width:820px){main{flex-direction:row}}
#map{flex:1;min-height:0;position:relative;overflow:hidden;background:#fff;touch-action:none;cursor:grab}
#map svg{width:100%;height:100%;display:block}
.lot{stroke:#fff;stroke-width:.25;cursor:pointer}
.lot:hover{stroke:#000;stroke-width:.8}.lot.sel{stroke:#d10;stroke-width:1}
.lot.flag{stroke:#c0c;stroke-dasharray:1.2 .8}
#tip{position:absolute;pointer-events:none;background:#000d;color:#fff;border-radius:6px;padding:3px 8px;font-size:12px;display:none;white-space:nowrap;z-index:5}
#zoom{position:absolute;right:10px;bottom:10px;display:flex;flex-direction:column;gap:4px;z-index:5}
aside{background:var(--card);border-top:1px solid var(--line);padding:12px 14px;overflow:auto;max-height:42%}
@media(min-width:820px){aside{width:330px;max-height:none;border-top:0;border-left:1px solid var(--line)}}
.kv{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px dashed var(--line);font-size:13px}
.warn{font-size:12px;color:#8a5a00;background:#fff4d6;border:1px solid #e8c96a;border-radius:8px;padding:6px 8px;margin-top:8px}
.note{font-size:11px;color:var(--mute);margin-top:10px}
</style></head>
<body>
<header><h1>__TENANT__ – Lot Map QA</h1><span class="pill">__COUNT__ lots</span><span class="pill">__REVIEW__ needs review</span></header>
<div class="bar">
<button id="vTier" class="on" type="button">Tier colours</button>
<button id="vConf" type="button">Confidence view</button>
<button id="vFlag" type="button">Flag low-confidence</button>
__CHIPS__
<input id="search" placeholder="Search lot (e.g. L-142)" aria-label="Search lot">
</div>
<main>
<div id="map"><svg id="svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet"><image id="bg" href="./masterplan_background.webp" x="0" y="0" width="100" height="100" preserveAspectRatio="none"/><g id="g"></g></svg><div id="tip"></div><div id="zoom"><button id="zin" type="button">+</button><button id="zout" type="button">−</button><button id="zreset" type="button">Reset</button></div></div>
<aside><h2 id="dTitle">Lot detail</h2><div id="dBody"><p>Select a lot on the map.</p></div><h3 style="font-size:12px;color:var(--mute)">Per-tier counts</h3>__SUMMARY__<div id="warnBox"></div><p class="note">QA build: polygons are 0–100% overlays on ./masterplan_background.webp. Verify alignment, tier colours, and the low-confidence cohort before publish. Statuses here are placeholders — real statuses come from the DB at publish time.</p></aside>
</main>
<script>
const LOTS=__LOTS_JSON__;
const TIERS=__TIERS_JSON__;
const NS='http://www.w3.org/2000/svg';
const svg=document.getElementById('svg'),g=document.getElementById('g'),tip=document.getElementById('tip');
let mode='tier',flag=false,sel=null,enabled=new Set(Object.keys(TIERS));
const confColor=c=>c>=0.85?'#22a55a':c>=0.65?'#e8a020':'#d10f0f';
function ptsAttr(poly){return poly.map(p=>p.x+','+p.y).join(' ');}
function render(){
  g.textContent='';
  for(const l of LOTS){
    if(!enabled.has(l.tier_key))continue;
    if(flag&&!l.needs_review)continue;
    const p=document.createElementNS(NS,'polygon');
    p.setAttribute('points',ptsAttr(l.polygon_pct));
    p.setAttribute('class','lot'+(l.needs_review&&flag?' flag':'')+(sel===l.lot_number?' sel':''));
    const t=TIERS[l.tier_key]||{};
    const fill=mode==='tier'?(t.legend||t.fill||'#999'):confColor(l.confidence);
    p.setAttribute('fill',fill);p.setAttribute('fill-opacity',sel===l.lot_number?'0.65':'0.4');
    p.dataset.lot=l.lot_number;
    p.addEventListener('mouseenter',e=>{tip.style.display='block';tip.textContent=l.lot_number+' · '+(t.label||l.tier_key)+(l.needs_review?' · REVIEW':'');});
    p.addEventListener('mousemove',e=>{const r=document.getElementById('map').getBoundingClientRect();tip.style.left=(e.clientX-r.left+12)+'px';tip.style.top=(e.clientY-r.top+12)+'px';});
    p.addEventListener('mouseleave',()=>{tip.style.display='none';});
    p.addEventListener('click',()=>{sel=l.lot_number;render();detail(l);});
    const title=document.createElementNS(NS,'title');title.textContent='Lot '+l.lot_number+' — '+(t.label||l.tier_key);p.appendChild(title);
    g.appendChild(p);
  }
}
function detail(l){
  const t=TIERS[l.tier_key]||{};
  document.getElementById('dTitle').textContent='Lot '+l.lot_number;
  document.getElementById('dBody').innerHTML=
    '<div class="kv"><span>Tier</span><strong>'+(t.label||l.tier_key)+'</strong></div>'+
    '<div class="kv"><span>Price</span><strong>$'+Number(l.price).toLocaleString()+'</strong></div>'+
    '<div class="kv"><span>Confidence</span><strong>'+l.confidence+'</strong></div>'+
    '<div class="kv"><span>Needs review</span><strong>'+(l.needs_review?'YES':'no')+'</strong></div>'+
    '<div class="kv"><span>Vertices</span><strong>'+l.polygon_pct.length+'</strong></div>'+
    (l.needs_review?'<div class="warn">Low-confidence polygon — verify against the plat before publish.</div>':'');
}
document.getElementById('vTier').onclick=e=>{mode='tier';e.target.classList.add('on');document.getElementById('vConf').classList.remove('on');render();};
document.getElementById('vConf').onclick=e=>{mode='conf';e.target.classList.add('on');document.getElementById('vTier').classList.remove('on');render();};
document.getElementById('vFlag').onclick=e=>{flag=!flag;e.target.classList.toggle('on',flag);render();};
document.querySelectorAll('.chip').forEach(c=>{c.onclick=()=>{const k=c.dataset.tier;if(enabled.has(k)){enabled.delete(k);c.classList.add('off');c.classList.remove('on');}else{enabled.add(k);c.classList.remove('off');c.classList.add('on');}render();};});
document.getElementById('search').onchange=e=>{const q=e.target.value.trim().toUpperCase();const hit=LOTS.find(l=>l.lot_number.toUpperCase()===q);if(hit){sel=hit.lot_number;enabled.add(hit.tier_key);render();detail(hit);}else{alert('Lot not found: '+q);}};
let vb={x:0,y:0,w:100,h:100};
function applyVb(){svg.setAttribute('viewBox',vb.x+' '+vb.y+' '+vb.w+' '+vb.h);}
function zoom(f,cx=50,cy=50){const nw=Math.min(100,Math.max(4,vb.w*f));const s=nw/vb.w;vb.x=cx-(cx-vb.x)*s;vb.y=cy-(cy-vb.y)*s;vb.w=nw;vb.h=nw;applyVb();}
document.getElementById('zin').onclick=()=>zoom(0.75);document.getElementById('zout').onclick=()=>zoom(1.33);
document.getElementById('zreset').onclick=()=>{vb={x:0,y:0,w:100,h:100};applyVb();};
svg.addEventListener('wheel',e=>{e.preventDefault();const pt=svg.createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;const c=pt.matrixTransform(svg.getScreenCTM().inverse());zoom(e.deltaY>0?1.2:0.83,c.x,c.y);},{passive:false});
let drag=null;document.getElementById('map').addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,vx:vb.x,vy:vb.y};e.target.setPointerCapture&&e.currentTarget.setPointerCapture(e.pointerId);});
document.getElementById('map').addEventListener('pointermove',e=>{if(!drag)return;const r=svg.getBoundingClientRect();vb.x=drag.vx-(e.clientX-drag.x)/r.width*vb.w;vb.y=drag.vy-(e.clientY-drag.y)/r.height*vb.h;applyVb();});
addEventListener('pointerup',()=>{drag=null;});
(function(){const low=LOTS.filter(l=>l.needs_review).length;const box=document.getElementById('warnBox');if(low)box.innerHTML='<div class="warn">'+low+' of '+LOTS.length+' lots flagged needs_review — audit this cohort in the Flag view.</div>';})();
render();
</script>
</body></html>`;
  return template
    .replaceAll("__TENANT__", tenant)
    .replaceAll("__COUNT__", String(lots.length))
    .replaceAll("__REVIEW__", String(lots.filter((l) => l.needs_review).length))
    .replaceAll("__CHIPS__", chips)
    .replaceAll("__SUMMARY__", summaryRows)
    .replace("__LOTS_JSON__", JSON.stringify(lots))
    .replace("__TIERS_JSON__", JSON.stringify(tiers));
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    fail(e.message);
  }
  args = applyDevelopment(args);
  if (args.help || args.h) {
    console.log(usage());
    return;
  }
  const tenant = (args.tenant || "").trim().toLowerCase();
  if (!tenant) fail(`--tenant is required\n${usage()}`);
  if (!args.source) fail(`--source is required\n${usage()}`);
  if (!args.tiers) fail(`--tiers is required\n${usage()}`);
  if (!args.out) fail(`--out is required\n${usage()}`);

  const source = resolve(args.source);
  const tiersPath = resolve(args.tiers);
  const outDir = resolve(args.out);
  if (!existsSync(source)) fail(`source not found: ${source}`);
  if (!existsSync(tiersPath)) fail(`tiers file not found: ${tiersPath}`);
  mkdirSync(outDir, { recursive: true });

  const workWidth = args["work-width"] ? num(args["work-width"], "--work-width") : 2000;
  const minArea = args["min-area"] ? num(args["min-area"], "--min-area") : 60;
  const expectedMin = args["expected-min"] ? num(args["expected-min"], "--expected-min") : 700;
  const expectedMax = args["expected-max"] ? num(args["expected-max"], "--expected-max") : 1000;
  const pdfImageIndex = args["pdf-image-index"] ? num(args["pdf-image-index"], "--pdf-image-index") : 0;
  const webpQuality = args["webp-quality"] ? num(args["webp-quality"], "--webp-quality") : 80;
  const webpMaxWidth = args["webp-max-width"] ? num(args["webp-max-width"], "--webp-max-width") : 3000;
  const alignmentMin = args["alignment-min"] ? num(args["alignment-min"], "--alignment-min") : 0.8;
  const edgeRatioMin = args["alignment-edge-ratio"] ? num(args["alignment-edge-ratio"], "--alignment-edge-ratio") : 1.2;
  const tiers = loadTiers(tiersPath);

  // 1. Detection (Stage 1).
  if (!args["skip-detect"]) {
    console.log(`[build] detecting lots from ${source} ...`);
    const res = run("python3", [
      "scripts/detect-lots.py",
      "--source", source,
      "--tiers", tiersPath,
      "--out-dir", outDir,
      "--tenant", tenant,
      "--pdf-image-index", String(pdfImageIndex),
      "--work-width", String(workWidth),
      "--min-area", String(minArea),
      "--expected-min", String(expectedMin),
      "--expected-max", String(expectedMax),
    ], { stdio: "inherit", cwd: process.cwd() });
    if (res.status !== 0) fail("detect-lots.py gates failed — see errors above");
  } else {
    console.log("[build] --skip-detect: reusing lots.json in out dir");
  }

  const lotsPath = join(outDir, "lots.json");
  const reportPath = join(outDir, "ingest-report.json");
  if (!existsSync(lotsPath)) fail(`lots.json missing in ${outDir} (detection did not produce it)`);
  const lots = JSON.parse(readFileSync(lotsPath, "utf8"));
  let detectorReport = {};
  if (existsSync(reportPath)) {
    try {
      detectorReport = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      detectorReport = {};
    }
  }
  if (Array.isArray(detectorReport.errors) && detectorReport.errors.length) {
    fail(`detector reported gate errors: ${detectorReport.errors.join("; ")}`);
  }

  // 2. Background extraction + webp conversion (<=10MB).
  const isPdf = source.toLowerCase().endsWith(".pdf");
  let rasterSrc = source;
  let cleanupTmp = null;
  if (isPdf) {
    const tmpPng = join(outDir, ".tmp-extract.png");
    console.log(`[build] extracting PDF image #${pdfImageIndex} (single-image, streaming) ...`);
    const meta = extractPdfImage(source, pdfImageIndex, tmpPng);
    console.log(`[build] extracted raster ${meta.width}x${meta.height}`);
    rasterSrc = tmpPng;
    cleanupTmp = tmpPng;
  }
  const bgPath = join(outDir, "masterplan_background.webp");
  console.log(`[build] converting background to webp (q=${webpQuality}, max-width=${webpMaxWidth}) ...`);
  let quality = webpQuality;
  let widthCap = webpMaxWidth;
  let bgDims = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    convertToWebp(rasterSrc, bgPath, quality, widthCap);
    bgDims = probeImage(bgPath);
    const bytes = statSync(bgPath).size;
    console.log(`[build] background attempt ${attempt + 1}: ${bgDims.width}x${bgDims.height}, ${(bytes / 1024 / 1024).toFixed(2)}MB`);
    if (bytes <= MAX_FILE_BYTES) break;
    if (quality > 60) quality -= 10;
    else widthCap = Math.round(widthCap * 0.8);
    if (attempt === 4) fail(`background still >10MB after 5 attempts — lower --webp-max-width`);
  }
  const bgBytes = statSync(bgPath).size;
  if (cleanupTmp) rmSync(cleanupTmp, { force: true });

  // 3. Aspect-drift gate vs the active map (fail closed when dims are known).
  const warnings = [...(detectorReport.warnings ?? [])];
  let aspect = { checked: false, drift_percent: null };
  if (args["active-width"] && args["active-height"]) {
    const active = { width: num(args["active-width"], "--active-width"), height: num(args["active-height"], "--active-height") };
    const drift = aspectDrift(bgDims, active);
    aspect = { checked: true, drift_percent: drift, active, draft: bgDims };
    if (drift !== null) fail(`aspect drift ${drift.toFixed(1)}% vs active map exceeds 2% — polygons would distort on activation`);
    console.log("[build] aspect drift vs active: within 2%");
  } else {
    warnings.push("active map dims not provided — verify alignment in the preview modal before publishing");
  }

  // 4. Node-side re-validation + QA html + merged report.
  const validation = validateLots(lots, tiers, expectedMin, expectedMax);
  for (const w of validation.warnings) {
    if (!warnings.includes(w)) warnings.push(w);
  }
  if (validation.errors.length) {
    for (const e of validation.errors) console.error(`error: ${e}`);
    process.exit(2);
  }
  console.log(`[build] validated ${lots.length} lots (${validation.needsReview} needs_review)`);

  // 5. Alignment gate: polygons must agree with the served background.
  let alignment = { checked: false, rate: null, lots_checked: 0, threshold: alignmentMin, edge_ratio: null, edge_threshold: edgeRatioMin, method: "interior-sample+edge" };
  if (!args["skip-alignment-check"]) {
    console.log("[build] checking polygon/background alignment (interior + edge sampling) ...");
    const result = checkAlignment(lotsPath, tiersPath, bgPath, edgeRatioMin);
    alignment = { checked: true, rate: result.rate, lots_checked: result.checked, threshold: alignmentMin, edge_ratio: result.edge_ratio, edge_threshold: edgeRatioMin, method: "interior-sample+edge" };
    console.log(`[build] alignment agreement: ${(result.rate * 100).toFixed(1)}% over ${result.checked} lots (min ${(alignmentMin * 100).toFixed(0)}%)`);
    console.log(`[build] edge ratio: ${result.edge_ratio.toFixed(2)} (zero-shift strength ${(result.edge_zero).toFixed(0)} vs best probe ${(result.edge_probe_best).toFixed(0)}, min ${edgeRatioMin})`);
    if (result.rate < alignmentMin) {
      fail(
        `alignment agreement ${(result.rate * 100).toFixed(1)}% below ${(alignmentMin * 100).toFixed(0)}% — ` +
        `polygons and background have different extents. Detect on the exact file served, then rebuild.`,
      );
    }
    if (result.edge_ratio < edgeRatioMin) {
      fail(
        `edge ratio ${result.edge_ratio.toFixed(2)} below ${edgeRatioMin} — ` +
        `polygon borders do not sit on Lot-line discontinuities (sub-lot shift or wrong export). Detect on the exact file served, then rebuild.`,
      );
    }
  } else {
    warnings.push("alignment check skipped (--skip-alignment-check) — verify polygon fit in poc.html before publishing");
  }

  const merged = {
    ...detectorReport,
    tenant,
    outputs: {
      ...(detectorReport.outputs ?? {}),
      background_webp: "masterplan_background.webp",
      qa_html: "poc.html",
    },
    background: {
      file: "masterplan_background.webp",
      width: bgDims.width,
      height: bgDims.height,
      bytes: bgBytes,
      megabytes: Number((bgBytes / 1024 / 1024).toFixed(2)),
      within_10mb: bgBytes <= MAX_FILE_BYTES,
    },
    aspect,
    alignment,
    // Rebuilds merge the previous report: dedupe so warnings don't stack.
    warnings: [...new Set(warnings)],
    errors: [],
    gates: {
      ...(detectorReport.gates ?? {}),
      background_bytes: bgBytes,
      background_within_10mb: bgBytes <= MAX_FILE_BYTES,
    },
  };
  const qaHtml = buildQaHtml({ tenant, lots, tiers, report: merged });
  writeFileSync(join(outDir, "poc.html"), qaHtml, "utf8");
  writeFileSync(reportPath, JSON.stringify(merged, null, 2) + "\n", "utf8");

  console.log(`[build] done -> ${outDir}`);
  console.log(`  lots.json:                   ${lots.length} lots (${validation.needsReview} needs_review)`);
  console.log(`  masterplan_background.webp:  ${bgDims.width}x${bgDims.height}, ${(bgBytes / 1024 / 1024).toFixed(2)}MB`);
  console.log(`  tiers:                       ${JSON.stringify(validation.counts)}`);
  console.log(`  poc.html + ingest-report.json written`);
  for (const w of warnings) console.warn(`warning: ${w}`);
}

main();
