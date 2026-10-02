import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const browser = await chromium.launch();
const page = await (await browser.newContext(devices["iPhone 13"])).newPage();
page.on("response", (r) => { if (r.url().includes("/vsrc")) console.log("NET:", r.status(), r.url().slice(0, 100)); });
page.on("requestfailed", (r) => { if (r.url().includes("vsrc")) console.log("FAILED:", r.failure()?.errorText, r.url().slice(0, 100)); });
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
await page.waitForTimeout(9000);
const st = await page.evaluate(() => {
  const v = document.querySelector(".frame video");
  return {
    badge: document.querySelector(".qbtn")?.textContent?.trim(),
    dropped: !!document.querySelector(".hd-dropped, .dropped, [class*=drop]"),
    src: v?.src?.slice(-60), t: +(v?.currentTime ?? -1).toFixed(1), err: v?.error?.code ?? null,
    rs: v?.readyState, ns: v?.networkState, vh: v?.videoHeight,
    url: location.href,
  };
});
console.log("STATE:", JSON.stringify(st));
await page.screenshot({ path: "/tmp/qa-hd-debug2.png" });
await browser.close();
