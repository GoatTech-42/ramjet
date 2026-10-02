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
  const h1 = d.querySelector("h1");
  const mw = d.querySelector("#content, .mw-body, main");
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { x: b.x, y: b.y, w: b.width, h: b.height, display: cs.display, vis: cs.visibility, op: cs.opacity, color: cs.color, bg: cs.backgroundColor, pos: cs.position, transform: cs.transform }; };
  return {
    h1: r(h1), content: r(mw),
    html: r(d.documentElement), body: r(d.body),
    scroll: { x: d.defaultView.scrollX, y: d.defaultView.scrollY },
    docH: d.documentElement.scrollHeight,
  };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
