import { chromium, devices } from 'playwright';
import { readFileSync } from 'fs';
const pw = readFileSync('../data/.qa-password', 'utf8').trim();
const BASE = 'http://127.0.0.1:14224';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
const r = await ctx.request.post(BASE + '/api/auth/login', { data: { username: 'qa', password: pw } });
const token = (r.headers()['set-cookie'] || '').match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: 'rj2_session', value: token, url: BASE }]);
await page.goto(BASE + '/jetstream', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.hcard', { timeout: 60000 });
// subs page
await page.tap('.subs-link');
await page.waitForTimeout(2000);
const subsState = await page.evaluate(() => ({
  h1: document.querySelector('.subspage h1')?.textContent || '',
  rows: document.querySelectorAll('.subrow').length,
  empty: document.querySelector('.subspage .empty')?.textContent || '',
}));
await page.screenshot({ path: '/tmp/subs-page.png' });
await page.evaluate(() => window.scrollTo(0, 0));
const back = await page.$('.subspage .backbtn');
if (back) await back.tap();
await page.waitForTimeout(1500);
// infinite for-you: scroll to the bottom, count cards before/after
const before = await page.evaluate(() => document.querySelectorAll('.fygrid .hcard').length);
for (let i = 0; i < 8; i++) { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(900); }
const after = await page.evaluate(() => document.querySelectorAll('.fygrid .hcard').length);
console.log(JSON.stringify({ subsState, forYou: { before, after } }));
await browser.close();
