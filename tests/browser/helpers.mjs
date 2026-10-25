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
  long: await readFile(resolve(MEDIA_ROOT, "long.mp4")),
};

function showBaseline(path) {
  return execFileSync("git", ["show", `origin/main:${path}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// The preserved legacy page is classic.html once this layout is on main; before that it was index.html.
export const BASELINE_HTML = (() => {
  try { return showBaseline("classic.html"); } catch { return showBaseline("index.html"); }
})();

export async function readIndexFixture() {
  return JSON.parse(await readFile(resolve(DAILY_ROOT, "latest/index.json"), "utf8"));
}

function mediaForPath(pathname) {
  if (pathname.endsWith("/long.mp4")) return MEDIA.long;
  if (pathname.endsWith("/blue.mp4")) return MEDIA.blue;
  if (pathname.endsWith("/green.mp4")) return MEDIA.green;
  if (pathname.endsWith("/red.mp4")) return MEDIA.red;
  if (pathname.endsWith("Seg2.mp4")) return MEDIA.green;
  if (pathname.endsWith("Seg1.mp4")) return MEDIA.long;
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
  failPaths = [],
  encodedDelayMs = 0,
  mediaResolver = mediaForPath,
  indexOverride = null,
  indexStatus = 200,
  replaceLegacy = false,
  manifestOverrides = {},
  digestStatus = 200,
  digestBody = { stories: [] },
} = {}) {
  const stats = {
    dailyPaths: [],
    indexRequests: 0,
    archivePaths: [],
    blockedExistingCdn: [],
    unroutedExternal: [],
    localPaths: [],
    digestPaths: [],
  };

  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === BASE_URL) {
      stats.localPaths.push(requestUrl.pathname);
      const localPath = requestUrl.pathname.replace(/^\/libvetv(?=\/|$)/, "") || "/";
      if (localPath === "/" || localPath === "/index.html" || localPath === "/classic.html") {
        const response = await route.fetch();
        let body = await response.text();
        if (!replaceLegacy) {
          body = body.replace(
            'data-dp-replace-legacy="true"',
            'data-dp-replace-legacy="false"',
          );
        }
        await route.fulfill({ response, body });
        return;
      }
      if (localPath === "/Daily-News-Digest-/data/current/data.json") {
        stats.digestPaths.push(requestUrl.pathname);
        await route.fulfill({
          status: digestStatus, contentType: "application/json",
          body: typeof digestBody === "string" ? digestBody : JSON.stringify(digestBody),
        });
        return;
      }
      if (localPath === "/__baseline__") {
        // origin/main now contains the legacy-replacement gate (data-dp-replace-legacy="true"),
        // so the baseline page must get the same opt-out as the branch page or it would hide
        // and pause the legacy player it is supposed to represent.
        const baselineBody = replaceLegacy ? BASELINE_HTML : BASELINE_HTML.replace(
          'data-dp-replace-legacy="true"',
          'data-dp-replace-legacy="false"',
        );
        await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: baselineBody });
        return;
      }
      if (localPath.startsWith("/daily/")) {
        stats.dailyPaths.push(requestUrl.pathname);
        let body;
        try {
          const fixturePath = resolve(DAILY_ROOT, `.${localPath.slice("/daily".length)}`);
          if (localPath === "/daily/latest/index.json" && indexOverride) {
            stats.indexRequests += 1;
            const responseStatus = typeof indexStatus === "function" ? await indexStatus() : indexStatus;
            if (responseStatus !== 200) {
              await route.fulfill({
                status: responseStatus, contentType: "application/json; charset=utf-8",
                body: JSON.stringify({ error: "DEMO synthetic index failure" }),
              });
              return;
            }
            const index = typeof indexOverride === "function" ? await indexOverride() : indexOverride;
            body = Buffer.from(JSON.stringify(index));
          } else if (manifestOverrides[localPath]) {
            const manifest = typeof manifestOverrides[localPath] === "function"
              ? await manifestOverrides[localPath]() : manifestOverrides[localPath];
            body = Buffer.from(JSON.stringify(manifest));
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

    if (requestUrl.hostname === "archive.org" || requestUrl.hostname === "affiliates.alexjoneslive.com") {
      stats.archivePaths.push(requestUrl.pathname);
      if ((requestUrl.pathname.includes("My%20Movie.mp4") ||
           failPaths.some((path) => requestUrl.pathname.endsWith(path))) &&
          (typeof failEncoded === "function" ? failEncoded() : failEncoded)) {
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
      const media = mediaResolver(requestUrl.pathname, MEDIA);
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
