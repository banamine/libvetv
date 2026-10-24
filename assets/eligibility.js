const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;

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
 * Validate an item for the first Daily Playlist release.
 * Only direct HTTPS Archive.org MP4 downloads without query/hash are accepted.
 */
export function eligibility(item) {
  const urlText = item?.url;
  if (typeof urlText !== "string") return reject("bad_url");
  if (CONTROL_CHARACTERS.test(urlText)) return reject("control_chars");
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
  if (url.hostname.toLowerCase() !== "archive.org" || url.port !== "") {
    return reject("host_not_archive");
  }
  if (!url.pathname.startsWith("/download/")) return reject("not_download_path");
  if (!url.pathname.toLowerCase().endsWith(".mp4")) return reject("not_mp4");
  if (url.username !== "" || url.password !== "") return reject("has_credentials");
  if (url.search !== "" || url.hash !== "") return reject("has_query");

  const durationSec = item?.durationSec;
  if (durationSec !== -1 && (!Number.isSafeInteger(durationSec) || durationSec < 1)) {
    return reject("bad_duration");
  }

  return { ok: true, kind: "video" };
}
