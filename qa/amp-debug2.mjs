import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
for (const [name, dev] of [["desktop", null], ["iphone", devices["iPhone 13"]]]) {
  const browser = await chromium.launch();
  const page = await (await browser.newContext(dev || { viewport: { width: 1280, height: 800 } })).newPage();
  let two06 = 0, other = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/apps/amp/stream")) {
      if (r.status() === 206 || r.status() === 200) two06++;
      else other.push(r.status());
    }
  });
  await page.goto(BASE + "/login");
  const inputs = await page.$$("input");
  await inputs[0].fill("qa"); await inputs[1].fill(PW);
  await page.click("button[type=submit], button");
  await page.waitForURL(BASE + "/", { timeout: 8000 });
  await page.goto(BASE + "/amp");
  await page.fill(".search input", "kavinsky nightcall");
  await page.click(".search button");
  await page.waitForSelector(".list .row", { timeout: 15000 });
  await page.click(".list .row");
  await page.waitForTimeout(9000);
  const st = await page.evaluate(() => ({
    times: document.querySelector(".times")?.textContent || "",
    title: document.querySelector(".p-title")?.textContent || "",
  }));
  await page.screenshot({ path: `/tmp/qa-amp-${name}-playing.png` });
  console.log(name, "|", st.title.slice(0, 35), "| times:", st.times.replace(/\s+/g, " "), "| 2xx chunks:", two06, "| non-2xx:", JSON.stringify(other));
  await browser.close();
}
