import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { test, expect } from "@playwright/test";
import {
  assertNoUnroutedExternal,
  BASE_URL,
  installLocalNetwork,
  openPlaylist,
  waitForOldPagePlaying,
  waitForVideoPlaying,
} from "./helpers.mjs";

async function gotoBranch(page) {
  await page.goto(`${BASE_URL}/`);
  await expect(page.locator("#dp-open")).toBeAttached();
  await waitForOldPagePlaying(page);
}

async function selectClassic(page) {
  await openPlaylist(page);
  await expect(page.locator(".dp-items button")).toHaveCount(3);
}

async function scrollOpenButtonIntoView(page) {
  const button = page.locator("#dp-open");
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await button.click();
  await expect(page.locator("#dp-panel")).toBeVisible();
}

async function writeScreenshot(page, testInfo, fileName) {
  const path = testInfo.outputPath("screenshots", fileName);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path });
  await testInfo.attach(fileName, { path, contentType: "image/png" });
}

function collectConsoleErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function captureExistingPage(page) {
  const video = await waitForOldPagePlaying(page);
  await expect(page.locator("#guide-strip .guide-card").first()).toBeVisible();
  await page.waitForTimeout(80);
  const beforeClick = await page.evaluate(() => {
    const videoElement = document.getElementById("video-player");
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    return {
      title: document.title,
      ids,
      guideCards: document.querySelectorAll("#guide-strip > .guide-card").length,
      guideItemCount: document.getElementById("item-count-badge")?.textContent ?? "",
      text: document.body.innerText,
      video: {
        autoplay: videoElement.hasAttribute("autoplay"),
        mutedAttribute: videoElement.hasAttribute("muted"),
        mutedProperty: videoElement.muted,
        playsinline: videoElement.hasAttribute("playsinline"),
        controls: videoElement.hasAttribute("controls"),
        preload: videoElement.getAttribute("preload"),
        playing: !videoElement.paused,
      },
    };
  });
  await page.locator('#guide-strip .guide-card[data-id="1"]').click();
  await expect.poll(() => video.evaluate((element) => element.src)).toContain("archive.org/download/");
  const afterCardClickSrc = await video.evaluate((element) => element.src);
  await page.waitForTimeout(80);
  return { ...beforeClick, afterCardClickSrc };
}

test("panel-closed branch preserves the origin/main page behavior", async ({ browser }) => {
  const baselineContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const branchContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const baseline = await baselineContext.newPage();
  const branch = await branchContext.newPage();
  const baselineErrors = collectConsoleErrors(baseline);
  const branchErrors = collectConsoleErrors(branch);
  const baselineStats = await installLocalNetwork(baseline);
  const branchStats = await installLocalNetwork(branch);
  try {
    await baseline.goto(`${BASE_URL}/__baseline__`);
    await gotoBranch(branch);
    const baselineSnapshot = await captureExistingPage(baseline);
    const branchSnapshot = await captureExistingPage(branch);

    expect(branchSnapshot.title).toBe(baselineSnapshot.title);
    expect(branchSnapshot.ids.filter((id) => !id.startsWith("dp-")).sort())
      .toEqual(baselineSnapshot.ids.sort());
    expect(branchSnapshot.guideCards).toBe(baselineSnapshot.guideCards);
    expect(branchSnapshot.guideItemCount).toBe(baselineSnapshot.guideItemCount);
    expect(branchSnapshot.video).toEqual(baselineSnapshot.video);
    expect(branchSnapshot.afterCardClickSrc).toBe(baselineSnapshot.afterCardClickSrc);
    expect(branchSnapshot.afterCardClickSrc).toContain("archive.org/download/");
    for (const label of ["LIVE", "Now Playing", "Next", "24h Schedule · Virtual Scroll"]) {
      expect(branchSnapshot.text.includes(label), `existing label: ${label}`).toBe(
        baselineSnapshot.text.includes(label),
      );
    }
    expect(branchStats.dailyPaths).toEqual([]);
    expect(baselineStats.dailyPaths).toEqual([]);
    expect([...new Set(branchErrors)].sort()).toEqual([...new Set(baselineErrors)].sort());
    await assertNoUnroutedExternal(baselineStats);
    await assertNoUnroutedExternal(branchStats);
    expect(branchStats.archivePaths.length).toBeGreaterThan(0);
    expect(baselineStats.archivePaths.length).toBeGreaterThan(0);
  } finally {
    await baselineContext.close();
    await branchContext.close();
  }
});

test("playlist starts, advances on ended, completes without looping, and replays", async ({ page }) => {
  const stats = await installLocalNetwork(page, { failEncoded: false });
  await gotoBranch(page);
  await selectClassic(page);
  const video = page.locator("#dp-video");

  await page.getByRole("button", { name: "Start", exact: true }).click();
  await waitForVideoPlaying(video);
  await expect(page.locator(".dp-items button").nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".dp-items button").nth(1)).toHaveAttribute("aria-pressed", "true", { timeout: 6_000 });
  await expect(page.locator(".dp-items button").nth(2)).toHaveAttribute("aria-pressed", "true", { timeout: 6_000 });
  await expect(page.getByText("Playlist complete.", { exact: true })).toBeVisible({ timeout: 6_000 });
  const completedSrc = await video.evaluate((element) => element.currentSrc);
  await page.waitForTimeout(1_200);
  await expect(page.getByText("Playlist complete.", { exact: true })).toBeVisible();
  expect(await video.evaluate((element) => element.currentSrc)).toBe(completedSrc);

  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await waitForVideoPlaying(video);
  await expect(page.locator(".dp-items button").nth(0)).toHaveAttribute("aria-pressed", "true");
  await assertNoUnroutedExternal(stats);
});

test("encoded-space media failure shows item error, Retry, and Skip instead of stalling", async ({ page }) => {
  const stats = await installLocalNetwork(page, { failEncoded: true });
  await gotoBranch(page);
  await selectClassic(page);
  await page.locator(".dp-items button").nth(1).click();
  const video = page.locator("#dp-video");
  await expect.poll(() => video.evaluate((element) => element.src)).toContain("My%20Movie.mp4");
  await expect(page.getByText("Unable to play item 2: DEMO — Encoded Space Error Clip")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip this item", exact: true })).toBeVisible();
  await expect.poll(() => video.evaluate((element) => element.currentSrc)).toContain("My%20Movie.mp4");

  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Unable to play item 2: DEMO — Encoded Space Error Clip")).toBeVisible();
  await page.getByRole("button", { name: "Skip this item", exact: true }).click();
  await waitForVideoPlaying(video);
  await expect(page.locator(".dp-items button").nth(2)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Unable to play item 2: DEMO — Encoded Space Error Clip")).toHaveCount(0);
  await assertNoUnroutedExternal(stats);
});

test("rapid item changes ignore stale errors, then Retry/Skip still advance on ended", async ({ page }) => {
  const stats = await installLocalNetwork(page, { failEncoded: true, encodedDelayMs: 300 });
  await gotoBranch(page);
  await openPlaylist(page, "DEMO — Rapid Switch — ok");
  await expect(page.locator(".dp-items button")).toHaveCount(4);
  const video = page.locator("#dp-video");

  await page.locator(".dp-items button").nth(1).click();
  await page.locator(".dp-items button").nth(2).click();
  await waitForVideoPlaying(video);
  await expect(page.locator(".dp-items button").nth(2)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".dp-item-error")).toHaveCount(0);

  await page.locator(".dp-items button").nth(1).click();
  await expect(page.getByText("Unable to play item 2: DEMO — Rapid Encoded Clip")).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Unable to play item 2: DEMO — Rapid Encoded Clip")).toBeVisible();
  await page.getByRole("button", { name: "Skip this item", exact: true }).click();
  await waitForVideoPlaying(video);
  await expect(page.locator(".dp-items button").nth(2)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".dp-item-error")).toHaveCount(0);
  await expect(page.locator(".dp-items button").nth(3)).toHaveAttribute("aria-pressed", "true", { timeout: 6_000 });
  await expect(page.locator(".dp-item-error")).toHaveCount(0);
  await assertNoUnroutedExternal(stats);
});

test("status rows show truthful empty states and last-good remains playable", async ({ page }) => {
  const stats = await installLocalNetwork(page, { failEncoded: false });
  await gotoBranch(page);
  await openPlaylist(page, "DEMO — No Playlist — no_playlist");
  await expect(page.getByText("No playlist for this channel (outside_tolerance).", { exact: true })).toBeVisible();
  await expect(page.locator(".dp-refresh-banner")).toHaveCount(0);

  const picker = page.locator("#dp-channel-picker");
  await picker.selectOption({ label: "DEMO — Failed Without Last Good — error" });
  await expect(page.getByText("Playlist unavailable (source_unavailable).", { exact: true })).toBeVisible();
  await expect(page.locator(".dp-refresh-banner")).toHaveCount(0);

  await picker.selectOption({ label: "DEMO — Last Good — error" });
  await expect(page.locator(".dp-refresh-banner")).toContainText(
    "Latest refresh failed (source_unavailable); showing the playlist published",
  );
  await expect(page.locator(".dp-items button")).toHaveCount(1);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await waitForVideoPlaying(page.locator("#dp-video"));
  await assertNoUnroutedExternal(stats);
});

test("unsafe manifest paths are rejected before any external access", async ({ browser }) => {
  const unsafePaths = [
    "../bad-path.json",
    "/daily/latest/bad-path.json",
    "https://evil.example/bad-path.json",
  ];
  for (const manifestPath of unsafePaths) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const index = {
      schemaVersion: 1,
      channels: [{
        id: "bad-path",
        label: "DEMO — Bad Manifest Path",
        status: "ok",
        manifest: manifestPath,
      }],
    };
    const stats = await installLocalNetwork(page, { indexOverride: index });
    await gotoBranch(page);
    await openPlaylist(page, "DEMO — Bad Manifest Path — ok");
    await expect(page.getByText("Manifest path rejected.", { exact: true })).toBeVisible();
    expect(stats.dailyPaths.filter((path) => path.includes("bad-path.json"))).toEqual([]);
    expect(stats.unroutedExternal).toEqual([]);
    await context.close();
  }
});

test("invalid media URL makes the manifest invalid without a request to that host", async ({ page }) => {
  const index = {
    schemaVersion: 1,
    channels: [{
      id: "bad-media",
      label: "DEMO — Invalid Media URL",
      status: "ok",
      manifest: "latest/bad-media.json",
    }],
  };
  const manifest = {
    schemaVersion: 1,
    channelId: "bad-media",
    publishedAt: "2026-10-24T10:00:00.000Z",
    durationBasis: "unknown",
    declaredTotalSeconds: null,
    items: [{
      seq: 1,
      localId: "demo-invalid-url",
      title: "DEMO — Invalid URL",
      url: "https://evil.example/track.mp4",
      durationSec: -1,
    }],
  };
  const stats = await installLocalNetwork(page, {
    indexOverride: index,
    manifestOverrides: { "/daily/latest/bad-media.json": manifest },
  });
  await gotoBranch(page);
  await openPlaylist(page, "DEMO — Invalid Media URL — ok");
  await expect(page.getByText("Playlist data is invalid.", { exact: true })).toBeVisible();
  expect(stats.unroutedExternal).toEqual([]);
  expect(stats.dailyPaths.some((path) => path.includes("bad-media.json"))).toBe(true);
});

test("existing schedule clicks pause the daily player, and close resumes only prior playback", async ({ page }) => {
  const stats = await installLocalNetwork(page, { failEncoded: false });
  await gotoBranch(page);
  const oldVideo = page.locator("#video-player");
  await selectClassic(page);
  const dailyVideo = page.locator("#dp-video");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await waitForVideoPlaying(dailyVideo);

  await page.locator('#guide-strip .guide-card[data-id="1"]').click();
  await expect.poll(() => dailyVideo.evaluate((element) => element.paused)).toBe(true);
  await expect.poll(() => oldVideo.evaluate((element) => !element.paused)).toBe(true);
  await page.locator("#dp-close").click();
  await expect.poll(() => oldVideo.evaluate((element) => !element.paused)).toBe(true);
  await expect(page.locator("#dp-panel")).toBeHidden();
  await assertNoUnroutedExternal(stats);
});

test("close resumes a previously playing old video but does not resume one paused before open", async ({ page }) => {
  const stats = await installLocalNetwork(page, { failEncoded: false });
  await gotoBranch(page);
  const oldVideo = page.locator("#video-player");
  await selectClassic(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await waitForVideoPlaying(page.locator("#dp-video"));
  await page.locator("#dp-close").click();
  await expect.poll(() => oldVideo.evaluate((element) => !element.paused)).toBe(true);

  await oldVideo.evaluate((element) => element.pause());
  await openPlaylist(page);
  await expect(page.locator(".dp-items button")).toHaveCount(3);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await waitForVideoPlaying(page.locator("#dp-video"));
  await page.locator("#dp-close").click();
  await expect.poll(() => oldVideo.evaluate((element) => element.paused)).toBe(true);
  await assertNoUnroutedExternal(stats);
});

test("three panel open-close cycles do not accumulate play listeners", async ({ page }) => {
  const stats = await installLocalNetwork(page, { failEncoded: false });
  await gotoBranch(page);
  for (let index = 0; index < 3; index += 1) {
    await openPlaylist(page);
    await page.locator("#dp-close").click();
    await expect(page.locator("#dp-panel")).toBeHidden();
  }
  await selectClassic(page);
  await page.locator("#dp-video").evaluate((video) => {
    window.__dpPlayEvents = 0;
    video.addEventListener("play", () => {
      window.__dpPlayEvents += 1;
    });
  });
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await waitForVideoPlaying(page.locator("#dp-video"));
  await expect.poll(() => page.evaluate(() => window.__dpPlayEvents)).toBe(1);
  await page.locator(".dp-items button").nth(2).click();
  await waitForVideoPlaying(page.locator("#dp-video"));
  await expect.poll(() => page.evaluate(() => window.__dpPlayEvents)).toBe(2);
  await assertNoUnroutedExternal(stats);
});

test("mobile and desktop button layout is visible, clickable, and has no horizontal overflow", async ({ page }) => {
  const stats = await installLocalNetwork(page, { failEncoded: false });
  await gotoBranch(page);
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await scrollOpenButtonIntoView(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
    await page.locator("#dp-close").click();
    await expect(page.locator("#dp-panel")).toBeHidden();
  }
  await assertNoUnroutedExternal(stats);
});

test("Escape closes the panel and returns focus to its launcher", async ({ page }) => {
  const stats = await installLocalNetwork(page);
  await gotoBranch(page);
  await page.locator("#dp-open").scrollIntoViewIfNeeded();
  await page.locator("#dp-open").click();
  await expect(page.locator("#dp-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#dp-panel")).toBeHidden();
  await expect(page.locator("#dp-open")).toBeFocused();
  await assertNoUnroutedExternal(stats);
});

test("browser imports use only .js assets and the static server returns text/javascript", async ({ page }) => {
  const stats = await installLocalNetwork(page);
  const requestedPaths = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === BASE_URL) requestedPaths.push(url.pathname);
  });
  await gotoBranch(page);
  const result = await page.evaluate(async () => {
    const response = await fetch("./assets/daily-playlist.js", { cache: "no-store" });
    return {
      contentType: response.headers.get("content-type"),
      source: await response.text(),
    };
  });
  expect(result.contentType).toMatch(/^text\/javascript(?:;|$)/);
  expect(result.source).not.toMatch(/from\s+["'][^"']*\.mjs["']/);
  await expect.poll(() => requestedPaths).toContain("/assets/eligibility.js");
  expect(requestedPaths).toContain("/assets/manifest-path.js");
  expect(requestedPaths).toContain("/assets/sequencer.js");
  expect(requestedPaths.some((path) => path.endsWith(".mjs"))).toBe(false);
  const rangeResult = await page.evaluate(async () => {
    const response = await fetch("./tests/fixtures/media/red.mp4", {
      headers: { Range: "bytes=0-1" },
    });
    return {
      status: response.status,
      contentRange: response.headers.get("content-range"),
      byteCount: (await response.arrayBuffer()).byteLength,
    };
  });
  expect(rangeResult.status).toBe(206);
  expect(rangeResult.byteCount).toBe(2);
  expect(rangeResult.contentRange).toMatch(/^bytes 0-1\//);
  await assertNoUnroutedExternal(stats);
});

test("screenshots: closed, playlist, error, completion at 360px and 1280px", async ({ browser }, testInfo) => {
  const screenshots = [];
  for (const width of [360, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    const closedStats = await installLocalNetwork(page, { failEncoded: true });
    await gotoBranch(page);
    await page.locator("#dp-open").scrollIntoViewIfNeeded();
    await writeScreenshot(page, testInfo, `closed_${width}.png`);
    await scrollOpenButtonIntoView(page);
    await page.locator("#dp-panel").scrollIntoViewIfNeeded();
    await page.locator("#dp-channel-picker").selectOption({ label: "DEMO — Classic Cinema — ok" });
    await expect(page.locator(".dp-items button")).toHaveCount(3);
    await page.locator("#dp-panel").scrollIntoViewIfNeeded();
    await writeScreenshot(page, testInfo, `playlist_${width}.png`);

    await page.locator(".dp-items button").nth(1).click();
    await expect(page.getByText("Unable to play item 2: DEMO — Encoded Space Error Clip")).toBeVisible();
    await page.locator("#dp-panel").scrollIntoViewIfNeeded();
    await writeScreenshot(page, testInfo, `item_error_${width}.png`);
    await assertNoUnroutedExternal(closedStats);
    await context.close();

    const completionContext = await browser.newContext({ viewport: { width, height: 800 } });
    const completionPage = await completionContext.newPage();
    const completionStats = await installLocalNetwork(completionPage, { failEncoded: false });
    await gotoBranch(completionPage);
    await selectClassic(completionPage);
    await completionPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(completionPage.getByText("Playlist complete.", { exact: true })).toBeVisible({ timeout: 10_000 });
    await completionPage.getByText("Playlist complete.", { exact: true }).scrollIntoViewIfNeeded();
    await writeScreenshot(completionPage, testInfo, `completion_${width}.png`);
    await assertNoUnroutedExternal(completionStats);
    await completionContext.close();

    screenshots.push(
      `closed_${width}.png`,
      `playlist_${width}.png`,
      `item_error_${width}.png`,
      `completion_${width}.png`,
    );
  }
  expect(screenshots).toHaveLength(8);
});
