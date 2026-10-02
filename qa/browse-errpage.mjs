import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const browser = await chromium.launch();
const page = await (await browser.newContext(devices["iPhone 13"])).newPage();
await page.goto(BASE + "/login");
const inputs = await page.$$("input");
await inputs[0].fill("qa"); await inputs[1].fill(PW);
await page.click("button[type=submit], button");
await page.waitForURL(BASE + "/", { timeout: 8000 });
await page.goto(BASE + "/browse");
await page.waitForTimeout(1500);
// force the new service worker to take over
await page.evaluate(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  for (const r of regs) await r.update();
});
await page.goto(BASE + "/browse");
await page.waitForTimeout(1500);
await page.fill("form input", "thissiteisnotreal.example");
await page.keyboard.press("Enter");
await page.waitForTimeout(6000);
const frameText = await page.evaluate(() => {
  const f = document.querySelector("iframe");
  try { return f.contentDocument.body.innerText.slice(0, 120); } catch { return "cross-origin"; }
});
await page.screenshot({ path: "/tmp/qa-browse-dead2.png" });
console.log("frame text:", JSON.stringify(frameText));
await browser.close();
