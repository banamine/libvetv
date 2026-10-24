#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eligibility } from "./lib/eligibility.mjs";
import { isSafeManifestPath, resolveManifestUrl } from "../assets/manifest-path.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DUMMY_BASE = "https://example.invalid/libvetv/";
const CHANNEL_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const IMPORTS_SCRIPTS = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'][^"']*(?:\.\.\/)+scripts(?:\/|["'])/;

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function addedLinesFromDiff(diff) {
  return String(diff)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

export function checkAddedResourceOrigins(diffText, baseUrl = DUMMY_BASE) {
  const base = new URL(baseUrl);
  const addedText = addedLinesFromDiff(diffText).join("\n");
  const resourceTag = /<(script|link)\b[\s\S]*?>/gi;
  const sourceOrHref = /\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi;
  for (const tag of addedText.matchAll(resourceTag)) {
    for (const attribute of tag[0].matchAll(sourceOrHref)) {
      let resource;
      try {
        resource = new URL(attribute[2], base);
      } catch {
        throw new Error("new_resource_url_invalid");
      }
      if (resource.origin !== base.origin) throw new Error("new_resource_off_origin");
    }
  }
  return true;
}

export async function assertAssetsDoNotImportScripts(root) {
  const assetsRoot = resolve(root, "assets");
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && /\.(?:js|jsx|mjs|mts|cjs|cts|ts|tsx)$/i.test(entry.name)) {
        const source = await readFile(path, "utf8");
        if (IMPORTS_SCRIPTS.test(source)) throw new Error("assets_import_scripts");
      }
    }
  }
  await visit(assetsRoot);
  return true;
}

function validateManifest(manifest, row) {
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    manifest.channelId !== row.id ||
    !Array.isArray(manifest.items) ||
    manifest.items.length === 0
  ) {
    throw new Error("manifest_schema_invalid");
  }
  for (let index = 0; index < manifest.items.length; index += 1) {
    const item = manifest.items[index];
    if (
      !item ||
      item.seq !== index + 1 ||
      typeof item.localId !== "string" ||
      typeof item.title !== "string" ||
      !eligibility({
        url: item.url,
        durationSec: item.durationSec === null ? -1 : item.durationSec,
      }).ok
    ) {
      throw new Error("manifest_item_invalid");
    }
  }
}

export async function verifySite({
  root = REPO_ROOT,
  baseRef = "origin/main",
  resourceDiff,
} = {}) {
  const repoRoot = resolve(root);
  let diff = resourceDiff;
  if (diff === undefined) {
    if (!baseRef || baseRef.startsWith("-")) throw new Error("base_ref_invalid");
    try {
      git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], repoRoot);
    } catch {
      throw new Error(`base_ref_unavailable:${baseRef}`);
    }
    diff = git(["diff", "--unified=0", baseRef, "--", "index.html"], repoRoot).toString("utf8");
  }
  checkAddedResourceOrigins(diff, DUMMY_BASE);
  await assertAssetsDoNotImportScripts(repoRoot);

  const indexPath = resolve(repoRoot, "daily/latest/index.json");
  let indexText;
  try {
    indexText = await readFile(indexPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { published: false, checkedManifests: 0, message: "No daily/latest/index.json; valid (nothing has been published)." };
    }
    throw error;
  }

  let index;
  try {
    index = JSON.parse(indexText);
  } catch {
    throw new Error("index_json_invalid");
  }
  if (index?.schemaVersion !== 1 || !Array.isArray(index.channels) || index.channels.length === 0) {
    throw new Error("index_schema_invalid");
  }

  for (const row of index.channels) {
    if (
      !row ||
      typeof row.id !== "string" ||
      !CHANNEL_ID.test(row.id) ||
      !["ok", "no_playlist", "error"].includes(row.status)
    ) {
      throw new Error("index_channel_invalid");
    }
    if (row.manifest === null) {
      if (row.status === "ok") throw new Error("index_manifest_missing");
      continue;
    }
    if (!isSafeManifestPath(row.manifest, row.id)) throw new Error("manifest_path_invalid");
    const manifestUrl = resolveManifestUrl(row.manifest, row.id, DUMMY_BASE);
    if (new URL(manifestUrl).origin !== new URL(DUMMY_BASE).origin) {
      throw new Error("manifest_url_invalid");
    }
    const manifestPath = resolve(repoRoot, "daily", row.manifest);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("manifest_file_missing");
      throw new Error("manifest_json_invalid");
    }
    validateManifest(manifest, row);
  }

  return {
    published: true,
    checkedManifests: index.channels.filter((row) => row.manifest !== null).length,
    message: "PASS: index and referenced manifests validated.",
  };
}

async function main() {
  const result = await verifySite({ root: REPO_ROOT });
  console.log(result.message);
  if (result.published) console.log(`Checked manifests: ${result.checkedManifests}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error?.message || "";
    const safe = /^[a-z0-9_:-]+$/.test(message) ? message : "verify_site_failed";
    console.error(`FAIL: ${safe}`);
    process.exitCode = 1;
  });
}
