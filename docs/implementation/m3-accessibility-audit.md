# M3 Buyer Map Technical Audit — 12 October 2026

**Target:** React public embed (`PublicLotMap`) and its buyer inquiry dialog.  
**Intended viewer:** developer evaluating the buyer experience; design baseline is phone-first, with desktop as the showcase.  
**Accessibility target:** WCAG 2.2 AA.  
**State:** the scores/findings below are the pre-remediation local diagnostic snapshot. A separate local remediation follow-up is recorded at the end. No hosted calls, inquiry writes, or release approval were performed.

## Scope and evidence

- Inspected `src/components/public/PublicLotMap.tsx`, `PublicInquiryModal.tsx`, `EmbeddableMapPage.tsx`, `src/lib/theme.ts`, and `src/index.css`.
- Ran the focused Chromium Playwright test `keyboard lot search opens details and exposes a keyboard lot action`: **1 passed**.
- Exercised the local `/embed/demo?demo=1` synthetic preview at 390×844 CSS px / DPR 1. Its search-results panel measured x = −100, width = 288, right = 188; the map root is 390px wide with `overflow-hidden`. The page had no console/page errors and made no `/functions/v1` or `/rest/v1` requests.
- In the same preview at DPR 2, selected a synthetic available lot and measured the 12px status badge. White on `#22c55e` is **2.28:1**. The other source-defined status fills yield white-text ratios of **2.15:1** (`#f59e0b`) and **3.76:1** (`#ef4444`).
- With a synthetic mocked public-lots response, opened the inquiry dialog in Chromium. Focus stayed on the background “Inquire” button after opening; Tab moved to the dialog backdrop button, and Shift+Tab returned to the background trigger. No real endpoint was called.
- Performance score uses the existing isolated production-bundle probe recorded in `project-scoped-public-map.md`: 719 candidate polygons at 412×839 / DPR 2.625, 1.396s useful-map-ready, 512,955 bytes transferred, and no browser/console errors under the documented throttled loopback profile. This remains synthetic/local evidence, not a physical-phone or hosted measurement.

This is not a screen-reader certification, physical-device test, approved-theme test, or WCAG conformance claim. The owner register, approved public fields, labels, scale, and sample route remain pending.

## Audit health score

The scores and findings in this initial snapshot describe the pre-remediation state; see the follow-up below for current local status.

| # | Dimension | Score | Key finding |
|---|---|---:|---|
| 1 | Accessibility | 2/4 | Search is keyboard-operable, but the inquiry dialog does not manage modal focus and status badges fail text contrast. |
| 2 | Performance | 3/4 | The local production simulation is fast and light; approved payload, hosted timing, physical device, and sustained frame rate remain unmeasured. |
| 3 | Responsive design | 2/4 | The mobile search chooser is clipped offscreen; primary controls are mostly 28–32px high. |
| 4 | Theming | 1/4 | Per-tenant tokens are parsed and assigned but are not consumed by the map’s base styles; no typography token exists. |
| 5 | Anti-patterns | 3/4 | The React map is restrained and task-focused; tier/status color mixing and the still-unfrozen standalone candidate remain concerns. |
| **Total** | | **11/20** | **Acceptable — significant M3 work remains before Demo A.** |

## Anti-patterns verdict

The pre-remediation snapshot showed a tenant/project name in the map header. The current local embed instead uses the neutral “Lot availability” label, with no platform or tenant wordmark in the map chrome; tenant colors and type come from scoped theme tokens. A configurable “powered by” line remains optional and is not rendered because no setting exists. The Hopkins source file still contains saturated tier fills and dense plat labels, but the React buyer map now renders that raster with a display-only grayscale filter and 0.68 opacity; the source asset and polygon geometry remain unchanged. Local screenshots at 1280×800 and 390×844 use anonymized alignment polygons all marked Sold (a geometry diagnostic, not a buyer inventory sample): they show source hues muted and status strokes distinct, but baked labels and sales marks are still apparent, and the phone view has substantial blank map canvas around the plat. The synthetic palette regression still proves only overlay palette switching. The real-source alignment E2E additionally checks the computed filter/opacity with anonymized polygons at three viewport ratios and zoom levels; it does not establish pixel-level palette separation or source-fit acceptance. Keep the neutral-base/raw-plat verdict partial and the paint-out decision open until source-fit and reviewer gates are satisfied. The standalone candidate has separate recorded crispness/sample-state issues in `polish-check.md`; it must not be treated as an approved buyer demo.

## Detailed findings

### P1 — Before Demo A

1. **Status text does not meet contrast.** `PublicLotMap.tsx` defines status fills at line 72 and renders white 12px text on the available/reserved/sold fill at line 1459. Measured ratios are 2.28:1, 2.15:1, and 3.76:1; normal text requires 4.5:1 under WCAG 1.4.3. Keep the status unmistakable, but use a passing foreground/background pairing (or a neutral badge with text plus another non-color cue). **Suggested:** `$impeccable harden`.

2. **Inquiry dialog focus is not modal-contained.** `PublicInquiryModal.tsx:78` sets `role="dialog"` and `aria-modal="true"`, but opening leaves focus on the underlying trigger and keyboard focus can leave the dialog. This makes the announced modal state disagree with keyboard behavior (WCAG 2.4.3; WAI-ARIA modal-dialog pattern). Move focus into the dialog, contain it while open, restore it on close, and support Escape. **Suggested:** `$impeccable harden`.

3. **Mobile search results are clipped.** `PublicLotMap.tsx:1029` anchors a 288px result region to the search field’s right edge. At a 390px viewport the region begins at x = −100 and is clipped by the map root’s `overflow-hidden`; the lot number can be hidden while the result remains interactive. This risks loss of content at phone width (WCAG 1.4.10). Keep the chooser fully inside the viewport. **Suggested:** `$impeccable adapt`.

4. **Tenant theme tokens do not drive the component’s default styling.** `buildThemeCssVars()` writes `--lotmap-*` at `src/lib/theme.ts:110–115`, and `PublicLotMap.tsx` assigns those variables at lines 520 and 977. A source search found no base-style consumer of those variables under `src/`; the map instead uses global `text-primary`, `bg-background`, and related tokens. `LotMapThemeTokens` also has no typography field. This conflicts with the requirement that tenant tokens provide map colors/type while embed chrome stays platform-neutral. Wire the scoped tokens into the component and define a safe tenant-type contract before presenting a tenant-branded experience. **Suggested:** `$impeccable colorize`.

5. **Tenant colors are format-checked, not contrast-checked.** `allowlistTheme()` accepts any syntactically valid hex color (`src/lib/theme.ts:75–95`). Once those colors are consumed, arbitrary `text`, `muted`, `primary`, and `card` combinations can still fail WCAG 1.4.3 or 1.4.11. Validate required foreground/background pairs or compute accessible fallbacks while preserving the tenant palette. **Suggested:** `$impeccable harden`.

### P2 — Follow-up polish

1. **Tab semantics lack tab-key behavior.** The colour and lot-filter controls use `tablist`/`tab` roles (`PublicLotMap.tsx:1084–1110`) but expose no arrow-key handler or roving `tabIndex`. The buttons remain reachable with Tab, but screen-reader users receive a tabs pattern that does not follow its expected keyboard model. Implement the pattern or use a button group/pressed-state semantics. **Suggested:** `$impeccable harden`.

2. **Phone controls are small for comfortable tapping.** The search and tab buttons measured 28px high; fullscreen/zoom controls are 32×32px. They exceed WCAG 2.2 AA’s 24px minimum-size baseline, so this is not a claimed AA failure, but 44px targets would better support phone-first use. **Suggested:** `$impeccable adapt`.

3. **Tier view still uses a traffic-light status badge.** The map strokes/dots switch to tier colors through `fillFor()`, but the selected-lot badge at `PublicLotMap.tsx:1459` always uses `STATUS_STYLE`. That combines the two palettes against the stated “one color system per view” rule. Keep status text; make the badge neutral or otherwise avoid a second competing color system. **Suggested:** `$impeccable colorize`.

4. **Loading pulse has no reduced-motion override.** The root has targeted `motion-reduce` rules for buttons and polygons (`PublicLotMap.tsx:970`), but the loading placeholder at line 1172 uses `animate-pulse` without a reduced-motion alternative. Suppress or replace that pulse when `prefers-reduced-motion: reduce` is set. **Suggested:** `$impeccable animate`.

## Positive findings

- The search input has an accessible name and keyboard instructions; Arrow Down/Up, Escape, and Enter reach a lot’s detail region. The focused Chromium regression passed.
- Empty, no-match, failure/retry, and loading states are represented in the component; the search results announce match counts.
- The synthetic preview is read-only: the measured path made no business API calls and reported no browser or console errors.
- The local production-bundle performance probe is comfortably inside the provisional three-second visible-time aim, with a small modeled transfer; its limitations remain explicit in the performance evidence.
- Embed chrome uses the generic “Lot availability” label rather than a Wamule platform wordmark; tenant theme tokens supply the brand colors and type.

## M3 release gates not closed by this audit

- No production-compatible frozen sample route or owner-approved public payload exists yet.
- The standalone candidate’s crispness and sample statuses remain open as recorded in `polish-check.md`; do not share it as a release surface.
- The original Hopkins base layer is still color-rich and dense. Its current React display is grayscale at 0.68 opacity, but baked labels and phone-portrait dead canvas remain visible; the synthetic palette E2E is not enough to accept the real buyer composite. A reviewed, source-aligned quiet base is still required before the one-palette-per-view criterion can pass.
- A physical phone, real hosted payload, Edge execution, and sustained 30fps have not been verified.
- Register, human labels, calibration, public-field approval, and sellable/common-area sign-off remain owner inputs.

## Recommendations from the initial audit

These were the recommendations before the remediation follow-up below.

1. **[P1] `$impeccable harden`**: fix the dialog focus model and establish contrast-safe status/theme pairs.
2. **[P1] `$impeccable adapt`**: keep search results on-screen and improve phone touch targets.
3. **[P1] `$impeccable colorize`**: connect tenant tokens to the map while keeping the chrome neutral and the active color system unambiguous.
4. **[P2] `$impeccable animate`**: add a reduced-motion loading state.
5. **`$impeccable polish`**: final responsive, focus, contrast, and browser pass after fixes.

## Local remediation follow-up — 12 October 2026

The baseline audit was converted into a local buyer-map implementation packet. No hosted services, real inquiry writes, or production inventory were used. The original 11/20 score is retained as a before snapshot and has not been rescored.

- **Resolved locally:** status badge contrast; the inquiry dialog now receives initial focus, traps Tab, closes on Escape, moves focus to the confirmation action after success, and restores focus to its trigger. Chromium E2E verifies open, trap, confirmation, and restore paths with mocked requests.
- **Resolved locally:** search results anchor to the search field's left edge and stay inside a 320px viewport. On phones, search uses the full row and the two filter groups share the next row with shortened visible labels and stable accessible names, reducing toolbar height without shrinking 44px targets. The search field, mode/filter controls, tier controls, and map zoom/fullscreen controls use 44px minimum targets; the Chromium 320px check verifies the controls fit without horizontal overflow.
- **Resolved locally:** the SVG exposes one keyboard stop for its lot listbox rather than hundreds of Tab stops. Arrow keys move the active option toward the nearest neighboring lot, Home/End reach the visible-list endpoints, and Enter/Space open the selected lot's detail region; Escape returns to search. A double-stroke white/ink outline follows the active option. E2E covers this map path, search-to-details, and phone-width search bounds in Chromium, Pixel 7, WebKit, and iPhone 13 emulation (12/12 checks).
- **Resolved locally:** public theme color tokens now feed the embed's scoped semantic Tailwind variables. Text and primary foregrounds select a WCAG AA-safe color; conflicting light/dark surfaces fall back to one readable card surface. Borders are raised to 3:1 contrast. Tenant font stacks are allowlisted and applied to the map's inherited text and display-font utilities. E2E verifies a custom palette/type stack is applied; unit tests cover low-contrast and conflicting inputs.
- **Resolved locally:** tier-color mode hides the status legend and uses a neutral status badge, so the two lot-color systems are not layered together. The badge's text contrast is asserted at 4.5:1 in Chromium.
- **Resolved locally:** status mode adds distinct circle/diamond/square lot markers for Available/Reserved/Sold, plus matching legend glyphs, so a lot state is not conveyed by hue alone. Tier mode deliberately returns to one marker shape and the tier palette; the five-project regression asserts the separation and no-urgency copy.
- **Resolved locally:** the map's color/filter selectors are pressed button groups rather than tab widgets without tab-key behavior; the loading pulse has a reduced-motion alternative.
- **Resolved locally:** embed chrome and lazy-load fallback are platform-neutral (“Lot availability” / “Loading…”). Search, color/filter groups, tier controls, zoom/fullscreen controls, and lot-card actions have visible theme-aware keyboard focus. The filter wrappers no longer clip the focus ring. E2E confirms the generic header, absence of a Wamule wordmark, control names, and visible focus styling.

**Verification:** `node --test test/tenant-theme.test.mjs` (9/9), full `npm test -- --test-reporter=dot` (pass), `npm run typecheck` (pass), `npm run lint` (pass), `npm run build` (pass), and the focused Chromium browser checks (4/4) passed. The full Chromium run of `e2e/inquiry-errors.spec.ts` and `e2e/lot-map.spec.ts` completed with **35 passed, 3 skipped, 0 failed**. The follow-on keyboard/search/mobile/focus matrix completed with **20 passed** across Chromium, Firefox, WebKit, Pixel 7, and iPhone 13 emulation.

**Current browser recheck — 12 October 2026:** the same two browser specs passed **81/84** across Chromium and Pixel 7 emulation (3 skipped; 0 failed). The run exposed test helpers selecting the first `<svg>` in `<main>`—a decorative legend marker—rather than the interactive map. Both specs now scope map geometry queries to `main svg[role=group]`. The correction changes test targeting only; it does not alter map behavior. This is synthetic-fixture and mocked-inquiry evidence, not a physical-device or hosted check.

**Still unverified:** physical iPhone/Android behavior, screen-reader review, real approved tenant configuration and inventory, hosted API/Edge timing, production inquiry delivery, and a final post-remediation full audit. The preview remains synthetic and read-only; release inputs and gates listed above remain open.
