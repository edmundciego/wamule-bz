import assert from "node:assert/strict";
import test from "node:test";
import {
  checkBuildCapacity,
  DEFAULT_MIN_FREE_BYTES,
  parseMinimumFreeBytes,
} from "../scripts/tenant-build-capacity.mjs";

function fakeStatfs(freeByPath) {
  return (path) => ({ bavail: BigInt(freeByPath[path]), bsize: 1n });
}

test("capacity preflight accepts output and temporary filesystems above the floor", () => {
  const checks = checkBuildCapacity({
    outputPath: "/build",
    temporaryPath: "/tmp",
    minimumFreeBytes: 100n,
    statfs: fakeStatfs({ "/build": 101, "/tmp": 200 }),
  });
  assert.equal(checks.length, 2);
});

test("capacity preflight refuses to start when either filesystem is below the floor", () => {
  assert.throws(() => checkBuildCapacity({
    outputPath: "/build",
    temporaryPath: "/tmp",
    minimumFreeBytes: 100n,
    statfs: fakeStatfs({ "/build": 100, "/tmp": 99 }),
  }), /temporary files .*99 bytes free.*at least 100 bytes/);
});

test("minimum free-space override accepts only non-negative integer bytes", () => {
  assert.equal(parseMinimumFreeBytes(undefined), DEFAULT_MIN_FREE_BYTES);
  assert.equal(parseMinimumFreeBytes("0"), 0n);
  assert.equal(parseMinimumFreeBytes("2048"), 2048n);
  assert.throws(() => parseMinimumFreeBytes("1 GiB"), /non-negative integer byte count/);
  assert.throws(() => parseMinimumFreeBytes("-1"), /non-negative integer byte count/);
});
