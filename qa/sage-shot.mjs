import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
for (const [name, dev] of [["desktop", null], ["iphone", devices["iPhone 13"]]]) {
  const browser = await chromium.launch();
  const page = await (await browser.newContext(dev || { viewport: { width: 1280, height: 800 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(BASE + "/login");
  const inputs = await page.$$("input");
  await inputs[0].fill("qa"); await inputs[1].fill(PW);
  await page.click("button[type=submit], button");
  await page.waitForURL(BASE + "/", { timeout: 8000 });
  await page.goto(BASE + "/sage");
  await page.evaluate(() => localStorage.removeItem("sage-conversation"));
  await page.reload();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `/tmp/qa-sage-${name}-empty.png` });
  await page.fill(".composer textarea", "explain why the sky is blue in two short paragraphs, bold the key phrase");
  await page.click(".composer button");
  await page.waitForFunction(() => {
    const bubbles = [...document.querySelectorAll(".msg:not(.mine) .bubble")];
    return bubbles.some((b) => !b.classList.contains("thinking-bubble"));
  }, null, { timeout: 90000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `/tmp/qa-sage-${name}-chat.png` });
  const md = await page.evaluate(() => !!document.querySelector(".bubble strong"));
  console.log(name, "| bold rendered:", md, "| pageerrors:", errs.length ? errs.join(";") : "none");
  await browser.close();
}
