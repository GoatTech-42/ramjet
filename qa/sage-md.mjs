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
  await page.evaluate(() => localStorage.removeItem("sage-conversation"));
  await page.reload();
  await page.fill(".composer textarea", "give me three tips for better sleep, short list");
  await page.click(".composer button");
  await page.waitForSelector(".msg:not(.mine) .bubble:not(.thinking-bubble)", { timeout: 90000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `/tmp/qa-sage-${name}-md.png` });
  const hasStrong = await page.evaluate(() => !!document.querySelector(".bubble strong, .bubble .li"));
  console.log(name, "| markdown rendered:", hasStrong, "| pageerrors:", errs.length ? errs.join(";") : "none");
  await browser.close();
}
