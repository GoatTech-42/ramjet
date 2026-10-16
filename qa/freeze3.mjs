import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1400000, uploadThroughput: 500000 });
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const token = (login.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 60000 });
await page.tap(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
// wait until genuinely playing (resolve+start can be slow under throttle)
let started = false;
for (let w = 0; w < 50; w++) {
  await page.waitForTimeout(400);
  started = await page.evaluate(() => { const v = [...document.querySelectorAll(".feed .slide video")].find((x) => !x.paused && x.currentTime > 0.4); return !!v; });
  if (started) break;
  const p = await page.$(".slide-play");
  if (p) await p.tap().catch(() => {});
}
if (!started) { console.log(JSON.stringify({ err: "never started" })); await browser.close(); process.exit(0); }
const r = await page.evaluate(async () => {
  const v = [...document.querySelectorAll(".feed .slide video")].find((x) => !x.paused);
  let waits = 0, lastT = -1, stuckMax = 0, stuckCur = 0;
  v.addEventListener("waiting", () => waits++);
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    await new Promise((r) => setTimeout(r, 500));
    if (Math.abs(v.currentTime - lastT) < 0.05 && !v.paused && !v.ended) { stuckCur += 0.5; stuckMax = Math.max(stuckMax, stuckCur); } else stuckCur = 0;
    lastT = v.currentTime;
    if (v.ended || v.error) break;
  }
  const a = document.querySelector("audio");
  return { dur: Math.round(v.duration * 10) / 10, reachedT: Math.round(v.currentTime * 10) / 10, waits, stuckMax, paused: v.paused, ended: v.ended, err: v.error?.code || 0, muted: v.muted, aExists: !!a, aPaused: a?.paused, aRate: a?.playbackRate };
});
console.log("slide1:", JSON.stringify(r));
await browser.close();
