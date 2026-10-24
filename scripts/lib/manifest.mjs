import { createHash } from "node:crypto";

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedValue(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortedValue(value));
}

export function stableJson(value) {
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`;
}

export function computeContentHash({
  channelId, guideId, label, network, sourceType, loop, mediaAllowlist,
  durationBasis, declaredTotalSeconds, items,
}) {
  const content = {
    channelId,
    guideId,
    label,
    ...(network !== undefined ? { network } : {}),
    ...(sourceType !== undefined ? { sourceType } : {}),
    ...(loop !== undefined ? { loop } : {}),
    ...(mediaAllowlist !== undefined ? { mediaAllowlist } : {}),
    durationBasis,
    declaredTotalSeconds,
    items: items.map(({ localId, title, url, durationSec, kind, showId, segments, network: itemNetwork, loop, day, asOf, fallbackFromDay }) => ({
      localId,
      title,
      url,
      durationSec,
      ...(kind === "show" ? {
        kind, showId, segments, ...(itemNetwork !== undefined ? { network: itemNetwork } : {}),
        ...(loop !== undefined ? { loop } : {}), ...(day !== undefined ? { day } : {}),
        ...(asOf !== undefined ? { asOf } : {}),
        ...(fallbackFromDay !== undefined ? { fallbackFromDay } : {}),
      } : {}),
    })),
  };
  return createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");
}

export function createManifest({
  channel,
  config,
  serviceDayUtc,
  sourceGeneratedAt,
  publishedAt,
  selection,
  items,
  excluded,
}) {
  const contentHash = computeContentHash({
    channelId: channel.id,
    guideId: channel.guideId,
    label: channel.label,
    network: channel.network,
    sourceType: channel.sourceType,
    loop: channel.loop,
    mediaAllowlist: channel.mediaAllowlist,
    durationBasis: selection.durationBasis,
    declaredTotalSeconds: selection.declaredTotalSeconds,
    items,
  });
  const uniqueItemCount = new Set(items.map((item) => item.kind === "show"
    ? canonicalJson({ kind: item.kind, showId: item.showId, urls: item.segments.map((part) => part.url) })
    : item.url)).size;
  return {
    schemaVersion: 1,
    playbackMode: "sequential",
    channelId: channel.id,
    guideId: channel.guideId,
    label: channel.label,
    ...(channel.network !== undefined ? { network: channel.network } : {}),
    ...(channel.sourceType !== undefined ? { sourceType: channel.sourceType } : {}),
    ...(channel.loop !== undefined ? { loop: channel.loop } : {}),
    ...(channel.mediaAllowlist !== undefined ? { mediaAllowlist: channel.mediaAllowlist } : {}),
    serviceDayUtc,
    sourceGeneratedAt,
    publishedAt,
    ...(items.some((item) => item.kind === "show" && item.asOf)
      ? { asOf: items.filter((item) => item.kind === "show" && item.asOf)
        .map((item) => item.asOf).sort().at(-1) } : {}),
    contentHash,
    targetSeconds: config.targetSeconds,
    toleranceSeconds: config.toleranceSeconds,
    durationBasis: selection.durationBasis,
    declaredTotalSeconds: selection.declaredTotalSeconds,
    itemCount: items.length,
    uniqueItemCount,
    repeatCount: items.length - uniqueItemCount,
    excluded,
    idNote: "localId is libvetv-local, not an AJN canonical id",
    items: items.map((item, index) => ({
      seq: index + 1,
      localId: item.localId,
      title: item.title,
      url: item.url,
      durationSec: item.durationSec,
      ...(item.kind === "show" ? {
        kind: "show", showId: item.showId, name: item.name, network: item.network,
        loop: item.loop, day: item.day, date: item.date, asOf: item.asOf,
        ...(item.fallbackFromDay !== undefined ? { fallbackFromDay: item.fallbackFromDay } : {}),
        segments: item.segments,
      } : {}),
    })),
  };
}

export function manifestToM3u(manifest) {
  const lines = ["#EXTM3U"];
  for (const item of manifest.items) {
    const segments = item.kind === "show" ? item.segments : [item];
    for (const [index, segment] of segments.entries()) {
      const duration = segment.durationSec === null ? -1 : segment.durationSec;
      lines.push(`#EXTINF:${duration} tvg-id="${manifest.channelId}",${segment.title}`);
      lines.push(segment.url);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function createIndex(channels) {
  return {
    schemaVersion: 1,
    channels: channels.map((entry) => ({
      id: entry.id,
      label: entry.label,
      guideId: entry.guideId,
      status: entry.status,
      reason: entry.reason ?? null,
      manifest: entry.manifest ?? null,
      itemCount: entry.itemCount ?? 0,
      declaredTotalSeconds: entry.declaredTotalSeconds ?? null,
      durationBasis: entry.durationBasis ?? "unknown",
      publishedAt: entry.publishedAt ?? null,
      ...(entry.asOf !== undefined ? { asOf: entry.asOf } : {}),
      ...(entry.fallbackFromDay !== undefined ? { fallbackFromDay: entry.fallbackFromDay } : {}),
    })),
  };
}
