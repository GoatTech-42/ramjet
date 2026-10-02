import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const THROTTLE = { offline: false, latency: 80, downloadThroughput: 4000000, uploadThroughput: 1000000 };
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", THROTTLE);
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const token = (login.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 60000 });
await page.tap(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
let started = false;
for (let w = 0; w < 50; w++) {
  await page.waitForTimeout(400);
  started = await page.evaluate(() => { const v = [...document.querySelectorAll(".feed .slide video")].find((x) => !x.paused && x.currentTime > 0.4); return !!v; });
  if (started) break;
  const p = await page.$(".slide-play");
  if (p) await p.tap().catch(() => {});
}
if (!started) {
  const diag = await page.evaluate(() => {
    const vids = [...document.querySelectorAll(".feed .slide video")].map((v) => ({ src: !!v.src, rs: v.readyState, ns: v.networkState, paused: v.paused, t: v.currentTime, err: v.error?.code || 0, muted: v.muted }));
    const errs = [...document.querySelectorAll(".slide-err")].map((e) => e.textContent.trim());
    const notes = [...document.querySelectorAll(".slide-note")].map((e) => e.textContent.trim());
    return { vids, errs, notes, audios: document.querySelectorAll("audio").length };
  });
  console.log("DIAG:", JSON.stringify(diag));
  await browser.close(); process.exit(0);
}
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
