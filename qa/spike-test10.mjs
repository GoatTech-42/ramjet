import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
const hits = [];
page.on("response", async (r) => {
  if (r.url().includes("load.php")) {
    try {
      const t = await r.text();
      hits.push({ status: r.status(), type: r.headers()["content-type"], len: t.length, head: t.slice(0, 120) });
    } catch (e) { hits.push({ err: String(e).slice(0, 80) }); }
  }
});
await page.goto("http://127.0.0.1:4599/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.fill("#url", "https://en.wikipedia.org/wiki/Minecraft");
await page.click("#go");
await page.waitForTimeout(30000);
console.log(JSON.stringify(hits.slice(0, 4), null, 1));
await browser.close();
