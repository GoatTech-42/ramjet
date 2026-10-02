import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.__iologs = [];
  const Orig = window.IntersectionObserver;
  window.IntersectionObserver = class extends Orig {
    constructor(cb, opts) {
      super((entries, obs) => {
        for (const e of entries) window.__iologs.push({ idx: e.target.dataset?.idx, r: Math.round(e.intersectionRatio * 100) / 100, i: e.isIntersecting });
        cb(entries, obs);
      }, opts);
    }
  };
});
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const token = (login.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
page.on("pageerror", (e) => errs.push("PAGEERR " + String(e).slice(0, 200)));
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 20000 });
await page.tap(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
await page.waitForTimeout(2500);
const p = await page.$(".slide-play");
if (p) await p.tap().catch(() => {});
await page.waitForTimeout(2000);
// real swipe gesture
await page.touchscreen.tap(195, 400).catch(() => {});
await page.evaluate(() => { const w = document.querySelector(".feed-scroll"); w.scrollTo({ top: w.clientHeight, behavior: "smooth" }); });
await page.waitForTimeout(4000);
const logs = await page.evaluate(() => window.__iologs.slice(-30));
console.log("IOLOGS", JSON.stringify(logs));
const st = await page.evaluate(() => {
  const v0 = document.querySelector(".slide[data-idx='0'] video");
  const v1 = document.querySelector(".slide[data-idx='1'] video");
  return { p0: v0?.paused, t0: Math.round((v0?.currentTime ?? -1) * 10) / 10, p1: v1?.paused, t1: Math.round((v1?.currentTime ?? -1) * 10) / 10, aud: document.querySelectorAll("audio").length };
});
console.log("STATE", JSON.stringify(st));
console.log("ERRS", JSON.stringify(errs.slice(0, 6)));
await browser.close();
