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
page.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 120)); });
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 20000 });
await page.tap(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
await page.waitForTimeout(2500);
const p = await page.$(".slide-play");
if (p) await p.tap().catch(() => {});
await page.waitForTimeout(4000); // let prefetch play its beat
const s1 = await page.evaluate(() => {
  const v0 = document.querySelector(".slide[data-idx='0'] video");
  const v1 = document.querySelector(".slide[data-idx='1'] video");
  let b1 = 0;
  try { if (v1?.buffered?.length) b1 = Math.round(v1.buffered.end(0) * 10) / 10; } catch {}
  return { p0: v0?.paused, vw0: v0?.videoWidth, vh0: v0?.videoHeight, nextPaused: v1?.paused, nextBuffered: b1, aud: document.querySelectorAll("audio").length };
});
console.log("FIRST+PREBUFFER", JSON.stringify(s1));
await page.evaluate(() => { const w = document.querySelector(".feed-scroll"); w.scrollTo({ top: w.clientHeight, behavior: "auto" }); });
await page.waitForTimeout(3000);
const s2 = await page.evaluate(() => {
  const v0 = document.querySelector(".slide[data-idx='0'] video");
  const v1 = document.querySelector(".slide[data-idx='1'] video");
  const a = [...document.querySelectorAll("audio")];
  return { p0: v0?.paused, p1: v1?.paused, t1: Math.round((v1?.currentTime ?? -1) * 10) / 10, vw1: v1?.videoWidth, vh1: v1?.videoHeight, audPlaying: a.filter((x) => !x.paused).length };
});
console.log("SWIPED", JSON.stringify(s2));
await page.screenshot({ path: "qa/shots/shorts-hd2-iphone.png" });
// back up: audio must rebuild
await page.evaluate(() => { const w = document.querySelector(".feed-scroll"); w.scrollTo({ top: 0, behavior: "auto" }); });
await page.waitForTimeout(3000);
const s3 = await page.evaluate(() => {
  const v0 = document.querySelector(".slide[data-idx='0'] video");
  const a = [...document.querySelectorAll("audio")];
  return { p0: v0?.paused, t0: Math.round((v0?.currentTime ?? -1) * 10) / 10, muted0: v0?.muted, aud: a.length, audPlaying: a.filter((x) => !x.paused).length };
});
console.log("BACK-UP", JSON.stringify(s3));
console.log("ERRS", JSON.stringify(errs.slice(0, 5)));
await browser.close();
