import { ARCHIVE_MEDIA_ALLOWLIST, eligibility } from "./eligibility.js";

function validSegment(item, index, allowlist) {
  return Boolean(item && item.seq === index + 1 &&
    typeof item.localId === "string" && item.localId.length &&
    typeof item.title === "string" &&
    (item.durationSec === null || Number.isSafeInteger(item.durationSec)) &&
    eligibility({ url: item.url, durationSec: item.durationSec === null ? -1 : item.durationSec }, allowlist).ok);
}

function validAffiliateSegments(item, manifestLoop) {
  if (!Array.isArray(item.segments)) return false;
  let previousHour = 0;
  let previousSegment = 0;
  return item.segments.every((segment, index) => {
    const nameMatch = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)-([A-Za-z0-9]+)-Hr(\d{1,2})-Seg(\d{1,2})\.mp4$/.exec(segment.name || "");
    if (!nameMatch || nameMatch[1] !== item.day || nameMatch[2] !== item.showId ||
        !Number.isSafeInteger(Number(nameMatch[3])) || !Number.isSafeInteger(Number(nameMatch[4])) ||
        Number(nameMatch[3]) < 1 || Number(nameMatch[4]) < 1 ||
        typeof segment.modifiedAt !== "string" || !Number.isFinite(Date.parse(segment.modifiedAt)) ||
        !Number.isSafeInteger(segment.sizeBytes) || segment.sizeBytes <= 0 ||
        segment.durationSec !== null || segment.seq !== index + 1) return false;
    const hour = Number(nameMatch[3]);
    const part = Number(nameMatch[4]);
    if (hour < previousHour || (hour === previousHour && part !== previousSegment + 1) ||
        (hour > previousHour && (hour !== previousHour + 1 || part !== 1))) return false;
    previousHour = hour;
    previousSegment = part;
    return true;
  }) && item.loop === manifestLoop;
}

export function validManifestItem(item, index, allowlist = ARCHIVE_MEDIA_ALLOWLIST) {
  if (!validSegment(item, index, allowlist)) return false;
  if (item.kind === undefined) return item.segments === undefined;
  if (item.kind !== "show" || typeof item.showId !== "string" || !item.showId.trim() ||
      !Array.isArray(item.segments) || !item.segments.length ||
      !item.segments.every((part, i) => validSegment(part, i, allowlist) &&
        (part.durationSec === null || part.durationSec > 0)) ||
      item.url !== item.segments[0].url) return false;
  const total = item.segments.some((segment) => segment.durationSec === null)
    ? null : item.segments.reduce((sum, segment) => sum + segment.durationSec, 0);
  return (total === null || Number.isSafeInteger(total)) && item.durationSec === total;
}

export function validManifest(value, channelId) {
  const allowlist = value?.mediaAllowlist ?? ARCHIVE_MEDIA_ALLOWLIST;
  const archiveOnly = Array.isArray(allowlist) && allowlist.length === 1 &&
    allowlist[0]?.host === "archive.org" && allowlist[0]?.prefix === "/download/";
  const affiliateEnabled = Array.isArray(allowlist) && allowlist.length === 2 &&
    allowlist[0]?.host === "archive.org" && allowlist[0]?.prefix === "/download/" &&
    allowlist[1]?.host === "affiliates.alexjoneslive.com" && allowlist[1]?.prefix === "/mp4-segs/";
  const affiliate = value?.sourceType === "affiliate-listing";
  const affiliateItemsValid = !affiliate || (
    value.network === "ajn" && typeof value.loop === "boolean" && affiliateEnabled &&
    value.items?.every((item) => item.kind === "show" && typeof item.showId === "string" &&
      typeof item.name === "string" && typeof item.loop === "boolean" &&
      item.network === "ajn" && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(item.day || "") &&
      /^\d{4}-\d{2}-\d{2}$/.test(item.date || "") &&
      typeof item.asOf === "string" && Number.isFinite(Date.parse(item.asOf)) &&
      item.durationSec === null && validAffiliateSegments(item, value.loop))
  );
  return Boolean(Array.isArray(allowlist) &&
    allowlist.length > 0 && allowlist.every((entry) =>
      typeof entry?.host === "string" && typeof entry?.prefix === "string") &&
    (archiveOnly || affiliateEnabled) &&
    value && value.schemaVersion === 1 && value.channelId === channelId &&
    (value.network === undefined || typeof value.network === "string") &&
    (value.sourceType === undefined || value.sourceType === "affiliate-listing") &&
    (value.loop === undefined || typeof value.loop === "boolean") &&
    (value.mediaAllowlist === undefined || Array.isArray(value.mediaAllowlist)) &&
    Array.isArray(value.items) && value.items.length > 0 &&
    value.items.every((item, index) => validManifestItem(item, index, allowlist)) &&
    affiliateItemsValid);
}
