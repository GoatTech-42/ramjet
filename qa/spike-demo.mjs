import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("https://scramjet.mercurywork.shop/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(e => console.log("NAV FAIL", e.message.slice(0,80)));
await page.waitForTimeout(6000);
await page.screenshot({ path: "/tmp/browse-spike/demo-home.png" });
console.log("HOME TITLE:", await page.title());
// try to find the url input
const inputs = await page.$$("input");
console.log("INPUTS:", inputs.length);
if (inputs.length) {
  await inputs[0].fill("https://en.wikipedia.org/wiki/Minecraft");
  await inputs[0].press("Enter");
  await page.waitForTimeout(15000);
  await page.screenshot({ path: "/tmp/browse-spike/demo-wiki.png" });
}
await browser.close();
