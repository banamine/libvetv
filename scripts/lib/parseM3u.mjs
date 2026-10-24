export class M3uParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "M3uParseError";
    this.code = code;
  }
}

function malformed(message) {
  throw new M3uParseError("malformed", message);
}

function findTitleSeparator(value) {
  let quoted = false;
  let escaped = false;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) return i;
  }

  if (quoted || escaped) malformed("Unclosed quoted EXTINF attribute");
  return -1;
}

function parseAttributes(source) {
  const attributes = {};
  let cursor = 0;

  while (cursor < source.length) {
    while (/\s/.test(source[cursor] || "")) cursor += 1;
    if (cursor >= source.length) break;

    const keyMatch = /^[A-Za-z0-9_-]+/.exec(source.slice(cursor));
    if (!keyMatch) malformed("Invalid EXTINF attribute name");
    const key = keyMatch[0];
    cursor += key.length;

    if (source[cursor] !== "=") malformed("EXTINF attribute is missing '='");
    cursor += 1;
    if (source[cursor] !== '"') malformed("EXTINF attribute value must be quoted");
    cursor += 1;

    let value = "";
    let closed = false;
    while (cursor < source.length) {
      const char = source[cursor];
      cursor += 1;
      if (char === "\\" && cursor < source.length) {
        value += source[cursor];
        cursor += 1;
      } else if (char === '"') {
        closed = true;
        break;
      } else {
        value += char;
      }
    }

    if (!closed) malformed("Unclosed EXTINF attribute value");
    if (Object.hasOwn(attributes, key)) malformed("Duplicate EXTINF attribute");
    attributes[key] = value;
    if (cursor < source.length && !/\s/.test(source[cursor])) {
      malformed("EXTINF attributes must be separated by whitespace");
    }
  }

  return attributes;
}

function parseExtinf(line) {
  const payload = line.slice("#EXTINF:".length);
  const separator = findTitleSeparator(payload);
  if (separator < 0) malformed("EXTINF is missing its title separator");

  const header = payload.slice(0, separator);
  const title = payload.slice(separator + 1);
  const durationMatch = /^(-?\d+)(?:\s+([\s\S]*))?$/.exec(header);
  if (!durationMatch) malformed("EXTINF duration must be an integer");

  const durationSec = Number(durationMatch[1]);
  if (!Number.isSafeInteger(durationSec)) malformed("EXTINF duration is outside the safe integer range");

  return {
    durationSec,
    attributes: parseAttributes(durationMatch[2] || ""),
    title: title.trim(),
  };
}

/**
 * Parse a simple extended M3U document into ordered entries.
 * Throws M3uParseError with code "empty" or "malformed" for invalid input.
 */
export function parseM3u(text) {
  if (typeof text !== "string") malformed("M3U input must be text");
  const source = text.replace(/^\uFEFF/, "");
  if (source.trim() === "") throw new M3uParseError("empty", "M3U body is empty");

  const lines = source.split(/\r?\n/);
  const firstNonEmpty = lines.findIndex((line) => line.trim() !== "");
  if (firstNonEmpty < 0 || lines[firstNonEmpty].trim() !== "#EXTM3U") {
    malformed("The first non-empty line must be #EXTM3U");
  }

  const items = [];
  let pending = null;

  for (const rawLine of lines.slice(firstNonEmpty + 1)) {
    const line = rawLine.trim();
    if (line === "") continue;

    if (line.startsWith("#")) {
      if (line.startsWith("#EXTINF:")) {
        if (pending) malformed("EXTINF was not followed by a URL");
        pending = parseExtinf(line);
      }
      continue;
    }

    if (!pending) malformed("URL line has no preceding EXTINF");
    items.push({ ...pending, url: line });
    pending = null;
  }

  if (pending) malformed("EXTINF was not followed by a URL");
  if (items.length === 0) throw new M3uParseError("empty", "M3U contains no items");
  return items;
}
