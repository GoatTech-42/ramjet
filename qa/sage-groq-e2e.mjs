import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
for (const [name, dev] of [["iphone", devices["iPhone 13"]], ["desktop", { viewport: { width: 1280, height: 800 } }]]) {
  const browser = await chromium.launch();
  const page = await (await browser.newContext(dev)).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  await page.goto(BASE + "/login");
  const inputs = await page.$$("input");
  await inputs[0].fill("qa"); await inputs[1].fill(PW);
  await page.click("button[type=submit], button");
  await page.waitForURL(BASE + "/", { timeout: 8000 });
  await page.goto(BASE + "/sage");
  const box = await page.waitForSelector("textarea", { timeout: 10000 });
  await box.fill("give me one fun fact about octopuses");
  await page.keyboard.press("Enter");
  let reply = "";
  try {
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll(".msg:not(.mine) .bubble:not(.thinking-bubble)")];
      return b.length && b[b.length - 1].textContent.trim().length > 30;
    }, null, { timeout: 45000 });
    reply = await page.evaluate(() => {
      const b = [...document.querySelectorAll(".msg:not(.mine) .bubble:not(.thinking-bubble)")];
      return b.length ? b[b.length - 1].textContent.trim().slice(0, 200) : "";
    });
  } catch {}
  const err = await page.evaluate(() => document.querySelector(".error")?.textContent?.trim() || "");
  await page.screenshot({ path: `/tmp/qa-sage-groq-${name}.png` });
  console.log(name, "| reply:", JSON.stringify(reply), "| err:", JSON.stringify(err), "| pageerrors:", errs.length ? errs.join(";") : "none");
  await browser.close();
}
