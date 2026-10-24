import { eligibility } from "./eligibility.js";
import { isSafeManifestPath, resolveManifestUrl } from "./manifest-path.js";
import { initialState, transition } from "./sequencer.js";

const DAILY_INDEX_URL = "./daily/latest/index.json";

export function setTextContent(element, value) {
  element.textContent = typeof value === "string" ? value : "";
}

function createElement(tagName, className = "", text = undefined) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (typeof text === "string") setTextContent(element, text);
  return element;
}

function validIndex(value) {
  return (
    value &&
    value.schemaVersion === 1 &&
    Array.isArray(value.channels) &&
    value.channels.length > 0 &&
    value.channels.every((row) =>
      row &&
      typeof row.id === "string" &&
      typeof row.label === "string" &&
      ["ok", "no_playlist", "error"].includes(row.status),
    )
  );
}

function validManifest(value, channelId) {
  return (
    value &&
    value.schemaVersion === 1 &&
    value.channelId === channelId &&
    Array.isArray(value.items) &&
    value.items.length > 0 &&
    value.items.every((item, index) =>
      item &&
      item.seq === index + 1 &&
      typeof item.localId === "string" &&
      typeof item.title === "string" &&
      eligibility({
        url: item.url,
        durationSec: item.durationSec === null ? -1 : item.durationSec,
      }).ok,
    )
  );
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatPublishedAt(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "date unavailable";
  return new Date(value).toLocaleString();
}

function initializeDailyPlaylist() {
  const openButton = document.getElementById("dp-open");
  const closeButton = document.getElementById("dp-close");
  const panel = document.getElementById("dp-panel");
  const status = document.getElementById("dp-status");
  const content = document.getElementById("dp-content");
  const existingVideo = document.getElementById("video-player");
  if (!openButton || !closeButton || !panel || !status || !content || !existingVideo) return;

  let wasExistingVideoPlaying = false;
  let openRequest = null;

  existingVideo.addEventListener("play", () => {
    if (panel.hidden) return;
    const dailyVideo = document.getElementById("dp-video");
    if (dailyVideo && !dailyVideo.paused) dailyVideo.pause();
  });

  function setStatus(message) {
    setTextContent(status, message);
  }

  function closePanel() {
    panel.hidden = true;
    openButton.setAttribute("aria-expanded", "false");
    openRequest?.abort();
    openRequest = null;
    const dailyVideo = document.getElementById("dp-video");
    if (dailyVideo) dailyVideo.pause();
    if (wasExistingVideoPlaying) {
      existingVideo.play().catch(() => {});
    }
    wasExistingVideoPlaying = false;
    openButton.focus();
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      closePanel();
    }
  });

  function addStateMessage(parent, message) {
    const paragraph = createElement("p", "dp-state-message", message);
    parent.replaceChildren(paragraph);
  }

  function addReasonBanner(parent, row, manifest) {
    if (row.status === "ok") return;
    const banner = createElement("p", "dp-refresh-banner");
    const reason = typeof row.reason === "string" && row.reason ? row.reason : row.status;
    setTextContent(
      banner,
      `Latest refresh failed (${reason}); showing the playlist published ${formatPublishedAt(manifest.publishedAt)}`,
    );
    parent.appendChild(banner);
  }

  function indexRowMessage(row) {
    const reason = typeof row.reason === "string" && row.reason ? ` (${row.reason})` : "";
    if (row.status === "no_playlist") return `No playlist for this channel${reason}.`;
    if (row.status === "error") return `Playlist unavailable${reason}.`;
    return "Playlist data unavailable.";
  }

  async function loadSelectedRow(row, mount) {
    mount.replaceChildren();
    if (row.manifest === null) {
      addStateMessage(mount, indexRowMessage(row));
      return;
    }
    if (!isSafeManifestPath(row.manifest, row.id)) {
      addStateMessage(mount, "Manifest path rejected.");
      return;
    }

    let manifestUrl;
    try {
      manifestUrl = resolveManifestUrl(row.manifest, row.id, document.baseURI);
    } catch {
      addStateMessage(mount, "Manifest path rejected.");
      return;
    }

    openRequest?.abort();
    openRequest = new AbortController();
    setStatus("Loading playlist…");
    try {
      const response = await fetch(manifestUrl, {
        signal: openRequest.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("manifest_unavailable");
      const manifest = await response.json();
      if (!validManifest(manifest, row.id)) throw new Error("manifest_invalid");
      if (panel.hidden) return;
      setStatus("");
      renderManifest(row, manifest, mount);
    } catch (error) {
      if (error?.name === "AbortError" || panel.hidden) return;
      setStatus("");
      addStateMessage(
        mount,
        error?.message === "manifest_invalid"
          ? "Playlist data is invalid."
          : "Playlist data unavailable.",
      );
    }
  }

  function renderManifest(row, manifest, mount) {
    mount.replaceChildren();
    addReasonBanner(mount, row, manifest);

    const meta = createElement("p", "dp-published");
    setTextContent(meta, `Playlist published ${formatPublishedAt(manifest.publishedAt)}`);
    mount.appendChild(meta);

    const durationSummary = createElement("p", "dp-duration");
    if (
      manifest.durationBasis === "declared" &&
      Number.isSafeInteger(manifest.declaredTotalSeconds) &&
      manifest.declaredTotalSeconds >= 0
    ) {
      setTextContent(
        durationSummary,
        `Declared total ${formatDuration(manifest.declaredTotalSeconds)}`,
      );
    } else {
      setTextContent(durationSummary, `${manifest.items.length} items`);
    }
    mount.appendChild(durationSummary);

    const player = createElement("video", "dp-video");
    player.id = "dp-video";
    player.controls = true;
    player.playsInline = true;
    player.preload = "metadata";
    player.setAttribute("aria-label", `Daily Playlist video for ${row.label}`);
    mount.appendChild(player);

    const controls = createElement("div", "dp-controls");
    const startButton = createElement("button", "dp-button", "Start");
    startButton.type = "button";
    controls.appendChild(startButton);
    mount.appendChild(controls);

    const itemList = createElement("ol", "dp-items");
    mount.appendChild(itemList);
    const feedback = createElement("div", "dp-feedback");
    feedback.setAttribute("aria-live", "polite");
    mount.appendChild(feedback);

    const itemCount = manifest.items.length;
    let machine = initialState();
    let itemButtons = [];
    let playRequestId = 0;
    let activePlayRequest = null;

    function updateItemButtons() {
      itemButtons.forEach((button, index) => {
        button.setAttribute("aria-pressed", String(machine.index === index && machine.state !== "idle"));
      });
    }

    function showItemError() {
      const item = manifest.items[machine.index];
      feedback.replaceChildren();
      const text = createElement("p", "dp-item-error");
      setTextContent(text, `Unable to play item ${machine.index + 1}: ${item.title}`);
      feedback.appendChild(text);

      const retry = createElement("button", "dp-button", "Retry");
      retry.type = "button";
      retry.addEventListener("click", () => {
        machine = transition(machine, "retry", itemCount);
        playCurrent();
      });
      const skip = createElement("button", "dp-button dp-button-secondary", "Skip this item");
      skip.type = "button";
      skip.addEventListener("click", () => {
        machine = transition(machine, "skipAfterError", itemCount);
        if (machine.state === "complete") renderComplete();
        else playCurrent();
      });
      feedback.append(retry, skip);
      updateItemButtons();
    }

    function renderComplete() {
      feedback.replaceChildren();
      const completeText = createElement("p", "dp-complete", "Playlist complete.");
      const replay = createElement("button", "dp-button", "Replay");
      replay.type = "button";
      replay.addEventListener("click", () => {
        machine = transition(machine, "replay", itemCount);
        playCurrent();
      });
      feedback.append(completeText, replay);
      updateItemButtons();
    }

    function playCurrent() {
      const requestedIndex = machine.index;
      const requestId = ++playRequestId;
      const item = manifest.items[requestedIndex];
      const safe = eligibility({
        url: item.url,
        durationSec: item.durationSec === null ? -1 : item.durationSec,
      });
      if (!safe.ok) {
        activePlayRequest = null;
        machine = transition(machine, "error", itemCount);
        showItemError();
        return;
      }
      activePlayRequest = { requestedIndex, requestId, url: item.url };
      feedback.replaceChildren();
      updateItemButtons();
      player.src = item.url;
      player.load();
      player.play().catch((error) => {
        if (
          error?.name === "AbortError" ||
          machine.index !== requestedIndex ||
          machine.state !== "playing" ||
          requestId !== playRequestId
        ) {
          return;
        }
        machine = transition(machine, "error", itemCount);
        showItemError();
      });
    }

    itemButtons = manifest.items.map((item, index) => {
      const li = createElement("li", "dp-item-row");
      const button = createElement("button", "dp-item-button");
      button.type = "button";
      setTextContent(button, `${index + 1}. ${item.title}`);
      button.addEventListener("click", () => {
        machine = transition(machine, { type: "jump", seq: index + 1 }, itemCount);
        playCurrent();
      });
      li.appendChild(button);
      itemList.appendChild(li);
      return button;
    });

    startButton.addEventListener("click", () => {
      machine = transition(machine, "start", itemCount);
      if (machine.state === "playing") playCurrent();
    });
    player.addEventListener("ended", () => {
      machine = transition(machine, "ended", itemCount);
      if (machine.state === "complete") renderComplete();
      else if (machine.state === "playing") playCurrent();
    });
    player.addEventListener("error", () => {
      const request = activePlayRequest;
      if (
        !request ||
        machine.index !== request.requestedIndex ||
        machine.state !== "playing" ||
        request.requestId !== playRequestId ||
        (player.currentSrc && player.currentSrc !== request.url)
      ) return;
      machine = transition(machine, "error", itemCount);
      showItemError();
    });
    player.addEventListener("play", () => {
      if (panel.hidden) return;
      wasExistingVideoPlaying ||= !existingVideo.paused && !existingVideo.ended;
      existingVideo.pause();
    });
  }

  async function openPanel() {
    panel.hidden = false;
    openButton.setAttribute("aria-expanded", "true");
    closeButton.focus();
    wasExistingVideoPlaying = !existingVideo.paused && !existingVideo.ended;
    existingVideo.pause();
    content.replaceChildren();
    setStatus("Loading Daily Playlist…");
    openRequest = new AbortController();
    try {
      const indexUrl = new URL(DAILY_INDEX_URL, document.baseURI);
      if (indexUrl.origin !== new URL(document.baseURI).origin) {
        throw new Error("index_unavailable");
      }
      const response = await fetch(indexUrl.href, {
        signal: openRequest.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("index_unavailable");
      const index = await response.json();
      if (!validIndex(index)) throw new Error("index_invalid");
      if (panel.hidden) return;
      setStatus("");

      const label = createElement("label", "dp-field-label", "Choose a channel");
      label.htmlFor = "dp-channel-picker";
      const picker = createElement("select", "dp-select");
      picker.id = "dp-channel-picker";
      const prompt = createElement("option", "", "Select a channel");
      prompt.value = "";
      picker.appendChild(prompt);
      index.channels.forEach((row, rowIndex) => {
        const option = createElement("option");
        option.value = String(rowIndex);
        setTextContent(option, `${row.label} — ${row.status}`);
        picker.appendChild(option);
      });
      const mount = createElement("div", "dp-result");
      picker.addEventListener("change", () => {
        const row = index.channels[Number(picker.value)];
        if (row) loadSelectedRow(row, mount);
        else mount.replaceChildren();
      });
      content.append(label, picker, mount);
    } catch (error) {
      if (error?.name === "AbortError" || panel.hidden) return;
      content.replaceChildren();
      setStatus(error?.message === "index_invalid" ? "Daily Playlist index is invalid." : "Index unavailable.");
    }
  }

  openButton.addEventListener("click", () => {
    if (panel.hidden) void openPanel();
    else closePanel();
  });
  closeButton.addEventListener("click", closePanel);
}

if (typeof document !== "undefined") initializeDailyPlaylist();
