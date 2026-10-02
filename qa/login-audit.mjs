import { chromium, devices } from "playwright";
const BASE = "http://127.0.0.1:14224";
const browser = await chromium.launch();
const page = await (await browser.newContext(devices["iPhone 13"])).newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(BASE + "/login");
await page.waitForTimeout(600);
const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")));
for (const h of links.filter((h) => h.startsWith("/"))) {
  const r = await page.request.get(BASE + h, { maxRedirects: 0 });
  console.log(h, r.status());
}
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
await page.screenshot({ path: "/tmp/qa-login-iphone.png" });
console.log("login links:", JSON.stringify(links), "| x-overflow px:", overflow, "| pageerrors:", errs.length ? errs.join(";") : "none");
await browser.close();
