import { chromium } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.route("**/*googlevideo.com/**", (r) => r.abort());
const page = await ctx.newPage();
page.on("response", async (res) => {
  if (res.url().includes("/history")) {
    let body = "";
    try { body = (await res.text()).slice(0, 120); } catch {}
    console.log("NET", res.request().method(), res.url().split("/api")[1], res.status(), body);
  }
});
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const token = (login.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 60000 });
await page.waitForTimeout(3000);
await page.click(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
await page.waitForTimeout(6000);
await page.click(".feed-back");
await page.waitForTimeout(1500);
const r = await page.request.get("http://127.0.0.1:14224/api/apps/jetstream/history");
console.log("GET status", r.status());
const d = await r.json();
console.log("items:", (d.items || []).length, "top:", JSON.stringify((d.items || [])[0]));
await browser.close();
