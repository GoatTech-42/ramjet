import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const results = [];
for (const [name, dev] of [["iphone", devices["iPhone 13"]], ["desktop", null]]) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(dev || { viewport: { width: 1280, height: 800 } });
  let page = await ctx.newPage();
  const errs = [], bad = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  page.on("response", (r) => { if (r.status() >= 500) bad.push(r.status() + " " + r.url().slice(0, 100)); });

  // One login per viewport. The double-submit login race is isolated below.
  await page.goto(BASE + "/login");
  const inputs = await page.$$("input");
  await inputs[0].fill("qa"); await inputs[1].fill(PW);
  await page.click("button[type=submit]");
  await page.waitForURL(BASE + "/", { timeout: 9000 });

  // a. oversized inputs
  const huge = "x".repeat(8192);
  for (const app of ["jetstream", "amp"]) {
    await page.goto(BASE + "/" + app);
    await page.waitForTimeout(700);
    await page.fill("input", huge);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(4000);
    const alive = await page.evaluate(() => !!document.querySelector("input"));
    results.push(`${name}: ${app} 8KB query survives=${alive}`);
  }
  await page.goto(BASE + "/sage");
  await page.waitForTimeout(700);
  await page.evaluate(() => localStorage.clear());
  await page.fill(".composer textarea", huge);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(5000);
  const sageAlive = await page.evaluate(() => !!document.querySelector(".composer textarea"));
  results.push(`${name}: sage 8KB message survives=${sageAlive}`);

  // b. spam clicking
  await page.goto(BASE + "/jetstream");
  await page.waitForTimeout(600);
  await page.fill("input", "never gonna give you up");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".row", { timeout: 15000 });
  const row = (await page.$$(".row"))[0];
  for (let i = 0; i < 8; i++) await row.click({ delay: 30 }).catch(() => {});
  await page.waitForTimeout(4000);
  const frames = await page.evaluate(() => document.querySelectorAll("video").length);
  results.push(`${name}: jetstream 8x-spam-tap -> video elements=${frames} (want 1)`);

  await page.goto(BASE + "/amp");
  await page.waitForTimeout(600);
  await page.fill("input", "rick astley");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".row", { timeout: 15000 });
  const scIdx = await page.evaluate(() => [...document.querySelectorAll(".row")].findIndex((r) => r.querySelector(".src")?.textContent === "soundcloud"));
  const rows2 = await page.$$(".row");
  await rows2[scIdx >= 0 ? scIdx : 0].click();
  await page.waitForTimeout(2500);
  for (let i = 0; i < 10; i++) await page.click(".p-btns .pp", { delay: 40 }).catch(() => {});
  await page.waitForTimeout(2000);
  const dock = await page.evaluate(() => !!document.querySelector(".player"));
  results.push(`${name}: amp 10x-spam-play -> dock alive=${dock}`);

  // c. rapid navigation between apps
  await page.goto(BASE + "/");
  for (const app of ["browse", "jetstream", "amp", "sage", "settings"]) {
    await page.goto(BASE + "/" + app);
    await page.waitForTimeout(250);
  }
  await page.goto(BASE + "/");
  await page.waitForTimeout(600);
  const hubRows = await page.evaluate(() => document.querySelectorAll("a.row").length);
  results.push(`${name}: rapid nav -> hub rows=${hubRows}`);

  results.push(`${name}: pageerrors=${errs.length}${errs.length ? " " + errs.join(" | ") : ""} 5xx=${bad.length ? bad.join(" ; ") : "none"}`);
  await browser.close();
}
console.log(results.join("\n"));
