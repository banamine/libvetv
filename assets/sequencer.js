const STATES = new Set(["idle", "playing", "itemError", "complete"]);

function validateCount(itemCount) {
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
    throw new TypeError("item_count_invalid");
  }
}

function validateState(state, itemCount) {
  if (!state || !STATES.has(state.state) || !Number.isSafeInteger(state.index)) {
    throw new TypeError("sequencer_state_invalid");
  }
  if (itemCount === 0 ? state.index !== 0 : state.index < 0 || state.index >= itemCount) {
    throw new TypeError("sequencer_index_invalid");
  }
}

function result(state, index) {
  return { state, index };
}

export function transition(current, action, itemCount) {
  validateCount(itemCount);
  validateState(current, itemCount);

  const type = typeof action === "string" ? action : action?.type;
  if (type === "start") {
    return current.state === "idle" && itemCount > 0
      ? result("playing", 0)
      : current;
  }
  if (type === "ended") {
    if (current.state !== "playing") return current;
    return current.index + 1 >= itemCount
      ? result("complete", current.index)
      : result("playing", current.index + 1);
  }
  if (type === "error") {
    return current.state === "playing" ? result("itemError", current.index) : current;
  }
  if (type === "retry") {
    return current.state === "itemError" ? result("playing", current.index) : current;
  }
  if (type === "skipAfterError") {
    if (current.state !== "itemError") return current;
    return current.index + 1 >= itemCount
      ? result("complete", current.index)
      : result("playing", current.index + 1);
  }
  if (type === "jump") {
    const sequence = typeof action === "object" ? action.seq : undefined;
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > itemCount) {
      throw new RangeError("sequence_out_of_range");
    }
    return result("playing", sequence - 1);
  }
  if (type === "replay") {
    return itemCount > 0 ? result("playing", 0) : result("idle", 0);
  }
  throw new TypeError("sequencer_action_invalid");
}

export function initialState() {
  return result("idle", 0);
}
