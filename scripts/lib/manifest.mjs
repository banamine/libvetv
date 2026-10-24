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

export function computeContentHash({ channelId, guideId, label, durationBasis, declaredTotalSeconds, items }) {
  const content = {
    channelId,
    guideId,
    label,
    durationBasis,
    declaredTotalSeconds,
    items: items.map(({ localId, title, url, durationSec }) => ({
      localId,
      title,
      url,
      durationSec,
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
    durationBasis: selection.durationBasis,
    declaredTotalSeconds: selection.declaredTotalSeconds,
    items,
  });
  const uniqueItemCount = new Set(items.map((item) => item.url)).size;
  return {
    schemaVersion: 1,
    playbackMode: "sequential",
    channelId: channel.id,
    guideId: channel.guideId,
    label: channel.label,
    serviceDayUtc,
    sourceGeneratedAt,
    publishedAt,
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
    })),
  };
}

export function manifestToM3u(manifest) {
  const lines = ["#EXTM3U"];
  for (const item of manifest.items) {
    const duration = item.durationSec === null ? -1 : item.durationSec;
    lines.push(`#EXTINF:${duration} tvg-id="${manifest.channelId}",${item.title}`);
    lines.push(item.url);
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
    })),
  };
}
