import { test, expect } from "@playwright/test";
import { assertNoUnroutedExternal, BASE_URL, installLocalNetwork } from "./helpers.mjs";

async function gotoStudio(page, path = "/") {
  await page.goto(`${BASE_URL}${path}`);
  await expect(page.locator("#dp-root")).toHaveAttribute("data-dp-mode", "studio");
}

async function noHorizontalOverflow(page) {
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("desktop studio", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("opens the daily playlist with all docks, without autoplay or legacy markup", async ({ page }) => {
    const stats = await installLocalNetwork(page);
    await gotoStudio(page);
    await expect(page.locator("#dp-panel")).toBeVisible();
    await expect(page.locator(".dp-items button")).toHaveCount(3);
    await expect(page.locator("#dp-video")).toHaveJSProperty("paused", true);
    await expect(page.locator("#video-player")).toHaveCount(0);
    await expect(page.locator(".app-container")).toHaveCount(0);
    for (const id of ["st-media", "st-monitor", "st-telemetry"]) await expect(page.locator(`#${id}`)).toBeVisible();
    await expect(page.locator(".st-rundown-title")).toBeVisible();
    await expect(page.locator("#dp-close")).toBeHidden();
    await expect(page.locator(".st-classic")).toHaveAttribute("href", "legacy.html");
    // Three columns: rundown left of the stage left of the right docks.
    const boxes = await Promise.all([".dp-items", ".dp-stage", "#st-monitor"].map(
      (selector) => page.locator(selector).first().boundingBox()));
    expect(boxes[0].x + boxes[0].width).toBeLessThanOrEqual(boxes[1].x);
    expect(boxes[1].x + boxes[1].width).toBeLessThanOrEqual(boxes[2].x);
    await noHorizontalOverflow(page);
    await assertNoUnroutedExternal(stats);
    expect(stats.blockedExistingCdn).toEqual([]);
  });

  test("monitor and telemetry show measured values from the real player", async ({ page }) => {
    const stats = await installLocalNetwork(page);
    await gotoStudio(page);
    await expect(page.locator(".dp-items button")).toHaveCount(3);
    await expect(page.locator("#st-monitor dd").first()).toHaveText("Idle");
    await expect(page.locator("#st-telemetry")).toContainText("Playlist data requests");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.locator("#st-monitor dd").first()).toHaveText("Playing");
    await expect(page.locator("#st-monitor")).not.toContainText("0×0");
    await expect(page.locator("#st-media dd").nth(1)).not.toHaveText("—");
    const requests = await page.locator("#st-telemetry dd").nth(4).textContent();
    expect(Number(requests)).toBeGreaterThanOrEqual(2);
    await assertNoUnroutedExternal(stats);
  });

  test("Focus mode hides the side docks, persists, and toggles with F", async ({ page }) => {
    const stats = await installLocalNetwork(page);
    await gotoStudio(page);
    await expect(page.locator(".dp-items")).toBeVisible();
    await page.locator("#st-focus").click();
    await expect(page.locator("#st-focus")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".dp-items")).toBeHidden();
    await expect(page.locator("#st-monitor")).toBeHidden();
    await expect(page.locator(".dp-stage")).toBeVisible();
    await page.reload();
    await expect(page.locator("#st-focus")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".dp-items")).toBeHidden();
    await page.keyboard.press("f");
    await expect(page.locator(".dp-items")).toBeVisible();
    await expect(page.locator("#st-focus")).toHaveAttribute("aria-pressed", "false");
    await page.locator("#dp-channel-picker").focus();
    await page.keyboard.press("f");
    await expect(page.locator(".dp-items")).toBeVisible();
    await assertNoUnroutedExternal(stats);
  });

  test("blocked localStorage does not break Focus mode", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() { throw new Error("DEMO storage unavailable"); },
      });
    });
    const stats = await installLocalNetwork(page);
    await gotoStudio(page);
    await page.locator("#st-focus").click();
    await expect(page.locator(".dp-items")).toBeHidden();
    await assertNoUnroutedExternal(stats);
  });

  test("a 404 index gives a truthful empty state and keeps the classic link", async ({ page }) => {
    const stats = await installLocalNetwork(page, { indexOverride: { schemaVersion: 1, channels: [] }, indexStatus: 404 });
    await gotoStudio(page);
    await expect(page.locator("#dp-check-status")).toHaveText("No published playlist");
    await expect(page.locator("#dp-panel")).toBeHidden();
    await expect(page.locator(".st-classic")).toBeVisible();
    await assertNoUnroutedExternal(stats);
  });

  test("works under a /libvetv/ base path", async ({ page }) => {
    const stats = await installLocalNetwork(page);
    await gotoStudio(page, "/libvetv/");
    await expect(page.locator(".dp-items button")).toHaveCount(3);
    expect(stats.dailyPaths).toContain("/libvetv/daily/latest/index.json");
    await assertNoUnroutedExternal(stats);
  });
});

test.describe("mobile studio", () => {
  test.use({ viewport: { width: 390, height: 800 }, hasTouch: true });

  test("docks become bottom sheets above a tab bar", async ({ page }) => {
    const stats = await installLocalNetwork(page);
    await gotoStudio(page);
    await expect(page.locator("#dp-channel-picker")).toBeVisible();
    await expect(page.locator(".st-tabs")).toBeVisible();
    await expect(page.locator(".dp-stage")).toBeVisible();
    await expect(page.locator(".dp-items")).toBeHidden();
    await expect(page.locator("#st-monitor")).toBeHidden();
    await noHorizontalOverflow(page);

    await page.getByRole("button", { name: "Rundown", exact: true }).click();
    await expect(page.locator(".dp-items")).toBeVisible();
    await expect(page.getByRole("button", { name: "Rundown", exact: true })).toHaveAttribute("aria-pressed", "true");
    const sheet = await page.locator(".dp-items").boundingBox();
    const tabs = await page.locator(".st-tabs").boundingBox();
    expect(sheet.y + sheet.height).toBeLessThanOrEqual(tabs.y + 1);

    await page.locator(".dp-item-button").nth(1).click();
    await expect(page.locator(".dp-items")).toBeHidden();

    await page.getByRole("button", { name: "Monitor", exact: true }).click();
    await expect(page.locator("#st-monitor")).toBeVisible();
    await expect(page.locator("#st-telemetry")).toBeHidden();
    await page.getByRole("button", { name: "Telemetry", exact: true }).click();
    await expect(page.locator("#st-telemetry")).toBeVisible();
    await expect(page.locator("#st-monitor")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.locator("#st-telemetry")).toBeHidden();

    await page.getByRole("button", { name: "Media", exact: true }).click();
    await page.locator("#st-media .st-sheet-close").click();
    await expect(page.locator("#st-media")).toBeHidden();
    await noHorizontalOverflow(page);
    await assertNoUnroutedExternal(stats);
  });

  test("Focus mode removes the tab bar", async ({ page }) => {
    const stats = await installLocalNetwork(page);
    await gotoStudio(page);
    await expect(page.locator(".st-tabs")).toBeVisible();
    await page.locator("#st-focus").click();
    await expect(page.locator(".st-tabs")).toBeHidden();
    await expect(page.locator(".dp-stage")).toBeVisible();
    await assertNoUnroutedExternal(stats);
  });
});
