import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "https://server.lukeevanson.com:4201";
const browser = await chromium.launch({ ignoreHTTPSErrors: true });
for (const [name, dev] of [["desktop", null], ["iphone", devices["iPhone 13"]]]) {
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true, ...(dev || { viewport: { width: 1280, height: 800 } }) })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(BASE + "/login");
  const inputs = await page.$$("input");
  await inputs[0].fill("qa"); await inputs[1].fill(PW);
  await page.click("button[type=submit], button");
  await page.waitForURL(BASE + "/", { timeout: 10000 });
  const rows = await page.evaluate(() => [...document.querySelectorAll("a.row")].map((r) => r.getAttribute("href")));
  await page.goto(BASE + "/settings");
  await page.waitForTimeout(700);
  const who = await page.evaluate(() => document.querySelector(".name")?.textContent);
  console.log(name, "| public hub rows:", JSON.stringify(rows), "| settings user:", who, "| pageerrors:", errs.length ? errs.join(";") : "none");
  await page.close();
}
await browser.close();
