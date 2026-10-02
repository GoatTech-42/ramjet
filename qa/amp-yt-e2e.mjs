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
  await page.goto(BASE + "/amp");
  await page.fill("input", "never gonna give you up");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".row", { timeout: 15000 });
  // click the youtube section's first row
  const clicked = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".row")];
    const ytRow = rows.find((r) => r.textContent.toLowerCase().includes("rick astley"));
    (ytRow || rows[0]).click();
    return (ytRow || rows[0]).textContent.slice(0, 60);
  });
  await page.waitForFunction(() => {
    const t = document.querySelector(".time, .times, .progress-time");
    return t && /[0-9]:[0-9]{2}/.test(t.textContent) && !/^(0:00)\b/.test(t.textContent.trim());
  }, null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const state = await page.evaluate(() => ({
    playhead: document.querySelector(".time, .times")?.textContent?.trim() || "",
    err: document.querySelector(".terr, .trackerr, .err, .track-err")?.textContent?.trim() || "",
  }));
  await page.screenshot({ path: `/tmp/qa-amp-yt2-${name}.png` });
  console.log(name, "| clicked:", JSON.stringify(clicked), "| state:", JSON.stringify(state), "| pageerrors:", errs.length ? errs.join(";") : "none");
  await browser.close();
}
