#!/usr/bin/env node

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchChannelSource, SourceConfigError, validateExportBaseUrl } from "./lib/fetchSource.mjs";
import { fetchAffiliateListing, validateAffiliateSource } from "./lib/fetchAffiliateListing.mjs";
import { parseAffiliateListing, selectAffiliateShows } from "./lib/affiliateListing.mjs";
import { createIndex, createManifest, manifestToM3u, stableJson } from "./lib/manifest.mjs";
import { assignLocalIds } from "./lib/ids.mjs";
import { ARCHIVE_MEDIA_ALLOWLIST, eligibility } from "../assets/eligibility.js";
import { select } from "./lib/select.mjs";
import { readJsonMaybe, writeIfChangedAtomic } from "./lib/write.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG = resolve(REPO_ROOT, "config/channels.json");
const CHANNEL_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const GUIDE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("config_invalid");
  }
  for (const key of ["targetSeconds", "toleranceSeconds", "maxSourceAgeSeconds", "maxFutureSkewSeconds"]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < (key === "toleranceSeconds" || key === "maxFutureSkewSeconds" ? 0 : 1)) {
      throw new TypeError("config_invalid");
    }
  }
  if (config.schemaVersion !== 1 || !Array.isArray(config.channels) || config.channels.length > 8 ||
      (config.sources !== undefined && (!Array.isArray(config.sources) || config.sources.length > 8))) {
    throw new TypeError("config_invalid");
  }
  const ids = new Set();
  for (const channel of config.channels) {
    if (
      !channel ||
      typeof channel !== "object" ||
      !CHANNEL_ID.test(channel.id || "") ||
      !GUIDE_ID.test(channel.guideId || "") ||
      typeof channel.label !== "string" ||
      channel.label.trim() === "" ||
      typeof channel.enabled !== "boolean" ||
      typeof channel.network !== "string" ||
      !channel.network.trim() || /[\u0000-\u001f\u007f]/.test(channel.network) ||
      ids.has(channel.id)
    ) {
      throw new TypeError("config_invalid");
    }
    ids.add(channel.id);
  }
  for (const source of config.sources || []) {
    try { validateAffiliateSource(source); } catch { throw new TypeError("config_invalid"); }
    if (ids.has(source.id)) throw new TypeError("config_invalid");
    ids.add(source.id);
  }
  if (!config.channels.some((channel) => channel.enabled)) throw new TypeError("config_invalid");
  return config;
}

export function parseArgs(argv) {
  const options = {};
  const known = new Set(["--baseline-dir", "--out", "--fixture-dir", "--now"]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!known.has(key) || index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new TypeError("arguments_invalid");
    }
    const property = {
      "--baseline-dir": "baselineDir",
      "--out": "outDir",
      "--fixture-dir": "fixtureDir",
      "--now": "now",
    }[key];
    if (options[property] !== undefined) throw new TypeError("arguments_invalid");
    options[property] = argv[index + 1];
    index += 1;
  }
  if (!options.baselineDir || !options.outDir) throw new TypeError("arguments_invalid");
  return options;
}

function safeOutputPath(root, ...segments) {
  const path = resolve(root, ...segments);
  const fromRoot = relative(root, path);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new Error("output_path_invalid");
  }
  return path;
}

async function readTextMaybe(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function loadLastGood(path) {
  const value = await readJsonMaybe(path);
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.items)) return null;
  return value;
}

async function appendWorkflowOutputs(result) {
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `changed=${result.changed ? "true" : "false"}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const reasons = Object.entries(result.reasonCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ") || "none";
    const summary = [
      `Daily Playlist generator: channels=${result.channels.length} ok=${result.counts.ok} no_playlist=${result.counts.no_playlist} error=${result.counts.error}`,
      `Changed paths=${result.changedFiles.length}`,
      `Reason counts: ${reasons}`,
      `Unknown show tokens: ${result.unknownShowTokens.join(", ") || "none"}`,
      "",
    ].join("\n");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

export async function runGenerator(options) {
  const config = validateConfig(options.config);
  const now = options.now instanceof Date
    ? new Date(options.now.getTime())
    : options.now === undefined
      ? new Date()
      : new Date(options.now);
  if (!Number.isFinite(now.getTime())) throw new TypeError("now_invalid");

  const fixtureDir = options.fixtureDir ? resolve(options.fixtureDir) : null;
  const baseOrigin = fixtureDir
    ? null
    : validateExportBaseUrl(options.baseUrl ?? process.env.AJN_EXPORT_BASE_URL);
  const baselineRoot = resolve(options.baselineDir);
  const outRoot = resolve(options.outDir);
  await mkdir(outRoot, { recursive: true });

  const limits = {
    maxSourceAgeSeconds: config.maxSourceAgeSeconds,
    maxFutureSkewSeconds: config.maxFutureSkewSeconds,
  };
  const rows = [];
  const changedFiles = [];
  const reasonCounts = {};
  const unknownShowTokens = new Set();

  for (const channel of config.channels.filter((entry) => entry.enabled)) {
    const source = await fetchChannelSource(channel, { fixtureDir, baseOrigin, limits, now });
    if (!source.ok) {
      reasonCounts[source.reason] = (reasonCounts[source.reason] || 0) + 1;
      const lastGoodPath = safeOutputPath(baselineRoot, "daily", "latest", `${channel.id}.json`);
      const lastGood = await loadLastGood(lastGoodPath);
      rows.push({
        id: channel.id,
        label: channel.label,
        guideId: channel.guideId,
        status: "error",
        reason: source.reason,
        manifest: lastGood ? `latest/${channel.id}.json` : null,
        itemCount: lastGood?.itemCount ?? 0,
        declaredTotalSeconds: lastGood?.declaredTotalSeconds ?? null,
        durationBasis: lastGood?.durationBasis ?? "unknown",
        publishedAt: lastGood?.publishedAt ?? null,
      });
      continue;
    }

    if (source.items.some((item) => item.attributes["tvg-id"] !== channel.id)) {
      reasonCounts.tvg_id_mismatch = (reasonCounts.tvg_id_mismatch || 0) + 1;
      const lastGoodPath = safeOutputPath(baselineRoot, "daily", "latest", `${channel.id}.json`);
      const lastGood = await loadLastGood(lastGoodPath);
      rows.push({
        id: channel.id,
        label: channel.label,
        guideId: channel.guideId,
        status: "error",
        reason: "tvg_id_mismatch",
        manifest: lastGood ? `latest/${channel.id}.json` : null,
        itemCount: lastGood?.itemCount ?? 0,
        declaredTotalSeconds: lastGood?.declaredTotalSeconds ?? null,
        durationBasis: lastGood?.durationBasis ?? "unknown",
        publishedAt: lastGood?.publishedAt ?? null,
      });
      continue;
    }

    const eligibleItems = [];
    const excludedCounts = {};
    for (const item of source.items) {
      const result = eligibility({
        url: item.url,
        durationSec: item.durationSec === null ? -1 : item.durationSec,
      }, channel.mediaAllowlist || ARCHIVE_MEDIA_ALLOWLIST);
      if (result.ok) eligibleItems.push(item);
      else excludedCounts[result.reason] = (excludedCounts[result.reason] || 0) + 1;
    }
    for (const [reason, count] of Object.entries(excludedCounts)) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + count;
    }

    const identified = assignLocalIds(eligibleItems);
    const selection = select(identified, config);
    if (selection.status !== "ok") {
      reasonCounts[selection.reason] = (reasonCounts[selection.reason] || 0) + 1;
      const lastGoodPath = safeOutputPath(baselineRoot, "daily", "latest", `${channel.id}.json`);
      const lastGood = await loadLastGood(lastGoodPath);
      rows.push({
        id: channel.id,
        label: channel.label,
        guideId: channel.guideId,
        status: "no_playlist",
        reason: selection.reason,
        manifest: lastGood ? `latest/${channel.id}.json` : null,
        itemCount: lastGood?.itemCount ?? 0,
        declaredTotalSeconds: lastGood?.declaredTotalSeconds ?? null,
        durationBasis: lastGood?.durationBasis ?? "unknown",
        publishedAt: lastGood?.publishedAt ?? null,
      });
      continue;
    }

    const selected = selection.items;
    const manifest = createManifest({
      channel,
      config,
      serviceDayUtc: now.toISOString().slice(0, 10),
      sourceGeneratedAt: source.generatedAt,
      publishedAt: now.toISOString(),
      selection,
      items: selected,
      excluded: Object.keys(excludedCounts).sort().map((reason) => ({
        reason,
        count: excludedCounts[reason],
      })),
    });
    const baselineManifest = await loadLastGood(
      safeOutputPath(baselineRoot, "daily", "latest", `${channel.id}.json`),
    );
    const currentManifest = baselineManifest?.contentHash === manifest.contentHash
      ? baselineManifest
      : manifest;

    if (baselineManifest?.contentHash !== manifest.contentHash) {
      const datedJson = safeOutputPath(
        outRoot,
        "daily",
        now.toISOString().slice(0, 10),
        channel.id,
        "playlist.json",
      );
      const datedM3u = safeOutputPath(
        outRoot,
        "daily",
        now.toISOString().slice(0, 10),
        channel.id,
        "playlist.m3u",
      );
      const latestJson = safeOutputPath(outRoot, "daily", "latest", `${channel.id}.json`);
      const latestM3u = safeOutputPath(outRoot, "daily", "latest", `${channel.id}.m3u`);
      for (const [path, content] of [
        [datedJson, stableJson(manifest)],
        [datedM3u, manifestToM3u(manifest)],
        [latestJson, stableJson(manifest)],
        [latestM3u, manifestToM3u(manifest)],
      ]) {
        if (await writeIfChangedAtomic(path, content)) {
          changedFiles.push(relative(outRoot, path).split(sep).join("/"));
        }
      }
    }

    rows.push({
      id: channel.id,
      label: channel.label,
      guideId: channel.guideId,
      status: "ok",
      reason: null,
      manifest: `latest/${channel.id}.json`,
      itemCount: currentManifest.itemCount,
      declaredTotalSeconds: currentManifest.declaredTotalSeconds,
      durationBasis: currentManifest.durationBasis,
      publishedAt: currentManifest.publishedAt,
    });
  }

  for (const sourceConfig of config.sources || []) {
    const channel = {
      id: sourceConfig.id,
      guideId: sourceConfig.id,
      label: sourceConfig.label || "AJN Affiliate Shows",
      network: sourceConfig.network,
      sourceType: sourceConfig.type,
      loop: sourceConfig.loop,
      mediaAllowlist: sourceConfig.mediaAllowlist,
    };
    const lastGood = await loadLastGood(safeOutputPath(baselineRoot, "daily", "latest", `${channel.id}.json`));
    const fetched = await fetchAffiliateListing(sourceConfig, { fixtureDir, now });
    let listing;
    let chosen;
    let failReason = null;
    if (!fetched.ok) failReason = fetched.reason;
    else {
      listing = parseAffiliateListing(fetched.body, {
        shows: sourceConfig.shows, fileBase: sourceConfig.fileBase, now,
        timeZone: sourceConfig.listingTimeZone,
      });
      for (const [reason, count] of Object.entries(listing.reasonCounts)) {
        reasonCounts[reason] = (reasonCounts[reason] || 0) + count;
      }
      listing.unknownShowTokens.forEach((token) => unknownShowTokens.add(token));
      if (listing.rows.length === 0) failReason = "listing_no_valid_rows";
      else {
        const selected = selectAffiliateShows(listing.rows, sourceConfig, now);
        chosen = selected.shows;
        for (const [reason, count] of Object.entries(selected.reasonCounts)) {
          reasonCounts[reason] = (reasonCounts[reason] || 0) + count;
        }
        if (chosen.length === 0) failReason = "no_complete_day_set";
      }
    }

    if (failReason) {
      reasonCounts[failReason] = (reasonCounts[failReason] || 0) + 1;
      const shownAsOf = lastGood?.asOf ?? null;
      rows.push({
        id: channel.id, label: channel.label, guideId: channel.guideId,
        status: lastGood ? "stale" : "no_playlist", reason: failReason,
        manifest: lastGood ? `latest/${channel.id}.json` : null,
        itemCount: lastGood?.itemCount ?? 0,
        declaredTotalSeconds: lastGood?.declaredTotalSeconds ?? null,
        durationBasis: lastGood?.durationBasis ?? "unknown",
        publishedAt: lastGood?.publishedAt ?? null, asOf: shownAsOf,
      });
      continue;
    }

    const items = assignLocalIds(chosen.map((item) => ({
      ...item, url: item.segments[0].url,
    })));
    const selection = select(items, config);
    const manifest = createManifest({
      channel, config, serviceDayUtc: now.toISOString().slice(0, 10),
      sourceGeneratedAt: fetched.fetchedAt || now.toISOString(),
      publishedAt: now.toISOString(), selection, items: selection.items,
      excluded: Object.keys(reasonCounts).sort().map((reason) => ({ reason, count: reasonCounts[reason] })),
    });
    const baselineManifest = lastGood;
    const currentManifest = baselineManifest?.contentHash === manifest.contentHash ? baselineManifest : manifest;
    if (baselineManifest?.contentHash !== manifest.contentHash) {
      for (const [path, content] of [
        [safeOutputPath(outRoot, "daily", now.toISOString().slice(0, 10), channel.id, "playlist.json"), stableJson(manifest)],
        [safeOutputPath(outRoot, "daily", now.toISOString().slice(0, 10), channel.id, "playlist.m3u"), manifestToM3u(manifest)],
        [safeOutputPath(outRoot, "daily", "latest", `${channel.id}.json`), stableJson(manifest)],
        [safeOutputPath(outRoot, "daily", "latest", `${channel.id}.m3u`), manifestToM3u(manifest)],
      ]) {
        if (await writeIfChangedAtomic(path, content)) changedFiles.push(relative(outRoot, path).split(sep).join("/"));
      }
    }
    const fallback = currentManifest.items.find((item) => item.kind === "show" && item.fallbackFromDay);
    rows.push({
      id: channel.id, label: channel.label, guideId: channel.guideId, status: "ok",
      reason: null, manifest: `latest/${channel.id}.json`, itemCount: currentManifest.itemCount,
      declaredTotalSeconds: currentManifest.declaredTotalSeconds,
      durationBasis: currentManifest.durationBasis, publishedAt: currentManifest.publishedAt,
      asOf: currentManifest.asOf, ...(fallback ? { fallbackFromDay: fallback.fallbackFromDay } : {}),
    });
  }

  const index = createIndex(rows);
  const indexPath = safeOutputPath(outRoot, "daily", "latest", "index.json");
  const indexText = stableJson(index);
  const baselineIndexPath = safeOutputPath(baselineRoot, "daily", "latest", "index.json");
  const baselineIndexText = await readTextMaybe(baselineIndexPath);
  if (baselineIndexText !== indexText) {
    await writeIfChangedAtomic(indexPath, indexText);
    changedFiles.push(relative(outRoot, indexPath).split(sep).join("/"));
  }
  changedFiles.sort();

  const changedFileText = changedFiles.length > 0 ? `${changedFiles.join("\n")}\n` : "";
  await writeIfChangedAtomic(safeOutputPath(outRoot, "changed-files.txt"), changedFileText);

  const counts = { ok: 0, no_playlist: 0, error: 0 };
  if (rows.some((row) => row.status === "stale")) counts.stale = 0;
  for (const row of rows) counts[row.status] += 1;
  const result = {
    exitCode: rows.some((row) => row.status !== "ok") ? 3 : 0,
    changed: changedFiles.length > 0,
    changedFiles,
    channels: rows.map(({ id, status, reason, itemCount, asOf, fallbackFromDay }) => ({
      id, status, reason, itemCount, ...(asOf !== undefined ? { asOf } : {}),
      ...(fallbackFromDay !== undefined ? { fallbackFromDay } : {}),
    })),
    counts,
    reasonCounts,
    unknownShowTokens: [...unknownShowTokens].sort(),
  };
  await appendWorkflowOutputs(result);
  return result;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const config = JSON.parse(await readFile(DEFAULT_CONFIG, "utf8"));
    const result = await runGenerator({ ...args, config });
    for (const channel of result.channels) {
      console.log(
        `channel=${channel.id} status=${channel.status} reason=${channel.reason || "none"} items=${channel.itemCount}`,
      );
    }
    console.log(
      `summary ok=${result.counts.ok} no_playlist=${result.counts.no_playlist} error=${result.counts.error} changed=${result.changed}`,
    );
    process.exitCode = result.exitCode;
  } catch (error) {
    const reason = error instanceof SourceConfigError ? error.code : error?.message;
    console.error(`fatal reason=${/^[a-z0-9_]+$/.test(reason || "") ? reason : "generation_failed"}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
