import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import "./network-guard.mjs";
import { parseM3u } from "../../scripts/lib/parseM3u.mjs";
import { select } from "../../scripts/lib/select.mjs";

const fixturePath = fileURLToPath(
  new URL("../fixtures/cable-tv__ajn-infowars-nightly-news.m3u", import.meta.url),
);
const config = (toleranceSeconds) => ({ targetSeconds: 86400, toleranceSeconds });

test("nightly-news declared durations sum to 87132 and pass the 900-second tolerance", async () => {
  const items = parseM3u(await readFile(fixturePath, "utf8"));
  assert.equal(items.reduce((sum, item) => sum + item.durationSec, 0), 87132);
  const result = select(items, config(900));
  assert.equal(result.status, "ok");
  assert.equal(result.durationBasis, "declared");
  assert.equal(result.declaredTotalSeconds, 87132);
  assert.equal(result.items.length, 8);
});

test("nightly-news fails a 300-second tolerance with the nearest complete prefix", async () => {
  const items = parseM3u(await readFile(fixturePath, "utf8"));
  const prefixes = [];
  let sum = 0;
  for (const entry of items) {
    sum += entry.durationSec;
    prefixes.push(sum);
  }
  assert.equal(prefixes[6], 72798);
  assert.equal(prefixes[7], 87132);
  const result = select(items, config(300));
  assert.deepEqual(result, {
    status: "no_playlist",
    reason: "outside_tolerance",
    nearestPrefixSeconds: 87132,
    itemCount: 8,
  });
});

test("classic-cinema unknown durations publish all eligible items without a duration claim", async () => {
  const path = fileURLToPath(
    new URL("../fixtures/movies-classics-vault__classic-cinema.m3u", import.meta.url),
  );
  const result = select(parseM3u(await readFile(path, "utf8")), config(900));
  assert.equal(result.status, "ok");
  assert.equal(result.durationBasis, "unknown");
  assert.equal(result.declaredTotalSeconds, null);
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every((entry) => entry.durationSec === null));
});

test("chooses the closest complete prefix and breaks equal-distance ties toward shorter", () => {
  const items = [
    { title: "short", durationSec: 40 },
    { title: "long", durationSec: 120 },
  ];
  const result = select(items, { targetSeconds: 100, toleranceSeconds: 60 });
  assert.equal(result.status, "ok");
  assert.equal(result.declaredTotalSeconds, 40);
  assert.equal(result.items.length, 1);
});

test("does not truncate items and returns a truthful empty result", () => {
  const result = select([], config(900));
  assert.deepEqual(result, {
    status: "no_playlist",
    reason: "no_eligible_items",
    nearestPrefixSeconds: null,
    itemCount: 0,
  });
});

test("rejects invalid config and invalid known durations", () => {
  assert.throws(() => select([], { targetSeconds: 0, toleranceSeconds: 1 }), /targetSeconds/);
  assert.throws(() => select([], { targetSeconds: 10, toleranceSeconds: -1 }), /toleranceSeconds/);
  assert.throws(
    () => select([{ durationSec: 0 }], { targetSeconds: 10, toleranceSeconds: 10 }),
    /positive safe integers/,
  );
});
