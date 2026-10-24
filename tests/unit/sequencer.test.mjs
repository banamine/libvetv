import test from "node:test";
import assert from "node:assert/strict";
import { initialState, transition } from "../../assets/sequencer.js";

test("three-item chain advances on ended and completes without looping", () => {
  let state = transition(initialState(), "start", 3);
  assert.deepEqual(state, { state: "playing", index: 0 });
  state = transition(state, "ended", 3);
  assert.deepEqual(state, { state: "playing", index: 1 });
  state = transition(state, "ended", 3);
  assert.deepEqual(state, { state: "playing", index: 2 });
  state = transition(state, "ended", 3);
  assert.deepEqual(state, { state: "complete", index: 2 });
  assert.deepEqual(transition(state, "ended", 3), state);
});

test("media error can retry the same item", () => {
  let state = transition(initialState(), "start", 3);
  state = transition(state, "error", 3);
  assert.deepEqual(state, { state: "itemError", index: 0 });
  state = transition(state, "retry", 3);
  assert.deepEqual(state, { state: "playing", index: 0 });
});

test("media error advances only after an explicit skip action", () => {
  let state = transition(initialState(), "start", 3);
  state = transition(state, "error", 3);
  assert.deepEqual(transition(state, "ended", 3), state);
  state = transition(state, "skipAfterError", 3);
  assert.deepEqual(state, { state: "playing", index: 1 });
});

test("last-item error can be skipped to completion", () => {
  let state = transition(initialState(), "start", 1);
  state = transition(state, "error", 1);
  assert.deepEqual(transition(state, "skipAfterError", 1), { state: "complete", index: 0 });
});

test("replay starts the completed chain at item one", () => {
  let state = transition(initialState(), "start", 2);
  state = transition(transition(state, "ended", 2), "ended", 2);
  assert.deepEqual(state, { state: "complete", index: 1 });
  assert.deepEqual(transition(state, "replay", 2), { state: "playing", index: 0 });
});

test("jump uses one-based sequence numbers and rejects out-of-range values", () => {
  assert.deepEqual(
    transition(initialState(), { type: "jump", seq: 3 }, 3),
    { state: "playing", index: 2 },
  );
  assert.throws(
    () => transition(initialState(), { type: "jump", seq: 0 }, 3),
    /sequence_out_of_range/,
  );
});

test("empty playlists cannot start or replay into an active state", () => {
  const idle = initialState();
  assert.deepEqual(transition(idle, "start", 0), idle);
  assert.deepEqual(transition(idle, "replay", 0), idle);
});
