import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const parity = path.join(root, "homepage-parity");
const data = path.join(parity, "staging-data");
const acceptedBuild = path.join(root, "wamule-homepage-ci", "dist");
const branchBuild = path.join(root, "wamule-homepage-layout-refactor", "dist");
const playwright = path.join(root, "wamule-homepage-layout-refactor", "node_modules", "playwright", "index.mjs");
const { chromium } = await import(pathToFileURL(playwright).href);
const staging = new URL("https://wamule-staging.netlify.app");
const ceiba = new URL("https://ceiba-test.wamuledevelopment.com");
const variants = [
  { slug: "wamule", screen: "desktop", width: 1363, height: 936 },
  { slug: "wamule", screen: "phone-width", width: 337, height: 234 },
  { slug: "hopkins-grove", screen: "desktop", width: 1348, height: 936 },
  { slug: "hopkins-grove", screen: "phone-width", width: 337, height: 234 },
  { slug: "wamule", screen: "desktop", width: 1363, height: 936, keepLogo: true },
  { slug: "wamule", screen: "phone-width", width: 337, height: 234, keepLogo: true },
];

async function load(name) {
  return JSON.parse(await fs.readFile(path.join(data, name), "utf8"));
}

const experiences = { wamule: await load("wamule-experience.json"), "hopkins-grove": await load("hopkins-grove-experience.json") };
const lotsByScope = { wamule: await load("wamule-lots.json"), "hopkins-grove": await load("hopkins-grove-lots.json") };
const binding = await load("hopkins-grove-host-binding.json");
const assets = await load("assets/manifest.json");
const captured = path.join(parity, "captures");
await fs.mkdir(captured, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.WAMULE_RENDER_BROWSER ?? "/usr/bin/chromium", args: ["--no-sandbox", "--hide-scrollbars"] });

const contentType = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

async function capture(variant, build, label) {
  const { slug, screen, width, height, keepLogo } = variant;
  const trip = slug === "wamule" ? staging.origin + "/p/wamule/wamule?phase=default" : ceiba.origin + "/hopkins?phase=initial";
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, locale: "en-US" });
  const diag = { unexpected: [], errors: [] };
  page.on("pageerror", (error) => diag.errors.push(error.message));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (assets[url.toString()]) {
      const { file, contentType } = assets[url.toString()];
      return route.fulfill({ path: path.join(data, "assets", file), contentType, headers: cors });
    }
    if (url.hostname === "kvocwmrcuhiaezlcgzjf.supabase.co") {
      if (url.pathname.endsWith("/resolve_public_hostname")) {
        if (req.postDataJSON().p_hostname !== ceiba.hostname) {
          diag.unexpected.push("Hostname lookup outside Hopkins fixture");
          return route.fulfill({ status: 404, headers: cors });
        }
        return route.fulfill({ json: binding, headers: cors });
      }
      if (url.pathname.endsWith("/get-public-site-experience")) {
        const experience = structuredClone(experiences[slug]);
        if (slug === "wamule" && !keepLogo) experience.company.logo_url = "";
        return route.fulfill({ json: experience, headers: cors });
      }
      if (url.pathname.endsWith("/get-public-lots")) {
        const lots = lotsByScope[slug];
        return route.fulfill({ status: lots.fetchStatus ?? 200, json: lots.body ?? lots, headers: cors });
      }
    }
    if (url.origin === staging.origin || url.origin === ceiba.origin) {
      if (req.resourceType() === "document") return route.fulfill({ path: path.join(build, "index.html"), contentType: "text/html" });
      const file = path.resolve(build, "." + url.pathname);
      if (file.startsWith(build + path.sep)) {
        const found = await fs.stat(file).catch(() => null);
        if (found?.isFile()) return route.fulfill({ path: file, contentType: contentType[path.extname(file)] });
      }
    }
    diag.unexpected.push([req.method(), url.origin + url.pathname].join(" "));
    return route.fulfill({ status: 404, headers: cors });
  });

  try {
    await page.goto(trip, { waitUntil: "domcontentloaded" });
    await page.locator("#home").waitFor({ timeout: 15000 });
    await page.getByRole("heading", { name: "Request project information" }).waitFor();
    if (slug === "hopkins-grove") await page.getByRole("heading", { name: "Explore the project map" }).waitFor();
    await page.waitForLoadState("networkidle");
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.allSettled(Array.from(document.images, (image) => image.decode()));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const probe = await page.evaluate(() => {
      const one = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const { x, y, width, height } = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return { x, y, width, height, color: style.color, background: style.backgroundColor, border: style.borderColor, gradient: style.backgroundImage };
      };
      return {
        layout: document.querySelector("#home")?.dataset.siteTemplate,
        title: document.querySelector("h1")?.textContent,
        logo: Boolean(document.querySelector("header img")?.naturalWidth),
        scrollHeight: document.documentElement.scrollHeight,
        header: one("header"),
        titleStyle: one("h1"),
        hero: one("section[aria-labelledby='project-title']"),
        map: one("#map"),
        inquiry: one("#request-info"),
        footer: one("footer"),
      };
    });
    const fname = [slug, screen, ...(keepLogo ? ["current-logo"] : []), label].join("-") + ".png";
    await page.screenshot({ path: path.join(captured, fname), fullPage: true, animations: "disabled" });

    if (slug === "hopkins-grove" && label === "refactor" && !process.env.WAMULE_PARITY_ONLY) {
      const plot = lotsByScope[slug].features.find((feature) => feature.source_printed_lot_number_candidate === "559"
        && feature.source_printed_lot_number_status === "source-image-cross-checked");
      if (!plot) throw Error("Plot 559 missing from published map fixture");
      const map = page.locator("#map");
      await map.getByRole("textbox", { name: "Search source number candidates or generated map references" }).fill("559");
      await map.getByRole("button", { name: new RegExp("Select generated map reference " + plot.demo_label) }).click();
      const details = map.getByRole("complementary", { name: "Map details and source price guide" });
      if (!(await details.getByText(/BZD 30,000\s*·\s*per 1\/4 acre/i).last().isVisible())) {
        throw Error("Expected reference price missing from Plot 559 map details");
      }
      await map.getByRole("button", { name: "Apply with this plot" }).click();
      await page.waitForURL((url) => url.pathname === "/apply" && url.searchParams.get("apply_feature") === plot.map_feature_ref);
      const selected = page.getByRole("status", { name: "Selected map outlines" });
      await selected.getByText(/BZD 30,000\s*·\s*per 1\/4 acre/i).waitFor();
      probe.plot559Passed = true;
    }
    if (diag.errors.length || diag.unexpected.length) throw Error(JSON.stringify(diag));
    await fs.writeFile(path.join(captured, fname.replace(".png", ".json")), JSON.stringify(probe, null, 2));
    return { file: fname, layout: probe.layout, height: probe.scrollHeight, logo: probe.logo, plot559Passed: probe.plot559Passed };
  } finally {
    await page.close();
  }
}

try {
  for (const variant of variants) {
    const results = [];
    for (const [label, build] of [["accepted", acceptedBuild], ["refactor", branchBuild]]) {
      results.push(await capture(variant, build, label));
    }
    console.log(JSON.stringify(results));
  }
} finally {
  await browser.close();
}

