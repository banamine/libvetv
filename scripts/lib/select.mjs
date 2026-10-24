function invalidConfig(message) {
  throw new TypeError(`Invalid selection config: ${message}`);
}

/**
 * Select an ordered prefix near the target duration, without truncating items.
 * Unknown duration on any eligible item disables all 24-hour duration claims.
 */
export function select(items, cfg) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  const targetSeconds = cfg?.targetSeconds;
  const toleranceSeconds = cfg?.toleranceSeconds;

  if (!Number.isSafeInteger(targetSeconds) || targetSeconds < 1) {
    invalidConfig("targetSeconds must be a positive safe integer");
  }
  if (!Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 0) {
    invalidConfig("toleranceSeconds must be a non-negative safe integer");
  }

  const normalized = items.map((item) => ({
    ...item,
    durationSec: item.durationSec === -1 ? null : item.durationSec,
  }));
  if (normalized.length === 0) {
    return {
      status: "no_playlist",
      reason: "no_eligible_items",
      nearestPrefixSeconds: null,
      itemCount: 0,
    };
  }

  if (normalized.some((item) => item.durationSec === null)) {
    return {
      status: "ok",
      items: normalized,
      durationBasis: "unknown",
      declaredTotalSeconds: null,
    };
  }

  for (const item of normalized) {
    if (!Number.isSafeInteger(item.durationSec) || item.durationSec < 1) {
      throw new TypeError("Known item durations must be positive safe integers");
    }
  }

  const prefixes = [];
  let total = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    total += normalized[index].durationSec;
    if (!Number.isSafeInteger(total)) throw new RangeError("Playlist duration exceeds safe integer range");
    prefixes.push({ seconds: total, count: index + 1 });
  }

  const byClosenessThenShorter = (a, b) => {
    const distance = Math.abs(a.seconds - targetSeconds) - Math.abs(b.seconds - targetSeconds);
    return distance || a.seconds - b.seconds;
  };
  const closest = [...prefixes].sort(byClosenessThenShorter)[0];
  const inTolerance = prefixes
    .filter((prefix) => Math.abs(prefix.seconds - targetSeconds) <= toleranceSeconds)
    .sort(byClosenessThenShorter);

  if (inTolerance.length === 0) {
    return {
      status: "no_playlist",
      reason: "outside_tolerance",
      nearestPrefixSeconds: closest.seconds,
      itemCount: closest.count,
    };
  }

  const chosen = inTolerance[0];
  return {
    status: "ok",
    items: normalized.slice(0, chosen.count),
    durationBasis: "declared",
    declaredTotalSeconds: chosen.seconds,
  };
}
