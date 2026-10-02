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
await page.fill("input", "minecraft");
await page.keyboard.press("Enter");
// the proxied frame: wait for bing results inside it
const frame = page.frames().find((f) => f.url().includes("/~/sj/") || f.url().includes("bing"));
let found = null;
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  const fr = page.frames().find((f) => f !== page.mainFrame());
  if (fr) {
    try {
      const html = await fr.evaluate(() => document.body ? document.body.innerText.slice(0, 600) : "");
      const url = fr.url();
      const algo = await fr.evaluate(() => document.querySelectorAll(".b_algo").length);
      const challenge = /captcha|unusual traffic|verify you are|robot/i.test(html);
      if (algo > 0 || html.length > 100) { found = { url: url.slice(0, 80), algo, challenge, text: html.slice(0, 300) }; if (algo >= 3) break; }
    } catch {}
  }
}
console.log(JSON.stringify(found, null, 1));
await page.screenshot({ path: "/tmp/browse-bing.png" });
await browser.close();
