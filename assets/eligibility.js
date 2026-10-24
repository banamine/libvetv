const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
export const ARCHIVE_MEDIA_ALLOWLIST = Object.freeze([{ host: "archive.org", prefix: "/download/" }]);
export const KNOWN_MEDIA_ALLOWLIST_ENTRIES = Object.freeze([
  ...ARCHIVE_MEDIA_ALLOWLIST,
  { host: "affiliates.alexjoneslive.com", prefix: "/mp4-segs/" },
]);

export function normalizeTitle(value) {
  if (typeof value !== "string") return "Untitled";
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
    .trim();
  return normalized || "Untitled";
}

function reject(reason) {
  return { ok: false, reason };
}

/**
 * Validate a direct HTTPS MP4 against the fixed Archive default or an explicitly
 * enabled, known affiliate host/path profile. Arbitrary configured hosts are never accepted.
 */
export function eligibility(item, configuredAllowlist = ARCHIVE_MEDIA_ALLOWLIST) {
  const urlText = item?.url;
  if (typeof urlText !== "string") return reject("bad_url");
  if (CONTROL_CHARACTERS.test(urlText) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(urlText)) {
    return reject("control_chars");
  }
  if (urlText.length > 2048) return reject("too_long");

  if (
    urlText.startsWith("/") ||
    urlText.startsWith("./") ||
    urlText.startsWith("../") ||
    !SCHEME_PREFIX.test(urlText)
  ) {
    return reject("relative_url");
  }

  let url;
  try {
    url = new URL(urlText);
  } catch {
    return reject("bad_url");
  }

  if (url.protocol !== "https:") return reject("not_https");
  const explicitPort = /^https:\/\/(?:[^/@]+@)?[^/?:#]+:\d+(?:[/?#]|$)/i.test(urlText);
  const allowlist = Array.isArray(configuredAllowlist) ? configuredAllowlist : ARCHIVE_MEDIA_ALLOWLIST;
  const allowed = allowlist.some((entry) => KNOWN_MEDIA_ALLOWLIST_ENTRIES.some((known) =>
    known.host === entry?.host && known.prefix === entry?.prefix && url.port === "" && !explicitPort &&
    url.hostname.toLowerCase() === known.host && url.pathname.startsWith(known.prefix)));
  if (!allowed) {
    if (url.hostname.toLowerCase() === "archive.org" && url.port === "") return reject("not_download_path");
    return reject("host_not_archive");
  }
  if (!url.pathname.toLowerCase().endsWith(".mp4")) return reject("not_mp4");
  if (url.username !== "" || url.password !== "") return reject("has_credentials");
  if (url.search !== "" || url.hash !== "") return reject("has_query");

  const durationSec = item?.durationSec;
  if (durationSec !== -1 && (!Number.isSafeInteger(durationSec) || durationSec < 1)) {
    return reject("bad_duration");
  }

  return { ok: true, kind: "video" };
}
