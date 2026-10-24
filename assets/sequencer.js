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

export function transition(current, action, itemsOrCount) {
  const items = Array.isArray(itemsOrCount) ? itemsOrCount : null;
  const itemCount = items ? items.length : itemsOrCount;
  validateCount(itemCount);
  validateState(current, itemCount);
  const segmentCount = (index) => items?.[index]?.kind === "show" ? items[index].segments.length : 1;
  const segment = current.segmentIndex ?? 0;
  if (items && (!Number.isSafeInteger(segment) || segment < 0 ||
      (itemCount > 0 && segment >= segmentCount(current.index)))) throw new TypeError("segment_index_invalid");
  const next = (state, index, segmentIndex = 0) =>
    ({ ...result(state, index), ...(items ? { segmentIndex } : {}) });
  const advance = () => {
    if (items && segment + 1 < segmentCount(current.index)) {
      return next("playing", current.index, segment + 1);
    }
    return current.index + 1 >= itemCount
      ? next("complete", current.index, segment)
      : next("playing", current.index + 1);
  };

  const type = typeof action === "string" ? action : action?.type;
  if (type === "start") {
    return current.state === "idle" && itemCount > 0
      ? next("playing", 0)
      : current;
  }
  if (type === "ended") {
    if (current.state !== "playing") return current;
    return advance();
  }
  if (type === "loopShow") {
    if (!items || current.state !== "playing" || items[current.index]?.kind !== "show") return current;
    return next("playing", current.index, 0);
  }
  if (type === "skipShow") {
    if (!items || current.state !== "itemError" || items[current.index]?.kind !== "show") return current;
    return current.index + 1 >= itemCount
      ? next("complete", current.index, segment)
      : next("playing", current.index + 1);
  }
  if (type === "error") {
    return current.state === "playing" ? next("itemError", current.index, segment) : current;
  }
  if (type === "retry") {
    return current.state === "itemError" ? next("playing", current.index, segment) : current;
  }
  if (type === "skipAfterError") {
    if (current.state !== "itemError") return current;
    return advance();
  }
  if (type === "jump") {
    const sequence = typeof action === "object" ? action.seq : undefined;
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > itemCount) {
      throw new RangeError("sequence_out_of_range");
    }
    return next("playing", sequence - 1);
  }
  if (type === "replay") {
    return itemCount > 0 ? next("playing", 0) : next("idle", 0);
  }
  throw new TypeError("sequencer_action_invalid");
}

export function initialState() {
  return result("idle", 0);
}
