import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const browser = await chromium.launch();
const page = await (await browser.newContext(devices["iPhone 13"])).newPage();
page.on("console", (m) => console.log("CONSOLE:", m.text().slice(0, 160)));
page.on("response", (r) => { if (r.url().includes("/vsrc") || r.url().includes("/watch")) console.log("NET:", r.status(), r.url().slice(0, 110)); });
page.on("requestfailed", (r) => { if (r.url().includes("vsrc")) console.log("FAILED:", r.url().slice(0, 110), r.failure()?.errorText); });
await page.goto(BASE + "/login");
const inputs = await page.$$("input");
await inputs[0].fill("qa"); await inputs[1].fill(PW);
await page.click("button[type=submit], button");
await page.waitForURL(BASE + "/", { timeout: 8000 });
await page.goto(BASE + "/jetstream/watch?id=aqz-KE-bpKQ", { waitUntil: "networkidle" }).catch(() => {});
await page.waitForTimeout(9000);
const st = await page.evaluate(() => {
  const v = document.querySelector(".frame video");
  return {
    badge: document.querySelector(".qbtn")?.textContent?.trim(),
    src: v?.src?.slice(0, 90), t: v?.currentTime, err: v?.error?.code ?? null,
    rs: v?.readyState, ns: v?.networkState,
    vh: v?.videoHeight, vw: v?.videoWidth,
  };
});
console.log("STATE:", JSON.stringify(st));
await page.screenshot({ path: "/tmp/qa-hd-debug.png" });
await browser.close();
