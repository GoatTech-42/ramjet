import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 80, downloadThroughput: 4000000, uploadThroughput: 1000000 });
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const token = (login.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 60000 });
await page.tap(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });
const r = await page.evaluate(async () => {
  const playing = () => [...document.querySelectorAll(".feed .slide video")].find((x) => !x.paused && !x.ended);
  const anyLoading = () => !!document.querySelector(".slide-note");
  const anyErr = () => [...document.querySelectorAll(".slide-err")].map((e) => e.textContent.trim());
  // tap play if overlay shows
  const tryPlay = () => { const b = document.querySelector(".slide-play"); if (b) b.click(); };
  tryPlay();
  let lastT = -1, lastIdx = -1, stuckMax = 0, stuckCur = 0, darkMax = 0, darkCur = 0, waits = 0, slides = new Set(), swipes = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 75000) {
    await new Promise((r) => setTimeout(r, 500));
    const v = playing();
    if (v) {
      v.addEventListener?.("waiting", () => waits++);
      const idx = parseInt(v.dataset.idx, 10);
      slides.add(idx);
      if (idx === lastIdx && Math.abs(v.currentTime - lastT) < 0.05) { stuckCur += 0.5; stuckMax = Math.max(stuckMax, stuckCur); } else stuckCur = 0;
      lastT = v.currentTime; lastIdx = idx;
      darkCur = 0;
    } else {
      if (!anyLoading() && anyErr().length === 0) { darkCur += 0.5; darkMax = Math.max(darkMax, darkCur); tryPlay(); }
    }
  }
  return { slidesSeen: [...slides].sort((a, b) => a - b), stuckMaxSameSlide: stuckMax, darkMax, waits, errTexts: anyErr() };
});
console.log("feed75s:", JSON.stringify(r));
await browser.close();
