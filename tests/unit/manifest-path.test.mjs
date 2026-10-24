import test from "node:test";
import assert from "node:assert/strict";
import { isSafeManifestPath, resolveManifestUrl } from "../../assets/manifest-path.js";

const id = "classic-cinema";

test("manifest path module imports under plain Node without a DOM", () => {
  assert.equal(isSafeManifestPath("latest/classic-cinema.json", id), true);
  assert.equal(
    resolveManifestUrl(
      "latest/classic-cinema.json",
      id,
      "https://example.invalid/libvetv/",
    ),
    "https://example.invalid/libvetv/daily/latest/classic-cinema.json",
  );
});

test("manifest path accepts only an exact latest path matching the channel id", () => {
  const invalid = [
    ["https://evil.example/x.json", id],
    ["//evil.example/x.json", id],
    ["/latest/x.json", "x"],
    ["../x.json", "x"],
    ["latest/../x.json", "x"],
    ["latest/../../x.json", "x"],
    ["latest/%2e%2e/x.json", "x"],
    ["latest\\x.json", "x"],
    ["latest/a/b.json", "a"],
    ["latest/x.json?y=1", "x"],
    ["latest/x.json#h", "x"],
    ["latest/X.json", "X"],
    ["latest/x.JSON", "x"],
    ["latest/classic-cinema.json", "another-id"],
    ["", id],
    [null, id],
    [7, id],
    ["latest/x.json", "a".repeat(129)],
  ];
  for (const [value, channelId] of invalid) {
    assert.equal(isSafeManifestPath(value, channelId), false, `${String(value)} / ${channelId}`);
    assert.throws(
      () => resolveManifestUrl(value, channelId, "https://example.invalid/libvetv/"),
      /manifest_path_invalid/,
    );
  }
});

test("manifest URL resolution rejects an invalid base", () => {
  assert.throws(
    () => resolveManifestUrl("latest/classic-cinema.json", id, "not a URL"),
    /base_url_invalid/,
  );
});
