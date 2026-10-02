import { chromium } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const token = (login.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
await page.goto("http://127.0.0.1:14224/browse", { waitUntil: "domcontentloaded" });
await page.waitForSelector("input", { timeout: 30000 });
await page.fill("input", "https://html.duckduckgo.com/html/?q=minecraft");
await page.keyboard.press("Enter");
await page.waitForTimeout(12000);
const fr = page.frames().find((f) => f !== page.mainFrame());
if (fr) {
  const info = await fr.evaluate(() => ({
    url: location.href.slice(0, 90),
    results: document.querySelectorAll(".result__a, .result-link").length,
    anomaly: /anomaly|not a robot|captcha/i.test(document.body?.innerText || ""),
    text: (document.body?.innerText || "").slice(0, 220),
  }));
  console.log(JSON.stringify(info, null, 1));
}
await page.screenshot({ path: "/tmp/browse-ddg.png" });
await browser.close();
