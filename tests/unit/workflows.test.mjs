import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import "./network-guard.mjs";
import { publicationGate } from "../../scripts/ci/publication-gate.mjs";
import { evaluateStatus, statusSummary } from "../../scripts/ci/evaluate-status.mjs";
import { validateChangedPaths, stageChanges } from "../../scripts/ci/publish.mjs";
import { smokePages } from "../../scripts/ci/smoke-pages.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const publishing = {
  eventName: "schedule", ref: "refs/heads/main", publishEnabled: "true",
  dryRun: false, baseUrlPresent: true, generateResult: "success", gated: "false",
  exitCode: "0", changed: "true", artifactResult: "success", publishResult: "success", deployResult: "success",
};

const statusCases = [
  ["disabled schedule", { publishEnabled: "", gated: "true", exitCode: "", changed: "", artifactResult: "skipped", publishResult: "skipped", deployResult: "skipped" }, true, "gated"],
  ["dry run changes", { eventName: "workflow_dispatch", dryRun: true, publishResult: "skipped", deployResult: "skipped" }, true, "publication_not_required"],
  ["publish and deploy success", {}, true, "published"],
  ["unexpected publish skip", { publishResult: "skipped" }, false, "publish_skipped"],
  ["unexpected deploy skip", { deployResult: "skipped" }, false, "deploy_skipped"],
  ["publish failure", { publishResult: "failure" }, false, "publish_failure"],
  ["deploy cancellation", { deployResult: "cancelled" }, false, "deploy_cancelled"],
  ["unchanged", { changed: "false", publishResult: "skipped", deployResult: "skipped" }, true, "publication_not_required"],
  ["partial published", { exitCode: "3" }, false, "partial_channel_failure"],
  ["partial dry run", { eventName: "workflow_dispatch", dryRun: true, exitCode: "3", publishResult: "skipped", deployResult: "skipped" }, false, "partial_channel_failure"],
  ["publishing missing URL", { baseUrlPresent: false, gated: "true", publishResult: "skipped", deployResult: "skipped" }, false, "base_url_missing"],
  ["generate failure", { generateResult: "failure" }, false, "generate_failure"],
  ["generate cancelled", { generateResult: "cancelled" }, false, "generate_cancelled"],
  ["unexpected generate skip", { generateResult: "skipped" }, false, "generate_skipped_unexpected"],
  ["unexpected gate", { gated: "true" }, false, "gate_unexpected"],
  ["missing exit code", { exitCode: "" }, false, "generator_exit_invalid"],
  ["missing changed output", { changed: "" }, false, "changed_output_missing"],
  ["artifact download failure", { artifactResult: "failure", publishResult: "skipped", deployResult: "skipped" }, false, "artifact_failure"],
  ["branch manual run cannot publish", { eventName: "workflow_dispatch", ref: "refs/heads/build/demo", publishResult: "skipped", deployResult: "skipped" }, true, "publication_not_required"],
  ["disabled manual run is dry", { eventName: "workflow_dispatch", publishEnabled: "", publishResult: "skipped", deployResult: "skipped" }, true, "publication_not_required"],
  ["unexpected publish in dry run", { eventName: "workflow_dispatch", dryRun: true }, false, "publish_unexpected"],
  ["dry missing URL is deliberate gate", { eventName: "workflow_dispatch", dryRun: true, baseUrlPresent: false, gated: "true", exitCode: "", changed: "", artifactResult: "skipped", publishResult: "skipped", deployResult: "skipped" }, true, "gated"],
];
for (const [name, overrides, ok, reason] of statusCases) {
  test(`workflow status: ${name}`, () => {
    assert.deepEqual(evaluateStatus({ ...publishing, ...overrides }), { ok, reason });
  });
}

test("publication gate blocks disabled schedules before any fetch and forces disabled manual runs dry", () => {
  assert.deepEqual(publicationGate({
    eventName: "schedule", publishEnabled: "", dryRun: false, baseUrlPresent: true,
  }), { gated: true, effectiveDryRun: true, reason: "publishing_disabled" });
  assert.deepEqual(publicationGate({
    eventName: "workflow_dispatch", publishEnabled: "", dryRun: false, baseUrlPresent: true,
  }), { gated: false, effectiveDryRun: true, reason: "allowed" });
  assert.deepEqual(publicationGate({
    eventName: "schedule", publishEnabled: "true", dryRun: false, baseUrlPresent: false,
  }), { gated: true, effectiveDryRun: false, reason: "base_url_missing" });
  assert.deepEqual(publicationGate({
    eventName: "workflow_dispatch", publishEnabled: "true", dryRun: true, baseUrlPresent: true,
  }), { gated: false, effectiveDryRun: true, reason: "allowed" });
});

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "libvetv-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

for (const code of [0, 3, 1, 2]) {
  test(`generator shell wrapper preserves exit ${code} under bash -e`, async (t) => {
    const root = await temporary(t);
    const output = join(root, "output");
    const run = spawnSync("bash", [
      "-e", "-c", 'bash "$1" node -e "process.exit($2)"; echo CONTINUED',
      "test", resolve(ROOT, "scripts/ci/run-generate.sh"), String(code),
    ], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } });
    assert.equal(run.status, code === 3 ? 0 : code);
    assert.equal(run.stdout.includes("CONTINUED"), code === 0 || code === 3);
    assert.equal(await readFile(output, "utf8"), `exit_code=${code}\n`);
  });
}

test("publish path allowlist accepts only generated daily paths", () => {
  const good = ["daily/latest/index.json", "daily/latest/demo.m3u", "daily/2026-10-24/demo/playlist.json"];
  assert.deepEqual(validateChangedPaths(`${good.join("\n")}\n`), good);
  for (const path of ["index.html", ".github/workflows/static.yml", "../daily/x", "daily/latest/../x.json",
    "daily/latest/a.json\nindex.html", "daily/latest/a.json\ndaily/latest/a.json", "daily/latest/A.json", ""]) {
    assert.throws(() => validateChangedPaths(path), /publish_path_rejected/);
  }
});

test("publish stages only validated paths and never an unrelated file", async (t) => {
  const root = await temporary(t);
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--quiet"]);
  git(["config", "user.name", "Synthetic"]);
  git(["config", "user.email", "synthetic@example.invalid"]);
  await writeFile(join(root, "index.html"), "synthetic baseline");
  git(["add", "--", "index.html"]);
  git(["commit", "--quiet", "-m", "baseline"]);
  const artifactDir = join(root, ".tmp/out");
  await mkdir(join(artifactDir, "daily/latest"), { recursive: true });
  await writeFile(join(artifactDir, "changed-files.txt"), "daily/latest/index.json\n");
  await writeFile(join(artifactDir, "daily/latest/index.json"), "{}");
  await writeFile(join(root, "unrelated.txt"), "not staged");
  assert.deepEqual(await stageChanges({ root, artifactDir, git }), ["daily/latest/index.json"]);
  assert.equal(git(["diff", "--cached", "--name-only"]).trim(), "daily/latest/index.json");
  assert.equal(await readFile(join(root, "index.html"), "utf8"), "synthetic baseline");
});

test("publish rejects symlink artifact files before copying or staging", async (t) => {
  const root = await temporary(t);
  const artifactDir = join(root, ".tmp/out");
  await mkdir(join(artifactDir, "daily/latest"), { recursive: true });
  await writeFile(join(root, "outside"), "synthetic");
  await writeFile(join(artifactDir, "changed-files.txt"), "daily/latest/index.json\n");
  await symlink(join(root, "outside"), join(artifactDir, "daily/latest/index.json"));
  await assert.rejects(stageChanges({ root, artifactDir, git: () => assert.fail("git must not run") }),
    /publish_file_rejected/);
});

test("status summary counts overlaid bytes without exposing labels or unsafe text", async (t) => {
  const root = await temporary(t);
  await mkdir(join(root, "daily/latest"), { recursive: true });
  await mkdir(join(root, ".tmp/out/daily/latest"), { recursive: true });
  await writeFile(join(root, "daily/latest/keep.m3u"), "123");
  await writeFile(join(root, "daily/latest/index.json"), "old");
  const indexText = JSON.stringify({ channels: [{ id: "demo", status: "error", reason: "source_unavailable",
    label: "DO NOT PRINT THIS LABEL" }] });
  await writeFile(join(root, ".tmp/out/daily/latest/index.json"), indexText);
  const summary = await statusSummary(root, { ok: false, reason: "partial_channel_failure" });
  assert.match(summary, new RegExp(`daily/ total size in bytes: ${Buffer.byteLength(indexText) + 3}`));
  assert.match(summary, /\| demo \| error \| source_unavailable \|/);
  assert.doesNotMatch(summary, /DO NOT PRINT/);
});

test("status CLI exits nonzero for partial results even after successful publish and deploy", async (t) => {
  const root = await temporary(t);
  const run = spawnSync("node", [join(ROOT, "scripts/ci/evaluate-status.mjs")], {
    cwd: root, encoding: "utf8", env: { ...process.env,
      EVENT_NAME: "schedule", RUN_REF: "refs/heads/main", PUBLISH_ENABLED: "true", DRY_RUN: "false",
      BASE_URL_PRESENT: "true", GENERATE_RESULT: "success", GATED: "false", EXIT_CODE: "3",
      CHANGED: "true", ARTIFACT_RESULT: "success", PUBLISH_RESULT: "success", DEPLOY_RESULT: "success",
      GITHUB_STEP_SUMMARY: join(root, "summary"),
    },
  });
  assert.equal(run.status, 1);
  assert.match(await readFile(join(root, "summary"), "utf8"), /FAIL \(partial_channel_failure\)/);
});

function smokeFixture({ manifestPath = "latest/demo.json", media = "https://archive.org/download/synthetic/item.mp4",
  schemaVersion = 1, status = 200 } = {}) {
  const calls = [];
  const index = { schemaVersion, channels: [{ id: "demo", status: "ok", manifest: manifestPath }] };
  const manifest = { schemaVersion: 1, channelId: "demo",
    // Deliberately old: smoke checks validity, never freshness.
    publishedAt: "2020-01-01T00:00:00Z",
    items: [{ seq: 1, localId: "synthetic", title: "DEMO", url: media, durationSec: null }] };
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "error");
    assert.ok(url.startsWith("https://example.invalid/libvetv/daily/"));
    return { status, json: async () => url.endsWith("index.json") ? index : manifest };
  };
  return { calls, fetchImpl };
}

test("Pages smoke validates index and manifests only, with no freshness or media request", async () => {
  const fixture = smokeFixture();
  assert.deepEqual(await smokePages("https://example.invalid/libvetv/", fixture.fetchImpl), { checkedManifests: 1 });
  assert.equal(fixture.calls.length, 2);
  assert.ok(fixture.calls.every((url) => url.endsWith(".json")));
});

test("Pages smoke rejects unsafe manifests before fetching them", async () => {
  const fixture = smokeFixture({ manifestPath: "https://evil.example/a.json" });
  await assert.rejects(smokePages("https://example.invalid/libvetv/", fixture.fetchImpl), /manifest_path_invalid/);
  assert.equal(fixture.calls.length, 1);
});

test("Pages smoke rejects invalid schema, HTTP failures and unsafe media URLs", async () => {
  for (const options of [{ schemaVersion: 2 }, { status: 503 }, { media: "https://evil.example/item.mp4" }]) {
    const fixture = smokeFixture(options);
    await assert.rejects(smokePages("https://example.invalid/libvetv/", fixture.fetchImpl, async () => {}));
  }
});

test("Pages smoke retries index and manifest 404s then passes on the third request", async () => {
  const calls = [];
  const delays = [];
  const index = { schemaVersion: 1, channels: [{ id: "demo", status: "ok", manifest: "latest/demo.json" }] };
  const manifest = { schemaVersion: 1, channelId: "demo", items: [
    { seq: 1, localId: "synthetic", title: "DEMO", url: "https://archive.org/download/synthetic/item.mp4", durationSec: 42 },
  ] };
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "error");
    if (url.endsWith("index.json")) {
      const attempts = calls.filter((entry) => entry.endsWith("index.json")).length;
      return attempts < 3 ? { status: 404 } : { status: 200, json: async () => index };
    }
    const attempts = calls.filter((entry) => entry.endsWith("demo.json")).length;
    return attempts < 3 ? { status: 404 } : { status: 200, json: async () => manifest };
  };
  assert.deepEqual(await smokePages("https://example.invalid/libvetv/", fetchImpl,
    async (milliseconds) => { delays.push(milliseconds); }), { checkedManifests: 1 });
  assert.equal(calls.filter((url) => url.endsWith("index.json")).length, 3);
  assert.equal(calls.filter((url) => url.endsWith("demo.json")).length, 3);
  assert.deepEqual(delays, [15_000, 15_000, 15_000, 15_000]);
  assert.ok(calls.every((url) => url.endsWith(".json")), "smoke checks must not fetch media");
});

test("Pages smoke fails with pages_smoke_failed after four failed fetch attempts", async () => {
  const calls = [];
  const delays = [];
  const fetchImpl = async (url) => { calls.push(url); return { status: 404 }; };
  await assert.rejects(smokePages("https://example.invalid/libvetv/", fetchImpl,
    async (milliseconds) => { delays.push(milliseconds); }), /pages_smoke_failed/);
  assert.equal(calls.length, 4);
  assert.equal(calls.every((url) => url.endsWith("index.json")), true);
  assert.deepEqual(delays, [15_000, 15_000, 15_000]);
});

test("new workflows pin every action and keep gated generator and status wiring", async () => {
  const ci = await readFile(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const daily = await readFile(join(ROOT, ".github/workflows/daily-playlist.yml"), "utf8");
  for (const source of [ci, daily]) {
    for (const line of source.split("\n").filter((line) => line.includes("uses:"))) {
      assert.match(line, /uses: actions\/[a-z-]+@[a-f0-9]{40} # v\d/);
    }
    assert.match(source, /node-version: '22'/);
    assert.doesNotMatch(source, /pull_request_target/);
  }
  assert.match(ci, /fetch-depth: 0/);
  assert.match(ci, /if: failure\(\)/);
  assert.match(ci, /retention-days: 7/);
  assert.match(daily, /needs: \[generate, publish, deploy\]\n    if: always\(\)/);
  assert.match(daily, /run: bash scripts\/ci\/run-generate\.sh/);
  assert.match(daily, /if: steps\.gate\.outputs\.gated == 'false'/);
  assert.match(daily, /vars\.PUBLISH_ENABLED == 'true'/);
  assert.match(daily, /environment:\n      name: github-pages/);
  assert.match(daily, /path: '\.'/);
  const publisher = await readFile(join(ROOT, "scripts/ci/publish.mjs"), "utf8");
  assert.doesNotMatch(publisher, /\["add",\s*"-A"\]/);
  assert.match(publisher, /\["push", "origin", "HEAD:main"\]/);
});
