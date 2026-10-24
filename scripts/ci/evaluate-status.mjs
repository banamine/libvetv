import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

export function evaluateStatus(input) {
  const { eventName, ref, publishEnabled, generateResult, exitCode, changed, publishResult, deployResult } = input;
  const dryRun = input.dryRun === true || input.dryRun === "true";
  const gated = input.gated === true || input.gated === "true";
  const fail = (reason) => ({ ok: false, reason });
  if (["failure", "cancelled"].includes(generateResult)) return fail(`generate_${generateResult}`);
  const active = ref === "refs/heads/main" && publishEnabled === "true" &&
    (eventName === "schedule" || (eventName === "workflow_dispatch" && !dryRun));
  if (active && !input.baseUrlPresent) return fail("base_url_missing");
  if (generateResult !== "success") return fail("generate_skipped_unexpected");
  const gateExpected = (eventName === "schedule" && publishEnabled !== "true") || !input.baseUrlPresent;
  if (gated !== gateExpected) return fail("gate_unexpected");
  if (!gated && !["0", "3"].includes(String(exitCode))) return fail("generator_exit_invalid");
  if (!gated && !["true", "false"].includes(String(changed))) return fail("changed_output_missing");
  const publishingExpected = active && !gated && String(changed) === "true";
  if (publishingExpected) {
    if (publishResult !== "success") return fail(`publish_${publishResult || "missing"}`);
    if (deployResult !== "success") return fail(`deploy_${deployResult || "missing"}`);
  } else {
    if (publishResult !== "skipped") return fail("publish_unexpected");
    if (deployResult !== "skipped") return fail("deploy_unexpected");
  }
  if (String(exitCode) === "3" && !gated) return fail("partial_channel_failure");
  return { ok: true, reason: gated ? "gated" : publishingExpected ? "published" : "publication_not_required" };
}

async function fileSizes(root) {
  const result = new Map();
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.set(relative(root, path), (await stat(path)).size);
    }
  }
  await visit(root);
  return result;
}

export async function statusSummary(root, decision) {
  const baseline = await fileSizes(resolve(root, "daily"));
  for (const [key, value] of await fileSizes(resolve(root, ".tmp/out/daily"))) baseline.set(key, value);
  let index;
  for (const path of [".tmp/out/daily/latest/index.json", "daily/latest/index.json"]) {
    try { index = JSON.parse(await readFile(resolve(root, path), "utf8")); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const safe = (value) => /^[a-z0-9_-]{1,128}$/.test(value || "") ? value : "invalid";
  const lines = [
    `Decision: ${decision.ok ? "PASS" : "FAIL"} (${decision.reason})`,
    `daily/ total size in bytes: ${[...baseline.values()].reduce((a, b) => a + b, 0)}`,
    "", "| Channel | Status | Reason code |", "| --- | --- | --- |",
  ];
  for (const row of index?.channels || []) {
    lines.push(`| ${safe(row.id)} | ${safe(row.status)} | ${row.reason == null ? "none" : safe(row.reason)} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const env = process.env;
  const decision = evaluateStatus({
    eventName: env.EVENT_NAME, ref: env.RUN_REF, publishEnabled: env.PUBLISH_ENABLED,
    dryRun: env.DRY_RUN, baseUrlPresent: env.BASE_URL_PRESENT === "true",
    generateResult: env.GENERATE_RESULT, gated: env.GATED, exitCode: env.EXIT_CODE,
    changed: env.CHANGED, publishResult: env.PUBLISH_RESULT, deployResult: env.DEPLOY_RESULT,
  });
  const summary = await statusSummary(process.cwd(), decision);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  if (!decision.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("status_evaluation_failed"); process.exitCode = 1; });
}
