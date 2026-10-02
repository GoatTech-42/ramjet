import { chromium } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
page.on("response", async (r) => {
  if (r.url().includes("/api/apps/amp/stream")) {
    const h = await r.allHeaders();
    console.log("STREAM RESP", r.status(), h["content-range"] || "-", h["content-type"] || "-", r.request().headers()["range"] || "NO-RANGE");
  }
});
page.on("requestfailed", (r) => { if (r.url().includes("/stream")) console.log("FAILED", r.url(), r.failure()?.errorText); });
await page.goto(BASE + "/login");
const inputs = await page.$$("input");
await inputs[0].fill("qa");
await inputs[1].fill(PW);
await page.click("button[type=submit], button");
await page.waitForURL(BASE + "/", { timeout: 8000 });
await page.goto(BASE + "/amp");
await page.fill(".search input", "instant crush");
await page.click(".search button");
await page.waitForSelector(".list .row", { timeout: 15000 });
await page.click(".list .row");
await page.waitForTimeout(6000);
const st = await page.evaluate(() => {
  const a = document.querySelector("audio");
  return { err: a?.error ? { code: a.error.code, msg: a.error.message } : null, readyState: a?.readyState, networkState: a?.networkState, src: (a?.src || "").slice(-40) };
});
console.log("audio state:", JSON.stringify(st));
await browser.close();
