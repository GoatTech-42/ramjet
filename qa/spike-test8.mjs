import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://127.0.0.1:4599/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.fill("#url", "https://example.com");
await page.click("#go");
await page.waitForTimeout(6000);
const html = await page.evaluate(async () => {
  const w = document.getElementById("frame").contentWindow;
  const r = await w.fetch("/scram/service/" + encodeURIComponent("https://en.wikipedia.org/wiki/Minecraft"));
  return await r.text();
});
console.log("LEN:", html.length);
console.log("LINKS:", (html.match(/<link[^>]*stylesheet[^>]*>/g) || []).slice(0, 3).join("\n"));
console.log("INJECT:", /scramjet/i.test(html));
const head = html.slice(0, 800).replace(/\s+/g, " ");
console.log("HEAD:", head);
await browser.close();
