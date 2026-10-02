import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
for (const [name, dev] of [["desktop", null], ["iphone", devices["iPhone 13"]]]) {
  const browser = await chromium.launch();
  const page = await (await browser.newContext(dev || { viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(BASE + "/login");
  const inputs = await page.$$("input");
  await inputs[0].fill("qa"); await inputs[1].fill(PW);
  await page.click("button[type=submit], button");
  await page.waitForURL(BASE + "/", { timeout: 8000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `/tmp/qa-hub-${name}.png` });
  const rows = await page.evaluate(() => [...document.querySelectorAll("a.row")].map((r) => r.getAttribute("href")));
  console.log(name, "| hub rows:", JSON.stringify(rows));
  await browser.close();
}
