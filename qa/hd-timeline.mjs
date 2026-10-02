import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const browser = await chromium.launch();
const page = await (await browser.newContext(devices["iPhone 13"])).newPage();
page.on("console", (m) => console.log("CONSOLE:", m.text().slice(0, 140)));
await page.goto(BASE + "/login");
const inputs = await page.$$("input");
await inputs[0].fill("qa"); await inputs[1].fill(PW);
await page.click("button[type=submit], button");
await page.waitForURL(BASE + "/", { timeout: 8000 });
await page.goto(BASE + "/jetstream", { waitUntil: "networkidle" });
await page.fill(".bar input", "big buck bunny");
await page.click(".bar button");
await page.waitForSelector(".row img", { timeout: 20000 });
await page.waitForTimeout(600);
await page.click(".row");
await page.waitForSelector(".frame video", { timeout: 25000 });
for (let i = 0; i < 10; i++) {
  const st = await page.evaluate(() => {
    const v = document.querySelector(".frame video");
    const kind = (s) => s?.includes("kind=video") ? "hd-video" : s?.includes("stream?") ? "360p" : s ? "other" : "none";
    return {
      badge: document.querySelector(".qbtn")?.textContent?.trim(),
      src: kind(v?.currentSrc || v?.src), t: +(v?.currentTime ?? -1).toFixed(1),
      err: v?.error?.code ?? null, rs: v?.readyState,
      paused: v?.paused, vh: v?.videoHeight,
    };
  });
  console.log(`t+${i * 1.5}s`, JSON.stringify(st));
  await page.waitForTimeout(1500);
}
await browser.close();
