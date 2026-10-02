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
  await page.fill("input", "qa");
  const pwInputs = await page.$$("input");
  await pwInputs[1].fill(PW);
  await page.click("button[type=submit], button");
  await page.waitForURL(BASE + "/", { timeout: 8000 });
  await page.goto(BASE + "/amp");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `/tmp/qa-amp-${name}-empty.png` });
  await page.fill(".search input", "daft punk");
  await page.click(".search button");
  await page.waitForSelector(".list .row", { timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `/tmp/qa-amp-${name}-results.png` });
  await page.click(".list .row");
  await page.waitForTimeout(7000);
  const state = await page.evaluate(() => {
    const t = document.querySelector(".times")?.textContent || "";
    return { times: t, title: document.querySelector(".p-title")?.textContent || "" };
  });
  await page.screenshot({ path: `/tmp/qa-amp-${name}-playing.png` });
  console.log(name, "| now:", state.title.slice(0, 40), "| times:", state.times, "| pageerrors:", errs.length ? errs.join("; ") : "none");
  await browser.close();
}
