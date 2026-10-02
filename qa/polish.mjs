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

// seed jetstream history: watch one video
await pg.goto(BASE + "/jetstream", { waitUntil: "networkidle" });
await pg.fill(".bar input", "minecraft");
await pg.click(".bar button");
await pg.waitForSelector(".row", { timeout: 15000 });
await pg.click(".row >> nth=0");
await pg.waitForSelector(".player video", { timeout: 20000 });
await pg.goto(BASE + "/jetstream", { waitUntil: "networkidle" });
await pg.waitForSelector(".hcard", { timeout: 8000 });
console.log("shelf cards:", await pg.locator(".hcard").count());
await pg.screenshot({ path: "/tmp/pol-1-shelf.png" });
// remove it via the x
await pg.click(".hcard .hx >> nth=0");
await pg.waitForTimeout(700);
console.log("after hx:", await pg.locator(".hcard").count(), "| shelf header:", await pg.locator(".hist-h").count());

// amp: rename flow
await pg.goto(BASE + "/amp", { waitUntil: "networkidle" });
await pg.fill(".newpl input", "temp mix");
await pg.click(".newpl button");
await pg.waitForSelector(".plrow", { timeout: 5000 });
await pg.click(".plrow >> nth=0");
await pg.waitForSelector(".plhead");
await pg.click("text=rename");
await pg.waitForSelector(".plrename input");
await pg.fill(".plrename input", "morning mix");
await pg.click(".plrename button");
await pg.waitForTimeout(700);
console.log("renamed to:", await pg.textContent(".pltitle"));
await pg.screenshot({ path: "/tmp/pol-2-rename.png" });
// cleanup: delete the playlist
await pg.click(".pldel >> nth=1");
await pg.waitForTimeout(700);
console.log("plrows after delete:", await pg.locator(".plrow").count());

// mobile shelf shot
const mp = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
await mp.goto(BASE + "/login", { waitUntil: "networkidle" });
await mp.fill("input:not([type=password])", "qa");
await mp.fill("input[type=password]", process.env.QAPASS);
await mp.click("button[type=submit]");
await mp.waitForURL("**/", { timeout: 8000 }).catch(() => {});
await mp.goto(BASE + "/jetstream", { waitUntil: "networkidle" });
await mp.waitForTimeout(1000);
await mp.screenshot({ path: "/tmp/pol-3-mobile.png" });
console.log("JS errors:", errs.length ? errs.join(" | ") : "none");
await b.close();
