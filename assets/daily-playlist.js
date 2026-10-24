import { eligibility } from "./eligibility.js";
import { isSafeManifestPath, resolveManifestUrl } from "./manifest-path.js";
import { initialState, transition } from "./sequencer.js";
import { validManifest } from "./manifest.js";
import { createOverlay } from "./overlay.js";

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
      ["ok", "no_playlist", "error", "stale"].includes(row.status) &&
      (typeof row.manifest === "string" ||
        (row.manifest === null && (row.status === "no_playlist" || row.status === "error"))),
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
  const footer = panel?.querySelector(".dp-footer");
  const existingVideo = document.getElementById("video-player");
  if (!openButton || !closeButton || !panel || !status || !content || !existingVideo) return;

  let wasExistingVideoPlaying = false;
  let openRequest = null;
  let disposeManifest = () => {};

  existingVideo.addEventListener("play", () => {
    if (panel.hidden) return;
    const dailyVideo = document.getElementById("dp-video");
    if (dailyVideo && !dailyVideo.paused) dailyVideo.pause();
  });

  function setStatus(message) {
    setTextContent(status, message);
  }

  function resetFooter() {
    if (footer) setTextContent(footer,
      "Items are Internet Archive files listed by AJN. This page does not verify availability or usage rights.");
  }

  function setManifestFooter(manifest) {
    if (footer) setTextContent(footer, manifest.sourceType === "affiliate-listing"
      ? "Items are MP4 files listed in AJN’s affiliate directory. This page does not verify availability or usage rights."
      : "Items are Internet Archive files listed by AJN. This page does not verify availability or usage rights.");
  }

  function closePanel() {
    disposeManifest();
    disposeManifest = () => {};
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
    parent.querySelectorAll(".dp-refresh-banner").forEach((banner) => banner.remove());
    const show = manifest.items.find((item) => item.kind === "show");
    if (row.status === "ok" && !show?.fallbackFromDay) return;
    const banner = createElement("p", "dp-refresh-banner");
    if (row.status === "stale" || show?.fallbackFromDay) {
      const shownDay = show?.day || "latest available";
      const shownDate = show?.date || formatPublishedAt(row.asOf || manifest.asOf || manifest.publishedAt);
      const reason = row.status === "stale" && row.reason ? `Latest refresh failed (${row.reason}); ` : "";
      setTextContent(banner, `${reason}Showing ${shownDay} ${shownDate} segments (latest available)`);
    } else {
      const reason = typeof row.reason === "string" && row.reason ? row.reason : row.status;
      setTextContent(banner,
        `Latest refresh failed (${reason}); showing the playlist published ${formatPublishedAt(manifest.publishedAt)}`);
    }
    parent.appendChild(banner);
  }

  function indexRowMessage(row) {
    const reason = typeof row.reason === "string" && row.reason ? ` (${row.reason})` : "";
    if (row.status === "no_playlist") return `No playlist for this channel${reason}.`;
    if (row.status === "error") return `Playlist unavailable${reason}.`;
    if (row.status === "stale") return `Showing the last available playlist${reason}.`;
    return "Playlist data unavailable.";
  }

  async function loadSelectedRow(row, mount) {
    disposeManifest();
    disposeManifest = () => {};
    openRequest?.abort();
    setStatus("");
    mount.replaceChildren();
    resetFooter();
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
    const controller = new AbortController();
    openRequest = controller;
    setStatus("Loading playlist…");
    try {
      const response = await fetch(manifestUrl, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("manifest_unavailable");
      const manifest = await response.json();
      if (!validManifest(manifest, row.id)) throw new Error("manifest_invalid");
      if (panel.hidden || openRequest !== controller) return;
      setStatus("");
      renderManifest(row, manifest, mount);
    } catch (error) {
      if (error?.name === "AbortError" || panel.hidden || openRequest !== controller) return;
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
    setManifestFooter(manifest);
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
    const refreshStatus = createElement("p", "dp-refresh-status");
    refreshStatus.setAttribute("aria-live", "polite");
    mount.appendChild(refreshStatus);

    const player = createElement("video", "dp-video");
    player.id = "dp-video";
    player.controls = true;
    player.playsInline = true;
    player.preload = "metadata";
    player.setAttribute("controlsList", "nofullscreen");
    player.setAttribute("aria-label", `Daily Playlist video for ${row.label}`);
    const position = createElement("p", "dp-position");
    position.setAttribute("aria-live", "polite");
    mount.appendChild(position);
    const stage = createElement("div", "dp-stage");
    stage.id = "dp-stage";
    stage.appendChild(player);
    const fullscreen = createElement("button", "dp-button dp-fullscreen", "Fullscreen");
    fullscreen.type = "button";
    fullscreen.setAttribute("aria-label", "Fullscreen player and overlay");
    fullscreen.addEventListener("click", async () => {
      try {
        if (document.fullscreenElement === stage) await document.exitFullscreen();
        else await stage.requestFullscreen();
      } catch {
        fullscreen.textContent = "Fullscreen unavailable";
      }
    });
    stage.appendChild(fullscreen);
    mount.appendChild(stage);
    const overlay = createOverlay(stage);

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

    let machine = initialState();
    let playlistRow = row;
    let viewerStarted = false;
    let loopGuard = false;
    let successfulSegments = new Set();
    let refreshTimer = null;
    let refreshRequest = null;
    let pendingManifest = null;
    let itemButtons = [];
    let playRequestId = 0;
    let activePlayRequest = null;
    disposeManifest = () => {
      playRequestId += 1;
      activePlayRequest = null;
      overlay.destroy();
      player.pause();
      player.removeAttribute("src");
      player.load();
    };

    function updateItemButtons() {
      itemButtons.forEach((button, index) => {
        button.setAttribute("aria-pressed", String(machine.index === index && machine.state !== "idle"));
      });
      const item = manifest.items[machine.index];
      position.textContent = item?.kind === "show" && machine.state !== "idle"
      ? `Segment ${(machine.segmentIndex ?? 0) + 1} of ${item.segments.length} · ${item.day || "Show"} · Show total ${
          item.durationSec === null ? "unknown" : formatDuration(item.durationSec)}`
        : "";
    }

    function renderItemButtons() {
      itemList.replaceChildren();
      itemButtons = manifest.items.map((item, index) => {
        const li = createElement("li", "dp-item-row");
        const button = createElement("button", "dp-item-button");
        button.type = "button";
        setTextContent(button, `${index + 1}. ${item.title}`);
        button.addEventListener("click", () => {
          machine = transition(machine, { type: "jump", seq: index + 1 }, manifest.items);
          successfulSegments = new Set();
          playCurrent();
        });
        li.appendChild(button);
        itemList.appendChild(li);
        return button;
      });
      updateItemButtons();
    }

    function stopRefresh() {
      clearInterval(refreshTimer);
      refreshTimer = null;
      refreshRequest?.abort();
      refreshRequest = null;
    }

    async function refreshLatest() {
      if (panel.hidden || machine.state !== "playing" ||
          manifest.items[machine.index]?.kind !== "show" || refreshRequest) return;
      const controller = new AbortController();
      refreshRequest = controller;
      try {
        const indexUrl = new URL(DAILY_INDEX_URL, document.baseURI);
        if (indexUrl.origin !== location.origin) throw new Error("index_origin");
        const indexResponse = await fetch(indexUrl.href, {
          signal: controller.signal, cache: "no-cache",
        });
        if (!indexResponse.ok) throw new Error("index_http");
        const index = await indexResponse.json();
        if (!validIndex(index)) throw new Error("index_invalid");
        const latestRow = index.channels.find((entry) => entry.id === playlistRow.id);
        if (!latestRow?.manifest || !isSafeManifestPath(latestRow.manifest, latestRow.id)) {
          throw new Error("manifest_missing");
        }
        const nextUrl = resolveManifestUrl(latestRow.manifest, latestRow.id, document.baseURI);
        if (new URL(nextUrl).origin !== location.origin) throw new Error("manifest_origin");
        const nextResponse = await fetch(nextUrl, {
          signal: controller.signal, cache: "no-cache",
        });
        if (!nextResponse.ok) throw new Error("manifest_http");
        const nextManifest = await nextResponse.json();
        if (!validManifest(nextManifest, latestRow.id)) throw new Error("manifest_invalid");
        if (controller !== refreshRequest || controller.signal.aborted) return;
        if (nextManifest.contentHash !== manifest.contentHash) {
          pendingManifest = { manifest: nextManifest, row: latestRow };
          setTextContent(refreshStatus, "Playlist update ready; it will apply at the next show boundary.");
        } else {
          setTextContent(refreshStatus, "");
        }
      } catch {
        if (controller === refreshRequest && !controller.signal.aborted) {
          setTextContent(refreshStatus, "Playlist refresh unavailable.");
        }
      } finally {
        if (controller === refreshRequest) refreshRequest = null;
      }
    }

    function startRefresh() {
      stopRefresh();
      if (manifest.items[machine.index]?.kind !== "show" || panel.hidden) return;
      refreshTimer = setInterval(() => void refreshLatest(), 30 * 60 * 1000);
    }

    function swapAtShowBoundary() {
      if (!pendingManifest) return false;
      const pending = pendingManifest;
      const current = manifest.items[machine.index];
      const nextIndex = pending.manifest.items.findIndex((item) =>
        item.kind === "show" && item.showId === current.showId);
      if (nextIndex < 0) {
        pendingManifest = null;
        setTextContent(refreshStatus, "Playlist updated; this show is no longer listed.");
        return false;
      }
      pendingManifest = null;
      manifest = pending.manifest;
      playlistRow = pending.row;
      setManifestFooter(manifest);
      successfulSegments = new Set();
      setTextContent(refreshStatus, "");
      addReasonBanner(mount, playlistRow, manifest);
      meta.textContent = `Playlist published ${formatPublishedAt(manifest.publishedAt)}`;
      durationSummary.textContent = `${manifest.items.length} items · declared total unknown`;
      machine = transition(initialState(), { type: "jump", seq: nextIndex + 1 }, manifest.items);
      renderItemButtons();
      playCurrent();
      return true;
    }

    function showItemError() {
      const item = manifest.items[machine.index];
      feedback.replaceChildren();
      const text = createElement("p", "dp-item-error");
      overlay.setShowPlaying(false);
      stopRefresh();
      setTextContent(text, loopGuard
        ? "No segment played successfully in this show pass."
        : item.kind === "show"
        ? `Unable to play segment ${(machine.segmentIndex ?? 0) + 1} of ${item.segments.length}: ${item.title}`
        : `Unable to play item ${machine.index + 1}: ${item.title}`);
      feedback.appendChild(text);

      const retry = createElement("button", "dp-button", "Retry");
      if (loopGuard) setTextContent(retry, "Retry show from segment 1");
      retry.type = "button";
      retry.addEventListener("click", () => {
        if (loopGuard) {
          machine = transition(machine, { type: "jump", seq: machine.index + 1 }, manifest.items);
          successfulSegments = new Set();
          loopGuard = false;
        } else {
          machine = transition(machine, "retry", manifest.items);
        }
        playCurrent();
      });
      const skip = createElement("button", "dp-button dp-button-secondary",
        loopGuard ? "Skip show" : item.kind === "show" ? "Skip segment" : "Skip this item");
      skip.type = "button";
      skip.addEventListener("click", () => {
        const currentItem = manifest.items[machine.index];
        if (!loopGuard && currentItem.kind === "show" && currentItem.loop && viewerStarted &&
            (machine.segmentIndex ?? 0) + 1 === currentItem.segments.length &&
            successfulSegments.size === 0) {
          loopGuard = true;
          showItemError();
          return;
        }
        machine = transition(machine, loopGuard ? "skipShow" : "skipAfterError", manifest.items);
        loopGuard = false;
        if (machine.state === "complete") renderComplete();
        else playCurrent();
      });
      feedback.append(retry, skip);
      updateItemButtons();
    }

    function renderComplete() {
      overlay.setShowPlaying(false);
      feedback.replaceChildren();
      const completeText = createElement("p", "dp-complete", "Playlist complete.");
      const replay = createElement("button", "dp-button", "Replay");
      replay.type = "button";
      replay.addEventListener("click", () => {
        machine = transition(machine, "replay", manifest.items);
        viewerStarted = true;
        successfulSegments = new Set();
        playCurrent();
      });
      feedback.append(completeText, replay);
      updateItemButtons();
    }

    function playCurrent() {
      const requestedIndex = machine.index;
      const requestedSegment = machine.segmentIndex ?? 0;
      const requestId = ++playRequestId;
      const parent = manifest.items[requestedIndex];
      const item = parent.kind === "show" ? parent.segments[requestedSegment] : parent;
      overlay.setShowPlaying(false);
      stopRefresh();
      const safe = eligibility({
        url: item.url,
        durationSec: item.durationSec === null ? -1 : item.durationSec,
      }, manifest.mediaAllowlist);
      if (!safe.ok) {
        activePlayRequest = null;
        machine = transition(machine, "error", manifest.items);
        showItemError();
        return;
      }
      activePlayRequest = { requestedIndex, requestedSegment, requestId, url: item.url };
      feedback.replaceChildren();
      updateItemButtons();
      player.src = item.url;
      player.load();
      player.play().catch((error) => {
        if (
          error?.name === "AbortError" ||
          machine.index !== requestedIndex ||
          (machine.segmentIndex ?? 0) !== requestedSegment ||
          machine.state !== "playing" ||
          requestId !== playRequestId
        ) {
          return;
        }
        machine = transition(machine, "error", manifest.items);
        showItemError();
      });
    }

    renderItemButtons();

    startButton.addEventListener("click", () => {
      viewerStarted = true;
      successfulSegments = new Set();
      machine = transition(machine, "start", manifest.items);
      if (machine.state === "playing") playCurrent();
    });
    player.addEventListener("ended", () => {
      overlay.setShowPlaying(false);
      stopRefresh();
      const current = manifest.items[machine.index];
      const lastSegment = current.kind === "show" &&
        (machine.segmentIndex ?? 0) + 1 === current.segments.length;
      if (lastSegment) {
        if (swapAtShowBoundary()) return;
        if (current.loop && viewerStarted) {
          if (successfulSegments.size === 0) {
            loopGuard = true;
            machine = transition(machine, "error", manifest.items);
            showItemError();
            return;
          }
          successfulSegments = new Set();
          machine = transition(machine, "loopShow", manifest.items);
          playCurrent();
          return;
        }
        successfulSegments = new Set();
      }
      machine = transition(machine, "ended", manifest.items);
      if (machine.state === "complete") renderComplete();
      else if (machine.state === "playing") playCurrent();
    });
    player.addEventListener("error", () => {
      const request = activePlayRequest;
      if (
        !request ||
        machine.index !== request.requestedIndex ||
        (machine.segmentIndex ?? 0) !== request.requestedSegment ||
        machine.state !== "playing" ||
        request.requestId !== playRequestId ||
        (player.currentSrc && player.currentSrc !== new URL(request.url).href)
      ) return;
      loopGuard = false;
      machine = transition(machine, "error", manifest.items);
      showItemError();
    });
    player.addEventListener("play", () => {
      if (panel.hidden) return;
      wasExistingVideoPlaying ||= !existingVideo.paused && !existingVideo.ended;
      existingVideo.pause();
    });
    player.addEventListener("playing", () => {
      const isShow = machine.state === "playing" &&
        manifest.items[machine.index]?.kind === "show" && !panel.hidden;
      overlay.setShowPlaying(isShow);
      if (isShow) {
        if (activePlayRequest) successfulSegments.add(activePlayRequest.requestedSegment);
        startRefresh();
      } else stopRefresh();
    });
    player.addEventListener("pause", () => {
      overlay.setShowPlaying(false);
      stopRefresh();
    });
  }

  async function openPanel() {
    panel.hidden = false;
    openButton.setAttribute("aria-expanded", "true");
    closeButton.focus();
    wasExistingVideoPlaying = !existingVideo.paused && !existingVideo.ended;
    existingVideo.pause();
    disposeManifest();
    disposeManifest = () => {};
    content.replaceChildren();
    resetFooter();
    setStatus("Loading Daily Playlist…");
    const controller = new AbortController();
    openRequest = controller;
    try {
      const indexUrl = new URL(DAILY_INDEX_URL, document.baseURI);
      if (indexUrl.origin !== new URL(document.baseURI).origin) {
        throw new Error("index_unavailable");
      }
      const response = await fetch(indexUrl.href, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("index_unavailable");
      const index = await response.json();
      if (!validIndex(index)) throw new Error("index_invalid");
      if (panel.hidden || openRequest !== controller) return;
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
        const row = picker.value === "" ? null : index.channels[Number(picker.value)];
        if (row) loadSelectedRow(row, mount);
        else {
          disposeManifest();
          disposeManifest = () => {};
          openRequest?.abort();
          mount.replaceChildren();
        }
      });
      content.append(label, picker, mount);
    } catch (error) {
      if (error?.name === "AbortError" || panel.hidden || openRequest !== controller) return;
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
