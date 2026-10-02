import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
const page = await ctx.newPage();
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const token = (login.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);

// what does /watch promise for the first 3 feed shorts?
const feed = await (await page.request.get("http://127.0.0.1:14224/api/apps/jetstream/shorts")).json();
const ids = (feed.items || []).slice(0, 3);
for (const v of ids) {
  const w = await (await page.request.get(`http://127.0.0.1:14224/api/apps/jetstream/watch?id=${v.id}`)).json();
  console.log("WATCH", JSON.stringify({ id: v.id, title: v.title.slice(0, 30), quality: w.quality, hd: w.hd?.quality || null }));
}

// what does the browser actually render?
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 60000 });
await page.tap(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
await page.waitForTimeout(3000);
const p = await page.$(".slide-play");
if (p) await p.tap().catch(() => {});
await page.waitForTimeout(8000);
const render = await page.evaluate(() => {
  const out = [];
  for (const i of [0, 1]) {
    const v = document.querySelectorAll(".feed .slide video")[i];
    out.push({ i, src: (v?.src || "").slice(0, 60), muted: v?.muted, vw: v?.videoWidth, vh: v?.videoHeight, t: Math.round((v?.currentTime ?? -1) * 10) / 10, paused: v?.paused });
  }
  return { slides: out, audios: document.querySelectorAll("audio").length, dpr: window.devicePixelRatio, cssW: document.querySelector(".slide video")?.clientWidth };
});
console.log("RENDER", JSON.stringify(render));
await browser.close();
