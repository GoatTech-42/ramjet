import { chromium } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const token = (login.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 20000 });
await page.click(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
await page.waitForTimeout(2500);
await page.click(".slide-play").catch(() => {});
await page.waitForTimeout(1500);
await page.evaluate(() => { const w = document.querySelector(".feed-scroll"); w.scrollTo({ top: w.clientHeight, behavior: "smooth" }); });
await page.waitForTimeout(3000);
const st = await page.evaluate(() => {
  const wrap = document.querySelector(".feed-scroll");
  const wr = wrap.getBoundingClientRect();
  const out = { scrollTop: wrap.scrollTop, h: wrap.clientHeight, slides: [] };
  for (const i of [0, 1, 2]) {
    const s = document.querySelector(`.slide[data-idx='${i}']`);
    const v = s?.querySelector("video");
    const r = s?.getBoundingClientRect();
    const vis = r ? Math.max(0, Math.min(r.bottom, wr.bottom) - Math.max(r.top, wr.top)) / r.height : 0;
    out.slides.push({ i, vis: Math.round(vis * 100) / 100, paused: v?.paused, t: Math.round((v?.currentTime ?? -1) * 10) / 10, hasSrc: !!v?.src });
  }
  return out;
});
console.log(JSON.stringify(st));
await browser.close();
