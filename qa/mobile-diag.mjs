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
await page.fill("header input", "https://httpbin.org/user-agent");
await page.press("header input", "Enter");
await page.waitForTimeout(10000);
const ua = await page.evaluate(() => { try { return document.querySelector("iframe").contentDocument.body.innerText.slice(0, 300) } catch (e) { return "guard" } });
console.log("UA seen by target:", ua);
await page.fill("header input", "en.wikipedia.org/wiki/Minecraft");
await page.press("header input", "Enter");
await page.waitForTimeout(14000);
const metrics = await page.evaluate(() => {
  try {
    const w = document.querySelector("iframe").contentWindow;
    const d = w.document;
    const meta = d.querySelector("meta[name=viewport]");
    return { innerWidth: w.innerWidth, clientWidth: d.documentElement.clientWidth, screenWidth: w.screen.width, frameUa: w.navigator.userAgent.slice(0, 90), metaViewport: meta ? meta.content : "none", location: w.location.href.slice(0, 90) };
  } catch (e) { return "guard: " + e.message.slice(0, 80) }
});
console.log("METRICS:", JSON.stringify(metrics, null, 1));
await page.screenshot({ path: "shots/browse-iphone-wiki.png" });
await browser.close();
