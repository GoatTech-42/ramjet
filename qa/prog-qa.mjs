import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
const page = await ctx.newPage();
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const token = (login.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 60000 });
await page.tap(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
await page.waitForTimeout(2000);
const p = await page.$(".slide-play");
if (p) await p.tap().catch(() => {});
// wait for real playback
let t0 = 0;
for (let w = 0; w < 30; w++) {
  await page.waitForTimeout(300);
  t0 = await page.evaluate(() => { const v = document.querySelector(".feed .slide video"); return v && !v.paused ? v.currentTime : 0; });
  if (t0 > 0.5) break;
}
const bar1 = await page.evaluate(() => document.querySelector(".slide-prog-fill")?.style.width || "none");
await page.waitForTimeout(2500);
const bar2 = await page.evaluate(() => document.querySelector(".slide-prog-fill")?.style.width || "none");
const before = await page.evaluate(() => { const v = document.querySelector(".feed .slide video"); return { cur: v.currentTime, dur: v.duration }; });
// tap the bar at ~70%
const bb = await page.locator(".slide-prog").first().boundingBox();
await page.touchscreen.tap(bb.x + bb.width * 0.7, bb.y + bb.height / 2);
await page.waitForTimeout(800);
const after = await page.evaluate(() => { const v = document.querySelector(".feed .slide video"); return { cur: v.currentTime, dur: v.duration }; });
console.log(JSON.stringify({ bar1, bar2, before, after, seeks: after.cur > before.dur * 0.55 }));
await page.screenshot({ path: "qa/shots/prog-iphone.png" });
await browser.close();
