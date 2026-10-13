import { statfsSync } from "node:fs";
import { tmpdir } from "node:os";

export const DEFAULT_MIN_FREE_BYTES = 1024n * 1024n * 1024n;

export function parseMinimumFreeBytes(value, fallback = DEFAULT_MIN_FREE_BYTES) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(String(value))) {
    throw new Error("WAMULE_BUILD_MIN_FREE_BYTES must be a non-negative integer byte count");
  }
  return BigInt(value);
}

function availableBytes(path, statfs) {
  const stats = statfs(path, { bigint: true });
  return BigInt(stats.bavail) * BigInt(stats.bsize);
}

/** Check output and temporary filesystems before a build archives prior output. */
export function checkBuildCapacity({
  outputPath,
  temporaryPath = tmpdir(),
  minimumFreeBytes = DEFAULT_MIN_FREE_BYTES,
  statfs = statfsSync,
}) {
  const required = BigInt(minimumFreeBytes);
  const checks = [
    { label: "build output", path: outputPath },
    { label: "temporary files", path: temporaryPath },
  ].map(({ label, path }) => {
    let available;
    try {
      available = availableBytes(path, statfs);
    } catch (error) {
      throw new Error(`could not inspect ${label} filesystem at ${path}: ${error.message}`);
    }
    return { label, path, availableBytes: available, requiredBytes: required };
  });

  const insufficient = checks.filter(({ availableBytes }) => availableBytes < required);
  if (insufficient.length) {
    const details = insufficient
      .map(({ label, path, availableBytes }) => `${label} (${path}) has ${availableBytes} bytes free`)
      .join("; ");
    throw new Error(
      `${details}; at least ${required} bytes of free space is required on each filesystem. ` +
      "Free space or set WAMULE_BUILD_MIN_FREE_BYTES to an explicit lower byte-count threshold.",
    );
  }
  return checks;
}
