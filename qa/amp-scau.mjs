import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
for (const [name, dev] of [["desktop", null], ["iphone", devices["iPhone 13"]]]) {
  const browser = await chromium.launch();
  const page = await (await browser.newContext(dev || { viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(BASE + "/login");
  const inputs = await page.$$("input");
  await inputs[0].fill("qa"); await inputs[1].fill(PW);
  await page.click("button[type=submit], button");
  await page.waitForURL(BASE + "/", { timeout: 8000 });
  await page.goto(BASE + "/amp");
  for (const [query, srcLabel] of [["get lucky dj kb", "soundcloud"], ["daft punk", "audius"]]) {
    await page.fill(".search input", query);
    await page.click(".search button");
    await page.waitForSelector(".list .row", { timeout: 15000 });
    const clicked = await page.evaluate((label) => {
      const rows = [...document.querySelectorAll(".list .row")];
      const row = rows.find((r) => r.querySelector(".src")?.textContent === label);
      if (!row) return null;
      row.click();
      return row.querySelector(".title")?.textContent;
    }, srcLabel);
    await page.waitForTimeout(8000);
    const st = await page.evaluate(() => ({
      times: document.querySelector(".times")?.textContent || "",
      err: document.querySelector(".terr")?.textContent || "",
    }));
    console.log(name, "|", srcLabel, "| clicked:", (clicked || "NOT FOUND").slice(0, 35), "| times:", st.times.replace(/\s+/g, " "), st.err ? "| ERR: " + st.err : "");
    if (name === "desktop") await page.screenshot({ path: `/tmp/qa-amp-${srcLabel}-playing.png` });
  }
  await browser.close();
}
