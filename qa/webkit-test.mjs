import { chromium } from "playwright";
const token = process.argv[2];
for (const [name, bt, ua] of [
  ["safari-ua-desktop", chromium, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"],
  ["chromium-desktop", chromium, null],
]) {
  const browser = await bt.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(ua ? { userAgent: ua } : {}) });
  await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "networkidle" });
  await page.fill(".bar input", "big buck bunny");
  await page.click(".bar button");
  await page.waitForSelector(".row img", { timeout: 15000 });
  await page.click(".row");
  await page.waitForSelector(".frame video", { timeout: 20000 });
  await page.waitForTimeout(6000);
  const info = await page.evaluate(() => {
    const v = document.querySelector(".frame video");
    return { src: v?.currentSrc?.split("?")[0].split("/").pop(), time: v?.currentTime ?? -1, err: v?.error?.code ?? null };
  });
  await page.screenshot({ path: `qa/shots/ua-${name}.png` });
  console.log(name, JSON.stringify(info));
  await browser.close();
}
