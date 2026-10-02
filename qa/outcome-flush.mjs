import { chromium } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.route("**/*googlevideo.com/**", (r) => r.abort());
const page = await ctx.newPage();
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const token = (login.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
const getHist = async () => {
  const r = await page.request.get("http://127.0.0.1:14224/api/apps/jetstream/history");
  const d = await r.json();
  return d.items || [];
};
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 60000 });
await page.waitForTimeout(4000);
await page.click(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
await page.waitForTimeout(1000);
const p = await page.$(".slide-play");
if (p) await p.click().catch(() => {});
await page.waitForTimeout(5000); // watch ~5s
const id1 = await page.evaluate(() => { const v = document.querySelector(".feed .slide video"); return v ? v.closest(".slide").dataset.id || null : null; });
// PATH 1: close the feed via the back button (resetSlides flush)
await page.click(".feed-back");
await page.waitForTimeout(1200);
const h1 = await getHist();
const e1 = h1.find((x) => x.id === id1) || h1[0];
console.log("PATH1 closeFeed: id", e1?.id, "ws =", e1?.ws, e1?.ws != null ? "PASS" : "FAIL");
// PATH 2: watch another, then kill the page (pagehide beacon)
await page.waitForSelector(".scard", { timeout: 30000 });
await page.click(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
await page.waitForTimeout(6000);
const id2 = await page.evaluate(() => { const v = document.querySelector(".feed .slide video"); return v ? v.closest(".slide").dataset.id || null : null; });
await page.close(); // fires pagehide
await page.waitForTimeout ? null : null;
await new Promise((r) => setTimeout(r, 1500));
const page2 = await ctx.newPage();
const h2res = await page2.request.get("http://127.0.0.1:14224/api/apps/jetstream/history");
const h2 = (await h2res.json()).items || [];
const e2 = h2.find((x) => x.id === id2);
console.log("PATH2 pagehide: id", e2?.id, "ws =", e2?.ws, e2?.ws != null ? "PASS" : "FAIL");
await browser.close();
