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

// chat 1
await pg.goto(BASE + "/sage", { waitUntil: "networkidle" });
await pg.fill(".composer textarea", "name three red fruits");
await pg.click(".composer button");
await pg.waitForSelector(".msg:not(.mine) .bubble:not(.thinking-bubble)", { timeout: 60000 });
console.log("chat1 answered, messages:", await pg.locator(".msg").count());

// chat 2 via the sheet
await pg.click(".chatsbtn");
await pg.waitForSelector(".sheet");
await pg.screenshot({ path: "/tmp/sc-1-sheet.png" });
console.log("sheet rows after chat1:", await pg.locator(".convrow").count());
await pg.click(".newchat");
await pg.waitForSelector(".empty .big", { timeout: 5000 });
await pg.fill(".composer textarea", "what is 12 times 12");
await pg.click(".composer button");
await pg.waitForSelector(".msg:not(.mine) .bubble:not(.thinking-bubble)", { timeout: 60000 });

// reopen sheet: two conversations, newest first
await pg.click(".chatsbtn");
await pg.waitForSelector(".convrow >> nth=1", { timeout: 5000 });
const titles = await pg.locator(".convtitle").allTextContents();
console.log("conversations:", JSON.stringify(titles));

// reopen chat 1
await pg.click(".convrow >> nth=1");
await pg.waitForTimeout(800);
const bubbles = await pg.locator(".msg .bubble").allTextContents();
console.log("reopened chat1 has fruit answer:", bubbles.some((t) => /fruit|apple|cherr|strawberr/i.test(t)));
await pg.screenshot({ path: "/tmp/sc-2-open.png" });

// persistence across reload
await pg.goto(BASE + "/sage", { waitUntil: "networkidle" });
console.log("reload restores:", await pg.locator(".msg").count(), "messages");

// delete chat 1 from the sheet
await pg.click(".chatsbtn");
await pg.waitForSelector(".convrow");
await pg.click(".convrow .convdel >> nth=1");
await pg.waitForTimeout(800);
console.log("after delete:", await pg.locator(".convrow").count());

// settings: two-tap delete all
await pg.goto(BASE + "/settings", { waitUntil: "networkidle" });
await pg.click(".plain");
await pg.waitForTimeout(300);
console.log("armed text:", await pg.textContent(".plain"));
await pg.click(".plain");
await pg.waitForSelector(".msg.ok", { timeout: 5000 });
console.log("settings result:", await pg.textContent(".msg.ok"));
await pg.goto(BASE + "/sage", { waitUntil: "networkidle" });
await pg.click(".chatsbtn");
await pg.waitForSelector(".sheet");
console.log("convs after delete-all:", await pg.locator(".convrow").count());
await pg.screenshot({ path: "/tmp/sc-3-mobile-check.png" });

// mobile
const mp = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
await mp.goto(BASE + "/login", { waitUntil: "networkidle" });
await mp.fill("input:not([type=password])", "qa");
await mp.fill("input[type=password]", process.env.QAPASS);
await mp.click("button[type=submit]");
await mp.waitForURL("**/", { timeout: 8000 }).catch(() => {});
await mp.goto(BASE + "/sage", { waitUntil: "networkidle" });
await mp.screenshot({ path: "/tmp/sc-4-mobile.png" });

console.log("JS errors:", errs.length ? errs.join(" | ") : "none");
await b.close();
