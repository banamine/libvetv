import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./network-guard.mjs";
import { assignLocalIds } from "../../scripts/lib/ids.mjs";
import { computeContentHash, createManifest, manifestToM3u } from "../../scripts/lib/manifest.mjs";
import { parseAffiliateListing, selectAffiliateShows } from "../../scripts/lib/affiliateListing.mjs";
import { fetchAffiliateListing, validateAffiliateSource } from "../../scripts/lib/fetchAffiliateListing.mjs";
import { parseDigest } from "../../assets/overlay.js";
import { initialState, transition } from "../../assets/sequencer.js";
import { runGenerator, validateConfig } from "../../scripts/generate.mjs";
import { validManifest } from "../../assets/manifest.js";
import { verifySite } from "../../scripts/verify-site.mjs";
import { smokePages } from "../../scripts/ci/smoke-pages.mjs";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const FILE_BASE = "https://affiliates.alexjoneslive.com/mp4-segs/";
const SOURCE = {
  id: "ajn-affiliate-segments", type: "affiliate-listing",
  listUrl: "https://www.alexjoneslive.com/affiliates/mp4-segs/", fileBase: FILE_BASE,
  network: "ajn", loop: true,
  mediaAllowlist: [
    { host: "archive.org", prefix: "/download/" },
    { host: "affiliates.alexjoneslive.com", prefix: "/mp4-segs/" },
  ],
  shows: { Alex: "The Alex Jones Show", WarRoom: "War Room with Harrison Smith", SundayLive: "Sunday Night Live" },
};
const htmlRow = (name, size = "400 MB", modified = "Oct 19 2026 12:00 PM") =>
  `<tr><td><a href="${name}">${name}</a></td><td>${size}</td><td>${modified}</td></tr>`;
const row = (name, size, modified) => {
  const result = parseAffiliateListing(htmlRow(name, size, modified), {
    shows: SOURCE.shows, fileBase: SOURCE.fileBase, now: NOW,
  }).rows[0];
  return result;
};
const select = (rows) => selectAffiliateShows(rows, SOURCE, NOW);
const makeManifest = (showItems) => {
  const items = assignLocalIds(showItems.map((item) => ({ ...item, url: item.segments[0].url })));
  const config = { targetSeconds: 86_400, toleranceSeconds: 0 };
  const selection = { status: "ok", items, durationBasis: "unknown", declaredTotalSeconds: null };
  return createManifest({
    channel: { id: SOURCE.id, guideId: SOURCE.id, label: "AJN Affiliate Shows", network: "ajn",
      sourceType: SOURCE.type, loop: SOURCE.loop, mediaAllowlist: SOURCE.mediaAllowlist },
    config, serviceDayUtc: "2026-10-24", sourceGeneratedAt: NOW.toISOString(),
    publishedAt: NOW.toISOString(), selection, items, excluded: [],
  });
};
async function repoConfig() {
  return JSON.parse(await readFile(new URL("../../config/channels.json", import.meta.url), "utf8"));
}

test("affiliate listing parser extracts strict names, sizes, timestamps and decodes markup", () => {
  const result = parseAffiliateListing(
    `<table><tr><th>Name</th><th>Size</th><th>Modified</th></tr>${htmlRow(
      "Mon-Alex-Hr2-Seg1.mp4", "1.25 GB", "Oct 19 2026 12:00 PM",
    )}</table>`,
    { shows: SOURCE.shows, fileBase: FILE_BASE, now: NOW },
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].sizeBytes, 1_250_000_000);
  assert.equal(result.rows[0].modifiedMs, Date.parse("2026-10-19T12:00:00Z"));
  assert.equal(result.rows[0].url, `${FILE_BASE}Mon-Alex-Hr2-Seg1.mp4`);
  assert.deepEqual(result.reasonCounts, {});
});

test("untrusted listing rows are rejected with reason counts and unknown show tokens are never labelled", () => {
  const html = [
    htmlRow("Mon-Unknown-Hr1-Seg1.mp4"),
    htmlRow("Mon-Alex-Hr0-Seg1.mp4"),
    htmlRow("Mon-Alex-Hr1-Seg1.exe"),
    htmlRow("Mon-Alex-Hr1-Seg1.mp4", "0 B"),
    htmlRow("Mon-Alex-Hr1-Seg2.mp4", "10 MB", "not a date"),
  ].join("");
  const result = parseAffiliateListing(html, { shows: SOURCE.shows, fileBase: FILE_BASE, now: NOW });
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.reasonCounts, {
    unknown_show: 1, invalid_filename: 2, invalid_size: 1, invalid_timestamp: 1,
  });
  assert.equal(parseAffiliateListing(htmlRow("Mon-Alex-Hr1-Seg1.mp4", "10 MB", "Feb 30 2026 12:00 PM"),
    { shows: SOURCE.shows, fileBase: FILE_BASE, now: NOW }).rows.length, 0);
  assert.throws(() => parseAffiliateListing("", { shows: SOURCE.shows, fileBase: "https://affiliates.alexjoneslive.com.evil.test/mp4-segs/", now: NOW }), /affiliate_file_base_invalid/);
});

test("yearless timestamps infer the run year and roll a date more than one day ahead back one year", () => {
  const currentYear = row("Sat-Alex-Hr1-Seg1.mp4", "1 GB", "Oct 24 11:00 AM");
  const rollover = parseAffiliateListing(htmlRow("Sat-Alex-Hr1-Seg1.mp4", "1 GB", "Dec 31 11:00 PM"), {
    shows: SOURCE.shows, fileBase: FILE_BASE, now: new Date("2026-01-01T00:00:00Z"),
  }).rows[0];
  assert.equal(currentYear.modifiedMs, Date.parse("2026-10-24T11:00:00Z"));
  const namedMonth = parseAffiliateListing(htmlRow("Sat-Alex-Hr1-Seg1.mp4", "1 GB", "Saturday, October 24 11:00 AM"), {
    shows: SOURCE.shows, fileBase: FILE_BASE, now: NOW,
  }).rows[0];
  assert.equal(namedMonth.modifiedMs, Date.parse("2026-10-24T11:00:00Z"));
  assert.equal(rollover.modifiedMs, Date.parse("2025-12-31T23:00:00Z"));
});

test("complete day sets sort by hour and segment and retain the configured show name", () => {
  const selected = select([
    row("Mon-Alex-Hr2-Seg1.mp4"),
    row("Mon-Alex-Hr1-Seg2.mp4"),
    row("Mon-Alex-Hr1-Seg1.mp4"),
  ]);
  assert.equal(selected.shows.length, 1);
  const show = selected.shows[0];
  assert.equal(show.title, "The Alex Jones Show");
  assert.equal(show.network, "ajn");
  assert.equal(show.loop, true);
  assert.equal(show.day, "Mon");
  assert.equal(show.durationSec, null);
  assert.deepEqual(show.segments.map((segment) => segment.name), [
    "Mon-Alex-Hr1-Seg1.mp4", "Mon-Alex-Hr1-Seg2.mp4", "Mon-Alex-Hr2-Seg1.mp4",
  ]);
  assert.deepEqual(show.segments.map((segment) => segment.seq), [1, 2, 3]);
});

test("newest incomplete day falls back to the newest earlier complete day without splicing", () => {
  const selected = select([
    row("Mon-WarRoom-Hr1-Seg1.mp4", "1 GB", "Oct 19 2026 12:00 PM"),
    row("Mon-WarRoom-Hr1-Seg2.mp4", "1 GB", "Oct 19 2026 12:01 PM"),
    row("Tue-WarRoom-Hr1-Seg1.mp4", "1 GB", "Oct 20 2026 12:00 PM"),
    row("Tue-WarRoom-Hr2-Seg2.mp4", "1 GB", "Oct 20 2026 12:01 PM"),
  ]);
  assert.equal(selected.shows.length, 1);
  assert.equal(selected.shows[0].day, "Mon");
  assert.equal(selected.shows[0].date, "2026-10-19");
  assert.equal(selected.shows[0].fallbackFromDay, "2026-10-20");
  assert.deepEqual(selected.shows[0].segments.map((segment) => segment.name), [
    "Mon-WarRoom-Hr1-Seg1.mp4", "Mon-WarRoom-Hr1-Seg2.mp4",
  ]);
});

test("separate calendar dates with the same weekday are separate sets and fall back without splicing", () => {
  const selected = select([
    row("Mon-Alex-Hr1-Seg1.mp4", "1 GB", "Oct 19 2026 12:00 PM"),
    row("Mon-Alex-Hr1-Seg2.mp4", "1 GB", "Oct 26 2026 12:00 PM"),
  ]);
  assert.equal(selected.shows.length, 1);
  assert.equal(selected.shows[0].date, "2026-10-19");
  assert.equal(selected.shows[0].fallbackFromDay, "2026-10-26");
  assert.deepEqual(selected.shows[0].segments.map((part) => part.name), ["Mon-Alex-Hr1-Seg1.mp4"]);
});

test("AJN files straddling 00:00 UTC form two date sets and are not stitched together", () => {
  const selected = select([
    row("Mon-Alex-Hr1-Seg1.mp4", "1 GB", "Oct 19 2026 11:58 PM"),
    row("Mon-Alex-Hr1-Seg2.mp4", "1 GB", "Oct 19 2026 11:59 PM"),
    row("Mon-Alex-Hr1-Seg1.mp4", "1 GB", "Oct 20 2026 12:01 AM"),
    row("Mon-Alex-Hr1-Seg2.mp4", "1 GB", "Oct 20 2026 12:02 AM"),
  ]);
  assert.equal(selected.shows.length, 1);
  assert.equal(selected.shows[0].date, "2026-10-20");
  assert.deepEqual(selected.shows[0].segments.map((part) => part.name), [
    "Mon-Alex-Hr1-Seg1.mp4", "Mon-Alex-Hr1-Seg2.mp4",
  ]);
  assert.equal(selected.shows[0].fallbackFromDay, undefined);
});

for (const [label, rows] of [
  ["missing hour 1", [row("Mon-Alex-Hr2-Seg1.mp4")]],
  ["missing segment 1", [row("Mon-Alex-Hr1-Seg2.mp4")]],
  ["duplicate segment", [row("Mon-Alex-Hr1-Seg1.mp4"), row("Mon-Alex-Hr1-Seg1.mp4")]],
  ["gap between hours", [row("Mon-Alex-Hr1-Seg1.mp4"), row("Mon-Alex-Hr3-Seg1.mp4")]],
]) {
  test(`incomplete day sets are not assembled from partial files: ${label}`, () => {
    const result = select(rows);
    assert.deepEqual(result.shows, []);
    assert.deepEqual(result.reasonCounts, { no_complete_day_set: 1 });
  });
}

test("one ineligible segment excludes its complete show/day as segment_ineligible", () => {
  const bad = row("Mon-Alex-Hr1-Seg1.mp4");
  bad.url = "https://affiliates.alexjoneslive.com.evil.test/mp4-segs/Mon-Alex-Hr1-Seg1.mp4";
  const result = select([bad]);
  assert.deepEqual(result.shows, []);
  assert.equal(result.reasonCounts.segment_ineligible, 1);
  assert.equal(result.reasonCounts.no_complete_day_set, undefined);
});

test("hash changes for each segment name, size or modification time, not for run timestamps", () => {
  const base = makeManifest(select([
    row("Mon-Alex-Hr1-Seg1.mp4"), row("Mon-Alex-Hr1-Seg2.mp4"),
  ]).shows);
  const changed = (modify) => {
    const copy = structuredClone(base);
    modify(copy.items[0].segments[0]);
    copy.contentHash = computeContentHash({
      ...copy, items: copy.items, network: copy.network, sourceType: copy.sourceType,
      loop: copy.loop, mediaAllowlist: copy.mediaAllowlist,
    });
    return copy.contentHash;
  };
  for (const mutate of [
    (segment) => { segment.name = "Mon-Alex-Hr1-Seg9.mp4"; },
    (segment) => { segment.sizeBytes += 1; },
    (segment) => { segment.modifiedAt = new Date(NOW.getTime() - 1).toISOString(); },
  ]) assert.notEqual(changed(mutate), base.contentHash);
  const otherwiseSame = createManifest({
    channel: { id: SOURCE.id, guideId: SOURCE.id, label: "AJN Affiliate Shows", network: "ajn",
      sourceType: SOURCE.type, loop: SOURCE.loop, mediaAllowlist: SOURCE.mediaAllowlist },
    config: { targetSeconds: 86_400, toleranceSeconds: 0 }, serviceDayUtc: "different",
    sourceGeneratedAt: "different", publishedAt: "different",
    selection: { durationBasis: "unknown", declaredTotalSeconds: null },
    items: base.items, excluded: [],
  });
  assert.equal(otherwiseSame.contentHash, base.contentHash);
});

test("archive-only eligibility is default; the configured affiliate allowlist admits only its exact host and prefix", async () => {
  const { eligibility } = await import("../../assets/eligibility.js");
  const affiliates = [
    { host: "affiliates.alexjoneslive.com", prefix: "/mp4-segs/" },
  ];
  assert.equal(eligibility({ url: `${FILE_BASE}Mon-Alex-Hr1-Seg1.mp4`, durationSec: -1 }).ok, false);
  assert.equal(eligibility({ url: `${FILE_BASE}Mon-Alex-Hr1-Seg1.mp4`, durationSec: -1 },
    [...SOURCE.mediaAllowlist]).ok, true);
  for (const url of [
    "https://affiliates.alexjoneslive.com.evil.test/mp4-segs/a.mp4",
    "https://alexjoneslive.com/mp4-segs/a.mp4",
    "https://affiliates.alexjoneslive.com/download/a.mp4",
    "https://affiliates.alexjoneslive.com:443/mp4-segs/a.mp4",
    "https://affiliates.alexjoneslive.com/mp4-segs/a%0A.mp4",
  ]) assert.equal(eligibility({ url, durationSec: -1 }, affiliates).ok, false, url);
  assert.equal(eligibility({ url: "https://archive.org/download/id/a.mp4", durationSec: -1 }).ok, true);
});

test("affiliate source config has exact public hosts, fixed media allowlist and explicit show mappings", async () => {
  const config = await repoConfig();
  assert.equal(config.sources.length, 1);
  assert.equal(validateAffiliateSource(config.sources[0]).network, "ajn");
  assert.throws(() => validateAffiliateSource({ ...SOURCE, fileBase: "https://alexjoneslive.com/mp4-segs/" }), /affiliate_source_url_invalid/);
  assert.throws(() => validateAffiliateSource({ ...SOURCE, listUrl: "https://www.alexjoneslive.com:443/affiliates/mp4-segs/" }), /affiliate_source_url_invalid/);
  assert.throws(() => validateAffiliateSource({ ...SOURCE, mediaAllowlist: [{ host: "evil.test", prefix: "/" }] }), /affiliate_allowlist_invalid/);
  assert.throws(() => validateConfig({ ...config, sources: [{ ...SOURCE, id: config.channels[0].id }] }), /config_invalid/);
});

test("affiliate generator input fetches one public listing request and never requests a media URL", async () => {
  let requests = 0;
  const dnsChecks = [];
  const fetched = await fetchAffiliateListing(SOURCE, {
    now: NOW,
    dnsCheck: async (host) => { dnsChecks.push(host); },
    fetchImpl: async (url, options) => {
      requests += 1;
      assert.equal(url.href, SOURCE.listUrl);
      assert.equal(options.redirect, "error");
      assert.equal(options.method, "GET");
      return new Response(htmlRow("Mon-Alex-Hr1-Seg1.mp4"), {
        status: 200, headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  assert.equal(fetched.ok, true);
  assert.equal(requests, 1);
  assert.deepEqual(dnsChecks, ["www.alexjoneslive.com"]);
  let failedRequests = 0;
  const rejected = await fetchAffiliateListing(SOURCE, {
    dnsCheck: async () => {},
    fetchImpl: async () => {
      failedRequests += 1;
      return new Response("unavailable", { status: 503, headers: { "content-type": "text/html" } });
    },
  });
  assert.deepEqual(rejected, { ok: false, reason: "listing_http_status" });
  assert.equal(failedRequests, 1, "listing failures are not retried");
  const oversized = await fetchAffiliateListing(SOURCE, {
    dnsCheck: async () => {},
    fetchImpl: async () => new Response(new Uint8Array(2_000_001), {
      status: 200, headers: { "content-type": "text/html" },
    }),
  });
  assert.deepEqual(oversized, { ok: false, reason: "source_too_large" });
});

test("affiliate manifests validate segment identity and configured host rules; M3U remains sequential", () => {
  const manifest = makeManifest(select([
    row("Mon-Alex-Hr1-Seg1.mp4"), row("Mon-Alex-Hr1-Seg2.mp4"),
  ]).shows);
  assert.equal(manifest.durationBasis, "unknown");
  assert.equal(manifest.declaredTotalSeconds, null);
  assert.equal(validManifest(manifest, SOURCE.id), true);
  assert.deepEqual(manifest.items[0].segments.map((segment) => segment.seq), [1, 2]);
  const entries = manifestToM3u(manifest).trim().split(/\r?\n/);
  assert.equal(entries.length, 5);
  assert.match(entries[3], /Hour 1, segment 2/);
  for (const mutate of [
    (copy) => { copy.items[0].segments[0].url = "https://alexjoneslive.com/a.mp4"; },
    (copy) => { copy.mediaAllowlist[1].host = "affiliates.alexjoneslive.com.evil.test"; },
    (copy) => { copy.items[0].segments[1].sizeBytes = 0; },
    (copy) => { copy.items[0].segments[1].seq = 7; },
  ]) {
    const copy = structuredClone(manifest); mutate(copy);
    assert.equal(validManifest(copy, SOURCE.id), false);
  }
});

test("sequencer advances segments, loops only on explicit command, and skip-show advances the channel", () => {
  const items = [{ kind: "show", segments: [{}, {}] }, { title: "DEMO plain" }];
  let state = transition(initialState(), "start", items);
  state = transition(state, "ended", items);
  assert.equal(state.segmentIndex, 1);
  state = transition(state, "loopShow", items);
  assert.equal(state.segmentIndex, 0);
  state = transition(state, "error", items);
  state = transition(state, "skipShow", items);
  assert.deepEqual(state, { state: "playing", index: 1, segmentIndex: 0 });
  assert.equal(transition(state, "ended", items).state, "complete");
});

test("generator reads a synthetic listing fixture once, publishes complete shows, and retains last-good on listing failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "libvetv-affiliate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureDir = join(root, "fixtures");
  await mkdir(fixtureDir);
  const config = await repoConfig();
  const m3uOnly = { ...config, sources: [] };
  const original = await readFile(new URL("../../tests/fixtures/movies-classics-vault__classic-cinema.m3u", import.meta.url), "utf8");
  const guideSource = config.channels[0];
  await writeFile(join(fixtureDir, `${guideSource.guideId}__${guideSource.id}.m3u`), original);
  const headers = await readFile(new URL("../../tests/fixtures/movies-classics-vault__classic-cinema.headers.json", import.meta.url), "utf8");
  await writeFile(join(fixtureDir, `${guideSource.guideId}__${guideSource.id}.headers.json`), headers);
  const second = config.channels[1];
  const secondM3u = await readFile(new URL(`../../tests/fixtures/${second.guideId}__${second.id}.m3u`, import.meta.url), "utf8");
  const secondHeaders = await readFile(new URL(`../../tests/fixtures/${second.guideId}__${second.id}.headers.json`, import.meta.url), "utf8");
  await writeFile(join(fixtureDir, `${second.guideId}__${second.id}.m3u`), secondM3u);
  await writeFile(join(fixtureDir, `${second.guideId}__${second.id}.headers.json`), secondHeaders);
  const listing = [htmlRow("Mon-Alex-Hr1-Seg1.mp4"), htmlRow("Mon-Alex-Hr1-Seg2.mp4")].join("");
  await writeFile(join(fixtureDir, `affiliate-${SOURCE.id}.html`), listing);
  const output = await runGenerator({ config, fixtureDir, baselineDir: root, outDir: root, now: NOW });
  assert.equal(output.exitCode, 0);
  const manifest = JSON.parse(await readFile(join(root, "daily/latest", `${SOURCE.id}.json`), "utf8"));
  assert.equal(manifest.items[0].segments.length, 2);
  assert.equal(manifest.durationBasis, "unknown");
  assert.equal(manifest.network, "ajn");
  assert.equal(manifest.loop, true);
  assert.deepEqual(manifest.mediaAllowlist, SOURCE.mediaAllowlist);

  await rm(join(fixtureDir, `affiliate-${SOURCE.id}.html`));
  const stale = await runGenerator({ config, fixtureDir, baselineDir: root, outDir: root, now: NOW });
  assert.equal(stale.channels.find((entry) => entry.id === SOURCE.id).status, "stale");
  const index = JSON.parse(await readFile(join(root, "daily/latest/index.json"), "utf8"));
  const row = index.channels.find((entry) => entry.id === SOURCE.id);
  assert.equal(row.status, "stale");
  assert.equal(row.manifest, `latest/${SOURCE.id}.json`);
  assert.ok(row.asOf);
  assert.equal(stale.reasonCounts.fixture_missing, 1);
  const noHistory = join(root, "empty-history");
  await mkdir(noHistory);
  const noPlaylist = await runGenerator({
    config, fixtureDir, baselineDir: noHistory, outDir: noHistory, now: NOW,
  });
  const noPlaylistRow = noPlaylist.channels.find((entry) => entry.id === SOURCE.id);
  assert.equal(noPlaylistRow.status, "no_playlist");
  const noPlaylistIndex = JSON.parse(await readFile(join(noHistory, "daily/latest/index.json"), "utf8"));
  assert.equal(noPlaylistIndex.channels.find((entry) => entry.id === SOURCE.id).manifest, null);
  assert.deepEqual(m3uOnly.sources, []);
});

test("parseDigest keeps only recent timestamped headlines, dedupes, and labels the feed", () => {
  const data = { stories: [
    { headline: " DEMO   one ", published: "2026-10-24T11:00:00Z", feedName: "DEMO Feed" },
    { title: "DEMO old", published: "Mon, 02 Jan 2006 15:04:05 GMT" },
    { headline: "DEMO bad", published: "not-a-date" },
    { title: "DEMO future", published: "Sat, 24 Oct 2026 12:06:00 GMT" },
  ], rss_feeds_articles: [
    { title: "demo one", published: "Sat, 24 Oct 2026 11:30:00 +0000" },
    { title: "DEMO two", published: "Sat, 24 Oct 2026 13:00:00 +0200", feedName: "DEMO RSS" },
  ] };
  const rows = parseDigest(data, NOW.getTime());
  assert.deepEqual(rows.map((entry) => entry.headline), ["DEMO one", "DEMO two"]);
  assert.equal(rows[0].feedName, "DEMO Feed");
  assert.equal(rows[1].publishedAt, "2026-10-24T11:00:00.000Z");
});

test("parseDigest caps 20, NFC-normalizes, rejects malformed, empty and non-timestamped items", () => {
  const stories = Array.from({ length: 30 }, (_, index) => ({ headline: `DEMO ${index}`, published: "2026-10-24T11:00:00Z" }));
  assert.equal(parseDigest({ stories }, NOW.getTime()).length, 20);
  assert.equal(parseDigest({ stories: [
    { headline: "DEMO Cafe\u0301", published: "2026-10-24T11:00:00Z" },
    { headline: "DEMO Café", published: "2026-10-24T11:00:00Z" },
    { headline: "DEMO missing date" },
  ] }, NOW.getTime()).length, 1);
  assert.throws(() => parseDigest("{", NOW.getTime()));
  assert.throws(() => parseDigest({}, NOW.getTime()), /digest_invalid/);
  assert.deepEqual(parseDigest({ stories: [], rss_feeds_articles: [] }, NOW.getTime()), []);
});
