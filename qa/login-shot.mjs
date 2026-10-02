import { chromium, devices } from "playwright";
const BASE = "http://127.0.0.1:14224";
for (const [name, dev] of [["iphone", devices["iPhone 13"]], ["desktop", null]]) {
  const browser = await chromium.launch();
  const page = await (await browser.newContext(dev || { viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(BASE + "/login");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `/tmp/qa-login-${name}.png` });
  await browser.close();
}
console.log("done");
