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

// --- API: shorts search returns short-form only, ranked list sane
const sres = await page.request.get("http://127.0.0.1:14224/api/apps/jetstream/shorts?q=minecraft");
const sj = await sres.json();
const secs = (t) => { const p = String(t || "").split(":"); return p.length === 2 ? +p[0] * 60 + +p[1] : null; };
const lens = (sj.items || []).map((v) => secs(v.duration));
console.log("SHORTS-SEARCH", JSON.stringify({ ok: sj.ok, count: (sj.items || []).length, maxSecs: Math.max(...lens), sample: (sj.items || [])[0]?.title?.slice(0, 50) }));

// --- API: likes toggle + read-back
const vid = (sj.items || [])[0]?.id;
const t1 = await page.request.post("http://127.0.0.1:14224/api/apps/jetstream/likes/toggle", { data: { id: vid, title: "qa like", channel: "qa chan", duration: "0:30" } });
const t1j = await t1.json();
const lr = await (await page.request.get("http://127.0.0.1:14224/api/apps/jetstream/likes")).json();
const t2 = await (await page.request.post("http://127.0.0.1:14224/api/apps/jetstream/likes/toggle", { data: { id: vid } })).json();
console.log("LIKES", JSON.stringify({ toggledOn: t1j.liked, inList: (lr.ids || []).includes(vid), toggledOff: t2.liked === false }));

// --- UI: home zone entry
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 20000 });
const zone = await page.evaluate(() => ({
  header: document.querySelector(".zone-h .hist-h")?.textContent,
  openBtn: document.querySelector(".zone-open")?.textContent,
}));
console.log("ZONE", JSON.stringify(zone));
await page.waitForTimeout(600);
await page.screenshot({ path: `qa/shots/zone-1-home-${tag}.png` });

// --- UI: open feed via start scrolling, search bar present
await page.click(".zone-open");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
await page.waitForTimeout(2000);
const feedUI = await page.evaluate(() => ({
  searchBar: !!document.querySelector(".feed-search input"),
  like: !!document.querySelector(".slide-like"),
  clear: !!document.querySelector(".feed-clear"),
}));
console.log("FEEDUI", JSON.stringify(feedUI));
await page.screenshot({ path: `qa/shots/zone-2-feed-${tag}.png` });

// --- UI: like toggle on slide 0
await page.click(".slide-like");
await page.waitForTimeout(700);
const liked1 = await page.evaluate(() => document.querySelector(".slide-like")?.classList.contains("liked"));
console.log("LIKE-UI", liked1);

// --- UI: search within the zone
await page.fill(".feed-search input", "skateboarding");
await page.press(".feed-search input", "Enter");
await page.waitForTimeout(4000);
const afterSearch = await page.evaluate(() => ({
  mode: !!document.querySelector(".feed-clear"),
  slides: document.querySelectorAll(".slide").length,
  first: document.querySelector(".slide-title")?.textContent?.slice(0, 60),
}));
console.log("SEARCH-MODE", JSON.stringify(afterSearch));
await page.waitForTimeout(1500);
await page.screenshot({ path: `qa/shots/zone-3-search-${tag}.png` });

// --- UI: back to for you
await page.click(".feed-clear");
await page.waitForTimeout(4000);
const backHome = await page.evaluate(() => ({
  clearGone: !document.querySelector(".feed-clear"),
  slides: document.querySelectorAll(".slide").length,
}));
console.log("BACK-FORYOU", JSON.stringify(backHome));

console.log("CONSOLE-ERRS", JSON.stringify(errs));
await browser.close();
