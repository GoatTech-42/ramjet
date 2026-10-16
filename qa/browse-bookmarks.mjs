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

await pg.goto(BASE + "/browse", { waitUntil: "networkidle" });
// wait for proxy ready (go button enabled)
await pg.waitForFunction(() => !document.querySelector(".go")?.disabled, { timeout: 30000 });
console.log("no bookmarks yet:", await pg.locator(".bm-row").count());

// surf to example.com and star it
await pg.fill("header input", "example.com");
await pg.click(".go");
await pg.waitForSelector("button[aria-label=\"bookmark this page\"]", { timeout: 10000 });
await pg.waitForTimeout(3000); // let the frame load so the title lands
await pg.click("button[aria-label=\"bookmark this page\"]");
await pg.waitForSelector(".bm-toast", { timeout: 5000 });
console.log("star toast:", await pg.textContent(".bm-toast"));
await pg.screenshot({ path: "/tmp/bm-1-surfing.png" });

// star again -> dedupe
await pg.waitForTimeout(2800);
await pg.click("button[aria-label=\"bookmark this page\"]");
await pg.waitForSelector(".bm-toast");
console.log("dup toast:", await pg.textContent(".bm-toast"));

// home shows the bookmark
await pg.goto(BASE + "/browse", { waitUntil: "networkidle" });
await pg.waitForFunction(() => !document.querySelector(".go")?.disabled, { timeout: 30000 });
console.log("home rows:", await pg.locator(".bm-row").count(), "| name:", await pg.textContent(".bm-open"));
await pg.screenshot({ path: "/tmp/bm-2-home.png" });

// open it from home
await pg.click(".bm-open");
await pg.waitForSelector("button[aria-label=\"bookmark this page\"]", { timeout: 10000 });
const f = await pg.frameLocator("iframe");
await f.locator("h1").waitFor({ timeout: 15000 });
console.log("bookmark opens:", await f.locator("h1").textContent());

// back home, delete it
await pg.goto(BASE + "/browse", { waitUntil: "networkidle" });
await pg.waitForFunction(() => !document.querySelector(".go")?.disabled, { timeout: 30000 });
await pg.click(".bm-x");
await pg.waitForTimeout(600);
console.log("after delete:", await pg.locator(".bm-row").count());

// mobile home
const mp = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
await mp.goto(BASE + "/login", { waitUntil: "networkidle" });
await mp.fill("input:not([type=password])", "qa");
await mp.fill("input[type=password]", process.env.QAPASS);
await mp.click("button[type=submit]");
await mp.waitForURL("**/", { timeout: 8000 }).catch(() => {});
await mp.goto(BASE + "/browse", { waitUntil: "networkidle" });
await mp.waitForTimeout(2000);
await mp.screenshot({ path: "/tmp/bm-3-mobile.png" });

console.log("JS errors:", errs.length ? errs.join(" | ") : "none");
await b.close();
