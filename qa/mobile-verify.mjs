import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
const page = await ctx.newPage();
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const token = (login.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
await page.goto("http://127.0.0.1:14224/browse", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth + " vs " + window.innerWidth);
console.log("PAGE WIDTH:", overflow);
await page.screenshot({ path: "shots/browse-iphone-home-fixed.png" });
for (const [name, url] of [["google", "google.com"], ["reddit", "reddit.com/r/Minecraft"], ["github", "github.com"]]) {
  await page.fill("header input", url);
  await page.press("header input", "Enter");
  await page.waitForTimeout(12000);
  const m = await page.evaluate(() => {
    try {
      const w = document.querySelector("iframe").contentWindow;
      return { w: w.innerWidth, scrollW: w.document.documentElement.scrollWidth, title: w.document.title.slice(0, 40) };
    } catch (e) { return "guard" }
  });
  console.log(name.toUpperCase(), JSON.stringify(m));
  const outer = await page.evaluate(() => document.documentElement.scrollWidth + " vs " + window.innerWidth);
  console.log(name.toUpperCase(), "OUTER WIDTH:", outer);
  await page.screenshot({ path: `shots/browse-iphone-${name}.png` });
}
await browser.close();
