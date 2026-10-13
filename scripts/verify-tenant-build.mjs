#!/usr/bin/env node
import { verifyTenantBuild } from "./tenant-build-evidence.mjs";

function usage() {
  return "Usage: node scripts/verify-tenant-build.mjs --slug <tenant-slug>";
}

function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--slug") {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  try {
    const result = verifyTenantBuild({ repositoryRoot: process.cwd(), slug: argv[1] });
    console.log(`[tenant:verify] manifest: ${result.manifestPath}`);
    console.log(`[tenant:verify] inputs verified: ${result.inputsVerified}`);
    console.log(`[tenant:verify] review evidence verified: ${result.evidenceVerified}`);
    console.log(`[tenant:verify] outputs verified: ${result.outputsVerified}`);
    for (const input of result.unverifiableInputs) {
      console.error(`[tenant:verify] unverifiable ${input.kind} (${input.path_scope}): ${input.role} ${input.path ?? ""}`);
    }
    for (const issue of result.issues) console.error(`[tenant:verify] ${issue}`);
    if (!result.ok) {
      console.error("[tenant:verify] NOT VERIFIED");
      process.exitCode = 1;
      return;
    }
    console.log("[tenant:verify] PASS: required input and output hashes match the completed manifest");
  } catch (error) {
    console.error(`[tenant:verify] error: ${error.message}`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
