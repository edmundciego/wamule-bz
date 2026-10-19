import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = fileURLToPath(new URL(".", import.meta.url));
const repo = resolve(root, "../..");
const run = promisify(execFile);
function localExtractor(): Plugin {
  return {
    name: "map-studio-local-extractor",
    configureServer(server) {
      server.middlewares.use("/api/extract", async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        const origin = req.headers.origin;
        // Bind only to loopback; refuse cross-origin requests to this local worker.
        if (
          req.method !== "POST" ||
          (origin && origin !== `http://${req.headers.host}`)
        ) {
          res.statusCode = 403;
          res.end(
            JSON.stringify({ error: "Use Map Studio on this computer." }),
          );
          return;
        }
        let directory: string | null = null;
        try {
          const chunks: Buffer[] = [];
          let length = 0;
          for await (const chunk of req) {
            length += chunk.length;
            if (length > 34 * 1024 * 1024)
              throw new Error("Source is too large; use a file under 24 MB.");
            chunks.push(Buffer.from(chunk));
          }
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (
            typeof body.name !== "string" ||
            !/\.(dxf|pdf|png|jpe?g|webp|dwg)$/i.test(body.name) ||
            typeof body.data_base64 !== "string"
          )
            throw new Error("Choose a supported drawing or image.");
          const bytes = Buffer.from(body.data_base64, "base64");
          if (bytes.length > 24 * 1024 * 1024 || !bytes.length)
            throw new Error("Source must be 1 byte–24 MB.");
          directory = await mkdtemp(join(tmpdir(), "wamule-map-studio-"));
          const source = join(
            directory,
            "source" +
              body.name.slice(body.name.lastIndexOf(".")).toLowerCase(),
          );
          await writeFile(source, bytes, { mode: 0o600 });
          const options =
            body.options && typeof body.options === "object"
              ? body.options
              : {};
          const { stdout } = await run(
            "python3",
            [
              join(repo, "scripts/map-studio/extract.py"),
              "--source",
              source,
              "--name",
              body.name.replace(/[\\/]/g, "_"),
              "--options",
              JSON.stringify(options),
            ],
            { timeout: 100_000, maxBuffer: 30 * 1024 * 1024 },
          );
          res.end(stdout);
        } catch (error) {
          res.statusCode = 400;
          let message =
            error instanceof Error ? error.message : "Extraction failed.";
          if (error && typeof error === "object" && "stdout" in error) {
            try {
              message = JSON.parse(String(error.stdout)).error || message;
            } catch {
              message =
                "The extraction worker failed. Check the Python dependencies.";
            }
          }
          res.end(JSON.stringify({ error: message }));
        } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      });
    },
  };
}
export default defineConfig({
  root,
  envDir: false,
  envPrefix: "STUDIO_PUBLIC_",
  plugins: [react(), localExtractor()],
  server: {
    host: "127.0.0.1",
    port: 5340,
    strictPort: true,
    fs: { allow: [repo] },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
