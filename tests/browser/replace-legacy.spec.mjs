import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { test, expect } from "@playwright/test";
import {
  assertNoUnroutedExternal,
  BASE_URL,
  installLocalNetwork,
  readIndexFixture,
} from "./helpers.mjs";

const validManifest = {
  schemaVersion: 1,
  channelId: "gate-demo",
  publishedAt: "2026-10-24T10:00:00.000Z",
  durationBasis: "unknown",
  declaredTotalSeconds: null,
  items: [{
    seq: 1,
    localId: "lv-0123456789ab",
    title: "DEMO — synthetic playlist item",
    url: "https://archive.org/download/synthetic/red.mp4",
    durationSec: -1,
  }],
};

function oneRowIndex(row) {
  return { schemaVersion: 1, channels: [row] };
}

async function gotoReplacementPage(page, path = "/classic.html") {
  await page.goto(`${BASE_URL}${path}`);
  await expect(page.locator("#dp-root")).toBeAttached();
  await expect(page.locator("#dp-root")).toHaveAttribute("data-dp-replace-legacy", "true");
}

async function expectLegacyVisible(page) {
  const legacy = page.locator(".app-container");
  await expect(legacy).toBeVisible();
  await expect(legacy).not.toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#dp-panel")).toBeHidden();
}

async function captureState(page, testInfo, fileName) {
  const path = testInfo.outputPath("screenshots", fileName);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(fileName, { path, contentType: "image/png" });
}

test("valid playlist replaces legacy only after verification, opens without autoplay, and can restore legacy", async ({ page }, testInfo) => {
  const index = await readIndexFixture();
  const stats = await installLocalNetwork(page, {
    replaceLegacy: true,
    indexOverride: index,
    indexStatus: async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return 200;
    },
  });
  await gotoReplacementPage(page);

  await expect(page.locator("#dp-check-status")).toHaveText("Checking daily playlist…");
  await expect(page.locator(".app-container")).toBeVisible();
  await expect(page.locator("#dp-panel")).toBeHidden();
  await page.evaluate(() => {
    window.updateNowPlayingUI.__dpOriginalMarker = "original";
  });

  await expect(page.locator(".app-container")).toBeHidden();
  await expect(page.locator(".app-container")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#dp-panel")).toBeVisible();
  await expect(page.locator("#dp-show-legacy")).toBeVisible();
  await expect(page.locator(".dp-items button")).toHaveCount(3);
  await expect(page.locator("#dp-video")).toHaveJSProperty("paused", true);
  await expect(page.locator("#video-player")).toHaveJSProperty("paused", true);
  expect(await page.evaluate(() => window.updateNowPlayingUI.__dpOriginalMarker)).toBeUndefined();
  await captureState(page, testInfo, "step9-a-ready.png");

  await page.locator("#dp-show-legacy").click();
  await expect(page.locator(".app-container")).toBeVisible();
  await expect(page.locator(".app-container")).not.toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#dp-show-legacy")).toBeHidden();
  await expect(page.locator("#dp-check-status")).toHaveText("Legacy 24h schedule shown for this session.");
  expect(await page.evaluate(() => window.updateNowPlayingUI.__dpOriginalMarker)).toBe("original");
  expect(await page.evaluate(() => sessionStorage.getItem("dp-show-legacy"))).toBe("true");
  await expect(page.locator("#video-player")).toHaveJSProperty("paused", true);
  await assertNoUnroutedExternal(stats);
});

test("a delayed index check keeps legacy visible until readiness resolves", async ({ page }) => {
  const index = await readIndexFixture();
  const stats = await installLocalNetwork(page, {
    replaceLegacy: true,
    indexOverride: index,
    indexStatus: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return 200;
    },
  });
  await gotoReplacementPage(page);
  await expect(page.locator(".app-container")).toBeVisible();
  await expect(page.locator("#dp-check-status")).toHaveText("Checking daily playlist…");
  await expect(page.locator("#dp-panel")).toBeHidden();
  await expect(page.locator(".app-container")).toBeHidden();
  await assertNoUnroutedExternal(stats);
});

test("index 404 leaves legacy visible and gives the button an explicit no-playlist state", async ({ page }, testInfo) => {
  const stats = await installLocalNetwork(page, {
    replaceLegacy: true,
    indexOverride: await readIndexFixture(),
    indexStatus: 404,
  });
  await gotoReplacementPage(page);
  await expect(page.locator("#dp-open")).toHaveText("No published playlist");
  await expect(page.locator("#dp-check-status")).toHaveText("No published playlist");
  await expectLegacyVisible(page);
  await captureState(page, testInfo, "step9-b-index-404.png");
  await assertNoUnroutedExternal(stats);
});

for (const scenario of [
  {
    name: "invalid manifest",
    row: { id: "gate-demo", label: "DEMO — Invalid Manifest", status: "ok", manifest: "latest/gate-demo.json", itemCount: 1 },
    manifest: { ...validManifest, items: [] },
    expected: "Playlist unavailable: no eligible items",
  },
  {
    name: "zero itemCount",
    row: { id: "gate-demo", label: "DEMO — Empty Count", status: "ok", manifest: "latest/gate-demo.json", itemCount: 0 },
    manifest: validManifest,
    expected: "No published playlist",
  },
  {
    name: "all items ineligible",
    row: { id: "gate-demo", label: "DEMO — Ineligible Items", status: "ok", manifest: "latest/gate-demo.json", itemCount: 1 },
    manifest: {
      ...validManifest,
      items: [{
        ...validManifest.items[0],
        url: "https://example.invalid/not-allowed.mp4",
      }],
    },
    expected: "Playlist unavailable: no eligible items",
  },
]) {
  test(`${scenario.name} cannot replace the legacy page`, async ({ page }, testInfo) => {
    const stats = await installLocalNetwork(page, {
      replaceLegacy: true,
      indexOverride: oneRowIndex(scenario.row),
      manifestOverrides: { "/daily/latest/gate-demo.json": scenario.manifest },
    });
    await gotoReplacementPage(page);
    await expect(page.locator("#dp-open")).toHaveText(scenario.expected);
    await expect(page.locator("#dp-check-status")).toHaveText(scenario.expected);
    await expectLegacyVisible(page);
    if (scenario.name === "invalid manifest") {
      await captureState(page, testInfo, "step9-c-invalid-manifest.png");
    }
    await assertNoUnroutedExternal(stats);
  });
}

test("error and no_playlist rows with last-good manifest paths do not qualify for replacement", async ({ page }) => {
  const rows = ["error", "no_playlist"].map((status) => ({
    id: `gate-${status}`,
    label: `DEMO — ${status}`,
    status,
    manifest: `latest/gate-${status}.json`,
    itemCount: 1,
  }));
  const stats = await installLocalNetwork(page, {
    replaceLegacy: true,
    indexOverride: { schemaVersion: 1, channels: rows },
    manifestOverrides: {
      "/daily/latest/gate-error.json": { ...validManifest, channelId: "gate-error" },
      "/daily/latest/gate-no_playlist.json": { ...validManifest, channelId: "gate-no_playlist" },
    },
  });
  await gotoReplacementPage(page);
  await expect(page.locator("#dp-open")).toHaveText("No published playlist");
  await expectLegacyVisible(page);
  expect(stats.dailyPaths.filter((path) => path.endsWith(".json"))).toEqual([
    "/daily/latest/index.json",
  ]);
  await assertNoUnroutedExternal(stats);
});

test("index and manifest paths remain under a /libvetv/ base path", async ({ page }) => {
  const stats = await installLocalNetwork(page, { replaceLegacy: true });
  await gotoReplacementPage(page, "/libvetv/classic.html");
  await expect(page.locator("#dp-panel")).toBeVisible();
  await expect(page.locator(".app-container")).toBeHidden();
  expect(stats.dailyPaths).toContain("/libvetv/daily/latest/index.json");
  expect(stats.dailyPaths).toContain("/libvetv/daily/latest/classic-cinema.json");
  await assertNoUnroutedExternal(stats);
});

test("data-dp-replace-legacy=false keeps legacy visible even when playlist can be opened", async ({ page }) => {
  const stats = await installLocalNetwork(page);
  await page.goto(`${BASE_URL}/classic.html`);
  await expect(page.locator("#dp-root")).toHaveAttribute("data-dp-replace-legacy", "false");
  await expectLegacyVisible(page);
  expect(stats.dailyPaths).toEqual([]);

  await page.locator("#dp-open").click();
  await expect(page.locator("#dp-channel-picker")).toBeVisible();
  await page.locator("#dp-channel-picker").selectOption({ label: "DEMO — Classic Cinema — ok" });
  await expect(page.locator(".dp-items button")).toHaveCount(3);
  await expect(page.locator(".app-container")).toBeVisible();
  await assertNoUnroutedExternal(stats);
});

test("throwing sessionStorage does not prevent replacement or restoring the legacy page", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("DEMO storage unavailable");
      },
    });
  });
  const stats = await installLocalNetwork(page, { replaceLegacy: true });
  await gotoReplacementPage(page);
  await expect(page.locator("#dp-panel")).toBeVisible();
  await expect(page.locator(".app-container")).toBeHidden();
  await page.locator("#dp-show-legacy").click();
  await expect(page.locator(".app-container")).toBeVisible();
  await expect(page.locator("#dp-check-status")).toHaveText("Legacy 24h schedule shown for this session.");
  await assertNoUnroutedExternal(stats);
});
