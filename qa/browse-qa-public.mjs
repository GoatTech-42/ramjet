import { chromium } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const browser = await chromium.launch();

async function run(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 150)));
  const login = await page.request.post("https://server.lukeevanson.com:4201/api/auth/login", { data: { username: "qa", password: pw } });
  const sc = login.headers()["set-cookie"] || "";
  const token = sc.match(/rj2_session=([^;]+)/)?.[1];
  await page.context().addCookies([{ name: "rj2_session", value: token, url: "https://server.lukeevanson.com:4201" }]);
  await page.goto("https://server.lukeevanson.com:4201/browse", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(7000);
  const boot = await page.evaluate(() => document.querySelector(".dim")?.textContent || "");
  console.log(name, "BOOT:", boot);
  await page.screenshot({ path: `shots/browsepub-${name}-home.png` });
  await page.fill("header input", "en.wikipedia.org/wiki/Minecraft");
  await page.click("button.go");
  await page.waitForTimeout(16000);
  const t = await page.evaluate(() => { try { return document.querySelector("iframe").contentDocument?.title } catch (e) { return "guard: " + e.message.slice(0, 50) } });
  console.log(name, "FRAME TITLE:", t);
  console.log(name, "ERRS:", JSON.stringify(errs.slice(0, 3)));
  await page.screenshot({ path: `shots/browsepub-${name}-wiki.png` });
  await page.close();
}
await run("desktop", { width: 1280, height: 800 });
await run("mobile", { width: 390, height: 844 });
await browser.close();
