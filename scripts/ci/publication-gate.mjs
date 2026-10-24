import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function publicationGate({ eventName, publishEnabled, dryRun, baseUrlPresent }) {
  const effectiveDryRun = dryRun === true || dryRun === "true" || publishEnabled !== "true";
  if (eventName === "schedule" && publishEnabled !== "true") {
    return { gated: true, effectiveDryRun, reason: "publishing_disabled" };
  }
  if (!baseUrlPresent) return { gated: true, effectiveDryRun, reason: "base_url_missing" };
  return { gated: false, effectiveDryRun, reason: "allowed" };
}

async function main() {
  const result = publicationGate({
    eventName: process.env.EVENT_NAME,
    publishEnabled: process.env.PUBLISH_ENABLED,
    dryRun: process.env.DRY_RUN,
    baseUrlPresent: Boolean(process.env.AJN_EXPORT_BASE_URL?.trim()),
  });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT,
      `gated=${result.gated}\neffective_dry_run=${result.effectiveDryRun}\n`);
  }
  console.log(`::notice::gate=${result.reason} dry_run=${result.effectiveDryRun}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("gate_failed"); process.exitCode = 1; });
}
