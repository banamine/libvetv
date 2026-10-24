import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "./network-guard.mjs";
import { assignLocalIds, IdCollisionError } from "../../scripts/lib/ids.mjs";

const hash = (url) => createHash("sha256").update(url, "utf8").digest("hex").slice(0, 12);

test("local IDs are deterministic and use the specified prefix and hash", () => {
  const url = "https://archive.org/download/item/file.mp4";
  const first = assignLocalIds([{ url }]);
  const second = assignLocalIds([{ url }]);
  assert.equal(first[0].localId, `lv-${hash(url)}`);
  assert.deepEqual(first, second);
});

test("exact repeated URLs receive stable one-based occurrence suffixes after the first", () => {
  const url = "https://archive.org/download/item/file.mp4";
  const items = assignLocalIds([{ url }, { url }, { url }]);
  assert.deepEqual(items.map((item) => item.localId), [
    `lv-${hash(url)}`,
    `lv-${hash(url)}-2`,
    `lv-${hash(url)}-3`,
  ]);
});

test("different URLs with a colliding 12-hex digest fail explicitly", () => {
  const first = "https://archive.org/download/item/first.mp4";
  const second = "https://archive.org/download/item/second.mp4";
  assert.throws(
    () => assignLocalIds([{ url: first }, { url: second }], () => "0123456789ab"),
    (error) => error instanceof IdCollisionError && error.code === "id_collision",
  );
});

test("requires a URL for each item", () => {
  assert.throws(() => assignLocalIds([{ title: "missing" }]), /string url/);
});
