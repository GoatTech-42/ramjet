import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://127.0.0.1:4599/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.fill("#url", "https://example.com");
await page.click("#go");
await page.waitForTimeout(5000);
const out = await page.evaluate(async () => {
  const w = document.getElementById("frame").contentWindow;
  const u = "/scram/service/" + encodeURIComponent("https://en.wikipedia.org/w/load.php?lang=en&modules=site.styles&only=styles&skin=vector-2022");
  const t0 = Date.now();
  try {
    const r = await w.fetch(u);
    const t = await r.text();
    return { ms: Date.now() - t0, status: r.status, type: r.headers.get("content-type"), len: t.length, head: t.slice(0, 100) };
  } catch (e) { return { ms: Date.now() - t0, err: String(e).slice(0, 120) }; }
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
