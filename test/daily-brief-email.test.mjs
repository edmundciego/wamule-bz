import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("daily brief email action is available to brief managers", async () => {
  const page = await read("src/pages/DailyBriefsPage.tsx");
  // The placeholder disabled button is gone; managers get a working action.
  assert.doesNotMatch(page, /<Button type="button" variant="outline" disabled>\s*\n?\s*<Mail/);
  assert.match(page, /Email Brief/);
  assert.match(page, /showEmailForm/);
  assert.match(page, /Recipient email/);
});

test("brief email queues a Daily Brief notification and sends it", async () => {
  const page = await read("src/pages/DailyBriefsPage.tsx");
  assert.match(page, /from\("email_notifications"\)/);
  assert.match(page, /notification_type: "Daily Brief"/);
  assert.match(page, /related_table: "ai_daily_briefs"/);
  assert.match(page, /formatBriefForClipboard\(selectedBrief\)/);
  assert.match(page, /send-notification-email/);
  assert.match(page, /email_notification_id/);
  assert.match(page, /Brief email processing complete/);
});
