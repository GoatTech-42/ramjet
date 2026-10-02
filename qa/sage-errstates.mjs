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
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE + "/sage");
  await page.waitForTimeout(700);

  // auto-grow: long draft should stretch the composer
  const h1 = await page.evaluate(() => document.querySelector(".composer textarea").offsetHeight);
  await page.fill(".composer textarea", "this is a deliberately long message meant to test whether the composer box grows as the text wraps onto a second and third line like every chat app does");
  await page.waitForTimeout(300);
  const h2 = await page.evaluate(() => document.querySelector(".composer textarea").offsetHeight);
  results.push(`${name}: composer grows=${h2 > h1} (${h1}->${h2})`);

  // happy path
  await page.fill(".composer textarea", "say hi in exactly one word");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".msg").length >= 2 && !document.querySelector(".thinking-bubble"), { timeout: 45000 });
  const h3 = await page.evaluate(() => document.querySelector(".composer textarea").offsetHeight);
  const reply = await page.evaluate(() => document.querySelectorAll(".msg:not(.mine) .bubble")[0]?.textContent.slice(0, 40));
  results.push(`${name}: reply=${JSON.stringify(reply)} box-reset=${h3 <= h1 + 2}`);

  // error path: API 500 -> error line + try again button
  await page.route("**/api/apps/sage/chat", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "couldn't reach the model - try again" }) }));
  await page.fill(".composer textarea", "another one");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".error .retrylink", { timeout: 15000 });
  const errTxt = await page.evaluate(() => document.querySelector(".error")?.textContent);
  await page.screenshot({ path: `/tmp/qa-sage-err-${name}.png` });
  results.push(`${name}: err=${JSON.stringify(errTxt)}`);

  // retry while still failing -> error persists, no dup user message
  await page.click(".retrylink");
  await page.waitForSelector(".thinking-bubble", { timeout: 8000 }).catch(() => {});
  await page.waitForSelector(".error .retrylink", { timeout: 15000 });
  const userMsgs = await page.evaluate(() => document.querySelectorAll(".msg.mine").length);
  results.push(`${name}: retry-still-failing keeps error, userMsgs=${userMsgs}`);

  // unroute, retry -> reply arrives, error clears
  await page.unroute("**/api/apps/sage/chat");
  await page.click(".retrylink");
  await page.waitForFunction(() => !document.querySelector(".error") && !document.querySelector(".thinking-bubble"), { timeout: 45000 });
  const msgCount = await page.evaluate(() => document.querySelectorAll(".msg").length);
  await page.screenshot({ path: `/tmp/qa-sage-ok-${name}.png` });
  results.push(`${name}: recovered msgs=${msgCount}`);

  // reload -> conversation persists, scrolled to bottom
  await page.reload();
  await page.waitForTimeout(1200);
  const persist = await page.evaluate(() => ({
    msgs: document.querySelectorAll(".msg").length,
    atBottom: (() => { const l = document.querySelector(".list"); return l ? l.scrollHeight - l.scrollTop - l.clientHeight < 5 : null; })(),
  }));
  results.push(`${name}: reload msgs=${persist.msgs} atBottom=${persist.atBottom}`);
  results.push(`${name}: pageerrors=${errs.length}${errs.length ? " " + errs.join(" | ") : ""}`);
  await browser.close();
}
console.log(results.join("\n"));
