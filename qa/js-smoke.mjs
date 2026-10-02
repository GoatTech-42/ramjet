import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const browser = await chromium.launch();
const page = await (await browser.newContext(devices["iPhone 13"])).newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
await page.goto(BASE + "/login");
const inputs = await page.$$("input");
await inputs[0].fill("qa"); await inputs[1].fill(PW);
await page.click("button[type=submit], button");
await page.waitForURL(BASE + "/", { timeout: 8000 });
await page.goto(BASE + "/jetstream");
await page.waitForTimeout(600);
await page.fill("input", "never gonna give you up");
await page.keyboard.press("Enter");
await page.waitForSelector(".row", { timeout: 15000 });
const rows = await page.$$(".row");
await rows[0].click();
await page.waitForTimeout(8000);
const st = await page.evaluate(() => ({
  t: document.querySelector("video")?.currentTime ?? -1,
  muted: document.querySelector("video")?.muted,
  pill: document.querySelector(".qbtn")?.textContent || null,
  note: !!document.querySelector(".hdnote"),
}));
console.log(`smoke: hd playing=${st.t > 0} t=${st.t.toFixed(1)} muted=${st.muted} pill=${st.pill} note=${st.note} pageerrors=${errs.length}`);
await browser.close();
