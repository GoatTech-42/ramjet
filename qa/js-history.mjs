import { chromium } from "playwright";
const BASE = "http://127.0.0.1:14224";
const b = await chromium.launch();
const pg = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errs = [];
pg.on("pageerror", (e) => errs.push(e.message));
pg.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
await pg.goto(BASE + "/login", { waitUntil: "networkidle" });
await pg.fill("input:not([type=password])", "qa");
await pg.fill("input[type=password]", process.env.QAPASS);
await pg.click("button[type=submit]");
await pg.waitForURL("**/", { timeout: 8000 }).catch(() => {});

// no history yet -> no shelf
await pg.goto(BASE + "/jetstream", { waitUntil: "networkidle" });
console.log("shelf before any watch:", await pg.locator(".hist-h").count());

// search and watch two videos (just resolve, no full playback)
await pg.fill(".bar input", "lofi beats");
await pg.click(".bar button");
await pg.waitForSelector(".row", { timeout: 15000 });
await pg.click(".row >> nth=0");
await pg.waitForSelector(".player video", { timeout: 20000 });
const t1 = await pg.textContent(".player h1");
await pg.click(".backbtn");
await pg.waitForSelector(".row", { timeout: 8000 });
await pg.click(".row >> nth=1");
await pg.waitForSelector(".player video", { timeout: 20000 });
const t2 = await pg.textContent(".player h1");
console.log("watched:", JSON.stringify([t1, t2]));

// home now shows the shelf, newest first
await pg.goto(BASE + "/jetstream", { waitUntil: "networkidle" });
await pg.waitForSelector(".hist-h", { timeout: 8000 });
const cards = await pg.locator(".hcard .htitle").allTextContents();
console.log("shelf:", JSON.stringify(cards));
await pg.screenshot({ path: "/tmp/hist-1-desktop.png" });

// tapping a card starts that video
await pg.click(".hcard >> nth=0");
await pg.waitForSelector(".player h1", { timeout: 20000 });
console.log("tapped card plays:", (await pg.textContent(".player h1")) === t2);

// dedupe: rewatch t2, shelf should still show it once at front
await pg.goto(BASE + "/jetstream", { waitUntil: "networkidle" });
await pg.waitForSelector(".hist-h");
const cards2 = await pg.locator(".hcard .htitle").allTextContents();
console.log("shelf after rewatch:", JSON.stringify(cards2), "count:", cards2.length);

// mobile
const mp = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
await mp.goto(BASE + "/login", { waitUntil: "networkidle" });
await mp.fill("input:not([type=password])", "qa");
await mp.fill("input[type=password]", process.env.QAPASS);
await mp.click("button[type=submit]");
await mp.waitForURL("**/", { timeout: 8000 }).catch(() => {});
await mp.goto(BASE + "/jetstream", { waitUntil: "networkidle" });
await mp.waitForSelector(".hist-h");
await mp.screenshot({ path: "/tmp/hist-2-mobile.png" });

console.log("JS errors:", errs.length ? errs.join(" | ") : "none");
await b.close();
