import test from "node:test";
import assert from "node:assert/strict";
import { isReplacementCandidate } from "../../assets/daily-playlist.js";

const row = {
  id: "demo-channel",
  status: "ok",
  manifest: "latest/demo-channel.json",
  itemCount: 1,
};

const manifest = {
  schemaVersion: 1,
  channelId: "demo-channel",
  items: [{
    seq: 1,
    localId: "lv-0123456789ab",
    title: "DEMO — synthetic item",
    url: "https://archive.org/download/demo/item.mp4",
    durationSec: null,
  }],
};

test("replacement requires an ok or stale row, a non-empty valid manifest, and eligible media", () => {
  assert.equal(isReplacementCandidate(row, manifest), true);
  assert.equal(isReplacementCandidate({ ...row, status: "stale" }, manifest), true);
  assert.equal(isReplacementCandidate({ ...row, status: "error" }, manifest), false);
  assert.equal(isReplacementCandidate({ ...row, status: "no_playlist" }, manifest), false);
  assert.equal(isReplacementCandidate({ ...row, itemCount: 0 }, manifest), false);
  assert.equal(isReplacementCandidate(row, { ...manifest, items: [] }), false);
  assert.equal(isReplacementCandidate(row, {
    ...manifest,
    items: [{ ...manifest.items[0], url: "https://example.invalid/not-allowed.mp4" }],
  }), false);
});
