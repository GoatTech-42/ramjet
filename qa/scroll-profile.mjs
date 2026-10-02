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
await page.waitForTimeout(2500);
const p = await page.$(".slide-play");
if (p) await p.tap().catch(() => {});
await page.waitForTimeout(3000);
const rows = [];
for (let i = 1; i <= 12; i++) {
  const t0 = Date.now();
  await page.evaluate((n) => { const w = document.querySelector(".feed-scroll"); w.scrollTo({ top: w.clientHeight * n, behavior: "auto" }); }, i);
  let played = -1;
  for (let w = 0; w < 40; w++) {
    await page.waitForTimeout(200);
    const st = await page.evaluate((n) => {
      const v = document.querySelectorAll(".feed .slide video")[n];
      return v ? { t: v.currentTime, paused: v.paused } : null;
    }, i);
    if (st && !st.paused && st.t > 0.3) { played = Date.now() - t0; break; }
  }
  const m = await page.evaluate(() => {
    const vids = [...document.querySelectorAll(".feed video")];
    const withSrc = vids.filter((v) => !!v.src).length;
    const act = vids.find((v) => !v.paused);
    const q = act?.getVideoPlaybackQuality?.();
    return {
      heapMB: Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576),
      vids: vids.length, withSrc, audios: document.querySelectorAll("audio").length,
      vw: act?.videoWidth, vh: act?.videoHeight,
      dropped: q?.droppedVideoFrames ?? -1, total: q?.totalVideoFrames ?? -1,
    };
  });
  console.log("SWIPE", i, "ms=" + played, JSON.stringify(m));
}
await browser.close();
