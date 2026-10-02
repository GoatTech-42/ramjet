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
let played = false;
for (let w = 0; w < 30; w++) {
  await page.waitForTimeout(300);
  played = await page.evaluate(() => { const v = [...document.querySelectorAll(".feed .slide video")].find((x) => !x.paused && x.currentTime > 0.4); return !!v; });
  if (played) break;
}
const visibleBar = async () => page.evaluate(() => {
  for (const b of document.querySelectorAll(".slide-prog")) {
    const r = b.getBoundingClientRect();
    if (r.y >= 0 && r.y + r.height <= innerHeight) return { x: r.x, y: r.y, w: r.width, h: r.height };
  }
  return null;
});
const bb = await visibleBar();
const fill1 = await page.evaluate(() => { for (const b of document.querySelectorAll(".slide-prog")) { const r = b.getBoundingClientRect(); if (r.y >= 0 && r.y + r.height <= innerHeight) return b.querySelector(".slide-prog-fill").style.width; } });
await page.waitForTimeout(2500);
const fill2 = await page.evaluate(() => { for (const b of document.querySelectorAll(".slide-prog")) { const r = b.getBoundingClientRect(); if (r.y >= 0 && r.y + r.height <= innerHeight) return b.querySelector(".slide-prog-fill").style.width; } });
const before = await page.evaluate(() => { const v = [...document.querySelectorAll(".feed .slide video")].find((x) => !x.paused); return v ? { cur: v.currentTime, dur: v.duration } : null; });
await page.touchscreen.tap(bb.x + bb.w * 0.7, bb.y + bb.h / 2);
await page.waitForTimeout(1500);
const after = await page.evaluate(() => { const v = [...document.querySelectorAll(".feed .slide video")].find((x) => !x.paused); return v ? { cur: v.currentTime, dur: v.duration } : null; });
console.log(JSON.stringify({ played, bb, fill1, fill2, before, after, seekOK: after && before && Math.abs(after.cur - before.dur * 0.7) < 2 }));
await page.screenshot({ path: "qa/shots/prog-iphone.png" });
await browser.close();
