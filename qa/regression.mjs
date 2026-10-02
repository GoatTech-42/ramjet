import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const results = [];
for (const [name, dev] of [["desktop", null], ["iphone", devices["iPhone 13"]]]) {
  const browser = await chromium.launch();
  const page = await (await browser.newContext(dev || { viewport: { width: 1280, height: 800 } })).newPage();
  const errs = [], cerrs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  page.on("console", (m) => { if (m.type() === "error") cerrs.push(m.text().slice(0, 120)); });
  page.on("response", (r) => { if (r.status() >= 400) cerrs.push("HTTP " + r.status() + " " + r.url().slice(0, 140)); });
  await page.goto(BASE + "/login");
  const inputs = await page.$$("input");
  await inputs[0].fill("qa"); await inputs[1].fill(PW);
  await page.click("button[type=submit], button");
  await page.waitForURL(BASE + "/", { timeout: 8000 });

  // hub
  await page.waitForTimeout(500);
  const hubRows = await page.evaluate(() => document.querySelectorAll("a.row").length);
  results.push(`${name} hub: rows=${hubRows}`);

  // browse: load a page through the proxy frame
  await page.goto(BASE + "/browse");
  await page.waitForTimeout(800);
  await page.fill("form input", "example.com").catch(() => {});
  await page.keyboard.press("Enter");
  await page.waitForTimeout(7000); // cold SW install+claim can take >4s on a fresh profile
  const frameOk = await page.evaluate(() => {
    const f = document.querySelector("iframe");
    try { return f && f.contentDocument && f.contentDocument.title.length > 0 ? f.contentDocument.title : "EMPTY"; } catch { return "cross-origin-cannot-read"; }
  });
  const browseOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  results.push(`${name} browse: frame="${frameOk}" xoverflow=${browseOverflow}`);

  // jetstream: search renders (no streaming)
  await page.goto(BASE + "/jetstream");
  await page.waitForTimeout(600);
  await page.fill("input", "lofi girl");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".row, .result, .card", { timeout: 15000 }).catch(() => {});
  const jsCount = await page.evaluate(() => document.querySelectorAll(".row, .result, .card").length);
  results.push(`${name} jetstream: results=${jsCount}`);

  // amp: search + play an audius track (no googlevideo)
  await page.goto(BASE + "/amp");
  await page.waitForTimeout(600);
  await page.fill("input", "fred again");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".row", { timeout: 15000 });
  const auIdx = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".row")];
    const i = rows.findIndex((r) => r.textContent.toLowerCase().includes("audius"));
    return i;
  });
  if (auIdx >= 0) {
    const rows = await page.$$(".row");
    await rows[auIdx].click();
    await page.waitForFunction(() => {
      const t = document.querySelector('.times')?.textContent || '';
      return /^0:0[1-9] \/ /.test(t) || !!document.querySelector('.terr');
    }, null, {timeout:15000}).catch(() => {});
    const t = await page.evaluate(() => document.querySelector(".times")?.textContent || "");
    const e = await page.evaluate(() => document.querySelector(".terr")?.textContent || "");
    results.push(`${name} amp: audius playhead="${t}" err="${e}"`);
  } else results.push(`${name} amp: NO AUDIUS ROW FOUND`);

  // sage: send a message, expect a reply bubble
  await page.goto(BASE + "/sage");
  await page.evaluate(() => localStorage.removeItem("sage-conversation"));
  await page.reload();
  await page.waitForTimeout(500);
  await page.fill(".composer textarea", "say hi in exactly five words");
  await page.click(".composer button");
  const sageOk = await page.waitForFunction(() => {
    const b = [...document.querySelectorAll(".msg:not(.mine) .bubble")];
    return b.some((x) => !x.classList.contains("thinking-bubble") && x.textContent.trim().length > 0);
  }, null, { timeout: 60000 }).then(() => true).catch(() => false);
  results.push(`${name} sage: reply=${sageOk}`);

  // settings
  await page.goto(BASE + "/settings");
  await page.waitForTimeout(600);
  const who = await page.evaluate(() => document.querySelector(".name")?.textContent || "");
  results.push(`${name} settings: user="${who}"`);

  results.push(`${name} pageerrors: ${errs.length ? errs.join(" | ") : "none"}`);
  results.push(`${name} console-errors: ${cerrs.length ? cerrs.slice(0, 3).join(" | ") : "none"}`);
  await page.screenshot({ path: `/tmp/qa-regress-${name}.png` });
  await browser.close();
}
console.log(results.join("\n"));
