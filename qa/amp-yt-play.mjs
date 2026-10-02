import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const browser = await chromium.launch();
const page = await (await browser.newContext(devices["iPhone 13"])).newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(BASE + "/login");
const inputs = await page.$$("input");
await inputs[0].fill("qa"); await inputs[1].fill(PW);
await page.click("button[type=submit], button");
await page.waitForURL(BASE + "/", { timeout: 8000 });
await page.goto(BASE + "/amp");
await page.fill("input", "never gonna give you up");
await page.keyboard.press("Enter");
await page.waitForSelector(".row", { timeout: 15000 });
const ytRow = await page.evaluateHandle(() => {
  const rows = [...document.querySelectorAll(".row")];
  return rows.find((r) => r.textContent.toLowerCase().includes("rick") || r.innerHTML.includes("yt"));
});
const rows = await page.$$(".row");
await rows[0].click();
await page.waitForTimeout(6000); await page.waitForFunction(() => {
  const t = document.querySelector(".time, .times, .progress-time");
  return t && /0:0[1-9]|0:[1-9]/.test(t.textContent);
}, null, { timeout: 20000 }).catch(() => {}); await page.waitForSelector(".terr", { timeout: 15000 }).catch(() => {});
const state = await page.evaluate(() => {
  const a = document.querySelector("audio");
  return {
    playheadText: document.querySelector(".time, .times")?.textContent || "",
    err: document.querySelector(".trackerr, .err, .track-err")?.textContent || "",
  };
});
await page.waitForTimeout(2500);
await page.screenshot({ path: "/tmp/qa-amp-yt-iphone.png" });
console.log("state:", JSON.stringify(state), "| pageerrors:", errs.length ? errs.join(";") : "none");
await browser.close();
