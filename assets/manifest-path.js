const CHANNEL_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const MANIFEST_PATH = /^latest\/([a-z0-9][a-z0-9-]{0,127})\.json$/;

export function isSafeManifestPath(value, channelId) {
  if (typeof value !== "string" || typeof channelId !== "string") return false;
  if (!CHANNEL_ID.test(channelId)) return false;
  const match = MANIFEST_PATH.exec(value);
  return Boolean(match && match[1] === channelId);
}

export function resolveManifestUrl(value, channelId, baseUrl) {
  if (!isSafeManifestPath(value, channelId)) {
    throw new TypeError("manifest_path_invalid");
  }

  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new TypeError("base_url_invalid");
  }

  const resolved = new URL(`./daily/${value}`, base);
  const expectedSuffix = `/daily/${value}`;
  if (resolved.origin !== base.origin || !resolved.pathname.endsWith(expectedSuffix)) {
    throw new TypeError("manifest_url_invalid");
  }
  return resolved.href;
}
