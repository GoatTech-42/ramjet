import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
const page = await ctx.newPage();
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const token = (login.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 140)); });
page.on("pageerror", (e) => errs.push("PAGEERR " + String(e).slice(0, 140)));
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 20000 });
await page.tap(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
await page.waitForTimeout(2500);
const p = await page.$(".slide-play");
if (p) { await p.tap().catch(() => {}); await page.waitForTimeout(3000); }
const s1 = await page.evaluate(() => {
  const v = document.querySelector(".slide[data-idx='0'] video");
  const v1 = document.querySelector(".slide[data-idx='1'] video");
  const auds = document.querySelectorAll("audio").length;
  let buf1 = 0;
  try { if (v1?.buffered?.length) buf1 = Math.round(v1.buffered.end(0) * 10) / 10; } catch {}
  return {
    playing: v && !v.paused, t: Math.round((v?.currentTime ?? -1) * 10) / 10,
    vw: v?.videoWidth, vh: v?.videoHeight, muted: v?.muted, audioEls: auds,
    nextHasSrc: !!v1?.src, nextBufferedSecs: buf1,
  };
});
console.log("HD-ACTIVE", JSON.stringify(s1));
// audio actually moving?
const a1 = await page.evaluate(() => { const a = document.querySelector("audio"); return a ? { t: Math.round(a.currentTime * 10) / 10, paused: a.paused } : null; });
console.log("AUDIO", JSON.stringify(a1));
await page.screenshot({ path: "qa/shots/shorts-hd-iphone.png" });
// swipe
await page.evaluate(() => { const w = document.querySelector(".feed-scroll"); w.scrollTo({ top: w.clientHeight, behavior: "smooth" }); });
await page.waitForTimeout(3500);
const s2 = await page.evaluate(() => {
  const v0 = document.querySelector(".slide[data-idx='0'] video");
  const v1 = document.querySelector(".slide[data-idx='1'] video");
  return { prevPaused: v0?.paused, cur: !v1?.paused, vw: v1?.videoWidth, vh: v1?.videoHeight, t: Math.round((v1?.currentTime ?? -1) * 10) / 10 };
});
console.log("AFTER-SWIPE", JSON.stringify(s2));
console.log("ERRS", JSON.stringify(errs.slice(0, 5)));
await browser.close();
