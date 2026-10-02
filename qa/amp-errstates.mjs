import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const results = [];
for (const [name, dev] of [["iphone", devices["iPhone 13"]], ["desktop", null]]) {
  const browser = await chromium.launch();
  const page = await (await browser.newContext(dev || { viewport: { width: 1280, height: 800 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));
  await page.goto(BASE + "/login");
  const inputs = await page.$$("input");
  await inputs[0].fill("qa"); await inputs[1].fill(PW);
  await page.click("button[type=submit], button");
  await page.waitForURL(BASE + "/", { timeout: 8000 });
  await page.goto(BASE + "/amp");
  await page.waitForTimeout(600);
  await page.fill("input", "never gonna give you up");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".row", { timeout: 20000 });
  const idx = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".row")];
    const find = (label) => rows.findIndex((r) => r.querySelector(".src")?.textContent === label);
    return { sc: find("soundcloud"), au: find("audius"), yt: find("youtube music"), total: rows.length };
  });
  results.push(`${name}: rows=${idx.total} sc=${idx.sc} au=${idx.au} yt=${idx.yt}`);
  const tapRow = async (i) => { const rows = await page.$$(".row"); await rows[i].click(); };
  const terr = () => page.evaluate(() => document.querySelector(".terr")?.textContent || null);
  const times = () => page.evaluate(() => document.querySelector(".times")?.textContent || null);

  // a) loading indicator: slow the stream 2.5s, expect "loading..." then playback
  await page.route("**/api/apps/amp/stream**", async (r) => { await new Promise((res) => setTimeout(res, 2500)); r.continue(); });
  await tapRow(idx.sc >= 0 ? idx.sc : idx.au);
  await page.waitForTimeout(1200);
  const loadingTxt = await times();
  await page.waitForTimeout(6000);
  const t1 = await page.evaluate(() => document.querySelector(".times")?.textContent || "");
  await page.unroute("**/api/apps/amp/stream**");
  results.push(`${name}: slow-load shows=${JSON.stringify(loadingTxt)} then=${JSON.stringify(t1)}`);

  // b) stream walled: SC row -> honest error, and play-tap retry must NOT clobber it
  await page.route("**/api/apps/amp/stream**", (r) => r.fulfill({ status: 403, body: "throttled" }));
  await tapRow(idx.sc >= 0 ? idx.sc : idx.au);
  await page.waitForTimeout(3500);
  const errSc = await terr();
  await page.click(".p-btns .pp").catch(() => {});
  await page.waitForTimeout(3500);
  const errSc2 = await terr();
  results.push(`${name}: sc-walled=${JSON.stringify(errSc)} after-retry=${JSON.stringify(errSc2)}`);
  await page.screenshot({ path: `/tmp/qa-amp-err-${name}.png` });

  // c) YT row walled -> throttle copy
  if (idx.yt >= 0) {
    await tapRow(idx.yt);
    await page.waitForTimeout(4000);
    results.push(`${name}: yt-walled=${JSON.stringify(await terr())}`);
  }

  // d) unwalled: tap play -> recovers, error clears, time advances
  await page.unroute("**/api/apps/amp/stream**");
  await tapRow(idx.sc >= 0 ? idx.sc : idx.au);
  await page.waitForTimeout(6000);
  const cur1 = await page.evaluate(() => document.querySelector(".times")?.textContent || "");
  const errGone = (await terr()) === null;
  await page.screenshot({ path: `/tmp/qa-amp-ok-${name}.png` });
  results.push(`${name}: recovered times=${JSON.stringify(cur1)} errCleared=${errGone}`);
  results.push(`${name}: pageerrors=${errs.length}${errs.length ? " " + errs.join(" | ") : ""}`);
  await browser.close();
}
console.log(results.join("\n"));
