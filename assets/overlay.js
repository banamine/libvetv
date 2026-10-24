const DAY = 24 * 60 * 60 * 1000;
const REFRESH_MS = 15 * 60 * 1000;
const DIGEST_PATH = "/Daily-News-Digest-/data/current/data.json";
const normalize = (value) => typeof value === "string" ? value.normalize("NFC").replace(/\s+/gu, " ").trim() : "";

// Accept JSON or its decoded value. Source-priority order is intentional.
export function parseDigest(json, now = Date.now()) {
  const value = typeof json === "string" ? JSON.parse(json) : json;
  if (!value || (!Array.isArray(value.stories) && !Array.isArray(value.rss_feeds_articles))) {
    throw new TypeError("digest_invalid");
  }
  const items = [];
  const seen = new Set();
  for (const row of [...(Array.isArray(value.stories) ? value.stories : []),
    ...(Array.isArray(value.rss_feeds_articles) ? value.rss_feeds_articles : [])]) {
    const headline = normalize(row?.headline || row?.title);
    const date = row?.publishedAt ?? row?.pubDate ?? row?.published ?? row?.published_at ?? row?.date;
    const timestamp = typeof date === "string" ? Date.parse(date) : NaN;
    const key = headline.toLowerCase();
    if (!headline || !Number.isFinite(timestamp) || timestamp < now - DAY ||
        timestamp > now + 5 * 60 * 1000 || seen.has(key)) continue;
    seen.add(key);
    items.push({ headline, publishedAt: new Date(timestamp).toISOString(), feedName: normalize(row.feedName) });
    if (items.length === 20) break;
  }
  return items;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createOverlay(stage, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const root = element("div", "dp-overlay");
  const clock = element("div", "dp-local-clock");
  clock.setAttribute("aria-label", "Viewer's local date and time");
  const headlines = element("div", "dp-headlines");
  headlines.tabIndex = 0;
  headlines.setAttribute("aria-label", "News headlines");
  headlines.hidden = true;
  const unavailable = element("p", "dp-headlines-unavailable", "Headlines unavailable");
  unavailable.hidden = true;
  root.append(clock, headlines, unavailable);
  stage.append(root);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let destroyed = false;
  let active = false;
  let rows = [];
  let index = 0;
  let hover = false;
  let focus = false;
  let touched = false;
  let fetchedAt = null;
  let refreshTimer = null;
  let rotationTimer = null;
  let request = null;
  let requestTimeout = null;

  function updateClock() {
    clock.textContent = `Viewer local time · ${new Date(now()).toLocaleString()}`;
  }
  updateClock();
  const clockTimer = setInterval(updateClock, 30_000);

  function rowNode(row) {
    const node = element("p", "dp-headline");
    node.append(element("span", "dp-headline-text", row.headline));
    const source = row.feedName ? `${row.feedName} · ` : "";
    node.append(element("small", "dp-headline-asof", `${source}as of ${new Date(row.publishedAt).toLocaleTimeString()}`));
    return node;
  }
  function render() {
    headlines.hidden = !active || !rows.length;
    unavailable.hidden = !active || Boolean(rows.length);
    headlines.replaceChildren();
    if (!active || !rows.length) return;
    if (reduced.matches) {
      const list = element("ul", "dp-headline-list");
      for (const row of rows) {
        const li = document.createElement("li");
        li.append(rowNode(row));
        list.append(li);
      }
      headlines.append(list);
    } else {
      headlines.append(rowNode(rows[index % rows.length]));
    }
  }
  function clearWork() {
    clearTimeout(refreshTimer);
    clearInterval(rotationTimer);
    clearTimeout(requestTimeout);
    refreshTimer = rotationTimer = requestTimeout = null;
    request?.abort();
    request = null;
  }
  async function refresh() {
    if (!active || destroyed) return;
    request?.abort();
    clearTimeout(requestTimeout);
    const controller = new AbortController();
    request = controller;
    requestTimeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const url = new URL(DIGEST_PATH, location.origin);
      if (url.origin !== location.origin) throw new Error("digest_origin");
      const response = await fetchImpl(url.href, {
        signal: controller.signal, redirect: "error", cache: "no-store", credentials: "omit",
      });
      if (!response.ok) throw new Error("digest_http");
      const nextRows = parseDigest(await response.json(), now());
      if (destroyed || !active || controller !== request || controller.signal.aborted) return;
      rows = nextRows;
      index = 0;
      fetchedAt = now();
    } catch {
      if (destroyed || !active || controller !== request) return;
      rows = [];
      fetchedAt = null;
    } finally {
      if (controller === request) {
        clearTimeout(requestTimeout);
        requestTimeout = null;
        request = null;
        if (!destroyed) render();
      }
    }
  }
  function setShowPlaying(value) {
    if (destroyed || active === Boolean(value)) return;
    active = Boolean(value);
    clearWork();
    if (active) {
      // Never retain expired headlines across pauses or failed refreshes.
      rows = rows.filter((row) => Date.parse(row.publishedAt) >= now() - DAY &&
        Date.parse(row.publishedAt) <= now() + 300_000);
      if (fetchedAt === null || now() - fetchedAt >= REFRESH_MS) {
        rows = [];
        void refresh();
      }
      const refreshTick = () => {
        rows = [];
        render();
        void refresh();
        refreshTimer = setTimeout(refreshTick, REFRESH_MS);
      };
      refreshTimer = setTimeout(refreshTick, fetchedAt === null
        ? REFRESH_MS : Math.max(1, REFRESH_MS - (now() - fetchedAt)));
      rotationTimer = setInterval(() => {
        if (hover || focus || touched || reduced.matches || rows.length < 2) return;
        rows = rows.filter((row) => Date.parse(row.publishedAt) >= now() - DAY);
        index = rows.length ? (index + 1) % rows.length : 0;
        render();
      }, 8_000);
    }
    render();
  }
  headlines.addEventListener("mouseenter", () => { hover = true; });
  headlines.addEventListener("mouseleave", () => { hover = false; });
  headlines.addEventListener("focusin", () => { focus = true; });
  headlines.addEventListener("focusout", (event) => { focus = headlines.contains(event.relatedTarget); });
  headlines.addEventListener("touchstart", () => { touched = true; }, { passive: true });
  headlines.addEventListener("touchend", () => { touched = false; }, { passive: true });
  headlines.addEventListener("touchcancel", () => { touched = false; }, { passive: true });
  reduced.addEventListener("change", render);
  return {
    setShowPlaying,
    destroy() {
      destroyed = true;
      active = false;
      clearWork();
      clearInterval(clockTimer);
      reduced.removeEventListener("change", render);
      rows = [];
      root.remove();
    },
  };
}
