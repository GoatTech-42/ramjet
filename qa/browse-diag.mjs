import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const browser = await chromium.launch();
const page = await (await browser.newContext(devices["iPhone 13"])).newPage();
const bad = [];
page.on("response", (r) => { if (r.status() >= 400) bad.push(r.status() + " " + r.url().slice(0, 140)); });
await page.goto(BASE + "/login");
const inputs = await page.$$("input");
await inputs[0].fill("qa"); await inputs[1].fill(PW);
await page.click("button[type=submit], button");
await page.waitForURL(BASE + "/", { timeout: 8000 });
// mirror the regression flow exactly: hub check, then browse
await page.waitForTimeout(500);
await page.evaluate(() => document.querySelectorAll("a.row").length);
await page.goto(BASE + "/browse");
await page.waitForTimeout(800);
const selInfo = await page.evaluate(() => {
  const omni = document.querySelector(".omni input");
  const text = document.querySelector("input[type=text]");
  return { omniExists: !!omni, textExists: !!text, omniType: omni?.type, inputCount: document.querySelectorAll("input").length };
});
console.log("selectors:", JSON.stringify(selInfo));
await page.fill(".omni input, input[type=text]", "example.com").catch((e) => console.log("FILL FAILED:", String(e).slice(0, 120)));
const val = await page.evaluate(() => document.querySelector(".omni input, input[type=text]")?.value);
console.log("input value after fill:", JSON.stringify(val));
await page.keyboard.press("Enter");
for (const wait of [2000, 3000, 5000]) {
  await page.waitForTimeout(wait);
  const st = await page.evaluate(async () => {
    const f = document.querySelector("iframe");
    const reg = await navigator.serviceWorker?.getRegistration();
    return {
      frameSrc: f?.src?.slice(0, 80) || null,
      title: (() => { try { return f?.contentDocument?.title || "EMPTY"; } catch { return "xo"; } })(),
      swController: !!navigator.serviceWorker?.controller,
      swState: reg?.active?.state || "none",
    };
  });
  console.log(`after +${wait}ms:`, JSON.stringify(st));
}
console.log("bad responses:", bad.length ? bad.join("\n  ") : "none");
await browser.close();
