import { chromium } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(BASE + "/login");
const inputs = await page.$$("input");
await inputs[0].fill("qa"); await inputs[1].fill(PW);
await page.click("button[type=submit], button");
await page.waitForTimeout(4000);
console.log("qa url:", page.url());
await browser.close();
// confirm qatmp is gone
const resp = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "qatmp", password: "tmppass123" }) });
console.log("qatmp login status:", resp.status);
