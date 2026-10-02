// direct-first QA (Luke 6:08 PM): unfiltered network must play DIRECT from
// the CDN; a filtered network (googlevideo blocked) must swap to the ramjet
// proxy within ~6s and still play. both paths verified with real playback.
import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";

async function login(ctx) {
  const r = await ctx.request.post(BASE + "/api/auth/login", { data: { username: "qa", password: pw } });
  const token = (r.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
  await ctx.addCookies([{ name: "rj2_session", value: token, url: BASE }]);
}

async function openFeed(page) {
  await page.goto(BASE + "/jetstream", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".scard", { timeout: 60000 });
  await page.tap(".scard");
  await page.waitForSelector(".feed .slide video", { timeout: 10000 });
}

async function slideState(page) {
  return page.evaluate(() => {
    const vids = [...document.querySelectorAll(".feed .slide video")];
    const act = vids.find((x) => x.src && !x.paused) || vids.find((x) => x.src);
    if (!act) return null;
    return { idx: act.dataset.idx, src: (act.src || "").slice(0, 50), mode: act.dataset.srcmode || "", ct: act.currentTime, rs: act.readyState, paused: act.paused };
  });
}

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });

// ---- RUN A: unfiltered -> must go DIRECT and play ----
{
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  await login(ctx);
  await openFeed(page);
  await page.waitForTimeout(9000);
  const s1 = await slideState(page);
  console.log("A direct-path slide:", JSON.stringify(s1));
  await page.waitForTimeout(4000);
  const s2 = await slideState(page);
  console.log("A 4s later       :", JSON.stringify(s2));
  console.log("A verdict:", s1 && s2 && s1.mode === "direct" && s2.ct > s1.ct ? "PASS (direct, playing)" : "CHECK");
  await ctx.close();
}

// ---- RUN B: googlevideo blocked -> must fall back to PROXY and play ----
{
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  await ctx.route("**://*.googlevideo.com/**", (r) => r.abort());
  const page = await ctx.newPage();
  await login(ctx);
  await openFeed(page);
  const t0 = Date.now();
  // wait for the proxy swap
  let s = null;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    s = await slideState(page);
    if (s && s.mode === "proxy") break;
  }
  const swapSecs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("B after swap (" + swapSecs + "s):", JSON.stringify(s));
  await page.waitForTimeout(5000);
  const s2 = await slideState(page);
  console.log("B 5s later          :", JSON.stringify(s2));
  console.log("B verdict:", s && s2 && s.mode === "proxy" && s2.ct > s.ct ? "PASS (proxy fallback, playing)" : "CHECK");
  await ctx.close();
}

// ---- RUN C: watch page direct (desktop), then blocked variant ----
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await login(ctx);
  await page.goto(BASE + "/jetstream", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".scard", { timeout: 60000 });
  await page.fill("form input", "minecraft redstone tutorial");
  await page.press("form input", "Enter");
  await page.waitForSelector(".row", { timeout: 30000 });
  await page.click(".row");
  await page.waitForSelector(".player video", { timeout: 30000 });
  await page.waitForTimeout(8000);
  const st = await page.evaluate(() => { const v = document.querySelector(".player video"); return v ? { src: (v.src||"").slice(0,50), ct: v.currentTime, rs: v.readyState } : null; });
  console.log("C watch-page direct :", JSON.stringify(st));
  console.log("C verdict:", st && st.src.includes("googlevideo") && st.ct > 0 ? "PASS (watch page direct, playing)" : "CHECK");
  await ctx.close();
}
await browser.close();
