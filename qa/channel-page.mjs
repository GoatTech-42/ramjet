// channel pages e2e (Luke 6:09 PM): channel link on the watch page opens the
// channel page; subscribe toggles + persists; play all chains to the next
// video on ended; scroll their shorts opens the feed on channel shorts.
import { chromium } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const r = await ctx.request.post(BASE + "/api/auth/login", { data: { username: "qa", password: pw } });
const token = (r.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: BASE }]);
await page.goto(BASE + "/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 60000 });

// open a long-form video, get to the channel page via the channel link
await page.fill("form input", "minecraft redstone tutorial");
await page.press("form input", "Enter");
await page.waitForSelector(".row", { timeout: 30000 });
await page.click(".row");
await page.waitForSelector(".player .chanlink", { timeout: 30000 });
const chanName = await page.textContent(".chanlink");
console.log("channel link on watch page:", chanName.trim());
await page.click(".chanlink");
await page.waitForSelector(".chanpage", { timeout: 15000 });
await page.waitForSelector(".chan-sec", { timeout: 90000 }); // cold ytdlp resolve
console.log("channel page loaded:", (await page.textContent(".chan-head h1")).trim());
const vids = await page.locator(".chan-sec .results .row").count();
const hasShorts = await page.locator(".chan-sec .hcard").count();
console.log("videos listed:", vids, "| shorts listed:", hasShorts);

// subscribe
await page.click(".subbtn");
await page.waitForTimeout(600);
const subLabel = (await page.textContent(".subbtn")).trim();
const subsList = await page.evaluate(async () => (await fetch("/api/apps/jetstream/subs")).json());
console.log("after sub: label =", subLabel, "| server subs:", subsList.subs.length);
await page.screenshot({ path: "/tmp/chan-desktop.png" });

// play all -> force near-end -> chain must advance
await page.click(".playall");
await page.waitForSelector(".player video", { timeout: 30000 });
await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && v.duration > 0; }, { timeout: 30000 });
const first = (await page.textContent(".player h1")).trim();
console.log("play all started on:", first.slice(0, 50), "| note:", await page.locator(".hdnote").last().textContent().catch(() => "none"));
await page.evaluate(() => { const v = document.querySelector(".player video"); v.currentTime = Math.max(0, v.duration - 0.6); v.play(); });
await page.waitForFunction((f) => document.querySelector(".player h1") && document.querySelector(".player h1").textContent.trim() !== f, first, { timeout: 30000 }).catch(() => null);
const second = (await page.textContent(".player h1")).trim();
console.log("chain advanced to:", second.slice(0, 50));
console.log("autoplay chain:", second !== first ? "PASS" : "FAIL");

// scroll their shorts
await page.click(".backbtn");
await page.waitForSelector(".chanpage", { timeout: 10000 });
if (hasShorts > 0) {
  await page.click("text=scroll their shorts");
  await page.waitForSelector(".feed .slide video", { timeout: 15000 });
  await page.waitForTimeout(6000);
  const st = await page.evaluate(() => { const vids = [...document.querySelectorAll(".feed .slide video")]; const a = vids.find((x) => x.src && !x.paused) || vids.find((x) => x.src); return a ? { ct: a.currentTime, mode: a.dataset.srcmode } : null; });
  console.log("channel shorts feed playing:", JSON.stringify(st));
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator(".feed-back").click().catch(() => {});
}

// cleanup: unsubscribe
await page.waitForSelector(".chanpage", { timeout: 10000 }).catch(() => {});
await page.click(".subbtn").catch(() => {});
await page.waitForTimeout(600);
const subs2 = await page.evaluate(async () => (await fetch("/api/apps/jetstream/subs")).json());
console.log("after unsub: server subs:", subs2.subs.length, "| page errors:", errs.length ? errs : "none");
await browser.close();
