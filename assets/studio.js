// Studio shell for the redesigned index page.
//
// This file only adds layout behaviour around the Daily Playlist module (daily-playlist.js):
// Focus mode, the mobile bottom sheets, and read-only Media / Monitor / Telemetry docks.
// Every number shown is read from the real <video> element or the browser's own
// PerformanceResourceTiming entries. Nothing is simulated, and when a value cannot be
// measured the dock says so with an em dash.

const FOCUS_KEY = "libvetv:studio:focus";
const DASH = "—";
const SHEETS = ["rundown", "media", "monitor", "telemetry"];

function createElement(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

export function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return DASH;
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function bufferedAhead(video) {
  try {
    const ranges = video.buffered;
    for (let i = 0; i < ranges.length; i += 1) {
      if (video.currentTime >= ranges.start(i) && video.currentTime <= ranges.end(i)) {
        return Math.max(0, ranges.end(i) - video.currentTime);
      }
    }
  } catch {
    // buffered can throw on a detached or errored element.
  }
  return null;
}

export function playerState(video) {
  if (!video) return "No player loaded";
  if (video.error) return `Error (code ${video.error.code})`;
  if (!video.currentSrc) return "Idle";
  if (video.ended) return "Ended";
  if (video.paused) return "Paused";
  return video.readyState < 3 ? "Buffering" : "Playing";
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return DASH;
  }
}

function readStoredFocus() {
  try {
    return window.localStorage.getItem(FOCUS_KEY) === "true";
  } catch {
    return false;
  }
}

function storeFocus(value) {
  try {
    window.localStorage.setItem(FOCUS_KEY, value ? "true" : "false");
  } catch {
    // Focus mode still works for this page view when storage is unavailable.
  }
}

function buildDock(id, title, rows) {
  const section = createElement("section", "st-dock");
  section.id = `st-${id}`;
  const headingId = `st-${id}-title`;
  section.setAttribute("aria-labelledby", headingId);
  const head = createElement("div", "st-dock-head");
  const heading = createElement("h3", "st-dock-title", title);
  heading.id = headingId;
  const close = createElement("button", "dp-button st-sheet-close", "Close");
  close.type = "button";
  close.dataset.closeSheet = "true";
  head.append(heading, close);
  const list = createElement("dl", "st-kv");
  const cells = {};
  for (const [key, label] of rows) {
    const dt = createElement("dt", "", label);
    const dd = createElement("dd", "", DASH);
    list.append(dt, dd);
    cells[key] = dd;
  }
  section.append(head, list);
  return { section, cells };
}

function initializeStudio() {
  const panel = document.getElementById("dp-panel");
  const focusButton = document.getElementById("st-focus");
  if (!panel || !focusButton) return;

  const rundownTitle = createElement("h3", "st-dock-title st-rundown-title", "Rundown");
  const media = buildDock("media", "Media", [
    ["channel", "Channel"], ["title", "Now playing"], ["source", "Source host"],
    ["published", "Published"], ["duration", "Duration"],
  ]);
  const monitor = buildDock("monitor", "Monitor", [
    ["state", "State"], ["position", "Position"], ["buffered", "Buffered ahead"],
    ["resolution", "Resolution"], ["ready", "Ready state"],
  ]);
  const telemetry = buildDock("telemetry", "Telemetry", [
    ["decoded", "Frames decoded"], ["dropped", "Frames dropped"], ["stalls", "Stalls (this page view)"],
    ["errors", "Media errors (this page view)"], ["requests", "Playlist data requests"], ["last", "Last request"],
    ["uptime", "Page open for"],
  ]);
  const right = createElement("aside", "st-right");
  right.setAttribute("aria-label", "Media, monitor and telemetry");
  right.append(media.section, monitor.section, telemetry.section);
  panel.append(rundownTitle, right);

  const counters = { stalls: 0, errors: 0 };
  for (const type of ["waiting", "stalled"]) {
    panel.addEventListener(type, () => { counters.stalls += 1; }, true);
  }
  panel.addEventListener("error", (event) => {
    if (event.target instanceof HTMLMediaElement) counters.errors += 1;
  }, true);

  function text(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function update() {
    const video = document.getElementById("dp-video");
    const pressed = panel.querySelector(".dp-item-button[aria-pressed='true']");
    const picker = document.getElementById("dp-channel-picker");
    const channel = picker && picker.value !== "" ? picker.selectedOptions[0]?.textContent : "";

    text(media.cells.channel, channel || DASH);
    text(media.cells.title, pressed?.textContent.trim() || DASH);
    text(media.cells.source, video?.currentSrc ? safeHost(video.currentSrc) : DASH);
    text(media.cells.published, panel.querySelector(".dp-published")?.textContent.trim() || DASH);
    text(media.cells.duration, panel.querySelector(".dp-duration")?.textContent.trim() || DASH);

    text(monitor.cells.state, playerState(video));
    text(monitor.cells.position, video
      ? `${formatClock(video.currentTime)} / ${formatClock(video.duration)}` : DASH);
    const ahead = video ? bufferedAhead(video) : null;
    text(monitor.cells.buffered, ahead === null ? DASH : `${ahead.toFixed(1)} s`);
    text(monitor.cells.resolution, video?.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : DASH);
    text(monitor.cells.ready, video ? `${video.readyState} of 4` : DASH);

    const quality = video?.getVideoPlaybackQuality?.();
    text(telemetry.cells.decoded, quality ? String(quality.totalVideoFrames) : DASH);
    text(telemetry.cells.dropped, quality ? String(quality.droppedVideoFrames) : DASH);
    text(telemetry.cells.stalls, String(counters.stalls));
    text(telemetry.cells.errors, String(counters.errors));
    const entries = performance.getEntriesByType("resource").filter((entry) => {
      try {
        return /\/daily\/.+\.json$/.test(new URL(entry.name).pathname);
      } catch {
        return false;
      }
    });
    text(telemetry.cells.requests, String(entries.length));
    const last = entries.at(-1);
    text(telemetry.cells.last, last
      ? `${Math.round(last.duration)} ms${last.responseStatus ? ` · HTTP ${last.responseStatus}` : ""}`
      : DASH);
    text(telemetry.cells.uptime, formatClock(performance.now() / 1000));
  }

  let timer = null;
  function shouldTick() {
    return !document.hidden && !panel.hidden && !document.body.classList.contains("st-focus");
  }
  function syncTimer() {
    if (shouldTick()) {
      update();
      if (timer === null) timer = window.setInterval(update, 1000);
    } else if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  for (const type of ["playing", "pause", "ended", "loadedmetadata", "emptied", "click"]) {
    panel.addEventListener(type, () => { if (shouldTick()) window.setTimeout(update, 0); }, true);
  }
  document.addEventListener("visibilitychange", syncTimer);
  new MutationObserver(syncTimer).observe(panel, { attributes: true, attributeFilter: ["hidden"] });

  // Focus mode: hide the side docks so the stage fills the window.
  function setFocus(on, { persist = true } = {}) {
    document.body.classList.toggle("st-focus", on);
    focusButton.setAttribute("aria-pressed", String(on));
    if (persist) storeFocus(on);
    syncTimer();
  }
  focusButton.addEventListener("click", () => setFocus(!document.body.classList.contains("st-focus")));
  document.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() !== "f" || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("input, select, textarea, [contenteditable]")) return;
    setFocus(!document.body.classList.contains("st-focus"));
  });
  setFocus(readStoredFocus(), { persist: false });

  // Mobile bottom sheets (the same docks, shown one at a time above the tab bar).
  const tabs = [...document.querySelectorAll(".st-tab")];
  function setSheet(name) {
    const next = SHEETS.includes(name) ? name : "";
    if (next) panel.dataset.sheet = next;
    else delete panel.dataset.sheet;
    for (const tab of tabs) tab.setAttribute("aria-pressed", String(tab.dataset.sheet === next));
    update();
  }
  for (const tab of tabs) {
    tab.addEventListener("click", () => setSheet(panel.dataset.sheet === tab.dataset.sheet ? "" : tab.dataset.sheet));
  }
  panel.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-close-sheet]") || target.closest(".dp-item-button")) setSheet("");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.dataset.sheet) {
      event.preventDefault();
      setSheet("");
    }
  });

  syncTimer();
}

if (typeof document !== "undefined") initializeStudio();
