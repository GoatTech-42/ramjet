import { chromium, devices } from "playwright";
const BASE = "http://127.0.0.1:14224";
for (const [name, dev] of [["iphone", devices["iPhone 13"]], ["desktop", { viewport: { width: 1280, height: 800 } }]]) {
  const browser = await chromium.launch();
  const page = await (await browser.newContext(dev)).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  await page.goto(BASE + "/login");
  const inputs = await page.$$("input");
  await inputs[0].fill("qatmp"); await inputs[1].fill("tmppass123");
  await page.click("button[type=submit], button");
  await page.waitForURL(BASE + "/", { timeout: 8000 });
  const rows = await page.$$eval("main a", (els) => els.length);
  const results = ["hub links=" + rows];
  for (const app of ["browse", "jetstream", "amp", "sage", "settings"]) {
    await page.goto(BASE + "/" + app);
    await page.waitForTimeout(1200);
    const title = await page.evaluate(() => document.body.textContent.replace(/\s+/g, " ").slice(0, 40));
    results.push(app + "=\"" + title.trim() + "\"");
  }
  await page.screenshot({ path: "/tmp/qa-fresh-" + name + ".png" });
  console.log(name, "|", results.join(" | "), "| pageerrors:", errs.length ? errs.join(";") : "none");
  await browser.close();
}
