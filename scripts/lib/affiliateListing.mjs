import { eligibility } from "../../assets/eligibility.js";

const FILENAME = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)-([A-Za-z0-9]+)-Hr(\d{1,2})-Seg(\d{1,2})\.mp4$/;
const MONTHS = new Map([
  ["jan", 0], ["feb", 1], ["mar", 2], ["apr", 3], ["may", 4], ["jun", 5],
  ["jul", 6], ["aug", 7], ["sep", 8], ["oct", 9], ["nov", 10], ["dec", 11],
]);
const HTML_ENTITY = /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi;

function decodeHtml(value) {
  return String(value).replace(HTML_ENTITY, (entity, key) => {
    const lower = key.toLowerCase();
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    if (lower in named) return named[lower];
    const point = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number(lower.slice(1));
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : entity;
  });
}

function cellText(html) {
  return decodeHtml(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function sizeBytes(value) {
  const match = /^([\d,]+(?:\.\d+)?)\s*(B|bytes?|KB|MB|GB|TB|KiB|MiB|GiB|TiB)?$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1].replaceAll(",", ""));
  const unit = (match[2] || "B").toLowerCase();
  const power = unit.startsWith("k") ? 1 : unit.startsWith("m") ? 2 : unit.startsWith("g") ? 3 : unit.startsWith("t") ? 4 : 0;
  const base = unit.endsWith("ib") ? 1024 : 1000;
  const result = Math.round(amount * base ** power);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function yearlessTimestamp(value, nowMs) {
  const cleaned = value.trim().replace(/^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?),?\s+/i, "");
  const match = /^([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s*(\d{4}))?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?:\s*(UTC|GMT|Z))?$/i.exec(cleaned);
  const monthKey = match?.[1]?.slice(0, 3).toLowerCase();
  if (!match || !MONTHS.has(monthKey)) return NaN;
  const month = MONTHS.get(monthKey);
  const day = Number(match[2]);
  let year = match[3] ? Number(match[3]) : new Date(nowMs).getUTCFullYear();
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  if (match[7]) {
    if (hour < 1 || hour > 12) return NaN;
    hour %= 12;
    if (match[7].toUpperCase() === "PM") hour += 12;
  }
  const timestamp = Date.UTC(year, month, day, hour, minute, second);
  const check = new Date(timestamp);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day ||
      hour > 23 || minute > 59 || second > 59) return NaN;
  if (!match[3] && timestamp > nowMs + 86_400_000) {
    year -= 1;
    return Date.UTC(year, month, day, hour, minute, second);
  }
  return timestamp;
}

function parseModified(value, nowMs) {
  const inferred = yearlessTimestamp(value, nowMs);
  if (Number.isFinite(inferred) ||
      /^(?:(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?),?\s+)?[A-Za-z]{3,9}\s+\d{1,2}\b/i.test(value.trim())) return inferred;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return NaN;
  // A listing timestamp that explicitly omits a year can be parsed as an old
  // default year by JS. Only retry a syntactically recognized yearless form above.
  return parsed;
}

// The real listing (verified 2026-10-24) is a <pre> tree, one line per file:
//   ├── [  385199345 Oct 23 11:08]    <a href="...">Fri-Alex-Hr1-Seg1.mp4</a>
// Files older than ~6 months may show "Oct 23  2025" instead of a time.
const PRE_LINE = /\[\s*(\d+)\s+([A-Za-z]{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4}))\s*\]\s*<a\b[^>]*>([^<]+)<\/a\s*>/g;

function parsePreRows(html) {
  const result = [];
  for (const [, size, when, name] of html.matchAll(PRE_LINE)) {
    const modified = /\d:\d{2}$/.test(when) ? when : `${when} 00:00`;
    result.push({ filename: cellText(name), cells: [size, modified.replace(/\s+/g, " ")] });
  }
  return result;
}

function zoneOffsetMs(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(ms).map((part) => [part.type, part.value]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    Math.floor(ms / 1000) * 1000;
}

// Convert a wall-clock time (expressed as if it were UTC) in `timeZone` to a real UTC instant.
function localToUtc(localAsUtcMs, timeZone) {
  if (!timeZone) return localAsUtcMs;
  let utc = localAsUtcMs - zoneOffsetMs(localAsUtcMs, timeZone);
  utc = localAsUtcMs - zoneOffsetMs(utc, timeZone);
  return utc;
}

export function validListingTimeZone(value) {
  if (value === undefined) return true;
  if (typeof value !== "string" || !/^[A-Za-z_]+(?:\/[A-Za-z_+\-0-9]+){0,2}$|^UTC$/.test(value)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}

function parseRows(html) {
  const result = [];
  for (const [, row] of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)].map((match) => match[1]);
    if (cells.length < 3) continue;
    const anchor = row.match(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/i);
    const filename = cellText(anchor?.[1] ?? cells.find((cell) => FILENAME.test(cellText(cell))) ?? "");
    if (filename) result.push({ filename, cells: cells.map(cellText) });
  }
  return result.length ? result : parsePreRows(html);
}

function completeSet(rows) {
  if (!rows.length) return false;
  const byHour = new Map();
  for (const row of rows) {
    if (!byHour.has(row.hour)) byHour.set(row.hour, new Set());
    const segments = byHour.get(row.hour);
    if (segments.has(row.segment)) return false;
    segments.add(row.segment);
  }
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  if (hours.some((hour, index) => hour !== index + 1)) return false;
  for (const hour of hours) {
    const segments = [...byHour.get(hour)].sort((a, b) => a - b);
    if (segments.some((segment, index) => segment !== index + 1)) return false;
  }
  return true;
}

export function parseAffiliateListing(html, { shows, fileBase, now = new Date(), timeZone } = {}) {
  if (typeof html !== "string" || !shows || typeof shows !== "object") throw new TypeError("affiliate_listing_invalid");
  const base = new URL(fileBase);
  if (base.protocol !== "https:" || base.hostname !== "affiliates.alexjoneslive.com" ||
      base.pathname !== "/mp4-segs/" || base.search || base.hash || base.port ||
      base.username || base.password) throw new TypeError("affiliate_file_base_invalid");
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("affiliate_clock_invalid");
  if (!validListingTimeZone(timeZone)) throw new TypeError("affiliate_timezone_invalid");
  const rows = [];
  const reasonCounts = {};
  const unknownShowTokens = new Set();
  const reject = (reason) => { reasonCounts[reason] = (reasonCounts[reason] || 0) + 1; };
  for (const parsedRow of parseRows(html)) {
    const match = FILENAME.exec(parsedRow.filename);
    if (!match) { reject("invalid_filename"); continue; }
    const [, day, showToken, hourText, segmentText] = match;
    const displayName = shows[showToken];
    if (typeof displayName !== "string" || !displayName.trim()) {
      reject("unknown_show"); unknownShowTokens.add(showToken); continue;
    }
    const hour = Number(hourText);
    const segment = Number(segmentText);
    if (hour < 1 || hour > 99 || segment < 1 || segment > 99) { reject("invalid_filename"); continue; }
    const size = parsedRow.cells.map(sizeBytes).find((value) => value !== null);
    if (!size) { reject("invalid_size"); continue; }
    const listed = parsedRow.cells.map((value) => parseModified(value, nowMs)).find(Number.isFinite);
    if (!Number.isFinite(listed)) { reject("invalid_timestamp"); continue; }
    // A day-set is the files listed on one calendar date in the listing's own time zone.
    const listedDate = new Date(listed).toISOString().slice(0, 10);
    const modified = localToUtc(listed, timeZone);
    const url = new URL(encodeURIComponent(parsedRow.filename), base).href;
    rows.push({
      name: parsedRow.filename, url, sizeBytes: size, modifiedMs: modified, listedDate,
      showToken, displayName: displayName.trim(), day, hour, segment,
    });
  }
  return { rows, reasonCounts, unknownShowTokens: [...unknownShowTokens].sort() };
}

export function selectAffiliateShows(rows, source, now = new Date()) {
  const byShow = new Map();
  for (const row of rows) {
    if (!byShow.has(row.showToken)) byShow.set(row.showToken, new Map());
    const days = byShow.get(row.showToken);
    const date = row.listedDate ?? new Date(row.modifiedMs).toISOString().slice(0, 10);
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(row);
  }
  const shows = [];
  const reasonCounts = {};
  const reject = (reason) => { reasonCounts[reason] = (reasonCounts[reason] || 0) + 1; };
  for (const [showToken, days] of byShow) {
    const sets = [...days].map(([date, entries]) => ({
      date, entries, maxModified: Math.max(...entries.map((row) => row.modifiedMs)),
      weekday: entries[0]?.day,
      complete: entries.every((row) => row.day === entries[0]?.day) && completeSet(entries),
      eligible: entries.every((row) => eligibility({
        url: row.url, durationSec: -1,
      }, source.mediaAllowlist).ok),
    })).sort((a, b) => b.maxModified - a.maxModified);
    for (const set of sets) if (!set.eligible) reject("segment_ineligible");
    const newest = sets[0];
    const chosen = newest.complete && newest.eligible
      ? newest : sets.slice(1).find((set) => set.complete && set.eligible && set.maxModified < newest.maxModified);
    if (!chosen) {
      if (sets.every((set) => !set.complete)) reject("no_complete_day_set");
      continue;
    }
    const rowsOrdered = [...chosen.entries].sort((a, b) => a.hour - b.hour || a.segment - b.segment);
    const asOfMs = Math.max(...rowsOrdered.map((row) => row.modifiedMs));
    const asOf = new Date(asOfMs).toISOString();
    const segments = rowsOrdered.map((row, index) => ({
      seq: index + 1, name: row.name, localId: "", title: `${row.displayName} — Hour ${row.hour}, segment ${row.segment}`,
      url: row.url, durationSec: null, sizeBytes: row.sizeBytes,
      modifiedAt: new Date(row.modifiedMs).toISOString(),
    }));
    shows.push({
      kind: "show", showId: showToken, name: rowDisplay(source, showToken), title: rowDisplay(source, showToken),
      network: source.network, loop: source.loop === true, day: chosen.weekday, date: chosen.date, asOf,
      ...(newest === chosen ? {} : { fallbackFromDay: newest.date }), durationSec: null, segments,
    });
  }
  return { shows, reasonCounts };
}

function rowDisplay(source, token) {
  return source.shows[token].trim();
}
