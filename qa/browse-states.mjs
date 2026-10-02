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
await page.waitForTimeout(800);
// dead domain
await page.fill("form input", "thissiteisnotreal.example");
await page.keyboard.press("Enter");
await page.waitForTimeout(6000);
await page.screenshot({ path: "/tmp/qa-browse-dead.png" });
// slow/heavy page mid-load state
await page.fill("form input", "wikipedia.org");
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);
await page.screenshot({ path: "/tmp/qa-browse-loading.png" });
await page.waitForTimeout(6000);
await page.screenshot({ path: "/tmp/qa-browse-loaded.png" });
console.log("shots taken");
await browser.close();
