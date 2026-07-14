import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const scanRoots = ["src", "public", "index.html", "package.json", "supabase/functions"];
const banned = [/wamuale/gi, /womola/gi, /wamule development platform/gi, /wamule development crm/gi];
const textExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".html", ".json", ".md", ".txt"]);

async function files(path) {
  const absolute = join(root, path);
  const stat = await import("node:fs/promises").then(({ stat }) => stat(absolute));
  if (stat.isFile()) return [absolute];
  const entries = await readdir(absolute, { withFileTypes: true });
  return (await Promise.all(entries.filter((entry) => entry.name !== "node_modules").map((entry) => files(join(path, entry.name))))).flat();
}

const matches = [];
for (const target of scanRoots) {
  for (const file of await files(target)) {
    if (!textExtensions.has(file.slice(file.lastIndexOf(".")))) continue;
    const content = await readFile(file, "utf8");
    for (const pattern of banned) {
      for (const match of content.matchAll(pattern)) {
        const line = content.slice(0, match.index).split("\n").length;
        matches.push(`${relative(root, file)}:${line}: ${match[0]}`);
      }
    }
  }
}
if (matches.length) {
  console.error("Brand regression check failed. Legacy user-facing names are not allowed:\n" + matches.join("\n"));
  process.exit(1);
}
console.log("Brand regression check passed.");
