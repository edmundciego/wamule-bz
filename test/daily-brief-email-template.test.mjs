import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("brief template uses email-safe table layout and inline styles", async () => {
  const template = await read("supabase/functions/_shared/daily-brief-template.ts");
  assert.match(template, /<table role="presentation"/);
  assert.match(template, /max-width:600px/);
  assert.match(template, /background:#f8fafc/);
  assert.match(template, /-apple-system, BlinkMacSystemFont/);
  assert.doesNotMatch(template, /display:\s*flex/);
  assert.doesNotMatch(template, /display:\s*grid/);
  assert.match(template, /export function renderDailyBriefHtml/);
  assert.match(template, /escapeBriefHtml/);
});

test("brief template renders branded forest-green header", async () => {
  const template = await read("supabase/functions/_shared/daily-brief-template.ts");
  assert.match(template, /background:#166534/);
  assert.match(template, /padding:24px/);
  assert.match(template, /WAMULE DEVELOPMENT/);
  assert.match(template, /letter-spacing:1px/);
  assert.match(template, /Daily Operations Brief/);
  assert.match(template, /font-size:22px/);
  assert.match(template, /font-size:12px/);
});

test("brief template renders the six-metric card grid", async () => {
  const template = await read("supabase/functions/_shared/daily-brief-template.ts");
  for (const label of [
    "New Applications / Leads",
    "Payments Logged ($)",
    "New Contracts",
    "Open Action Items",
    "Resolved Items",
    "Outstanding Balance ($)",
  ]) {
    assert.ok(template.includes(label), `metric card present: ${label}`);
  }
  assert.match(template, /background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:12px 16px/);
  assert.match(template, /color:#64748b/);
  assert.match(template, /font-size:20px/);
  assert.match(template, /color:#0f172a/);
});

test("brief template covers summary, priorities, activity, and collections", async () => {
  const template = await read("supabase/functions/_shared/daily-brief-template.ts");
  assert.match(template, /Executive Summary/);
  assert.match(template, /background:#f1f5f9/);
  assert.match(template, /color:#334155/);
  assert.match(template, /Today's Priorities/);
  assert.match(template, /No open priorities need attention right now/);
  assert.match(template, /background:#f0fdf4; border:1px solid #bbf7d0/);
  assert.match(template, /border-left:4px solid/);
  assert.match(template, /#ef4444/);
  assert.match(template, /Activity Breakdown/);
  assert.match(template, /Outstanding Collections & Balances/);
});

test("brief template ends with dashboard CTA and Belize footer", async () => {
  const template = await read("supabase/functions/_shared/daily-brief-template.ts");
  assert.match(template, /Open CRM Dashboard/);
  assert.match(template, /dashboardUrl/);
  assert.match(template, /border-radius:6px/);
  assert.match(template, /Mile 3, Hummingbird Highway, Dangriga Town, Belize/);
  assert.match(template, /Automated system email sent by/);
  assert.match(template, /color:#94a3b8/);
});

test("dispatcher renders the styled brief for Daily Brief notifications", async () => {
  const dispatcher = await read("supabase/functions/send-notification-email/index.ts");
  assert.match(dispatcher, /daily-brief-template/);
  assert.match(dispatcher, /renderDailyBriefHtml/);
  assert.match(dispatcher, /notification_type === "Daily Brief"/);
  assert.match(dispatcher, /related_table.*ai_daily_briefs|ai_daily_briefs.*related_table/s);
  assert.match(dispatcher, /from\("ai_daily_briefs"\)/);
  assert.match(dispatcher, /from\("brief_action_items"\)/);
  // Generic wrapper remains the fallback for every other type and on failure.
  assert.match(dispatcher, /renderEmailHtml\(email, config\.branding\)/);
  assert.match(dispatcher, /\/briefs/);
});
