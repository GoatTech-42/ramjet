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
await page.waitForSelector(".scard", { timeout: 20000 });
await page.tap(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
await page.waitForTimeout(2500);
const p = await page.$(".slide-play");
if (p) { await p.tap().catch(() => {}); }
await page.waitForTimeout(6000); // let prefetch buffer
const pre = await page.evaluate(() => {
  const v1 = document.querySelector(".slide[data-idx='1'] video");
  let buf = 0;
  try { if (v1?.buffered?.length) buf = Math.round(v1.buffered.end(0) * 10) / 10; } catch {}
  return { nextSrc: !!v1?.src, readyState: v1?.readyState, buffered: buf, preload: v1?.preload };
});
console.log("PREFETCH", JSON.stringify(pre));
await page.evaluate(() => { const w = document.querySelector(".feed-scroll"); w.scrollTo({ top: w.clientHeight, behavior: "smooth" }); });
await page.waitForTimeout(5000);
const post = await page.evaluate(() => {
  const wrap = document.querySelector(".feed-scroll");
  const wr = wrap.getBoundingClientRect();
  const out = { scrollTop: Math.round(wrap.scrollTop), h: wrap.clientHeight, slides: [] };
  for (const i of [0, 1, 2]) {
    const s = document.querySelector(`.slide[data-idx='${i}']`);
    const v = s?.querySelector("video");
    const r = s?.getBoundingClientRect();
    const vis = r ? Math.max(0, Math.min(r.bottom, wr.bottom) - Math.max(r.top, wr.top)) / r.height : 0;
    out.slides.push({ i, vis: Math.round(vis * 100) / 100, paused: v?.paused, t: Math.round((v?.currentTime ?? -1) * 10) / 10 });
  }
  out.audios = document.querySelectorAll("audio").length;
  return out;
});
console.log("POST-SWIPE", JSON.stringify(post));
await browser.close();
