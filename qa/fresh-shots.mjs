import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const browser = await chromium.launch();
const page = await (await browser.newContext(devices["iPhone 13"])).newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 200)));
await page.goto(BASE + "/login");
const inputs = await page.$$("input");
await inputs[0].fill("qa"); await inputs[1].fill(PW);
await page.click("button[type=submit], button");
await page.waitForURL(BASE + "/", { timeout: 8000 });
await page.waitForTimeout(900);
await page.screenshot({ path: "/tmp/qa-fresh-hub-iphone.png" });
const rows = await page.evaluate(() => [...document.querySelectorAll("a.row")].map((r) => r.getAttribute("href")));
console.log("HUB ROWS:", JSON.stringify(rows));
// jetstream: find a video with a real 1080p source
await page.goto(BASE + "/jetstream", { waitUntil: "networkidle" });
await page.fill(".bar input", "big buck bunny");
await page.click(".bar button");
await page.waitForSelector(".row img", { timeout: 20000 });
await page.waitForTimeout(800);
await page.click(".row");
await page.waitForSelector(".frame video", { timeout: 25000 });
await page.waitForTimeout(6000);
const state = await page.evaluate(() => ({
  t: document.querySelector(".frame video")?.currentTime ?? -1,
  badge: document.querySelector(".qbtn")?.textContent?.trim() ?? "NO BADGE",
  title: document.querySelector("h1, .title")?.textContent?.trim() ?? "",
}));
console.log("WATCH STATE:", JSON.stringify(state));
await page.screenshot({ path: "/tmp/qa-fresh-jetstream-hd-iphone.png" });
await browser.close();
