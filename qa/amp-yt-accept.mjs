import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const browser = await chromium.launch();
const page = await (await browser.newContext(devices["iPhone 13"])).newPage();
await page.goto(BASE + "/login");
const inputs = await page.$$("input");
await inputs[0].fill("qa"); await inputs[1].fill(PW);
await page.click("button[type=submit], button");
await page.waitForURL(BASE + "/", { timeout: 8000 });
await page.goto(BASE + "/amp");
await page.fill("input", "starboy the weeknd");
await page.keyboard.press("Enter");
await page.waitForSelector(".row", { timeout: 15000 });
const rows = await page.$$(".row");
await rows[0].click();
for (let i = 0; i < 9; i++) {
  await page.waitForTimeout(10000);
  const t = await page.evaluate(() => document.querySelector(".times")?.textContent || "");
  const e = await page.evaluate(() => document.querySelector(".terr")?.textContent || "");
  console.log(`t+${(i + 1) * 10}s`, t, e ? "| err: " + e : "");
  if (e) break;
}
await page.screenshot({ path: "/tmp/qa-amp-yt-accept.png" });
await browser.close();
