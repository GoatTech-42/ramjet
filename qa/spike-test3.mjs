import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 150)); });
await page.goto("http://127.0.0.1:4599/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.fill("#url", "https://en.wikipedia.org/wiki/Minecraft");
await page.click("#go");
await page.waitForTimeout(18000);
const info = await page.evaluate(() => {
  const f = document.getElementById("frame");
  const d = f.contentDocument;
  return {
    title: d?.title,
    bodyLen: d?.body?.innerHTML?.length,
    bodyText: d?.body?.innerText?.slice(0, 120),
    stylesheets: d?.styleSheets?.length,
    bg: d ? getComputedStyle(d.body).backgroundColor : null,
  };
});
console.log("INFO:", JSON.stringify(info, null, 1));
console.log("ERRORS:", JSON.stringify(errs.slice(0, 8), null, 1));
await page.screenshot({ path: "/tmp/browse-spike/wiki2.png" });
await browser.close();
