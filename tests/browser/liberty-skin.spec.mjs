import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BASE_URL } from "./helpers.mjs";

const RED = await readFile(resolve("tests/fixtures/media/red.mp4"));

async function routeExternal(page, { mediaStatus = 200 } = {}) {
  const external = [];
  await page.route("https://affiliates.alexjoneslive.com/**", async (route) => {
    external.push(route.request().url());
    if (mediaStatus !== 200) { await route.fulfill({ status: mediaStatus, body: "nope" }); return; }
    await route.fulfill({ status: 200, contentType: "video/mp4", body: RED });
  });
  await page.route("https://www.liberty-express.org/**", async (route) => {
    external.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<title>stub</title>" });
  });
  return external;
}

test("skin loads real data, plays nothing until clicked", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const external = await routeExternal(page);
  await page.goto(`${BASE_URL}/`);
  await expect(page.locator("h1")).toHaveText("Liberty Express");
  await expect(page.locator(".news-tile")).toHaveCount(3);
  await expect(page.locator(".cat-btn").first()).toContainText("335");
  await expect(page.locator("video")).toHaveCount(0);
  expect(external).toEqual([]);          // nothing external requested before a click
  expect(errors).toEqual([]);
});

test("category tabs and search filter the guide; page links open in a new tab", async ({ page }) => {
  await routeExternal(page);
  await page.goto(`${BASE_URL}/`);
  await page.locator('.cat-btn[data-cat="News"]').click();
  await expect(page.locator("#channel-guide-list .channel-row")).toHaveCount(22);
  await page.locator('.cat-btn[data-cat="All"]').click();
  await page.fill("#guide-search", "zzzz-no-such-page");
  await expect(page.locator(".guide-note")).toHaveText("No pages match.");
  await page.fill("#guide-search", "");
  const first = page.locator("#channel-guide-list a.channel-row").first();
  await expect(first).toHaveAttribute("target", "_blank");
  await expect(first).toHaveAttribute("rel", /noopener/);
  await expect(first).toHaveAttribute("href", /^https:\/\/www\.liberty-express\.org\//);
});

test("clicking a show plays its first segment and reports Playing from the video element", async ({ page }) => {
  const external = await routeExternal(page);
  await page.goto(`${BASE_URL}/`);
  await page.locator(".news-tile").first().click();
  await expect(page.locator("video")).toHaveCount(1);
  await expect(page.locator(".news-tile").first().locator(".status-indicator")).toContainText(/Loading|Playing|Buffering/);
  await expect.poll(() => external.some((u) => /Fri-Alex-Hr1-Seg1\.mp4$/.test(u))).toBe(true);
  await expect(page.locator("#status-bar-text")).toContainText("Segment 1/12");
});

test("a failed media load shows Unavailable with the real error and keeps it", async ({ page }) => {
  await routeExternal(page, { mediaStatus: 404 });
  await page.goto(`${BASE_URL}/`);
  await page.locator(".news-tile").first().click();
  await expect(page.locator(".news-tile").first().locator(".status-indicator")).toContainText("Unavailable");
  await expect(page.locator("#status-bar-text")).toContainText("Error:");
  await expect(page.locator("#player-container")).toContainText("Fri-Alex-Hr1-Seg1.mp4");
});

test("classic view link and the preserved page still exist", async ({ page }) => {
  await page.goto(`${BASE_URL}/`);
  await expect(page.locator('a[href="classic.html"]')).toBeVisible();
  const res = await page.request.get(`${BASE_URL}/classic.html`);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("DAILY-PLAYLIST:BEGIN");
});

test("no horizontal scroll on a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
