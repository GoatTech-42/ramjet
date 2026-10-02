import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
// Luke's path: his network filters googlevideo, so the client goes straight proxy.
await ctx.route("**/*googlevideo.com/**", (route) => route.abort());
await ctx.route("**/*.googlevideo.com/**", (route) => route.abort());
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
  rows.push(played);
  console.log("slide " + i + ": " + (played < 0 ? "TIMEOUT>8s" : played + "ms"));
}
const ok = rows.filter((r) => r >= 0);
console.log("PROXY-SCROLL median:", ok.sort((a, b) => a - b)[Math.floor(ok.length / 2)] + "ms", "played:", ok.length + "/12");
await browser.close();
