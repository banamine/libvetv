import { createHash } from "node:crypto";

export class IdCollisionError extends Error {
  constructor() {
    super("Two different URLs produced the same local ID");
    this.name = "IdCollisionError";
    this.code = "id_collision";
  }
}

function sha256Prefix(url) {
  return createHash("sha256").update(url, "utf8").digest("hex").slice(0, 12);
}

function baseId(url, hashUrl) {
  const digest = hashUrl(url);
  if (!/^[a-f0-9]{12}$/.test(digest)) throw new TypeError("hashUrl must return 12 lowercase hex characters");
  return `lv-${digest}`;
}

/**
 * Add deterministic libvetv-local IDs. Repeated URLs get stable -2, -3 suffixes.
 * The optional hashUrl parameter exists to make the collision branch testable.
 */
export function assignLocalIds(items, hashUrl = sha256Prefix) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  if (typeof hashUrl !== "function") throw new TypeError("hashUrl must be a function");

  const seenByUrl = new Map();
  const urlById = new Map();

  return items.map((item) => {
    const url = item?.url;
    if (typeof url !== "string") throw new TypeError("Every item must have a string url");

    const base = baseId(url, hashUrl);
    const previousUrl = urlById.get(base);
    if (previousUrl !== undefined && previousUrl !== url) throw new IdCollisionError();

    const occurrence = (seenByUrl.get(url) || 0) + 1;
    seenByUrl.set(url, occurrence);
    const localId = occurrence === 1 ? base : `${base}-${occurrence}`;

    const urlForId = urlById.get(localId);
    if (urlForId !== undefined && urlForId !== url) throw new IdCollisionError();
    urlById.set(localId, url);
    return {
      ...item, localId,
      ...(item.kind === "show" ? {
        segments: assignLocalIds(item.segments, hashUrl).map((segment, index) => ({ ...segment, seq: index + 1 })),
      } : {}),
    };
  });
}
