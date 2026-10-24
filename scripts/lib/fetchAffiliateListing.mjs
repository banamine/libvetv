import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validListingTimeZone } from "./affiliateListing.mjs";
import { assertPublicDns, readBoundedResponseBody, SourceConfigError } from "./fetchSource.mjs";

const MAX_LISTING_BYTES = 2_000_000;

export function validateAffiliateSource(source) {
  if (!source || source.type !== "affiliate-listing" ||
      !/^[a-z0-9][a-z0-9-]{0,127}$/.test(source.id || "") ||
      source.network !== "ajn" || typeof source.loop !== "boolean" ||
      !source.shows || typeof source.shows !== "object" || Array.isArray(source.shows) ||
      !Object.keys(source.shows).length) throw new TypeError("affiliate_source_invalid");
  const checkUrl = (value, host, path) => {
    let url;
    try { url = new URL(value); } catch { throw new TypeError("affiliate_source_url_invalid"); }
    const explicitPort = /^https:\/\/[^/?#]*:\d+(?:[/?#]|$)/i.test(value);
    if (url.protocol !== "https:" || url.hostname !== host || url.pathname !== path ||
        url.port || explicitPort || url.username || url.password || url.search || url.hash) {
      throw new TypeError("affiliate_source_url_invalid");
    }
  };
  if (!validListingTimeZone(source.listingTimeZone)) throw new TypeError("affiliate_timezone_invalid");
  checkUrl(source.listUrl, "www.alexjoneslive.com", "/affiliates/mp4-segs/");
  checkUrl(source.fileBase, "affiliates.alexjoneslive.com", "/mp4-segs/");
  for (const [token, display] of Object.entries(source.shows)) {
    if (!/^[A-Za-z0-9]+$/.test(token) || typeof display !== "string" || !display.trim() ||
        /[\u0000-\u001f\u007f]/.test(display)) throw new TypeError("affiliate_show_config_invalid");
  }
  const allowlist = source.mediaAllowlist;
  const exact = [
    { host: "archive.org", prefix: "/download/" },
    { host: "affiliates.alexjoneslive.com", prefix: "/mp4-segs/" },
  ];
  if (!Array.isArray(allowlist) || allowlist.length !== exact.length ||
      exact.some((rule, index) => allowlist[index]?.host !== rule.host || allowlist[index]?.prefix !== rule.prefix)) {
    throw new TypeError("affiliate_allowlist_invalid");
  }
  return source;
}

async function fixtureListing(source, fixtureDir) {
  try { return await readFile(join(fixtureDir, `affiliate-${source.id}.html`), "utf8"); }
  catch (error) { return error?.code === "ENOENT" ? null : Promise.reject(error); }
}

export async function fetchAffiliateListing(sourceInput, {
  fixtureDir, now = new Date(), fetchImpl = globalThis.fetch, dnsCheck = assertPublicDns,
} = {}) {
  const source = validateAffiliateSource(sourceInput);
  if (fixtureDir) {
    const body = await fixtureListing(source, fixtureDir);
    return body === null ? { ok: false, reason: "fixture_missing" } : { ok: true, body };
  }
  try {
    const url = new URL(source.listUrl);
    await dnsCheck(url.hostname);
    const response = await fetchImpl(url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { accept: "text/html", "user-agent": "libvetv-daily-playlist/1.0" },
    });
    const length = response.headers.get("content-length");
    if (/^\d+$/.test(length || "") && Number(length) > MAX_LISTING_BYTES) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, reason: "source_too_large" };
    }
    const body = await readBoundedResponseBody(response);
    if (Buffer.byteLength(body, "utf8") > MAX_LISTING_BYTES) return { ok: false, reason: "source_too_large" };
    if (response.status !== 200) return { ok: false, reason: "listing_http_status" };
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
      return { ok: false, reason: "listing_content_type" };
    }
    return { ok: true, body, fetchedAt: now.toISOString() };
  } catch (error) {
    if (error instanceof SourceConfigError) return { ok: false, reason: error.code };
    return { ok: false, reason: error?.name === "TimeoutError" ? "listing_timeout" : "listing_fetch_failed" };
  }
}
