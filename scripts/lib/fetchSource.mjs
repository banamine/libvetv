import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseM3u, M3uParseError } from "./parseM3u.mjs";

export const MAX_SOURCE_BYTES = 2_000_000;

export class SourceConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceConfigError";
    this.code = code;
  }
}

function forbiddenHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home") ||
    host.endsWith(".test") ||
    host.endsWith(".invalid") ||
    host === "archive.org" ||
    host.endsWith(".archive.org")
  );
}

export function validateExportBaseUrl(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new SourceConfigError("missing_export_base_url");
  }
  if (/[\u0000-\u0020\u007f]/.test(value)) {
    throw new SourceConfigError("invalid_export_base_url");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new SourceConfigError("invalid_export_base_url");
  }

  if (parsed.protocol !== "https:") throw new SourceConfigError("export_base_not_https");
  if (parsed.username !== "" || parsed.password !== "") {
    throw new SourceConfigError("export_base_has_credentials");
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new SourceConfigError("export_base_has_path");
  }
  if (parsed.port !== "") throw new SourceConfigError("export_base_has_port");
  if (isIP(parsed.hostname) !== 0 || forbiddenHostname(parsed.hostname)) {
    throw new SourceConfigError("export_base_host_not_public");
  }
  return parsed.origin;
}

function isPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168)) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1") return false;
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice("::ffff:".length);
      return isIP(mapped) === 4 && isPublicAddress(mapped);
    }
    const firstHextet = Number.parseInt(normalized.split(":")[0] || "0", 16);
    return (firstHextet & 0xe000) === 0x2000 && !normalized.startsWith("2001:db8:");
  }
  return false;
}

async function assertPublicDns(hostname, lookupImpl = lookup) {
  let addresses;
  try {
    addresses = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch {
    throw new SourceConfigError("export_base_dns_failed");
  }
  if (
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    addresses.some((entry) => !isPublicAddress(entry.address))
  ) {
    throw new SourceConfigError("export_base_host_not_public");
  }
}

function headerValue(headers, expected) {
  if (!headers || typeof headers !== "object") return "";
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === expected);
  return key ? String(headers[key] ?? "") : "";
}

function validIsoDate(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, zoneHourText, zoneMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  if (zone !== "Z" && (Number(zoneHourText) > 23 || Number(zoneMinuteText) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

export function validateSourceResponse({ status, headers, body }, limits, now) {
  if (status !== 200) return { ok: false, reason: "http_status" };
  const contentType = headerValue(headers, "content-type").toLowerCase();
  if (!contentType.includes("mpegurl")) return { ok: false, reason: "content_type" };

  const generatedAt = headerValue(headers, "x-ajn-generated-at");
  if (!validIsoDate(generatedAt)) return { ok: false, reason: "invalid_generated_at" };
  const ageSeconds = (now.getTime() - Date.parse(generatedAt)) / 1000;
  if (ageSeconds > limits.maxSourceAgeSeconds) return { ok: false, reason: "stale_source" };
  if (ageSeconds < -limits.maxFutureSkewSeconds) return { ok: false, reason: "future_source" };
  if (typeof body !== "string") return { ok: false, reason: "invalid_body" };
  if (Buffer.byteLength(body, "utf8") > MAX_SOURCE_BYTES) {
    return { ok: false, reason: "source_too_large" };
  }

  try {
    return { ok: true, generatedAt, items: parseM3u(body) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof M3uParseError ? error.code : "malformed",
    };
  }
}

async function readFixture(channel, fixtureDir) {
  const prefix = `${channel.guideId}__${channel.id}`;
  try {
    const [body, sidecarText] = await Promise.all([
      readFile(join(fixtureDir, `${prefix}.m3u`), "utf8"),
      readFile(join(fixtureDir, `${prefix}.headers.json`), "utf8"),
    ]);
    const sidecar = JSON.parse(sidecarText);
    return {
      status: sidecar.status,
      headers: sidecar.headers,
      body,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { error: "fixture_missing" };
    if (error instanceof SyntaxError) return { error: "fixture_headers_invalid" };
    return { error: "fixture_read_failed" };
  }
}

async function fetchRemote(channel, baseOrigin) {
  const base = new URL(baseOrigin);
  await assertPublicDns(base.hostname);

  const url = new URL(
    `/api/channels/${encodeURIComponent(channel.id)}/playlist.m3u`,
    baseOrigin,
  );
  url.searchParams.set("guide", channel.guideId);

  try {
    const response = await globalThis.fetch(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "audio/x-mpegurl" },
    });
    const contentLength = response.headers.get("content-length");
    if (/^\d+$/.test(contentLength || "") && Number(contentLength) > MAX_SOURCE_BYTES) {
      await response.body?.cancel().catch(() => {});
      return { error: "source_too_large" };
    }
    const body = await readBoundedResponseBody(response);
    return {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") || "",
        "x-ajn-generated-at": response.headers.get("x-ajn-generated-at") || "",
      },
      body,
    };
  } catch (error) {
    if (error instanceof SourceConfigError) {
      return { error: error.code };
    }
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      return { error: "source_timeout" };
    }
    return { error: "source_fetch_failed" };
  }
}

export async function readBoundedResponseBody(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_SOURCE_BYTES) {
        await reader.cancel();
        throw new SourceConfigError("source_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SourceConfigError("source_invalid_utf8");
  }
}

export async function fetchChannelSource(channel, options) {
  const envelope = options.fixtureDir
    ? await readFixture(channel, options.fixtureDir)
    : await fetchRemote(channel, options.baseOrigin);
  if (envelope.error) return { ok: false, reason: envelope.error };
  return validateSourceResponse(envelope, options.limits, options.now);
}
