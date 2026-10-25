import { resolveManifestUrl } from "./manifest-path.js";
import { validManifest } from "./manifest.js";

const CATEGORIES = ["All", "Live TV", "News", "Movies", "Series", "Radio", "General"];
const PAGE_ORIGIN = "https://www.liberty-express.org";
const MAX_WALL_TILES = 4;

const state = { pages: [], shows: [], active: null, token: 0, category: "All", query: "" };
const rowState = new Map();   // id -> state name
const $ = (id) => document.getElementById(id);

const MARKERS = {
  idle: ["marker-idle", "text-idle", "Idle"],
  loading: ["marker-loading", "text-loading", "Loading"],
  buffering: ["marker-loading", "text-loading", "Buffering"],
  playing: ["marker-playing", "text-playing", "Playing"],
  paused: ["marker-paused", "text-paused", "Paused"],
  unavailable: ["marker-unavailable", "text-unavailable", "Unavailable"],
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function setStatus(progress, detail) {
  $("status-bar-progress").style.width = `${Math.min(100, Math.max(0, progress))}%`;
  const bar = $("status-bar-text");
  bar.replaceChildren();
  const left = el("span", "", state.active ? state.active.title : "Standby");
  left.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60%";
  const right = el("span", "", detail || "");
  right.style.whiteSpace = "nowrap";
  bar.append(left, right);
}

function markerNodes(name) {
  const [shape, text, label] = MARKERS[name] || MARKERS.idle;
  return [el("span", `marker-shape ${shape}`), el("span", text, label)];
}

function refreshStates() {
  for (const show of state.shows) {
    const name = rowState.get(show.id) || "idle";
    const tile = $(`wall-${show.id}`);
    if (tile) {
      tile.classList.toggle("selected", state.active?.id === show.id);
      const slot = tile.querySelector(".status-indicator");
      slot.replaceChildren(...markerNodes(name));
    }
  }
}

/* ---------- playback (shows) and click-to-embed (allowlisted guide pages) ---------- */

// Only the owner's own pages are framed. banamine.github.io is deliberately excluded: it is the
// same origin as this page, and a same-origin frame with allow-scripts + allow-same-origin is unsandboxed.
const EMBED_HOSTS = new Set(["liberty-express.org", "www.liberty-express.org"]);
let embed = null; // { href } while a guide page is shown in the player area

// First-party pages shipped in this repo (pages/*.html next to index.html). They are reviewed code, so they get the
// same-origin sandbox the nested video player needs; nothing else on banamine.github.io qualifies.
const LOCAL_PAGE = /^pages\/[a-z0-9-]+\.html$/;

function embedKind(href) {
  try {
    const u = new URL(href, document.baseURI);
    if (u.protocol === "https:" && EMBED_HOSTS.has(u.hostname)) return "remote";
    const base = new URL(".", document.baseURI);
    if (u.origin === base.origin && u.pathname.startsWith(base.pathname) && LOCAL_PAGE.test(u.pathname.slice(base.pathname.length))) return "local";
  } catch { /* fall through */ }
  return null;
}

function canEmbed(href) { return embedKind(href) !== null; }

function findGuideRow(href) {
  for (const a of document.querySelectorAll("#channel-guide-list a.channel-row")) if (a.href === href) return a;
  return null;
}

function openEmbed(row, title) {
  stopPlayback();                       // one active thing at a time; also clears any playing show
  state.active = null;
  for (const [id, name] of rowState) if (name !== "unavailable") rowState.set(id, "idle");
  refreshStates();
  embed = { href: row.href };
  const container = $("player-container");
  const panel = el("section", "embed-panel");
  panel.setAttribute("aria-label", title);
  const bar = el("div", "embed-bar");
  const label = el("span", "embed-title", title);
  const original = el("a", "", "Open original \u2197");
  original.href = row.href; original.target = "_blank"; original.rel = "noopener noreferrer";
  const close = el("button", "embed-close", "\u2715");
  close.type = "button"; close.setAttribute("aria-label", "Close embedded page");
  close.addEventListener("click", closeEmbed);
  bar.append(label, original, close);
  const frame = document.createElement("iframe");
  frame.title = title;
  frame.setAttribute("sandbox", embedKind(row.href) === "local" ? "allow-scripts allow-same-origin allow-popups allow-presentation" : "allow-scripts allow-same-origin allow-popups");
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute("allow", embedKind(row.href) === "local" ? "autoplay; fullscreen; picture-in-picture" : "fullscreen");
  frame.src = row.href;
  panel.append(bar, frame);
  container.replaceChildren(panel);
  container.parentElement.classList.add("is-embedding");
  setStatus(0, `Embedded page - ${new URL(row.href).hostname}${embedKind(row.href) === "local" ? " (local)" : ""}`);
  close.focus();
}

function closeEmbed() {
  if (!embed) return;
  const href = embed.href;
  stopPlayback();
  state.active = null;
  refreshStates();
  setStatus(0, "Ready");
  findGuideRow(href)?.focus();
}

function stopPlayback() {
  state.token += 1;
  embed = null;
  const container = $("player-container");
  container.parentElement.classList.remove("is-embedding");
  const video = container.querySelector("video");
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  container.replaceChildren(el("div", "player-placeholder", "Choose a show from the News Wall. Nothing plays until you click."));
}

function playShow(show) {
  stopPlayback();
  const token = state.token;
  for (const [id, name] of rowState) if (name !== "unavailable") rowState.set(id, "idle");
  state.active = show;
  rowState.set(show.id, "loading");
  refreshStates();
  setStatus(0, `Loading segment 1 of ${show.segments.length}...`);

  const container = $("player-container");
  container.replaceChildren();
  const video = document.createElement("video");
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  container.append(video);

  let index = 0;
  const live = () => token === state.token && state.active === show;
  const load = () => {
    video.src = show.segments[index].url;
    video.play().catch(() => {});
  };
  const label = () => `Segment ${index + 1}/${show.segments.length}`;

  video.addEventListener("loadstart", () => { if (live() && !video.error) { rowState.set(show.id, "loading"); refreshStates(); setStatus(0, `${label()} | ReadyState ${video.readyState}`); } });
  video.addEventListener("playing", () => { if (live()) { rowState.set(show.id, "playing"); refreshStates(); } });
  video.addEventListener("pause", () => { if (live() && !video.ended && !video.error && rowState.get(show.id) !== "unavailable") { rowState.set(show.id, "paused"); refreshStates(); setStatus(0, `Paused | ${label()} | ${formatTime(video.currentTime)}`); } });
  video.addEventListener("waiting", () => { if (live() && rowState.get(show.id) !== "unavailable") { rowState.set(show.id, "buffering"); refreshStates(); setStatus(0, `Buffering | ${label()}`); } });
  video.addEventListener("timeupdate", () => {
    if (!live() || rowState.get(show.id) === "unavailable") return;
    const d = video.duration;
    if (Number.isFinite(d) && d > 0) setStatus((video.currentTime / d) * 100, `${label()} | ${formatTime(video.currentTime)} / ${formatTime(d)} | ReadyState ${video.readyState}`);
    else setStatus(0, `${label()} | ${formatTime(video.currentTime)} | duration unknown | ReadyState ${video.readyState}`);
  });
  video.addEventListener("ended", () => {
    if (!live()) return;
    if (index + 1 < show.segments.length) { index += 1; load(); }
    else { rowState.set(show.id, "idle"); refreshStates(); setStatus(100, `Finished ${show.segments.length} segments`); }
  });
  video.addEventListener("error", () => {
    if (!live()) return;
    const reasons = { 1: "Aborted", 2: "Network error", 3: "Decode error", 4: "Source not supported" };
    const why = reasons[video.error?.code] || "Media load error";
    rowState.set(show.id, "unavailable");
    refreshStates();
    container.replaceChildren(el("div", "player-placeholder", `${show.segments[index].name}: ${why}`));
    setStatus(0, `Error: ${why} (${label()})`);
  });
  load();
}

/* ---------- guide (pages) ---------- */

function renderCategoryBar() {
  const bar = $("cat-bar");
  bar.replaceChildren();
  for (const cat of CATEGORIES) {
    const count = cat === "All" ? state.pages.length : state.pages.filter((p) => p.cat === cat).length;
    const btn = el("button", `cat-btn${cat === state.category ? " on" : ""}`, `${cat} `);
    btn.type = "button";
    btn.dataset.cat = cat;
    btn.setAttribute("aria-pressed", String(cat === state.category));
    btn.append(el("span", "", String(count)));
    btn.addEventListener("click", () => { state.category = cat; renderCategoryBar(); renderGuide(); });
    bar.append(btn);
  }
}

function renderGuide() {
  const list = $("channel-guide-list");
  list.replaceChildren();
  const q = state.query.toLowerCase();
  const rows = state.pages.filter((p) => (state.category === "All" || p.cat === state.category) && (!q || p.title.toLowerCase().includes(q)));
  if (!rows.length) {
    list.append(el("li", "guide-note", state.pages.length ? "No pages match." : "No pages available."));
    return;
  }
  for (const page of rows) {
    const li = document.createElement("li");
    const a = el("a", "channel-row");
    a.href = new URL(page.url, document.baseURI).href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    const thumb = el("div", "channel-thumb", "PAGE");
    const info = el("div", "channel-info");
    info.append(el("div", "channel-title", page.title), el("div", "channel-meta", canEmbed(page.url) ? `${page.cat} \u2022 shown here \u2022 Ctrl-click for a new tab` : `${page.cat} \u2022 opens in a new tab`));
    a.append(thumb, info);
    a.style.textDecoration = "none";
    li.append(a);
    list.append(li);
  }
}

$("channel-guide-list").addEventListener("click", (event) => {
  const row = event.target.closest("a.channel-row");
  if (!row || !canEmbed(row.href) || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  openEmbed(row, row.querySelector(".channel-title")?.textContent || row.href);
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeEmbed(); });

/* ---------- news wall (AJN shows from the daily playlist) ---------- */

function renderWall(error) {
  const wall = $("news-wall");
  wall.replaceChildren();
  if (error) { wall.append(el("p", "wall-note err", `Daily shows unavailable: ${error}`)); return; }
  if (!state.shows.length) { wall.append(el("p", "wall-note", "No shows published yet.")); return; }
  for (const show of state.shows.slice(0, MAX_WALL_TILES)) {
    const tile = el("button", "news-tile");
    tile.type = "button";
    tile.id = `wall-${show.id}`;
    tile.append(el("div", "news-tile-bg"));
    const top = el("div", "news-tile-top-bar");
    top.append(el("span", "news-tile-play-badge", "PLAY"), el("div", "status-indicator"));
    tile.append(top, el("div", "news-tile-title", `${show.title} (${show.day} ${show.date})`));
    tile.addEventListener("click", () => playShow(show));
    wall.append(tile);
  }
  refreshStates();
}

/* ---------- data loading (fail closed, explicit errors) ---------- */

function validPages(data) {
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.pages)) return false;
  return data.pages.every((p) => p && typeof p.title === "string" && p.title.trim() &&
    CATEGORIES.includes(p.cat) && p.cat !== "All" && typeof p.url === "string" &&
    (LOCAL_PAGE.test(p.url) || (() => { try { const u = new URL(p.url); return u.origin === PAGE_ORIGIN && (u.pathname === "/" || u.pathname.endsWith(".html")); } catch { return false; } })()));
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadPages() {
  try {
    const data = await fetchJson(new URL("data/liberty-links.json", document.baseURI));
    if (!validPages(data)) throw new Error("invalid page index");
    state.pages = data.pages;
  } catch (error) {
    state.pages = [];
    $("channel-guide-list").replaceChildren(el("li", "guide-note err", `Page index unavailable: ${error.message}`));
    renderCategoryBar();
    return;
  }
  renderCategoryBar();
  renderGuide();
}

async function loadShows() {
  try {
    const index = await fetchJson(new URL("daily/latest/index.json", document.baseURI));
    const row = (index.channels || []).find((c) => c.id === "ajn-affiliate-segments" && c.status === "ok");
    if (!row) throw new Error("no AJN playlist published");
    const manifest = await fetchJson(resolveManifestUrl(row.manifest, row.id, document.baseURI));
    if (!validManifest(manifest, row.id)) throw new Error("playlist failed validation");
    state.shows = manifest.items
      .filter((item) => item.kind === "show")
      .map((item) => ({ id: item.localId, title: item.title, day: item.day, date: item.date, segments: item.segments }));
    for (const show of state.shows) rowState.set(show.id, "idle");
    renderWall();
  } catch (error) {
    state.shows = [];
    renderWall(error.message);
  }
}

$("guide-search").addEventListener("input", (event) => { state.query = event.target.value.trim(); renderGuide(); });
loadPages();
loadShows();
