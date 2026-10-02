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
// wait for an HD pair (audio element exists) and playback
let ok = false;
for (let w = 0; w < 40; w++) {
  await page.waitForTimeout(300);
  ok = await page.evaluate(() => { const v = [...document.querySelectorAll(".feed .slide video")].find((x) => !x.paused && x.currentTime > 0.5); return !!v && document.querySelectorAll("audio").length > 0; });
  if (ok) break;
}
const samples = await page.evaluate(async () => {
  const v = [...document.querySelectorAll(".feed .slide video")].find((x) => !x.paused) || document.querySelector(".feed .slide video");
  const a = document.querySelector("audio");
  if (!v || !a) return { err: "no pair" };
  let waits = 0; v.addEventListener("waiting", () => waits++);
  const rows = [];
  let lastA = a.currentTime, hardSeeks = 0, maxDrift = 0, rateChanges = new Set();
  for (let k = 0; k < 80; k++) {
    await new Promise((r) => setTimeout(r, 250));
    const d = v.currentTime - a.currentTime;
    maxDrift = Math.max(maxDrift, Math.abs(d));
    if (a.currentTime < lastA - 0.4 || a.currentTime - lastA > 0.9) hardSeeks++;
    lastA = a.currentTime;
    rateChanges.add(Math.round(a.playbackRate * 100) / 100);
  }
  return { vt: v.currentTime, at: a.currentTime, maxDrift: Math.round(maxDrift * 1000) / 1000, hardSeeks, rates: [...rateChanges], videoWaits: waits };
});
console.log(JSON.stringify({ pairReady: ok, ...samples }));
await browser.close();
