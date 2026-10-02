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
        for (const e of entries) window.__iologs.push(`${e.target.dataset?.idx}:${Math.round(e.intersectionRatio * 100) / 100}:${e.isIntersecting ? 1 : 0}`);
        cb(entries, obs);
      }, opts);
    }
  };
});
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const token = (login.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 20000 });
await page.tap(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
await page.waitForTimeout(2500);
const p = await page.$(".slide-play");
if (p) await p.tap().catch(() => {});
await page.waitForTimeout(2500);
const before = await page.evaluate(() => ({ p0: document.querySelector(".slide[data-idx='0'] video")?.paused }));
console.log("BEFORE-SCROLL", JSON.stringify(before));
await page.evaluate(() => { const w = document.querySelector(".feed-scroll"); w.scrollTo({ top: w.clientHeight, behavior: "auto" }); });
await page.waitForTimeout(3500);
const logs = await page.evaluate(() => window.__iologs.slice(-8));
const st = await page.evaluate(() => {
  const v0 = document.querySelector(".slide[data-idx='0'] video");
  const v1 = document.querySelector(".slide[data-idx='1'] video");
  const a = [...document.querySelectorAll("audio")];
  return { p0: v0?.paused, t0: Math.round((v0?.currentTime ?? -1) * 10) / 10, p1: v1?.paused, t1: Math.round((v1?.currentTime ?? -1) * 10) / 10, vw1: v1?.videoWidth, aud: a.length, audPaused: a.map((x) => x.paused) };
});
console.log("AFTER", JSON.stringify(st));
console.log("IOLOGS", JSON.stringify(logs));
console.log("ERRS", JSON.stringify(errs));
// scroll back up
await page.evaluate(() => { const w = document.querySelector(".feed-scroll"); w.scrollTo({ top: 0, behavior: "auto" }); });
await page.waitForTimeout(3000);
const st2 = await page.evaluate(() => {
  const v0 = document.querySelector(".slide[data-idx='0'] video");
  const v1 = document.querySelector(".slide[data-idx='1'] video");
  return { p0: v0?.paused, t0: Math.round((v0?.currentTime ?? -1) * 10) / 10, p1: v1?.paused, aud: document.querySelectorAll("audio").length };
});
console.log("BACK-UP", JSON.stringify(st2));
await browser.close();
