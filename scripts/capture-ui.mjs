import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
});
try {
  await mkdir("docs/screenshots", { recursive: true });
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1100 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    await page.goto(process.env.PREVIEW_URL || "http://127.0.0.1:5173");
    await page.locator(".event-card").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: `docs/screenshots/${name}.png`,
      fullPage: true,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
