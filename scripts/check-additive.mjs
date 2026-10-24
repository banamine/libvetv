#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BEGIN = "<!-- DAILY-PLAYLIST:BEGIN -->";
const END = "<!-- DAILY-PLAYLIST:END -->";
const BLOCK = /^[\t ]*<!-- DAILY-PLAYLIST:BEGIN -->\r?\n[\s\S]*?^[\t ]*<!-- DAILY-PLAYLIST:END -->(?:\r?\n|$)/gm;

export function checkAdditive({ baseBytes, currentBytes, numstat }) {
  const columns = String(numstat).trim().split("\t");
  const deleted = columns.length >= 2 && columns[0] !== ""
    ? Number(columns[1])
    : 0;
  if (!Number.isSafeInteger(deleted) || deleted !== 0) {
    throw new Error("index_html_deletions_detected");
  }

  const baseText = Buffer.from(baseBytes).toString("utf8");
  const currentText = Buffer.from(currentBytes).toString("utf8");
  const starts = currentText.split(BEGIN).length - 1;
  const ends = currentText.split(END).length - 1;
  const blocks = [...currentText.matchAll(BLOCK)];
  if (starts !== ends || starts !== blocks.length || blocks.length > 3) {
    throw new Error("marker_blocks_invalid");
  }

  const stripped = currentText.replace(BLOCK, "");
  if (stripped.includes(BEGIN) || stripped.includes(END)) {
    throw new Error("marker_blocks_unmatched");
  }
  // After the feature merges, origin/main contains the same marker blocks.
  // Compare the preserved page on both sides, not feature markup to stripped markup.
  const baseHash = createHash("sha256").update(baseText.replace(BLOCK, ""), "utf8").digest("hex");
  const strippedHash = createHash("sha256").update(stripped, "utf8").digest("hex");
  if (baseHash !== strippedHash) throw new Error("index_html_base_mismatch");
  return { deletedLines: deleted, markerBlocks: blocks.length, baseHash };
}

function parseArgs(argv) {
  if (argv.length === 0) return "origin/main";
  if (argv.length !== 2 || argv[0] !== "--base" || argv[1].startsWith("-")) {
    throw new TypeError("usage: node scripts/check-additive.mjs [--base <ref>]");
  }
  return argv[1];
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: null, stdio: ["ignore", "pipe", "pipe"] });
}

async function main() {
  const baseRef = parseArgs(process.argv.slice(2));
  try {
    git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  } catch {
    throw new Error(`base_ref_unavailable:${baseRef}`);
  }
  const numstat = git(["diff", "--numstat", baseRef, "--", "index.html"]).toString("utf8");
  const baseBytes = git(["show", `${baseRef}:index.html`]);
  const currentBytes = await readFile(resolve(REPO_ROOT, "index.html"));
  const result = checkAdditive({ baseBytes, currentBytes, numstat });
  const displayedNumstat = numstat.trim()
    ? numstat.trim().split("\t").join(" | ")
    : "(no change)";
  console.log(`git diff --numstat ${baseRef} -- index.html: ${displayedNumstat}`);
  console.log(`PASS: zero deleted lines; stripped ${result.markerBlocks} marker blocks match ${baseRef}:index.html SHA-256 ${result.baseHash}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error?.message || "";
    const safe = /^[a-z0-9_:-]+$/.test(message) ? message : "check_additive_failed";
    console.error(`FAIL: ${safe}`);
    process.exitCode = 1;
  });
}
