import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/tmp/rj-qa-data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14225";
const seed = [
  { name: "discord.com", url: "https://discord.com/", n: 12 },
  { name: "reddit.com", url: "https://www.reddit.com/", n: 8 },
  { name: "duckduckgo.com", url: "https://duckduckgo.com/", n: 6 },
  { name: "omoggle.com", url: "https://omoggle.com/", n: 4 },
  { name: "github.com", url: "https://github.com/", n: 2 },
  { name: "wikipedia.org", url: "https://www.wikipedia.org/", n: 1 },
];
const browser = await chromium.launch();
for (const [name, ctxopts] of [["iphone", devices["iPhone 13"]], ["desktop", { viewport: { width: 1280, height: 800 } }]]) {
  const ctx = await browser.newContext(ctxopts);
  await ctx.addInitScript((s) => { try { localStorage.setItem("rj-browse-recent", JSON.stringify(s)); } catch {} }, seed);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", name, String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLEERR", name, m.text().slice(0, 200)); });
  await page.goto(BASE + "/login");
  const inputs = await page.$$("input");
  await inputs[0].fill("qa"); await inputs[1].fill(PW);
  await inputs[1].press("Enter");
  await page.waitForURL(BASE + "/", { timeout: 8000 });
  await page.goto(BASE + "/browse", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `/tmp/browse-mostvisited-${name}.png` });
  console.log("shot", name);
  await ctx.close();
}
await browser.close();
