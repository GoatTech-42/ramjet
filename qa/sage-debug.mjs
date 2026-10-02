import { chromium } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
page.on("console", (m) => console.log("CONSOLE:", m.type(), m.text().slice(0, 200)));
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 300)));
page.on("response", (r) => { if (r.url().includes("/api/apps/sage")) console.log("SAGE RESP:", r.status()); });
await page.goto(BASE + "/login");
const inputs = await page.$$("input");
await inputs[0].fill("qa"); await inputs[1].fill(PW);
await page.click("button[type=submit], button");
await page.waitForURL(BASE + "/", { timeout: 8000 });
await page.goto(BASE + "/sage");
await page.evaluate(() => localStorage.removeItem("sage-conversation"));
await page.reload();
await page.click(".starter >> nth=2");
await page.waitForSelector(".msg:not(.mine) .bubble", { timeout: 60000 });
console.log("turn 1 done, msgs:", await page.evaluate(() => document.querySelectorAll(".msg").length));
await page.fill(".composer textarea", "and which one is faster for games?");
await page.click(".composer button");
console.log("sent turn 2");
await page.waitForTimeout(15000);
const st = await page.evaluate(() => ({
  msgs: document.querySelectorAll(".msg").length,
  thinking: !!document.querySelector(".thinking-bubble"),
  error: document.querySelector(".error")?.textContent || "",
  draft: document.querySelector(".composer textarea")?.value,
}));
console.log("state:", JSON.stringify(st));
await page.screenshot({ path: "/tmp/qa-sage-debug.png" });
await browser.close();
