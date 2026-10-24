import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";

export const BASE_URL = "http://127.0.0.1:4173";
const ROOT = process.cwd();
const MEDIA_ROOT = resolve(ROOT, "tests/fixtures/media");
const DAILY_ROOT = resolve(ROOT, "tests/fixtures/site/daily");

const MEDIA = {
  red: await readFile(resolve(MEDIA_ROOT, "red.mp4")),
  blue: await readFile(resolve(MEDIA_ROOT, "blue.mp4")),
  green: await readFile(resolve(MEDIA_ROOT, "green.mp4")),
};

export const BASELINE_HTML = execFileSync(
  "git",
  ["show", "origin/main:index.html"],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

export async function readIndexFixture() {
  return JSON.parse(await readFile(resolve(DAILY_ROOT, "latest/index.json"), "utf8"));
}

function mediaForPath(pathname) {
  if (pathname.endsWith("/blue.mp4")) return MEDIA.blue;
  if (pathname.endsWith("/green.mp4")) return MEDIA.green;
  return MEDIA.red;
}

function rangeResponse(buffer, rangeHeader) {
  if (!rangeHeader) return { status: 200, body: buffer, rangeHeaders: {} };
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return {
      status: 416,
      body: Buffer.alloc(0),
      rangeHeaders: { "Content-Range": `bytes */${buffer.length}` },
    };
  }
  const start = Number(match[1]);
  const end = Math.min(
    match[2] ? Number(match[2]) : buffer.length - 1,
    buffer.length - 1,
  );
  if (!Number.isSafeInteger(start) || start > end || start >= buffer.length) {
    return {
      status: 416,
      body: Buffer.alloc(0),
      rangeHeaders: { "Content-Range": `bytes */${buffer.length}` },
    };
  }
  return {
    status: 206,
    body: buffer.subarray(start, end + 1),
    rangeHeaders: {
      "Content-Range": `bytes ${start}-${end}/${buffer.length}`,
    },
  };
}

export async function installLocalNetwork(page, {
  failEncoded = true,
  encodedDelayMs = 0,
  indexOverride = null,
  manifestOverrides = {},
} = {}) {
  const stats = {
    dailyPaths: [],
    archivePaths: [],
    blockedExistingCdn: [],
    unroutedExternal: [],
    localPaths: [],
  };

  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === BASE_URL) {
      stats.localPaths.push(requestUrl.pathname);
      if (requestUrl.pathname === "/__baseline__") {
        await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: BASELINE_HTML });
        return;
      }
      if (requestUrl.pathname.startsWith("/daily/")) {
        stats.dailyPaths.push(requestUrl.pathname);
        let body;
        try {
          const fixturePath = resolve(DAILY_ROOT, `.${requestUrl.pathname.slice("/daily".length)}`);
          if (requestUrl.pathname === "/daily/latest/index.json" && indexOverride) {
            body = Buffer.from(JSON.stringify(indexOverride));
          } else if (manifestOverrides[requestUrl.pathname]) {
            body = Buffer.from(JSON.stringify(manifestOverrides[requestUrl.pathname]));
          } else {
            body = await readFile(fixturePath);
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json; charset=utf-8",
            body,
          });
        } catch {
          await route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
        }
        return;
      }
      await route.continue();
      return;
    }

    if (requestUrl.hostname === "archive.org") {
      stats.archivePaths.push(requestUrl.pathname);
      if (requestUrl.pathname.includes("My%20Movie.mp4") && failEncoded) {
        if (encodedDelayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, encodedDelayMs));
        try {
          await route.abort("failed");
        } catch {
          // A fast item switch may already have cancelled this synthetic request.
        }
        return;
      }
      if (!requestUrl.pathname.toLowerCase().endsWith(".mp4")) {
        await route.fulfill({ status: 200, contentType: "text/vtt", body: "WEBVTT\n\n" });
        return;
      }
      const media = mediaForPath(requestUrl.pathname);
      const ranged = rangeResponse(media, route.request().headers().range);
      await route.fulfill({
        status: ranged.status,
        headers: {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "Content-Length": String(ranged.body.length),
          ...ranged.rangeHeaders,
        },
        body: ranged.body,
      });
      return;
    }

    if (requestUrl.hostname === "cdn.tailwindcss.com" || requestUrl.hostname === "cdn.jsdelivr.net") {
      stats.blockedExistingCdn.push(requestUrl.hostname);
      try {
        await route.abort("blockedbyclient");
      } catch {
        // Ignore a request already cancelled by the page.
      }
      return;
    }

    stats.unroutedExternal.push(`${requestUrl.hostname}${requestUrl.pathname}`);
    try {
      await route.abort("blockedbyclient");
    } catch {
      // Keep the original external request blocked even if the page has navigated.
    }
  });

  return stats;
}

export async function openPlaylist(page, label = "DEMO — Classic Cinema — ok") {
  await page.getByRole("button", { name: "Daily Playlist", exact: true }).click();
  await expect(page.locator("#dp-panel")).toBeVisible();
  const picker = page.locator("#dp-channel-picker");
  await expect(picker).toBeVisible();
  await picker.selectOption({ label });
}

export async function waitForVideoPlaying(videoLocator) {
  await expect.poll(
    () => videoLocator.evaluate((video) => !video.paused && Boolean(video.currentSrc)),
    { timeout: 10_000 },
  ).toBe(true);
}

export async function waitForOldPagePlaying(page) {
  const video = page.locator("#video-player");
  await expect(video).toBeAttached();
  await waitForVideoPlaying(video);
  return video;
}

export async function assertNoUnroutedExternal(stats) {
  expect(stats.unroutedExternal).toEqual([]);
}
