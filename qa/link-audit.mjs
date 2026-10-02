import { chromium } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(BASE + "/login");
const inputs = await page.$$("input");
await inputs[0].fill("qa"); await inputs[1].fill(PW);
await page.click("button[type=submit], button");
await page.waitForURL(BASE + "/", { timeout: 8000 });
const hrefs = new Set();
for (const p of ["/", "/browse", "/jetstream", "/amp", "/sage", "/settings"]) {
  await page.goto(BASE + p);
  await page.waitForTimeout(800);
  const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")));
  links.filter((h) => h && h.startsWith("/") && !h.startsWith("//")).forEach((h) => hrefs.add(h.split(/[?#]/)[0]));
  console.log(p, "-> links:", JSON.stringify(links.filter((h) => h && h.startsWith("/"))));
}
console.log("--- checking each internal href ---");
for (const h of [...hrefs].sort()) {
  const r = await page.request.get(BASE + h);
  const title = r.ok ? "" : " <== PROBLEM";
  console.log(h, r.status(), title);
}
await browser.close();
