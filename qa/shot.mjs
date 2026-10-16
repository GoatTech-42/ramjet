// usage: node shot.mjs <path> <outfile> <width> <height> [sessionToken]
import { chromium } from "playwright";
const [,, path, out, w, h, token] = process.argv;
const base = "http://127.0.0.1:14224";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 2 });
if (token) await ctx.addCookies([{ name: "rj2_session", value: token, url: base }]);
const page = await ctx.newPage();
await page.goto(base + path, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(400);
await page.screenshot({ path: out });
await browser.close();
console.log("shot saved:", out);
