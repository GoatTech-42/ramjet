import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const results = [];
for (const [name, dev] of [["iphone", devices["iPhone 13"]], ["desktop", null]]) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(dev || { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));
  await page.goto(BASE + "/login");
  const inputs = await page.$$("input");
  await inputs[0].fill("qa"); await inputs[1].fill(PW);
  await page.click("button[type=submit], button");
  await page.waitForURL(BASE + "/", { timeout: 8000 });

  await page.goto(BASE + "/jetstream");
  await page.waitForTimeout(600);
  await page.fill("input", "never gonna give you up");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".row", { timeout: 15000 });

  // simulate the googlevideo wall: 403s, exactly what production hits
  await page.route("**/api/apps/jetstream/vsrc**", (r) => r.fulfill({ status: 403, body: "throttled" }));
  await page.route("**/api/apps/jetstream/stream**", (r) => r.fulfill({ status: 403, body: "throttled" }));
  const rows = await page.$$(".row");
  await rows[0].click();
  await page.waitForTimeout(8000);
  const state1 = await page.evaluate(() => ({
    pill: document.querySelector(".qbtn")?.textContent || null,
    cut: document.querySelector(".stall .cut")?.textContent.replace(/\s+/g, " ").trim() || null,
    note: document.querySelector(".hdnote")?.textContent || null,
  }));
  await page.screenshot({ path: `/tmp/qa-js-cutout-${name}.png` });
  results.push(`${name}: walled -> pill=${state1.pill} note=${state1.note ? "yes" : "no"} overlay=${state1.cut ? JSON.stringify(state1.cut) : "MISSING"}`);

  // reopen only 360p, retry -> fallback plays, note shows, pill reads 360p
  await page.unroute("**/api/apps/jetstream/stream**");
  await page.click(".retry").catch(() => {});
  await page.waitForTimeout(6000);
  const t1 = await page.evaluate(() => document.querySelector("video")?.currentTime ?? -1);
  await page.waitForTimeout(2000);
  const state2 = await page.evaluate(() => ({
    t: document.querySelector("video")?.currentTime ?? -1,
    pill: document.querySelector(".qbtn")?.textContent || null,
    note: document.querySelector(".hdnote")?.textContent || null,
    overlayGone: !document.querySelector(".stall .cut"),
  }));
  await page.screenshot({ path: `/tmp/qa-js-fallback-${name}.png` });
  results.push(`${name}: retry -> playing=${state2.t > t1 && state2.t > 0} (t=${t1.toFixed(1)}->${state2.t.toFixed(1)}) pill=${state2.pill} note=${JSON.stringify(state2.note)} overlayGone=${state2.overlayGone}`);

  // restore everything, toggle back to HD
  await page.unroute("**/api/apps/jetstream/vsrc**");
  await page.click(".qbtn").catch(() => {});
  await page.waitForTimeout(5000);
  const state3 = await page.evaluate(() => ({
    t: document.querySelector("video")?.currentTime ?? -1,
    muted: document.querySelector("video")?.muted,
    pill: document.querySelector(".qbtn")?.textContent || null,
    note: document.querySelector(".hdnote")?.textContent || null,
  }));
  await page.screenshot({ path: `/tmp/qa-js-hd-${name}.png` });
  results.push(`${name}: toggle -> pill=${state3.pill} muted=${state3.muted} t=${state3.t.toFixed(1)} noteStill=${!!state3.note}`);
  results.push(`${name}: pageerrors=${errs.length}${errs.length ? " " + errs.join(" | ") : ""}`);
  await browser.close();
}
console.log(results.join("\n"));
