import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

describe("Graphify documentation maps", () => {
  it("documents the Daily Brief Action Center across system, data, route, and workflow maps", () => {
    const files = [
      "graphify/wamule-system-map.md",
      "graphify/wamule-data-flow.md",
      "graphify/wamule-route-map.md",
      "graphify/wamule-workflow-map.md",
    ];

    for (const file of files) {
      const content = read(file);
      assert.match(content, /Action Center|brief_action_items/, `${file} should mention Action Center or brief_action_items`);
    }

    assert.match(read("graphify/wamule-data-flow.md"), /stable source_key/);
    assert.match(read("graphify/wamule-workflow-map.md"), /Done or Dismissed/);
  });

  it("documents Email Center and Resend notification boundaries", () => {
    const systemMap = read("graphify/wamule-system-map.md");
    const routeMap = read("graphify/wamule-route-map.md");
    const dataFlow = read("graphify/wamule-data-flow.md");
    const futureMap = read("graphify/wamule-future-portal-map.md");

    assert.match(routeMap, /\| `\/emails` \| `EmailsPage`/);
    assert.match(systemMap, /Email Center/);
    assert.match(dataFlow, /send-notification-email/);
    assert.match(dataFlow, /RESEND_API_KEY/);
    assert.match(futureMap, /manual send/);
    assert.match(futureMap, /Scheduled\/cron daily brief emails/);
  });

  it("documents Developer Feedback flow and queued email behavior", () => {
    const systemMap = read("graphify/wamule-system-map.md");
    const dataFlow = read("graphify/wamule-data-flow.md");
    const workflowMap = read("graphify/wamule-workflow-map.md");

    assert.match(systemMap, /Developer Feedback/);
    assert.match(dataFlow, /submit-developer-feedback/);
    assert.match(dataFlow, /developer_feedback/);
    assert.match(workflowMap, /not sent automatically/);
  });

  it("does not invent a hand-maintained graphify graph.json", () => {
    assert.equal(existsSync(join(root, "graphify/graph.json")), false);
  });
});
