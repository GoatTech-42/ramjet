import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const pages = ["", "browse", "jetstream", "amp", "sage", "settings"];
const browser = await chromium.launch();
for (const [name, ctxopts] of [["iphone", devices["iPhone 13"]], ["desktop", { viewport: { width: 1280, height: 800 } }]]) {
  const ctx = await browser.newContext(ctxopts);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", name, String(e).slice(0, 150)));
  await page.goto(BASE + "/login");
  const inputs = await page.$$("input");
  await inputs[0].fill("qa"); await inputs[1].fill(PW);
  await page.click("button[type=submit], button");
  await page.waitForURL(BASE + "/", { timeout: 8000 });
  for (const p of pages) {
    await page.goto(BASE + "/" + p, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const tag = p === "" ? "hub" : p;
    await page.screenshot({ path: `/tmp/qa-cmp-${tag}-${name}.png` });
    console.log("shot", tag, name);
  }
  await ctx.close();
}
await browser.close();
