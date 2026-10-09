/**
 * Tenant theming contract (single source of truth).
 *
 * Used by the web app (PublicLotMap applies tokens as CSS variables + card
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

const TOKEN_KEYS = ["primary", "background", "card", "accent", "text", "muted"] as const;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

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
  };
  const out: LotMapTheme = {
    tokens: {
      primary: cleanHex(tokens.primary, base.primary),
      background: cleanHex(tokens.background, base.background),
      card: cleanHex(tokens.card, base.card),
      accent: cleanHex(tokens.accent, base.accent),
      text: cleanHex(tokens.text, base.text),
      muted: cleanHex(tokens.muted, base.muted),
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
  for (const key of TOKEN_KEYS) {
    vars[`--lotmap-${key}`] = theme.tokens[key];
  }
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
