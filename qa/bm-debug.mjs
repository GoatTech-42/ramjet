import { chromium } from "playwright";
const BASE = "http://127.0.0.1:14224";
const b = await chromium.launch();
const pg = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errs = [];
pg.on("pageerror", (e) => errs.push("pageerror: " + e.message));
pg.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
await pg.goto(BASE + "/login", { waitUntil: "networkidle" });
await pg.fill("input:not([type=password])", "qa");
await pg.fill("input[type=password]", process.env.QAPASS);
await pg.click("button[type=submit]");
await pg.waitForURL("**/", { timeout: 8000 }).catch(() => {});

// re-add the bookmark (previous run deleted it never - script died first)
await pg.goto(BASE + "/browse", { waitUntil: "networkidle" });
await pg.waitForFunction(() => !document.querySelector(".go")?.disabled, { timeout: 30000 });
console.log("rows:", await pg.locator(".bm-row").count());
if (await pg.locator(".bm-row").count()) {
  console.log("opening:", await pg.textContent(".bm-open"));
  await pg.click(".bm-open");
} else {
  await pg.fill("header input", "example.com");
  await pg.click(".go");
}
await pg.waitForTimeout(12000);
console.log("surfing:", await pg.evaluate(() => document.querySelector(".shell")?.className));
const frames = pg.frames();
console.log("frames:", frames.length, frames.map((f) => f.url().slice(0, 90)));
console.log("document.title:", await pg.title());
try { console.log("h1:", await pg.frameLocator("iframe").locator("h1").textContent({ timeout: 5000 })); } catch (e) { console.log("h1: timeout"); }
console.log("JS errors:", errs.length ? errs.join(" | ") : "none");
await b.close();
