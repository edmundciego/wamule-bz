import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Prepare the stable current build directory without discarding prior output.
 * Non-empty builds move intact into a unique, private build-history directory.
 */
export function prepareBuildOutput(tenantDir, protectedSource = null, allowedRoot = dirname(resolve(tenantDir))) {
  const tenantPath = resolve(tenantDir);
  const tenantStat = lstatSync(tenantPath);
  if (tenantStat.isSymbolicLink() || !tenantStat.isDirectory()) {
    throw new Error("tenant package path must be a real directory, not a symlink");
  }
  const tenantReal = realpathSync(tenantPath);
  const allowedRootReal = realpathSync(resolve(allowedRoot));
  if (allowedRootReal === tenantReal || !isWithin(allowedRootReal, tenantReal)) {
    throw new Error("tenant package resolves outside or directly to its allowed root");
  }

  const outDir = join(tenantPath, "build");
  if (protectedSource) {
    const sourcePath = resolve(protectedSource);
    if (isWithin(outDir, sourcePath)) throw new Error("source must not be read from the build output directory");
    if (existsSync(outDir)) {
      const outStat = lstatSync(outDir);
      if (!outStat.isSymbolicLink() && outStat.isDirectory() && isWithin(realpathSync(outDir), realpathSync(sourcePath))) {
        throw new Error("source resolves into the build output directory");
      }
    }
  }

  let archivedPath = null;
  if (existsSync(outDir)) {
    const outStat = lstatSync(outDir);
    if (outStat.isSymbolicLink() || !outStat.isDirectory()) {
      throw new Error("build output path must be a real directory, not a symlink or file");
    }
    if (readdirSync(outDir).length > 0) {
      const historyDir = join(tenantPath, "build-history");
      if (existsSync(historyDir)) {
        const historyStat = lstatSync(historyDir);
        if (historyStat.isSymbolicLink() || !historyStat.isDirectory()) {
          throw new Error("build-history path must be a real directory, not a symlink or file");
        }
        const historyReal = realpathSync(historyDir);
        if (!isWithin(tenantReal, historyReal)) {
          throw new Error("build-history path resolves outside the tenant package");
        }
      } else {
        mkdirSync(historyDir);
      }
      archivedPath = join(historyDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
      renameSync(outDir, archivedPath);
    }
  }

  if (!existsSync(outDir)) mkdirSync(outDir);
  const outputReal = realpathSync(outDir);
  if (!isWithin(tenantReal, outputReal)) {
    throw new Error("build output resolves outside the tenant package");
  }
  return { outDir, archivedPath };
}
