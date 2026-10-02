import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const mobile = process.argv[2] === "iphone";
const tag = mobile ? "iphone" : "desktop";
const browser = await chromium.launch();
const ctx = await browser.newContext(mobile ? { ...devices["iPhone 13"] } : { viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const sc = login.headers()["set-cookie"] || "";
const token = sc.match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
page.on("pageerror", (e) => errs.push("PAGEERR " + String(e).slice(0, 160)));

// jetstream home: shelves
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 20000 });
const shelfInfo = await page.evaluate(() => ({
  shorts: document.querySelectorAll(".scard").length,
  forYou: [...document.querySelectorAll(".hist-h")].map((h) => h.textContent),
}));
console.log("SHELVES", JSON.stringify(shelfInfo));
await page.waitForTimeout(800);
await page.screenshot({ path: `qa/shots/shorts-1-home-${tag}.png` });

// open feed on first short
await page.click(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
await page.waitForTimeout(2500);
// ensure playback (tap big play if paused)
const st1 = await page.evaluate(() => {
  const v = document.querySelector(".slide[data-idx='0'] video");
  return { src: !!v?.src, paused: v?.paused, t: v?.currentTime ?? -1 };
});
if (st1.paused) { await page.click(".slide-play").catch(() => {}); await page.waitForTimeout(3000); }
const st2 = await page.evaluate(() => {
  const v = document.querySelector(".slide[data-idx='0'] video");
  return { src: !!v?.src, paused: v?.paused, t: v?.currentTime ?? -1, vw: v?.videoWidth, vh: v?.videoHeight };
});
console.log("FIRST-SHORT", JSON.stringify(st2));
await page.screenshot({ path: `qa/shots/shorts-2-feed-${tag}.png` });

// swipe to second short
await page.evaluate(() => document.querySelector(".slide[data-idx='1']")?.scrollIntoView());
await page.waitForTimeout(3500);
const st3 = await page.evaluate(() => {
  const v0 = document.querySelector(".slide[data-idx='0'] video");
  const v1 = document.querySelector(".slide[data-idx='1'] video");
  return { firstPaused: v0?.paused, secondSrc: !!v1?.src, secondPaused: v1?.paused, secondT: v1?.currentTime ?? -1 };
});
console.log("SECOND-SHORT", JSON.stringify(st3));
await page.screenshot({ path: `qa/shots/shorts-3-second-${tag}.png` });

// close feed
await page.click(".feed-back");
await page.waitForTimeout(500);
const feedGone = await page.evaluate(() => !document.querySelector(".feed"));
console.log("FEED-CLOSED", feedGone);

// settings page: privacy sections
await page.goto("http://127.0.0.1:14224/settings", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".card", { timeout: 10000 });
await page.waitForTimeout(600);
const sections = await page.evaluate(() => [...document.querySelectorAll(".card .label")].map((l) => l.textContent));
console.log("SETTINGS-SECTIONS", JSON.stringify(sections));
// toggle pause
const pauseBtn = page.locator("button", { hasText: "pause watch history" });
if (await pauseBtn.count()) {
  await pauseBtn.click();
  await page.waitForTimeout(800);
  console.log("PAUSE-TOGGLED", await page.locator("button", { hasText: "resume watch history" }).count());
  await page.locator("button", { hasText: "resume watch history" }).click();
  await page.waitForTimeout(500);
} else console.log("PAUSE-TOGGLED", "button-missing");
await page.screenshot({ path: `qa/shots/shorts-4-settings-${tag}.png`, fullPage: true });

// clear keep watching (two-tap) to clean qa data
await page.goto("http://127.0.0.1:14224/settings", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(600);
const clearBtn = page.locator("button", { hasText: "clear keep watching" });
if (await clearBtn.count()) {
  await clearBtn.click();
  await page.locator("button", { hasText: "tap again to clear it" }).click();
  await page.waitForTimeout(600);
  console.log("HISTORY-CLEARED", true);
} else console.log("HISTORY-CLEARED", "button-missing");
console.log("CONSOLE-ERRS", JSON.stringify(errs.slice(0, 6)));
await browser.close();
