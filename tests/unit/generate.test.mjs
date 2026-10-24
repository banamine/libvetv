import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "./network-guard.mjs";
import { parseM3u } from "../../scripts/lib/parseM3u.mjs";
import {
  MAX_SOURCE_BYTES,
  readBoundedResponseBody,
  validateExportBaseUrl,
} from "../../scripts/lib/fetchSource.mjs";
import { writeFileAtomic } from "../../scripts/lib/write.mjs";
import { parseArgs, runGenerator, validateConfig } from "../../scripts/generate.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SOURCE = resolve(TEST_DIR, "../fixtures");
const CONFIG_PATH = resolve(TEST_DIR, "../../config/channels.json");
const NOW = new Date("2026-10-24T10:00:00.000Z");

async function readConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

async function makeTemp(t) {
  const root = await mkdtemp(join(tmpdir(), "libvetv-step2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureDir = join(root, "fixtures");
  await cp(FIXTURE_SOURCE, fixtureDir, { recursive: true });
  return { root, fixtureDir };
}

async function offlineRun(options) {
  const oldOutput = process.env.GITHUB_OUTPUT;
  const oldSummary = process.env.GITHUB_STEP_SUMMARY;
  delete process.env.GITHUB_OUTPUT;
  delete process.env.GITHUB_STEP_SUMMARY;
  try {
    return await runGenerator(options);
  } finally {
    if (oldOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = oldOutput;
    if (oldSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = oldSummary;
  }
}

async function treeHash(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(path);
    }
  }
  await visit(root);
  files.sort();
  const hash = createHash("sha256");
  for (const path of files) {
    const rel = path.slice(root.length).replaceAll("\\", "/");
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function loadManifest(root, channelId) {
  return JSON.parse(await readFile(join(root, "daily/latest", `${channelId}.json`), "utf8"));
}

test("fixture run processes both configured channels and writes index, JSON and M3U", async (t) => {
  const { root, fixtureDir } = await makeTemp(t);
  const config = await readConfig();
  const result = await offlineRun({
    config,
    baselineDir: root,
    outDir: root,
    fixtureDir,
    now: NOW,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.counts, { ok: 2, no_playlist: 0, error: 0 });
  assert.equal(result.channels.length, 2);
  assert.ok(result.changed);
  const index = JSON.parse(await readFile(join(root, "daily/latest/index.json"), "utf8"));
  assert.deepEqual(index.channels.map(({ id, status }) => [id, status]), [
    ["classic-cinema", "ok"],
    ["ajn-infowars-nightly-news", "ok"],
  ]);
  assert.equal((await loadManifest(root, "classic-cinema")).durationBasis, "unknown");
  assert.equal((await loadManifest(root, "ajn-infowars-nightly-news")).declaredTotalSeconds, 87132);
  assert.ok(result.changedFiles.includes("daily/latest/index.json"));
  assert.ok(result.changedFiles.includes("daily/latest/classic-cinema.m3u"));
});

test("identical run reports no artifact changes and empties changed-files.txt", async (t) => {
  const { root, fixtureDir } = await makeTemp(t);
  const config = await readConfig();
  const options = { config, baselineDir: root, outDir: root, fixtureDir, now: NOW };

  const first = await offlineRun(options);
  const second = await offlineRun(options);
  const secondHash = await treeHash(root);
  const third = await offlineRun(options);

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(second.changedFiles, []);
  assert.equal(await readFile(join(root, "changed-files.txt"), "utf8"), "");
  assert.equal(third.changed, false);
  assert.deepEqual(third.changedFiles, []);
  assert.equal(await treeHash(root), secondHash);
});

test("unchanged content in a separate output directory writes an empty change list and no daily files", async (t) => {
  const { root, fixtureDir } = await makeTemp(t);
  const baselineDir = join(root, "baseline");
  const outDir = join(root, "out");
  const config = await readConfig();
  const first = await offlineRun({
    config,
    baselineDir,
    outDir: baselineDir,
    fixtureDir,
    now: NOW,
  });
  assert.equal(first.exitCode, 0);

  for (const channel of config.channels) {
    const headerPath = join(fixtureDir, `${channel.guideId}__${channel.id}.headers.json`);
    const headers = JSON.parse(await readFile(headerPath, "utf8"));
    headers.headers["x-ajn-generated-at"] = "2026-10-25T09:00:00.000Z";
    await writeFile(headerPath, `${JSON.stringify(headers, null, 2)}\n`);
  }
  const second = await offlineRun({
    config,
    baselineDir,
    outDir,
    fixtureDir,
    now: new Date("2026-10-25T10:00:00.000Z"),
  });

  assert.equal(second.exitCode, 0);
  assert.equal(second.changed, false);
  assert.deepEqual(second.changedFiles, []);
  assert.equal(await readFile(join(outDir, "changed-files.txt"), "utf8"), "");
  assert.deepEqual(await readdir(outDir), ["changed-files.txt"]);
});

test("a title-only edit changes contentHash and writes the next UTC dated folder", async (t) => {
  const { root, fixtureDir } = await makeTemp(t);
  const config = { ...(await readConfig()), maxSourceAgeSeconds: 172800 };
  const classicFixture = join(fixtureDir, "movies-classics-vault__classic-cinema.m3u");
  const before = await readFile(classicFixture, "utf8");
  const first = await offlineRun({
    config,
    baselineDir: root,
    outDir: root,
    fixtureDir,
    now: NOW,
  });
  assert.equal(first.exitCode, 0);
  const oldManifest = await loadManifest(root, "classic-cinema");

  await writeFile(
    classicFixture,
    before.replace("Cinema Classics Vault - TheDeathKiss", "Cinema Classics Vault - Café, Special"),
  );
  const second = await offlineRun({
    config,
    baselineDir: root,
    outDir: root,
    fixtureDir,
    now: new Date("2026-10-25T10:00:00.000Z"),
  });

  const current = await loadManifest(root, "classic-cinema");
  assert.equal(second.exitCode, 0);
  assert.notEqual(current.contentHash, oldManifest.contentHash);
  assert.equal(current.items[0].title, "Cinema Classics Vault - Café, Special");
  assert.equal(current.publishedAt, "2026-10-25T10:00:00.000Z");
  assert.ok(await readFile(join(root, "daily/2026-10-25/classic-cinema/playlist.json"), "utf8"));
});

test("JSON and M3U stay item-for-item aligned for Unicode and comma titles", async (t) => {
  const { root, fixtureDir } = await makeTemp(t);
  const fixture = join(fixtureDir, "movies-classics-vault__classic-cinema.m3u");
  const source = await readFile(fixture, "utf8");
  await writeFile(
    fixture,
    source.replace("Cinema Classics Vault - TheDeathKiss", "Cinema Classics Vault - Café, Special"),
  );
  const result = await offlineRun({
    config: await readConfig(),
    baselineDir: root,
    outDir: root,
    fixtureDir,
    now: NOW,
  });
  assert.equal(result.exitCode, 0);

  const manifest = await loadManifest(root, "classic-cinema");
  const m3u = await readFile(join(root, "daily/latest/classic-cinema.m3u"), "utf8");
  const parsed = parseM3u(m3u);
  assert.deepEqual(
    parsed.map((item) => [item.title, item.url, item.durationSec]),
    manifest.items.map((item) => [item.title, item.url, item.durationSec ?? -1]),
  );
  assert.equal(parsed[0].title, "Cinema Classics Vault - Café, Special");
});

test("partial failure preserves the failed channel's last-good manifest while another channel updates", async (t) => {
  const { root, fixtureDir } = await makeTemp(t);
  const config = await readConfig();
  await offlineRun({ config, baselineDir: root, outDir: root, fixtureDir, now: NOW });
  const failedBefore = await readFile(join(root, "daily/latest/classic-cinema.json"), "utf8");

  const badHeaders = join(fixtureDir, "movies-classics-vault__classic-cinema.headers.json");
  const headers = JSON.parse(await readFile(badHeaders, "utf8"));
  headers.headers["content-type"] = "text/plain";
  await writeFile(badHeaders, `${JSON.stringify(headers, null, 2)}\n`);

  const goodFixture = join(fixtureDir, "cable-tv__ajn-infowars-nightly-news.m3u");
  const goodSource = await readFile(goodFixture, "utf8");
  await writeFile(
    goodFixture,
    goodSource.replace("Synthetic fixture item 1", "Synthetic fixture item 1 amended"),
  );
  const result = await offlineRun({
    config,
    baselineDir: root,
    outDir: root,
    fixtureDir,
    now: NOW,
  });

  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.counts, { ok: 1, no_playlist: 0, error: 1 });
  assert.equal(await readFile(join(root, "daily/latest/classic-cinema.json"), "utf8"), failedBefore);
  assert.notEqual(
    (await loadManifest(root, "ajn-infowars-nightly-news")).items[0].title,
    "Synthetic fixture item 1",
  );
  const index = JSON.parse(await readFile(join(root, "daily/latest/index.json"), "utf8"));
  assert.equal(index.channels[0].status, "error");
  assert.equal(index.channels[0].reason, "content_type");
  assert.ok(result.changedFiles.includes("daily/latest/index.json"));
  assert.ok(result.changedFiles.some((path) => path.includes("ajn-infowars-nightly-news")));
  assert.ok(!result.changedFiles.some((path) => path.includes("classic-cinema")));
});

test("stale and too-far-future source headers become explicit error rows", async (t) => {
  for (const [generatedAt, expectedReason] of [
    ["2026-10-22T08:10:50.932Z", "stale_source"],
    ["2026-10-24T10:10:00.000Z", "future_source"],
    ["2026-02-30T10:00:00.000Z", "invalid_generated_at"],
  ]) {
    const { root, fixtureDir } = await makeTemp(t);
    const config = await readConfig();
    config.channels = [config.channels[0]];
    const headerPath = join(fixtureDir, "movies-classics-vault__classic-cinema.headers.json");
    const headers = JSON.parse(await readFile(headerPath, "utf8"));
    headers.headers["x-ajn-generated-at"] = generatedAt;
    await writeFile(headerPath, `${JSON.stringify(headers, null, 2)}\n`);

    const result = await offlineRun({
      config,
      baselineDir: root,
      outDir: root,
      fixtureDir,
      now: NOW,
    });
    assert.equal(result.exitCode, 3);
    assert.equal(result.channels[0].reason, expectedReason);
  }
});

test("non-200 fixture status is rejected without publishing a manifest", async (t) => {
  const { root, fixtureDir } = await makeTemp(t);
  const config = await readConfig();
  config.channels = [config.channels[0]];
  const headerPath = join(fixtureDir, "movies-classics-vault__classic-cinema.headers.json");
  const headers = JSON.parse(await readFile(headerPath, "utf8"));
  headers.status = 503;
  await writeFile(headerPath, `${JSON.stringify(headers, null, 2)}\n`);

  const result = await offlineRun({
    config,
    baselineDir: root,
    outDir: root,
    fixtureDir,
    now: NOW,
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.channels[0].reason, "http_status");
  assert.deepEqual(await readdir(join(root, "daily/latest")), ["index.json"]);
});

test("source bodies over 2 MB fail with source_too_large", async (t) => {
  const { root, fixtureDir } = await makeTemp(t);
  const config = await readConfig();
  config.channels = [config.channels[0]];
  const sourcePath = join(fixtureDir, "movies-classics-vault__classic-cinema.m3u");
  await writeFile(sourcePath, `#EXTM3U\n${"x".repeat(MAX_SOURCE_BYTES + 1)}`);

  const result = await offlineRun({
    config,
    baselineDir: root,
    outDir: root,
    fixtureDir,
    now: NOW,
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.channels[0].reason, "source_too_large");
  assert.deepEqual(await readdir(join(root, "daily/latest")), ["index.json"]);
});

test("streaming source reader cancels as soon as the 2 MB cap is exceeded", async () => {
  let chunksSent = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (chunksSent === 0) {
        controller.enqueue(new Uint8Array(MAX_SOURCE_BYTES));
        chunksSent += 1;
      } else {
        controller.enqueue(new Uint8Array(1));
        chunksSent += 1;
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    readBoundedResponseBody({ body }),
    (error) => error.code === "source_too_large",
  );
  assert.equal(cancelled, true);
});

test("invalid tvg-id and malformed source bodies fail the whole channel", async (t) => {
  const cases = [
    {
      mutate: (body) => body.replaceAll('tvg-id="classic-cinema"', 'tvg-id="wrong-channel"'),
      reason: "tvg_id_mismatch",
    },
    {
      mutate: () => "#EXTM3U\n#EXTINF:1 tvg-id=\"classic-cinema\",Missing URL\n",
      reason: "malformed",
    },
  ];
  for (const scenario of cases) {
    const { root, fixtureDir } = await makeTemp(t);
    const config = await readConfig();
    config.channels = [config.channels[0]];
    const sourcePath = join(fixtureDir, "movies-classics-vault__classic-cinema.m3u");
    const original = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, scenario.mutate(original));

    const result = await offlineRun({
      config,
      baselineDir: root,
      outDir: root,
      fixtureDir,
      now: NOW,
    });
    assert.equal(result.exitCode, 3);
    assert.equal(result.channels[0].reason, scenario.reason);
  }
});

test("a known-duration channel outside tolerance reports no_playlist without publishing it", async (t) => {
  const { root, fixtureDir } = await makeTemp(t);
  const config = await readConfig();
  config.toleranceSeconds = 300;
  config.channels = [config.channels[1]];
  const result = await offlineRun({
    config,
    baselineDir: root,
    outDir: root,
    fixtureDir,
    now: NOW,
  });

  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.counts, { ok: 0, no_playlist: 1, error: 0 });
  assert.equal(result.channels[0].reason, "outside_tolerance");
  assert.equal(result.channels[0].itemCount, 0);
  assert.deepEqual(
    await readdir(join(root, "daily/latest")),
    ["index.json"],
  );
});

test("invalid config and unsafe base URLs are rejected before source access", async () => {
  const config = await readConfig();
  assert.throws(() => validateConfig({ ...config, channels: Array(9).fill(config.channels[0]) }), /config_invalid/);
  assert.throws(() => parseArgs(["--out", ".tmp/out"]), /arguments_invalid/);
  for (const [url, reason] of [
    ["http://ajn.example", "export_base_not_https"],
    ["https://localhost", "export_base_host_not_public"],
    ["https://127.0.0.1", "export_base_host_not_public"],
    ["https://archive.org", "export_base_host_not_public"],
    ["https://user:pass@ajn.example", "export_base_has_credentials"],
    ["https://ajn.example/api", "export_base_has_path"],
    ["https://ajn.example/?q=x", "export_base_has_path"],
    ["https://ajn.example:8443", "export_base_has_port"],
  ]) {
    assert.throws(
      () => validateExportBaseUrl(url),
      (error) => error.code === reason,
    );
  }

  await assert.rejects(
    runGenerator({
      config: { ...config, channels: [] },
      baselineDir: ".",
      outDir: ".tmp/never-created",
      baseUrl: "https://ajn.example",
    }),
    /config_invalid/,
  );
  assert.equal(globalThis.__networkAttempts, 0);
});

test("atomic rename failure leaves the previous target intact and removes the temporary file", async (t) => {
  const { root } = await makeTemp(t);
  const target = join(root, "output.json");
  await writeFile(target, "previous\n");
  await assert.rejects(
    writeFileAtomic(target, "replacement\n", {
      renameImpl: async () => {
        throw new Error("injected rename failure");
      },
    }),
    /injected rename failure/,
  );
  assert.equal(await readFile(target, "utf8"), "previous\n");
  assert.deepEqual(await readdir(root), ["fixtures", "output.json"]);
});

test("GitHub outputs expose only changed and summary counts/reason codes", async (t) => {
  const { root, fixtureDir } = await makeTemp(t);
  const outputPath = join(root, "github-output.txt");
  const summaryPath = join(root, "github-summary.txt");
  const oldOutput = process.env.GITHUB_OUTPUT;
  const oldSummary = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_OUTPUT = outputPath;
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  try {
    const result = await runGenerator({
      config: await readConfig(),
      baselineDir: root,
      outDir: root,
      fixtureDir,
      now: NOW,
    });
    assert.equal(result.exitCode, 0);
  } finally {
    if (oldOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = oldOutput;
    if (oldSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = oldSummary;
  }
  const output = await readFile(outputPath, "utf8");
  const summary = await readFile(summaryPath, "utf8");
  assert.equal(output, "changed=true\n");
  assert.ok(!output.includes("exit_code"));
  assert.ok(summary.includes("channels=2 ok=2 no_playlist=0 error=0"));
  assert.ok(!summary.includes("archive.org"));
  assert.ok(!summary.includes("Cinema Classics"));
});

test("fixture generation never calls fetch", async () => {
  assert.equal(globalThis.__networkAttempts, 0);
});
