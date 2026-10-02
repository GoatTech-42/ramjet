import { chromium } from "playwright";
const BASE = "http://127.0.0.1:14224";
const QAPASS = process.env.QAPASS;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const pg = await ctx.newPage();
const errs = [];
pg.on("pageerror", (e) => errs.push("pageerror: " + e.message));
pg.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });

await pg.goto(BASE + "/login", { waitUntil: "networkidle" });
await pg.fill("input:not([type=password])", "qa");
await pg.fill("input[type=password]", QAPASS);
await pg.click("button[type=submit]");
await pg.waitForURL("**/", { timeout: 8000 }).catch(() => {});

// 1. amp home: create a playlist
await pg.goto(BASE + "/amp", { waitUntil: "networkidle" });
await pg.fill(".newpl input", "night drive");
await pg.click(".newpl button");
await pg.waitForSelector(".plrow", { timeout: 5000 });
console.log("create: playlist row appeared");
await pg.screenshot({ path: "/tmp/pl-1-home.png" });

// 2. search, save first result to the playlist
await pg.fill(".search input", "daft punk");
await pg.click(".search button");
await pg.waitForSelector(".row", { timeout: 15000 });
await pg.click(".row .rowact >> nth=0");
await pg.waitForSelector(".sheet", { timeout: 5000 });
await pg.screenshot({ path: "/tmp/pl-2-sheet.png" });
await pg.click(".sheetrow >> nth=0");
await pg.waitForSelector(".toast", { timeout: 5000 });
console.log("save:", await pg.textContent(".toast"));

// 3. save two more (one dedupe test)
await pg.click(".row .rowact >> nth=0");
await pg.waitForSelector(".sheet");
await pg.click(".sheetrow >> nth=0");
await pg.waitForSelector(".toast");
console.log("dedupe:", await pg.textContent(".toast"));
await pg.click(".row .rowact >> nth=1");
await pg.waitForSelector(".sheet");
await pg.click(".sheetrow >> nth=0");
await pg.waitForSelector(".toast");
console.log("save2:", await pg.textContent(".toast"));

// 4. open the playlist from home
await pg.goto(BASE + "/amp", { waitUntil: "networkidle" });
const count = await pg.textContent(".plrow .plcount");
console.log("home count:", count);
await pg.click(".plrow");
await pg.waitForSelector(".plhead", { timeout: 5000 });
console.log("playlist title:", await pg.textContent(".pltitle"));
console.log("tracks in view:", await pg.locator(".list .row").count());
await pg.screenshot({ path: "/tmp/pl-3-open.png" });

// 5. remove one track
await pg.click(".list .row .rowact >> nth=0");
await pg.waitForTimeout(500);
console.log("after remove:", await pg.locator(".list .row").count());

// 6. persistence: reload, still there?
await pg.goto(BASE + "/amp", { waitUntil: "networkidle" });
console.log("after reload count:", await pg.textContent(".plrow .plcount"));

// 7. mobile viewport pass
const m = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mp = await m.newPage();
await mp.goto(BASE + "/login", { waitUntil: "networkidle" });
await mp.fill("input:not([type=password])", "qa");
await mp.fill("input[type=password]", QAPASS);
await mp.click("button[type=submit]");
await mp.waitForURL("**/", { timeout: 8000 }).catch(() => {});
await mp.goto(BASE + "/amp", { waitUntil: "networkidle" });
await mp.screenshot({ path: "/tmp/pl-4-mobile-home.png" });
await mp.click(".plrow");
await mp.waitForSelector(".plhead");
await mp.screenshot({ path: "/tmp/pl-5-mobile-open.png" });

// 8. delete the playlist (cleanup so qa account stays tidy)
await mp.click(".pldel");
await mp.waitForTimeout(700);
console.log("after delete, plrows:", await mp.locator(".plrow").count());

console.log("JS errors:", errs.length ? errs.join(" | ") : "none");
await b.close();
