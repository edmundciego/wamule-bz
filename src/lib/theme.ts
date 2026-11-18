/**
 * Tenant theming contract (single source of truth).
 *
 * Used by the web app (PublicLotMap applies color/type tokens as CSS variables + card
 * config), the publish pipeline (scripts validate + allowlist before
 * writing), and node tests. Dependency-free on purpose: no DOM access here
 * (callers own the DOM), no Node/Deno APIs.
 *
 * Isolation model: theme.json tokens become per-container CSS variables
 * (--lotmap-*) so two embeds never share state, and overrides.css selectors
 * must all be prefixed with the tenant scope class (`.lotmap-t-<slug>`),
 * enforced by validateTenantCss. No per-tenant JS is ever loaded.
 */

export interface LotMapThemeTokens {
  primary: string;
  background: string;
  card: string;
  accent: string;
  text: string;
  muted: string;
  fontFamily: string;
}

export interface LotMapCardConfig {
  showTier: boolean;
  showArea: boolean;
  showPrice: boolean;
  inquireText: string;
  waitlistText: string;
  zoomText: string;
}

export interface LotMapTheme {
  tokens: LotMapThemeTokens;
  card: LotMapCardConfig;
  /** Storage URL of the validated overrides.css (null when none). */
  cssUrl: string | null;
}

const COLOR_TOKEN_KEYS = ["primary", "background", "card", "accent", "text", "muted"] as const;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const FONT_NAME = String.raw`(?:[\p{L}\p{N}_-][\p{L}\p{N}_ -]*|"[\p{L}\p{N}_ -]+"|'[\p{L}\p{N}_ -]+')`;
const FONT_STACK = new RegExp(`^${FONT_NAME}(?:\\s*,\\s*${FONT_NAME})*$`, "u");
export const DEFAULT_FONT_FAMILY = `Inter, Manrope, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;

export const DEFAULT_CARD_CONFIG: LotMapCardConfig = {
  showTier: true,
  showArea: true,
  showPrice: true,
  inquireText: "Inquire About Lot {lot}",
  waitlistText: "Join Waitlist for Lot {lot}",
  zoomText: "Zoom to Lot {lot}",
};

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanHex(value: unknown, fallback: string): string {
  const text = cleanText(value, 16);
  return HEX_COLOR.test(text) ? text : fallback;
}

function cleanFontFamily(value: unknown, fallback: string): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
  if (!text || !FONT_STACK.test(text) || /^(inherit|initial|unset|revert|revert-layer)$/i.test(text)) return fallback;
  return text;
}

type RGB = readonly [number, number, number];

function hexToRgb(hex: string): RGB {
  const raw = hex.slice(1);
  const full = raw.length === 3 ? [...raw].map((value) => `${value}${value}`).join("") : raw;
  return [0, 2, 4].map((index) => Number.parseInt(full.slice(index, index + 2), 16)) as unknown as RGB;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function chooseForeground(preferred: string, surfaces: string[]): string {
  const choices = [preferred, "#000000", "#ffffff"];
  return choices.find((color) => surfaces.every((surface) => contrastRatio(color, surface) >= 4.5)) ??
    ["#000000", "#ffffff"].sort((left, right) =>
      Math.min(...surfaces.map((surface) => contrastRatio(right, surface))) -
      Math.min(...surfaces.map((surface) => contrastRatio(left, surface))),
    )[0];
}

function mixHex(base: string, tint: string, tintAmount: number): string {
  const mixed = hexToRgb(base).map((channel, index) =>
    Math.round(channel * (1 - tintAmount) + hexToRgb(tint)[index] * tintAmount),
  );
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function blendForContrast(surface: string, preferred: string, minimum = 3): string {
  if (contrastRatio(preferred, surface) >= minimum) return preferred;
  const target = chooseForeground(preferred, [surface]);
  let low = 0;
  let high = 1;
  for (let step = 0; step < 12; step++) {
    const middle = (low + high) / 2;
    if (contrastRatio(mixHex(surface, target, middle), surface) >= minimum) high = middle;
    else low = middle;
  }
  return mixHex(surface, target, high);
}

function toHslChannels(hex: string): string {
  const [red, green, blue] = hexToRgb(hex).map((channel) => channel / 255);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;
  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return `${Math.round(hue)} ${Math.round(saturation * 100)}% ${Math.round(lightness * 100)}%`;
}

function cleanBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Allowlist a raw theme.json value into a safe LotMapTheme. Unknown keys
 * are dropped, colors must be hex (else the default), texts are stripped
 * of markup and length-capped. Never throws.
 */
export function allowlistTheme(raw: unknown, cssUrl: string | null): LotMapTheme {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tokens = (source.tokens && typeof source.tokens === "object" ? source.tokens : {}) as Record<string, unknown>;
  const card = (source.card && typeof source.card === "object" ? source.card : {}) as Record<string, unknown>;
  const base: LotMapThemeTokens = {
    primary: "#173f2d",
    background: "#fffdf8",
    card: "#ffffff",
    accent: "#8a5a35",
    text: "#2d2317",
    muted: "#6b6259",
    fontFamily: DEFAULT_FONT_FAMILY,
  };
  const out: LotMapTheme = {
    tokens: {
      primary: cleanHex(tokens.primary, base.primary),
      background: cleanHex(tokens.background, base.background),
      card: cleanHex(tokens.card, base.card),
      accent: cleanHex(tokens.accent, base.accent),
      text: cleanHex(tokens.text, base.text),
      muted: cleanHex(tokens.muted, base.muted),
      fontFamily: cleanFontFamily(tokens.fontFamily, base.fontFamily),
    },
    card: {
      showTier: cleanBool(card.showTier, DEFAULT_CARD_CONFIG.showTier),
      showArea: cleanBool(card.showArea, DEFAULT_CARD_CONFIG.showArea),
      showPrice: cleanBool(card.showPrice, DEFAULT_CARD_CONFIG.showPrice),
      inquireText: cleanText(card.inquireText, 80) || DEFAULT_CARD_CONFIG.inquireText,
      waitlistText: cleanText(card.waitlistText, 80) || DEFAULT_CARD_CONFIG.waitlistText,
      zoomText: cleanText(card.zoomText, 40) || DEFAULT_CARD_CONFIG.zoomText,
    },
    cssUrl: typeof cssUrl === "string" && cssUrl ? cssUrl.slice(0, 1000) : null,
  };
  return out;
}

/** Build the per-container CSS variable map (fresh object per call). */
export function buildThemeCssVars(theme: LotMapTheme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of COLOR_TOKEN_KEYS) {
    vars[`--lotmap-${key}`] = theme.tokens[key];
  }

  // A single foreground must work on both public surfaces. If a tenant pairs
  // opposing light/dark surfaces such that no AA foreground can serve both,
  // keep the requested values available as lotmap tokens but use one neutral
  // semantic surface in the embed rather than shipping unreadable text.
  const background = theme.tokens.background;
  let card = theme.tokens.card;
  if (![theme.tokens.text, "#000000", "#ffffff"].some((color) =>
    [background, card].every((surface) => contrastRatio(color, surface) >= 4.5),
  )) {
    card = background;
  }
  const text = chooseForeground(theme.tokens.text, [background, card]);
  const primary = chooseForeground(theme.tokens.primary, [background, card]);
  const cardText = chooseForeground(theme.tokens.text, [card]);
  const muted = chooseForeground(theme.tokens.muted, [background, card]);
  const primaryForeground = chooseForeground("#ffffff", [primary]);
  const accentForeground = chooseForeground("#ffffff", [theme.tokens.accent]);
  let darkerPrimary = mixHex(primary, "#000000", 0.14);
  if (contrastRatio(primaryForeground, darkerPrimary) < 4.5) darkerPrimary = primary;
  let primarySoft = mixHex(background, primary, 0.09);
  if (contrastRatio(primary, primarySoft) < 4.5) primarySoft = background;
  let darkerAccent = mixHex(theme.tokens.accent, "#000000", 0.14);
  if (contrastRatio(accentForeground, darkerAccent) < 4.5) darkerAccent = theme.tokens.accent;
  let accentSoft = mixHex(background, theme.tokens.accent, 0.09);
  if (contrastRatio(accentForeground, accentSoft) < 4.5) accentSoft = background;
  const subtleBorder = blendForContrast(card, muted);
  const border = [background, card].every((surface) => contrastRatio(subtleBorder, surface) >= 3)
    ? subtleBorder
    : muted;

  // The app's Tailwind utilities consume HSL channel variables. Mapping these
  // per embed keeps the chrome neutral and tenant-scoped without changing the
  // surrounding host page or another map instance.
  vars["--lotmap-font-family"] = theme.tokens.fontFamily;
  vars["--font-sans"] = theme.tokens.fontFamily;
  vars["--background"] = toHslChannels(background);
  vars["--foreground"] = toHslChannels(text);
  vars["--card"] = toHslChannels(card);
  vars["--card-foreground"] = toHslChannels(cardText);
  vars["--muted"] = toHslChannels(mixHex(card, text, 0.04));
  vars["--muted-foreground"] = toHslChannels(muted);
  vars["--primary"] = toHslChannels(primary);
  vars["--primary-hover"] = toHslChannels(darkerPrimary);
  vars["--primary-soft"] = toHslChannels(primarySoft);
  vars["--primary-foreground"] = toHslChannels(primaryForeground);
  vars["--accent"] = toHslChannels(theme.tokens.accent);
  vars["--accent-hover"] = toHslChannels(darkerAccent);
  vars["--accent-soft"] = toHslChannels(accentSoft);
  vars["--border"] = toHslChannels(border);
  vars["--input"] = vars["--border"];
  vars["--ring"] = vars["--primary"];
  vars["--accent-foreground"] = toHslChannels(accentForeground);
  return vars;
}

/** Fill a card text template ({lot} supported, unknown tokens left alone). */
export function applyCardText(template: string, lotNumber: string): string {
  return template.replace(/\{lot\}/g, lotNumber);
}

/**
 * Validate tenant overrides.css. Returns error strings (empty = valid).
 * Rules: no @import, no expression(), no external url() (relative paths
 * only), only @media may nest, and EVERY selector must start with the
 * tenant scope class so one tenant's CSS can never style another embed.
 */
export function validateTenantCss(cssText: string, scopeClass: string): string[] {
  const errors: string[] = [];
  if (!scopeClass || !/^\.[a-z0-9-]+$/.test(scopeClass)) {
    return ["scope class must look like .lotmap-t-<slug>"];
  }
  const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@import\b/i.test(withoutComments)) errors.push("CSS @import is not allowed");
  if (/expression\s*\(/i.test(withoutComments)) errors.push("CSS expression() is not allowed");
  const urlMatch = withoutComments.match(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/i);
  if (urlMatch) {
    const target = urlMatch[2].trim().toLowerCase();
    if (
      target.startsWith("http:") ||
      target.startsWith("https:") ||
      target.startsWith("//") ||
      target.startsWith("data:") ||
      target.startsWith("/") ||
      target === ""
    ) {
      errors.push(`external url() is not allowed: ${urlMatch[2].slice(0, 80)}`);
    }
  }

  // Top-level rule walk (one @media nesting level supported).
  const scope = scopeClass.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scopedSelector = new RegExp(`^${scope}(?![a-zA-Z0-9_-])`);
  function checkRules(block: string, where: string) {
    let depth = 0;
    let selectorStart = 0;
    let ruleSelector = "";
    for (let i = 0; i < block.length; i++) {
      const char = block[i];
      if (char === "{") {
        if (depth === 0) ruleSelector = block.slice(selectorStart, i).trim();
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) {
          selectorStart = i + 1;
          if (ruleSelector && !ruleSelector.startsWith("@")) {
            for (const part of ruleSelector.split(",")) {
              const selector = part.trim();
              if (selector && !scopedSelector.test(selector)) {
                errors.push(`unscoped selector in ${where}: ${selector.slice(0, 80)}`);
              }
            }
          }
          ruleSelector = "";
        }
        if (depth < 0) {
          errors.push(`unbalanced braces in ${where}`);
          return;
        }
      }
    }
    if (depth !== 0) errors.push(`unbalanced braces in ${where}`);
  }

  // Split out @media blocks (validated recursively); any other at-rule is rejected.
  const mediaPattern = /@media[^{]+\{/gi;
  let rest = withoutComments;
  let mediaMatch: RegExpExecArray | null;
  const innerBlocks: string[] = [];
  // Collect top-level text by blanking @media blocks (brace-matched).
  let blanked = "";
  let cursor = 0;
  mediaPattern.lastIndex = 0;
  while ((mediaMatch = mediaPattern.exec(withoutComments)) !== null) {
    const open = mediaMatch.index + mediaMatch[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < withoutComments.length; i++) {
      if (withoutComments[i] === "{") depth++;
      else if (withoutComments[i] === "}") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) {
      errors.push("unbalanced braces in @media block");
      break;
    }
    blanked += withoutComments.slice(cursor, mediaMatch.index);
    innerBlocks.push(withoutComments.slice(open + 1, close));
    cursor = close + 1;
    mediaPattern.lastIndex = close + 1;
  }
  blanked += withoutComments.slice(cursor);
  rest = blanked;
  const otherAtRule = rest.match(/@[a-zA-Z-]+/);
  if (otherAtRule) errors.push(`at-rule not allowed: ${otherAtRule[0].slice(0, 40)}`);
  checkRules(rest, "top level");
  innerBlocks.forEach((inner, index) => checkRules(inner, `@media block ${index + 1}`));
  return errors;
}
