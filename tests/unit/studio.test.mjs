import test from "node:test";
import assert from "node:assert/strict";
import "./network-guard.mjs";
import { bufferedAhead, formatClock, playerState } from "../../assets/studio.js";

test("formatClock renders measured seconds and an em dash for unmeasured values", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(65.9), "1:05");
  assert.equal(formatClock(3725), "1:02:05");
  for (const value of [NaN, Infinity, -1, undefined, null]) assert.equal(formatClock(value), "—");
});

test("playerState reports only what the element says", () => {
  assert.equal(playerState(null), "No player loaded");
  assert.equal(playerState({ error: { code: 4 }, currentSrc: "x" }), "Error (code 4)");
  assert.equal(playerState({ currentSrc: "" }), "Idle");
  assert.equal(playerState({ currentSrc: "x", ended: true }), "Ended");
  assert.equal(playerState({ currentSrc: "x", paused: true }), "Paused");
  assert.equal(playerState({ currentSrc: "x", paused: false, readyState: 2 }), "Buffering");
  assert.equal(playerState({ currentSrc: "x", paused: false, readyState: 4 }), "Playing");
});

test("bufferedAhead is null when the playhead is outside every buffered range", () => {
  const ranges = (list) => ({
    length: list.length,
    start: (i) => list[i][0],
    end: (i) => list[i][1],
  });
  assert.equal(bufferedAhead({ currentTime: 5, buffered: ranges([[0, 12.5]]) }), 7.5);
  assert.equal(bufferedAhead({ currentTime: 20, buffered: ranges([[0, 12.5]]) }), null);
  assert.equal(bufferedAhead({ currentTime: 1, buffered: ranges([]) }), null);
  assert.equal(bufferedAhead({ get buffered() { throw new Error("detached"); }, currentTime: 0 }), null);
});
