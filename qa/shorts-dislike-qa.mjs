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

// API: dislike the first for-you short, confirm it leaves the feed, undo
const fy = await (await page.request.get("http://127.0.0.1:14224/api/apps/jetstream/shorts")).json();
const victim = (fy.items || [])[0];
const t1 = await (await page.request.post("http://127.0.0.1:14224/api/apps/jetstream/dislikes/toggle", { data: { id: victim.id, title: victim.title, channel: victim.channel, duration: victim.duration } })).json();
const lr = await (await page.request.get("http://127.0.0.1:14224/api/apps/jetstream/dislikes")).json();
const fy2 = await (await page.request.get("http://127.0.0.1:14224/api/apps/jetstream/shorts")).json();
const gone = !(fy2.items || []).some((v) => v.id === victim.id);
console.log("DISLIKE-API", JSON.stringify({ on: t1.disliked, inList: (lr.ids || []).includes(victim.id), excludedFromFeed: gone }));

// UI: rail has both buttons; dislike click advances the feed
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 20000 });
await page.click(".zone-open");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
await page.waitForTimeout(1500);
const rail = await page.evaluate(() => ({ like: !!document.querySelector(".slide-like"), dislike: !!document.querySelector(".slide-dislike") }));
console.log("RAIL", JSON.stringify(rail));
await page.click(".slide-dislike");
await page.waitForTimeout(1500);
const adv = await page.evaluate(() => ({
  scrollTop: Math.round(document.querySelector(".feed-scroll").scrollTop),
  dislikedClass: !!document.querySelector(".slide-dislike.disliked"),
}));
console.log("ADVANCE", JSON.stringify(adv));
await page.waitForTimeout(1200);
await page.screenshot({ path: `qa/shots/dislike-1-rail-${tag}.png` });

// cleanup: undo both test dislikes
const now = await (await page.request.get("http://127.0.0.1:14224/api/apps/jetstream/dislikes")).json();
for (const id of now.ids || []) await page.request.post("http://127.0.0.1:14224/api/apps/jetstream/dislikes/toggle", { data: { id } });
const cleared = await (await page.request.get("http://127.0.0.1:14224/api/apps/jetstream/dislikes")).json();
console.log("CLEANUP", JSON.stringify({ left: (cleared.ids || []).length }));
console.log("CONSOLE-ERRS", JSON.stringify(errs));
await browser.close();
