#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_REGISTRY_PREFIX = "https://registry.npmjs.org/";

export function assertPublicRegistryLockfile(lockfile) {
  if (!lockfile || typeof lockfile !== "object" || !lockfile.packages || typeof lockfile.packages !== "object") {
    throw new Error("lockfile_packages_invalid");
  }
  for (const entry of Object.values(lockfile.packages)) {
    if (
      entry &&
      Object.hasOwn(entry, "resolved") &&
      (typeof entry.resolved !== "string" || !entry.resolved.startsWith(PUBLIC_REGISTRY_PREFIX))
    ) {
      throw new Error("lockfile_resolved_url_invalid");
    }
  }
  return true;
}

export async function checkLockfile(lockfilePath = resolve(REPO_ROOT, "package-lock.json")) {
  let lockfile;
  try {
    lockfile = JSON.parse(await readFile(lockfilePath, "utf8"));
  } catch {
    throw new Error("lockfile_json_invalid");
  }
  return assertPublicRegistryLockfile(lockfile);
}

async function main() {
  await checkLockfile();
  console.log("PASS: all lockfile resolved URLs use https://registry.npmjs.org/.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error?.message || "";
    const safe = /^[a-z0-9_:-]+$/.test(message) ? message : "lockfile_check_failed";
    console.error(`FAIL: ${safe}`);
    process.exitCode = 1;
  });
}
