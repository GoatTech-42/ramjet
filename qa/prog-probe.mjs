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
await page.waitForTimeout(3500);
const probe = await page.evaluate(() => {
  const bar = document.querySelector(".slide-prog");
  const bb = bar.getBoundingClientRect();
  const el = document.elementFromPoint(bb.x + bb.width * 0.7, bb.y + bb.height / 2);
  const v = document.querySelector(".feed .slide video");
  return { bb: { x: bb.x, y: bb.y, w: bb.width, h: bb.height }, hit: el?.className || el?.tagName, cur: v.currentTime, dur: v.duration, seekable: v.seekable.length ? [v.seekable.start(0), v.seekable.end(0)] : null };
});
console.log("probe:", JSON.stringify(probe));
// direct JS seek test: does the video accept a far currentTime?
const js = await page.evaluate(async () => {
  const v = document.querySelector(".feed .slide video");
  const target = v.duration * 0.7;
  v.currentTime = target;
  await new Promise((r) => setTimeout(r, 2500));
  return { target, cur: v.currentTime, seeking: v.seeking };
});
console.log("js-seek:", JSON.stringify(js));
await browser.close();
