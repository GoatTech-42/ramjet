import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
for (const [name, dev] of [["desktop", null], ["iphone", devices["iPhone 13"]]]) {
  const browser = await chromium.launch();
  const page = await (await browser.newContext(dev || { viewport: { width: 1280, height: 800 } })).newPage();
  const bad = [];
  page.on("response", (r) => { if (r.status() >= 400) bad.push(r.status() + " " + r.url().slice(0, 110)); });
  await page.goto(BASE + "/login");
  const inputs = await page.$$("input");
  await inputs[0].fill("qa"); await inputs[1].fill(PW);
  await page.click("button[type=submit], button");
  await page.waitForURL(BASE + "/", { timeout: 8000 });
  await page.goto(BASE + "/browse");
  await page.waitForTimeout(800);
  await page.fill("form input", "example.com");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(6000);
  const frameInfo = await page.evaluate(() => {
    const f = document.querySelector("iframe");
    if (!f) return "NO IFRAME";
    try { return f.contentDocument ? (f.contentDocument.title || "no-title-yet") : "no-doc"; } catch { return "cross-origin"; }
  });
  await page.screenshot({ path: `/tmp/qa-browse-${name}-example.png` });
  console.log(name, "| frame:", frameInfo, "| 4xx/5xx:", bad.length ? bad.join(" ; ") : "none");
  await browser.close();
}
