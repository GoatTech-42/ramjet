import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("console", (m) => console.log("[console]", m.type(), m.text().slice(0, 200)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.goto("http://127.0.0.1:4599/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
console.log("STATUS:", await page.textContent("#status"));
await page.screenshot({ path: "/tmp/browse-spike/shot1.png" });
await page.waitForTimeout(6000);
console.log("STATUS2:", await page.textContent("#status"));
await page.screenshot({ path: "/tmp/browse-spike/shot2.png" });
const frameInfo = await page.evaluate(() => {
  const f = document.getElementById("frame");
  return { src: f.src, contentLen: (() => { try { return f.contentDocument?.documentElement?.innerHTML?.length } catch (e) { return "cross-origin-guard: " + e.message.slice(0, 60) } })() };
});
console.log("FRAME:", JSON.stringify(frameInfo));
await browser.close();
