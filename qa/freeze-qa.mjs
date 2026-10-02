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
const report = [];
for (let s = 0; s < 4; s++) {
  const r = await page.evaluate(async () => {
    const v = [...document.querySelectorAll(".feed .slide video")].find((x) => !x.paused) || document.querySelector(".feed .slide video");
    if (!v) return { err: "no video" };
    let waits = 0, lastT = v.currentTime, stuckMax = 0, stuckCur = 0;
    v.addEventListener("waiting", () => waits++);
    const t0 = Date.now();
    while (Date.now() - t0 < 35000) {
      await new Promise((r) => setTimeout(r, 500));
      if (Math.abs(v.currentTime - lastT) < 0.05) { stuckCur += 0.5; stuckMax = Math.max(stuckMax, stuckCur); }
      else stuckCur = 0;
      lastT = v.currentTime;
      if (v.ended) break;
    }
    const a = document.querySelector("audio");
    return { dur: v.duration, endT: v.currentTime, waits, stuckMax, paused: v.paused, ended: v.ended, err: v.error?.code || 0, aRate: a?.playbackRate, aPaused: a?.paused };
  });
  report.push(r);
  if (r.ended || r.err) { /* move on */ }
  await page.evaluate((n) => { const w = document.querySelector(".feed-scroll"); w.scrollTo({ top: w.clientHeight * n, behavior: "auto" }); }, s + 1);
  await page.waitForTimeout(1500);
}
console.log(JSON.stringify(report, null, 1));
await browser.close();
