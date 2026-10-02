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
await page.waitForTimeout(12000);
const fr = page.frames().find((f) => f !== page.mainFrame());
if (fr) {
  const info = await fr.evaluate(() => {
    const algos = [...document.querySelectorAll(".b_algo")];
    const first = algos[0];
    const r = first ? first.getBoundingClientRect() : null;
    return {
      count: algos.length,
      titles: algos.slice(0, 4).map((a) => a.querySelector("h2")?.innerText || "(no h2)"),
      firstRect: r ? { top: r.top, height: r.height, width: r.width } : null,
      bodyH: document.body ? document.body.scrollHeight : 0,
      resultsEl: !!document.querySelector("#b_results"),
      olHtml: document.querySelector("#b_results")?.innerHTML?.slice(0, 200) || "none",
    };
  });
  console.log(JSON.stringify(info, null, 1));
  await fr.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(1500);
}
await page.screenshot({ path: "/tmp/browse-bing2.png" });
await browser.close();
