import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://127.0.0.1:4599/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const html = await page.evaluate(async () => {
  const r = await fetch("/scram/service/" + encodeURIComponent("https://en.wikipedia.org/wiki/Minecraft"));
  return await r.text();
});
const links = html.match(/<link[^>]*stylesheet[^>]*>/g) || [];
console.log("LINKS:", links.slice(0, 4).join("\n"));
const scripts = (html.match(/<script[^>]*src=[^>]*>/g) || []).slice(0, 3);
console.log("SCRIPTS:", scripts.join("\n"));
console.log("HAS SCRAM INJECT:", html.includes("scramjet"), html.slice(0, 300));
await browser.close();
