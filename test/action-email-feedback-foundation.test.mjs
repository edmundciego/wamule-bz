import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function listFiles(path) {
  const base = join(root, path);
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    // Node 18 exposes the containing path as `path`; newer Node versions use
    // `parentPath`. Support both so the security check runs in CI and locally.
    .map((entry) => join(entry.parentPath ?? entry.path ?? base, entry.name));
}

function readAbsolute(path) {
  return readFileSync(path, "utf8");
}

describe("Action, email, and feedback foundation", () => {
  const migration = read("supabase/migrations/20260617000100_action_email_feedback_foundation.sql");

  it("creates the expected foundation tables and constraints", () => {
    for (const table of ["brief_action_items", "email_notifications", "notification_settings", "developer_feedback"]) {
      assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
      assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    }

    assert.match(migration, /status in \('Open', 'In Progress', 'Done', 'Dismissed'\)/);
    assert.match(migration, /status in \('Pending', 'Sent', 'Failed', 'Cancelled'\)/);
    assert.match(migration, /feedback_type in \('Bug', 'Question', 'Feature Request', 'Data Issue', 'Other'\)/);
    assert.match(migration, /uniq_open_brief_action_items_source_key/);
  });

  it("keeps action item mutations scoped to action tracking", () => {
    const dailyBriefFunction = read("supabase/functions/generate-daily-brief/index.ts");

    assert.match(dailyBriefFunction, /syncBriefActionItems/);
    assert.match(dailyBriefFunction, /\.from\("brief_action_items"\)/);
    assert.match(dailyBriefFunction, /source_key/);
    assert.match(dailyBriefFunction, /last_seen_on/);
  });

  it("keeps Resend secrets server-side only", () => {
    const senderFunction = read("supabase/functions/send-notification-email/index.ts");
    const sourceFiles = listFiles("src")
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => readAbsolute(path))
      .join("\n");

    assert.match(senderFunction, /Deno\.env\.get\("RESEND_API_KEY"\)/);
    assert.match(senderFunction, /Deno\.env\.get\("EMAIL_FROM_ADDRESS"\)/);
    assert.match(senderFunction, /https:\/\/api\.resend\.com\/emails/);
    assert.match(senderFunction, /html: renderEmailHtml/);
    assert.match(senderFunction, /\.from\("business_settings"\)/);
    assert.match(senderFunction, /logoUrl/);
    assert.doesNotMatch(sourceFiles, /RESEND_API_KEY/);
  });

  it("queues developer feedback notifications without sending automatically", () => {
    const feedbackFunction = read("supabase/functions/submit-developer-feedback/index.ts");

    assert.match(feedbackFunction, /\.from\("developer_feedback"\)/);
    assert.match(feedbackFunction, /\.from\("email_notifications"\)/);
    assert.match(feedbackFunction, /DEVELOPER_FEEDBACK_EMAIL/);
    assert.match(feedbackFunction, /status: "Pending"/);
    assert.doesNotMatch(feedbackFunction, /api\.resend\.com\/emails/);
  });
});
