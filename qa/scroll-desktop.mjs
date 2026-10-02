import { chromium } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.route("**/*googlevideo.com/**", (route) => route.abort());
await ctx.route("**/*.googlevideo.com/**", (route) => route.abort());
const page = await ctx.newPage();
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const token = (login.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 60000 });
await page.waitForTimeout(12000); // prefetch head start (desktop UA -> vp9 cache)
await page.click(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
await page.waitForTimeout(2500);
const p = await page.$(".slide-play");
if (p) await p.tap().catch(() => {});
const rows = [];
for (let i = 1; i <= 8; i++) {
  let stalls0 = await page.evaluate((n) => { const v = document.querySelectorAll(".feed .slide video")[n]; return v ? v._stalls || 0 : 0; }, i).catch(() => 0);
  await page.waitForTimeout(4500);
  const t0 = Date.now();
  await page.evaluate((n) => { const w = document.querySelector(".feed-scroll"); w.scrollTo({ top: w.clientHeight * n, behavior: "auto" }); }, i);
  let played = -1;
  for (let w = 0; w < 35; w++) {
    await page.waitForTimeout(200);
    const st = await page.evaluate((n) => {
      const v = document.querySelectorAll(".feed .slide video")[n];
      return v ? { t: v.currentTime, paused: v.paused, vw: v.videoWidth } : null;
    }, i);
    if (st && !st.paused && st.t > 0.3) { played = Date.now() - t0; break; }
  }
  const dims = await page.evaluate((n) => { const v = document.querySelectorAll(".feed .slide video")[n]; return v ? v.videoWidth + "x" + v.videoHeight : "?"; }, i);
  rows.push(played);
  console.log("slide " + i + ": " + (played < 0 ? "TIMEOUT>7s" : played + "ms") + " (" + dims + ")");
}
const ok = rows.filter((r) => r >= 0).sort((a, b) => a - b);
console.log("DESKTOP-VP9 median:", ok[Math.floor(ok.length / 2)] + "ms", "played:", ok.length + "/8");
await browser.close();
