import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

function functionBody(source, name) {
  const start = source.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `${name} must be defined.`);
  // Body runs to the next top-level `const ... = ` / `function ` / `useEffect(`.
  const rest = source.slice(start);
  const end = rest.search(/\n  (const|function|return) /);
  return end >= 0 ? rest.slice(0, end) : rest;
}

test("fullscreen toggle enters natively and state follows browser-owned exits", async () => {
  const map = await read("src/components/public/PublicLotMap.tsx");

  // Toggle button with changing label + pressed state, next to zoom controls.
  assert.match(map, /aria-label=\{expanded \? "Exit fullscreen" : "Enter fullscreen"\}/);
  assert.match(map, /aria-pressed=\{expanded\}/);
  assert.match(map, /expanded \? exitFullscreen\(\) : enterFullscreen\(\)/);

  // Primary mechanism with webkit fallbacks for older Safari.
  assert.match(map, /requestContainerFullscreen/);
  assert.match(map, /webkitRequestFullscreen/);
  assert.match(map, /webkitExitFullscreen/);

  // Browser-owned exits (Esc key, device UI) sync through both events.
  assert.match(map, /document\.addEventListener\("fullscreenchange", sync\)/);
  assert.match(map, /document\.addEventListener\("webkitfullscreenchange", sync\)/);
  assert.match(map, /currentFullscreenElement\(\) === containerRef\.current/);

  // Focus: Close on enter, toggle on exit (skipped on first mount).
  assert.match(map, /closeRef\.current\?\.focus/);
  assert.match(map, /toggleRef\.current\?\.focus/);
  assert.match(map, /wasExpandedRef/);
});

test("pseudo-fullscreen fallback locks scroll, covers viewport, and exits on Esc", async () => {
  const map = await read("src/components/public/PublicLotMap.tsx");

  // Rejection (or missing API) engages the CSS fallback.
  const enter = functionBody(map, "enterFullscreen");
  assert.match(enter, /requestContainerFullscreen/);
  assert.match(enter, /\.catch\(\(\) =>/);
  assert.match(enter, /setPseudoFullscreen\(true\)/);

  // Fixed overlay, viewport units, top-layer z-index, safe-area insets.
  assert.match(map, /pseudoFullscreen && "fixed inset-0 z-\[100\]"/);
  assert.match(map, /h-\[100dvh\] w-screen/);
  assert.match(map, /env\(safe-area-inset-top\)/);
  assert.match(map, /env\(safe-area-inset-bottom\)/);

  // Body scroll locks on entry and restores on exit/unmount.
  assert.match(map, /document\.body\.style\.overflow = "hidden"/);
  assert.match(map, /document\.body\.style\.overflow = previousOverflowRef\.current/);

  // Manual Esc handling for pseudo mode (native Esc is browser-owned).
  assert.match(map, /event\.key === "Escape" && pseudoRef\.current/);

  // Reduced motion respected for in-map transitions.
  assert.match(map, /motion-reduce:/);
});

test("selection, search, filters, zoom, and view mode survive toggling", async () => {
  const map = await read("src/components/public/PublicLotMap.tsx");

  // Expanded derives from fullscreen flags only; enter/exit never reset content.
  assert.match(map, /const expanded = nativeFullscreen \|\| pseudoFullscreen/);
  for (const fn of ["enterFullscreen", "exitFullscreen"]) {
    const body = functionBody(map, fn);
    for (const reset of ["setQuery(", "setZoom(", "setFilter(", "setColourView(", "setDisabledTiers(", "setInternalSelectedId("]) {
      assert.ok(!body.includes(reset), `${fn} must not reset content state (${reset}).`);
    }
  }
  // State hooks all live above the toggle logic (no unmount on expand).
  for (const hook of ["useState<PublicLotFilter>", "useState<PublicLotColourView>", 'useState("")', "useState<string[]>([])", "useState(MIN_ZOOM)"]) {
    assert.ok(map.includes(hook), `Expected content state hook ${hook}.`);
  }
});

test("add-to-preferences works inside fullscreen with confirmation", async () => {
  const [map, page] = await Promise.all([
    read("src/components/public/PublicLotMap.tsx"),
    read("src/pages/ApplicationPage.tsx"),
  ]);

  // Detail panel + toast live inside the fullscreen container.
  assert.match(map, /added to your preferences/);
  assert.match(map, /role="status"/);
  assert.match(map, /aria-live="polite"/);
  // Fullscreen detail panel docks on desktop, scrolls on short viewports.
  assert.match(map, /max-h-\[50dvh\] overflow-auto/);
  // Close sits top-right; the docked panel clears it, and the zoom stack
  // lifts above the bottom sheet on small screens.
  assert.match(map, /md:top-14/);
  assert.match(map, /focusLot && !expanded \? "bottom-48 sm:bottom-3"/);

  // Pick action flows into the application form field.
  assert.match(page, /form\.setValue\("preferred_parcel_ids"/);
  assert.match(map, /Select Lot /);
});

test("legend matches the active colour view", async () => {
  const map = await read("src/components/public/PublicLotMap.tsx");
  assert.match(map, /aria-label="Map legend"/);
  assert.match(map, /colourView === "status"/);
  // Tier view legend is the tier chips row (collapsible, closed on small screens).
  assert.match(map, /aria-expanded=\{chipsOpen\}/);
  assert.match(map, /window\.innerWidth >= 640/);
});

test("small lots get an invisible pointer halo without changing the visuals", async () => {
  const map = await read("src/components/public/PublicLotMap.tsx");
  assert.match(map, /HIT_STROKE_PX/);
  assert.match(map, /stroke="rgba\(0,0,0,0\)"/);
  assert.match(map, /pointerEvents="none"/);
  // Public data contract untouched.
  assert.match(map, /viewBox=\{viewBox\}/);
  assert.match(map, /preserveAspectRatio="xMidYMid meet"/);
});

test("embed snippet permits fullscreen and documents older embeds", async () => {
  const snippet = await read("src/components/admin/settings/WordPressEmbedSnippet.tsx");
  assert.match(snippet, /allow="fullscreen"/);
  assert.match(snippet, /allowfullscreen/);
  assert.match(snippet, /older embeds need/);
});
