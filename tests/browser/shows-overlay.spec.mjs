import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { test, expect } from "@playwright/test";
import { LEGACY_URL, installLocalNetwork, openPlaylist, waitForOldPagePlaying, waitForVideoPlaying,
  assertNoUnroutedExternal } from "./helpers.mjs";

const NOW = new Date("2026-10-24T12:00:00Z");
const MEDIA_BASE = "https://affiliates.alexjoneslive.com/mp4-segs/";
const DIGEST = { stories: [
  { headline: "DEMO — Community observatory opens tonight", publishedAt: "2026-10-24T11:30:00Z", feedName: "DEMO Science Desk" },
  { headline: "DEMO — Library announces its autumn programme", pubDate: "Sat, 24 Oct 2026 11:00:00 GMT", feedName: "DEMO Local Desk" },
  { headline: "DEMO — obsolete item must not appear", publishedAt: "2006-01-02T12:00:00Z", feedName: "DEMO" },
] };
const segment = (seq, name = `Mon-Alex-Hr1-Seg${seq}.mp4`) => ({
  seq, localId: `lv-demo-${seq}`, title: `DEMO — synthetic segment ${seq}`,
  name, url: `${MEDIA_BASE}${name}`, durationSec: null, sizeBytes: 400_000_000,
  modifiedAt: "2026-10-19T12:00:00.000Z",
});
function fixture({ loop = false, modified = "2026-10-19T12:00:00.000Z" } = {}) {
  const segments = [segment(1),
    segment(2, "Mon-Alex-Hr1-Seg2.mp4")].map((part) => ({ ...part, modifiedAt: modified }));
  return {
    schemaVersion: 1, channelId: "demo-show", label: "DEMO — Show Channel", network: "ajn",
    sourceType: "affiliate-listing", loop, mediaAllowlist: [
      { host: "archive.org", prefix: "/download/" },
      { host: "affiliates.alexjoneslive.com", prefix: "/mp4-segs/" },
    ],
    publishedAt: NOW.toISOString(), asOf: modified, durationBasis: "unknown", declaredTotalSeconds: null,
    items: [
      { seq: 1, localId: "lv-show-demo", kind: "show", showId: "Alex",
        title: "DEMO — Consolidated synthetic show", url: segments[0].url,
        name: "The Alex Jones Show", network: "ajn", loop, day: "Mon", date: modified.slice(0, 10),
        asOf: modified, durationSec: null, segments },
      { seq: 2, localId: "lv-war-room", kind: "show", showId: "WarRoom",
        title: "DEMO — Synthetic War Room show", url: `${MEDIA_BASE}Tue-WarRoom-Hr1-Seg1.mp4`,
        name: "The War Room", network: "ajn", loop, day: "Tue", date: "2026-10-20",
        asOf: modified, durationSec: null,
        segments: [segment(1, "Tue-WarRoom-Hr1-Seg1.mp4")] },
    ],
  };
}
async function setup(page, options = {}) {
  const manifest = options.manifest || fixture(options);
  const failPaths = options.error ? ["Mon-Alex-Hr1-Seg1.mp4"] : (options.failPaths || []);
  const mediaResolver = options.mediaResolver || (options.short
    ? (pathname, media) => pathname.endsWith("Seg2.mp4") ? media.green : media.red
    : (_pathname, media) => media.long);
  const stats = await installLocalNetwork(page, {
    ...options, failPaths, mediaResolver, digestBody: options.digestBody ?? DIGEST,
    indexOverride: options.indexOverride || { schemaVersion: 1, channels: [
      { id: "demo-show", label: "DEMO — Show Channel", status: options.status || "ok",
        reason: options.reason || null, asOf: options.asOf || NOW.toISOString(),
        manifest: "latest/demo-show.json" },
    ] },
    manifestOverrides: {
      ...options.manifestOverrides,
      "/daily/latest/demo-show.json": options.manifestOverrides?.["/daily/latest/demo-show.json"] || manifest,
    },
  });
  await page.goto(LEGACY_URL);
  await waitForOldPagePlaying(page);
  expect(stats.digestPaths).toEqual([]);
  await openPlaylist(page, `DEMO — Show Channel — ${options.status || "ok"}`);
  expect(stats.digestPaths).toEqual([]);
  return stats;
}
async function start(page) {
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await waitForVideoPlaying(page.locator("#dp-video"));
}
async function clock(page) {
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(new Date(NOW.getTime() + 1_000));
}
async function shot(page, info, name, target = "#dp-panel") {
  const path = info.outputPath("screenshots", name);
  await mkdir(dirname(path), { recursive: true });
  if (target === "page") await page.screenshot({ path, fullPage: false });
  else await page.locator(target).screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("natural ended advances two segments then the next item and completes without looping", async ({ page }) => {
  const stats = await setup(page, { short: true, manifest: fixture() });
  const video = page.locator("#dp-video");
  await video.evaluate((v) => {
    v.__sources = [];
    v.addEventListener("playing", () => v.__sources.push(new URL(v.currentSrc).pathname));
  });
  await start(page);
  await expect(page.locator(".dp-position")).toContainText("Segment 1 of 2");
  await expect(page.locator(".dp-position")).toContainText("Show total unknown");
  await expect(page.locator(".dp-position")).toContainText("Segment 2 of 2", { timeout: 6_000 });
  await expect(page.locator(".dp-items button").nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".dp-items button").nth(1)).toHaveAttribute("aria-pressed", "true", { timeout: 6_000 });
  await expect(page.getByText("Playlist complete.", { exact: true })).toBeVisible();
  expect(await video.evaluate((v) => v.__sources)).toEqual([
    "/mp4-segs/Mon-Alex-Hr1-Seg1.mp4",
    "/mp4-segs/Mon-Alex-Hr1-Seg2.mp4",
    "/mp4-segs/Tue-WarRoom-Hr1-Seg1.mp4",
  ]);
  await assertNoUnroutedExternal(stats);
});

test("segment failure Retry replays that segment; Skip segment advances only within the show", async ({ page }) => {
  let fail = true;
  const stats = await setup(page, { error: true, manifest: fixture(), failEncoded: () => fail });
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.locator(".dp-item-error")).toContainText("Unable to play segment 1 of 2");
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await waitForVideoPlaying(page.locator("#dp-video"));
  await expect(page.locator(".dp-item-error")).toHaveCount(0);
  fail = true;
  await page.locator(".dp-items button").nth(0).click();
  await expect(page.locator(".dp-item-error")).toBeVisible();
  await page.getByRole("button", { name: "Skip segment", exact: true }).click();
  await waitForVideoPlaying(page.locator("#dp-video"));
  await expect(page.locator(".dp-position")).toContainText("Segment 2 of 2");
  await expect(page.locator(".dp-items button").nth(0)).toHaveAttribute("aria-pressed", "true");
  await assertNoUnroutedExternal(stats);
});

test("configured loop restarts at segment one only after an explicit Start", async ({ page }) => {
  const stats = await setup(page, { short: true, loop: true });
  const video = page.locator("#dp-video");
  await video.evaluate((node) => {
    node.__played = [];
    node.addEventListener("playing", () => node.__played.push(new URL(node.currentSrc).pathname));
  });
  await expect(video).toHaveJSProperty("paused", true);
  await expect(video).not.toHaveAttribute("src");
  await start(page);
  await expect.poll(() => video.evaluate((node) => node.__played.length), { timeout: 7_000 })
    .toBeGreaterThanOrEqual(3);
  const paths = await video.evaluate((node) => node.__played);
  expect(paths.slice(0, 3)).toEqual([
    "/mp4-segs/Mon-Alex-Hr1-Seg1.mp4",
    "/mp4-segs/Mon-Alex-Hr1-Seg2.mp4",
    "/mp4-segs/Mon-Alex-Hr1-Seg1.mp4",
  ]);
  await expect(video).toHaveJSProperty("paused", false);
  await assertNoUnroutedExternal(stats);
});

test("a loop pass that skips every failed segment stops with retry/skip-show choices", async ({ page }) => {
  const stats = await setup(page, {
    short: true, loop: true,
    failPaths: ["Mon-Alex-Hr1-Seg1.mp4", "Mon-Alex-Hr1-Seg2.mp4"],
  });
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.locator(".dp-item-error")).toContainText("Unable to play segment 1 of 2");
  await page.getByRole("button", { name: "Skip segment", exact: true }).click();
  await expect(page.locator(".dp-item-error")).toContainText("Unable to play segment 2 of 2");
  await page.getByRole("button", { name: "Skip segment", exact: true }).click();
  await expect(page.locator(".dp-item-error")).toContainText("No segment played successfully");
  await expect(page.getByRole("button", { name: "Retry show from segment 1" })).toBeVisible();
  await page.getByRole("button", { name: "Skip show", exact: true }).click();
  await waitForVideoPlaying(page.locator("#dp-video"));
  await expect(page.locator(".dp-items button").nth(1)).toHaveAttribute("aria-pressed", "true");
  await assertNoUnroutedExternal(stats);
});

test("a stale fallback row visibly labels the weekday/date of the segments being played", async ({ page }) => {
  const manifest = fixture({ short: true });
  manifest.items[0].fallbackFromDay = "2026-10-20";
  const stats = await setup(page, {
    short: true, manifest, status: "stale", reason: "no_complete_day_set", asOf: manifest.asOf,
  });
  await expect(page.locator(".dp-refresh-banner")).toContainText(
    "Latest refresh failed (no_complete_day_set); Showing Mon 2026-10-19 segments (latest available)",
  );
  await start(page);
  await waitForVideoPlaying(page.locator("#dp-video"));
  await assertNoUnroutedExternal(stats);
});

test("a changed manifest waits for a show boundary before swapping", async ({ page }) => {
  await clock(page);
  const first = fixture({ short: true, loop: true });
  first.contentHash = "demo-hash-old";
  const latest = fixture({ short: true, loop: true, modified: "2026-10-20T12:00:00.000Z" });
  latest.contentHash = "demo-hash-new";
  latest.items[0].day = "Tue";
  latest.items[0].date = "2026-10-20";
  latest.items[0].asOf = "2026-10-20T12:00:00.000Z";
  latest.items[0].segments = latest.items[0].segments.map((part) => ({
    ...part, name: part.name.replace(/^Mon-/, "Tue"),
    url: part.url.replace("/Mon-", "/Tue-"), modifiedAt: latest.items[0].asOf,
  }));
  latest.items[0].url = latest.items[0].segments[0].url;
  latest.items[0].segments = [latest.items[0].segments[0]];
  latest.items[0].segments[0].name = "Tue-Alex-Hr1-Seg1.mp4";
  latest.items[0].segments[0].url = `${MEDIA_BASE}Tue-Alex-Hr1-Seg1.mp4`;
  latest.items[0].url = latest.items[0].segments[0].url;
  let updated = false;
  const stats = await setup(page, {
    manifest: first,
    indexOverride: () => ({ schemaVersion: 1, channels: [
      { id: "demo-show", label: "DEMO — Show Channel", status: "ok", manifest: "latest/demo-show.json" },
    ] }),
    manifestOverrides: { "/daily/latest/demo-show.json": () => updated ? latest : first },
  });
  await start(page);
  updated = true;
  await page.clock.fastForward(30 * 60_000);
  await expect(page.locator(".dp-refresh-status")).toContainText("update ready");
  await expect(page.locator("#dp-video")).toHaveAttribute("src", /Mon-Alex-Hr1-Seg1\.mp4/);
  await page.locator("#dp-video").evaluate((node) => node.dispatchEvent(new Event("ended")));
  await expect(page.locator(".dp-position")).toContainText("Segment 2 of 2");
  await expect(page.locator(".dp-position")).not.toContainText("Tue");
  await page.locator("#dp-video").evaluate((node) => node.dispatchEvent(new Event("ended")));
  await expect(page.locator(".dp-position")).toContainText("Segment 1 of 1 · Tue");
  await expect(page.locator("#dp-video")).toHaveAttribute("src", /Tue-Alex-Hr1-Seg1\.mp4/);
  await assertNoUnroutedExternal(stats);
});

test("a failed 30-minute manifest poll is visible but does not interrupt current show playback", async ({ page }) => {
  await clock(page);
  let indexReads = 0;
  const stats = await setup(page, {
    indexStatus: () => (++indexReads === 1 ? 200 : 503),
  });
  await start(page);
  await page.clock.fastForward(30 * 60_000);
  await expect(page.locator(".dp-refresh-status")).toHaveText("Playlist refresh unavailable.");
  await expect(page.locator("#dp-video")).toHaveJSProperty("paused", false);
  await expect(page.locator(".dp-item-error")).toHaveCount(0);
  expect(indexReads).toBe(2);
  await assertNoUnroutedExternal(stats);
});

test("overlay rotates every 8s, pauses on hover/focus/touch, updates local clock and clears on close", async ({ page }) => {
  await clock(page);
  const stats = await setup(page);
  await start(page);
  const strip = page.locator(".dp-headlines");
  await expect(strip).toContainText("Community observatory");
  await expect(strip).toContainText("DEMO Science Desk");
  await expect(strip).toContainText("as of");
  const clockBefore = await page.locator(".dp-local-clock").textContent();
  await page.clock.fastForward(8_000);
  await expect(strip).toContainText("Library announces");
  await strip.hover();
  await page.clock.fastForward(8_000);
  await expect(strip).toContainText("Library announces");
  await page.locator(".dp-position").hover();
  await strip.focus();
  await page.clock.fastForward(8_000);
  await expect(strip).toContainText("Library announces");
  await page.locator(".dp-fullscreen").focus();
  await strip.dispatchEvent("touchstart");
  await page.clock.fastForward(8_000);
  await expect(strip).toContainText("Library announces");
  await strip.dispatchEvent("touchend");
  await page.clock.fastForward(8_000);
  await expect(strip).toContainText("Community observatory");
  expect(await page.locator(".dp-local-clock").textContent()).not.toBe(clockBefore);
  expect(stats.digestPaths.length).toBe(1);
  await page.clock.fastForward(15 * 60_000);
  await expect.poll(() => stats.digestPaths.length).toBe(2);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".dp-local-clock")).toHaveCount(0);
  await page.clock.fastForward(30 * 60_000);
  expect(stats.digestPaths.length).toBe(2);
  await assertNoUnroutedExternal(stats);
});

test("prefers-reduced-motion shows a static headline list instead of rotation", async ({ page }) => {
  await clock(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stats = await setup(page);
  await start(page);
  await expect(page.locator(".dp-headline-list li")).toHaveCount(2);
  const before = await page.locator(".dp-headlines").textContent();
  await page.clock.fastForward(24_000);
  expect(await page.locator(".dp-headlines").textContent()).toBe(before);
  await expect(page.locator(".dp-headlines")).not.toContainText("obsolete");
  await assertNoUnroutedExternal(stats);
});

test("a failed refresh removes previously displayed headlines instead of retaining stale news", async ({ page }) => {
  await clock(page);
  const stats = await setup(page);
  await start(page);
  await expect(page.locator(".dp-headlines")).toContainText("Community observatory");
  let refreshes = 0;
  await page.route("**/Daily-News-Digest-/data/current/data.json", async (route) => {
    refreshes += 1;
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  await page.clock.fastForward(15 * 60_000);
  await expect.poll(() => refreshes).toBe(1);
  await expect(page.locator(".dp-headlines-unavailable")).toBeVisible();
  await expect(page.locator(".dp-headline")).toHaveCount(0);
  await assertNoUnroutedExternal(stats);
});

test("closing the panel aborts an in-flight digest fetch", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.__digestAborted = false;
    window.fetch = (url, options) => {
      if (new URL(url, location.href).pathname !== "/Daily-News-Digest-/data/current/data.json") {
        return original(url, options);
      }
      window.__digestStarted = true;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          window.__digestAborted = true;
          reject(new DOMException("Synthetic abort", "AbortError"));
        }, { once: true });
      });
    };
  });
  const stats = await setup(page);
  await start(page);
  await expect.poll(() => page.evaluate(() => window.__digestStarted)).toBe(true);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__digestAborted)).toBe(true);
  expect(stats.digestPaths).toEqual([]);
  await assertNoUnroutedExternal(stats);
});

for (const [name, options] of [
  ["HTTP failure", { digestStatus: 503 }],
  ["malformed JSON", { digestBody: "{" }],
  ["empty digest", { digestBody: { stories: [] } }],
  ["only obsolete items", { digestBody: { stories: [{ headline: "DEMO old", date: "2006-01-02T12:00:00Z" }] } }],
]) {
  test(`digest ${name} gives an honest unavailable state without headlines`, async ({ page }) => {
    const stats = await setup(page, options);
    await start(page);
    await expect(page.locator(".dp-headlines-unavailable")).toBeVisible();
    await expect(page.locator(".dp-headlines")).toBeHidden();
    await expect(page.locator(".dp-headline")).toHaveCount(0);
    expect(stats.digestPaths.length).toBe(1);
    await assertNoUnroutedExternal(stats);
  });
}

test("fullscreen belongs to the stage and retains the overlay; existing schedule still wins playback", async ({ page }) => {
  const stats = await setup(page);
  await start(page);
  await expect(page.locator(".dp-headlines")).toBeVisible();
  await expect(page.locator("#dp-video")).toHaveAttribute("controlslist", "nofullscreen");
  await page.getByRole("button", { name: "Fullscreen player and overlay" }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe("dp-stage");
  await expect(page.locator("#dp-stage .dp-local-clock")).toBeVisible();
  await expect(page.locator("#dp-stage .dp-headlines")).toBeVisible();
  await page.evaluate(() => document.exitFullscreen());
  await page.locator('#guide-strip .guide-card[data-id="1"]').click();
  await waitForVideoPlaying(page.locator("#video-player"));
  await expect.poll(() => page.locator("#dp-video").evaluate((v) => v.paused)).toBe(true);
  await expect(page.locator(".dp-headlines")).toBeHidden();
  await assertNoUnroutedExternal(stats);
});

for (const width of [360, 1280]) {
  test(`STEP 8 synthetic screenshots and stage layout at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 360 ? 844 : 900 });
    await clock(page);
    const stats = await setup(page);
    await start(page);
    await expect(page.locator(".dp-headlines")).toContainText("Community observatory");
    await expect(page.locator(".dp-position")).toContainText("Segment 1 of 2");
    expect(await page.locator(".dp-headlines").evaluate((strip) => strip.scrollHeight <= strip.clientHeight)).toBe(true);
    await shot(page, info, `step8-show-${width}.png`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator(".dp-headline-list li")).toHaveCount(2);
    await shot(page, info, `step8-static-headlines-${width}.png`);
    await assertNoUnroutedExternal(stats);
  });

  test(`STEP 8 review scenes at ${width}px: closed, open, error, completion`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 360 ? 844 : 800 });
    const manifest = fixture();
    let fail = false;
    const stats = await installLocalNetwork(page, {
      digestBody: DIGEST,
      failPaths: ["Mon-Alex-Hr1-Seg1.mp4"],
      failEncoded: () => fail,
      mediaResolver: (_pathname, files) => files.red,
      indexOverride: { schemaVersion: 1, channels: [
        { id: "demo-show", label: "DEMO — Show Channel", status: "ok", manifest: "latest/demo-show.json" },
      ] },
      manifestOverrides: { "/daily/latest/demo-show.json": manifest },
    });
    await page.goto(LEGACY_URL);
    await waitForOldPagePlaying(page);
    await shot(page, info, `step8-${width}-closed.png`, "page");

    await openPlaylist(page, "DEMO — Show Channel — ok");
    await start(page);
    await expect(page.locator(".dp-headlines")).toContainText("DEMO — Community observatory");
    await expect(page.locator(".dp-footer")).toContainText("AJN’s affiliate directory");
    await shot(page, info, `step8-${width}-open.png`);

    fail = true;
    await page.locator(".dp-items button").nth(0).click();
    await expect(page.locator(".dp-item-error")).toBeVisible();
    await shot(page, info, `step8-${width}-error.png`);

    fail = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await waitForVideoPlaying(page.locator("#dp-video"));
    await page.locator("#dp-video").evaluate((node) => node.dispatchEvent(new Event("ended")));
    await expect(page.locator(".dp-position")).toContainText("Segment 2 of 2");
    await page.locator("#dp-video").evaluate((node) => node.dispatchEvent(new Event("ended")));
    await expect(page.locator(".dp-position")).toContainText("Segment 1 of 1 · Tue");
    await page.locator("#dp-video").evaluate((node) => node.dispatchEvent(new Event("ended")));
    await expect(page.getByText("Playlist complete.", { exact: true })).toBeVisible();
    await shot(page, info, `step8-${width}-completion.png`);
    await assertNoUnroutedExternal(stats);
  });
}
