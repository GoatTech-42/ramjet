import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
for (const [name, dev] of [["desktop", null], ["iphone", devices["iPhone 13"]]]) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(dev || { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(BASE + "/login");
  const inputs = await page.$$("input");
  await inputs[0].fill("qa"); await inputs[1].fill(PW);
  await page.click("button[type=submit], button");
  await page.waitForURL(BASE + "/", { timeout: 8000 });
  await page.goto(BASE + "/sage");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `/tmp/qa-sage-${name}-empty.png` });
  // starter chip
  await page.click(".starter >> nth=2");
  await page.waitForSelector(".msg.mine", { timeout: 8000 });
  await page.waitForSelector(".msg:not(.mine) .bubble", { timeout: 45000 });
  await page.waitForTimeout(800);
  // follow-up via composer
  await page.fill(".composer textarea", "and which one is faster for games?");
  await page.click(".composer button");
  await page.waitForFunction(() => document.querySelectorAll(".msg:not(.mine)").length >= 2, null, { timeout: 90000 });
  await page.waitForTimeout(800);
  const count = await page.evaluate(() => document.querySelectorAll(".msg").length);
  await page.screenshot({ path: `/tmp/qa-sage-${name}-chat.png` });
  console.log(name, "| messages:", count, "| pageerrors:", errs.length ? errs.join(";") : "none");
  await browser.close();
}
