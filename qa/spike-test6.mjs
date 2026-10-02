import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://127.0.0.1:4599/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.fill("#url", "https://en.wikipedia.org/wiki/Minecraft");
await page.click("#go");
await page.waitForTimeout(15000);
const info = await page.evaluate(() => {
  const d = document.getElementById("frame").contentDocument;
  const sheets = [...d.styleSheets].map((s) => { let n = -1; try { n = s.cssRules.length } catch (e) { n = "xhr-blocked" } return { href: (s.href || "inline").slice(0, 90), rules: n }; });
  const links = [...d.querySelectorAll("link[rel=stylesheet]")].map((l) => l.href.slice(0, 100));
  return { links };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
