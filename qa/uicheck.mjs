import { chromium, devices } from 'playwright';
import { readFileSync } from 'fs';
const pw = readFileSync('../data/.qa-password', 'utf8').trim();
const BASE = 'http://127.0.0.1:14224';
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
const r = await ctx.request.post(BASE + '/api/auth/login', { data: { username: 'qa', password: pw } });
const token = (r.headers()['set-cookie'] || '').match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: 'rj2_session', value: token, url: BASE }]);
await page.goto(BASE + '/jetstream', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.scard', { timeout: 60000 });
await page.tap('.scard');
await page.waitForSelector('.feed .slide video', { timeout: 10000 });
await page.waitForTimeout(5000);
const barGone = await page.evaluate(() => !document.querySelector('.feed-search'));
const btnThere = await page.evaluate(() => !!document.querySelector('.feed-search-btn'));
await page.screenshot({ path: '/tmp/feed-nobar.png' });
const chanBtn = await page.$('button.slide-chan');
if (chanBtn) {
  await chanBtn.tap();
  await page.waitForTimeout(9000);
  const state = await page.evaluate(() => ({
    feedOpen: !!document.querySelector('.feed'),
    h1: document.querySelector('h1')?.textContent || '',
    cards: document.querySelectorAll('.vcard, .scard').length,
  }));
  console.log('after channel tap:', JSON.stringify(state));
  await page.screenshot({ path: '/tmp/chan-from-short.png' });
} else console.log('NO channel button on slide');
console.log(JSON.stringify({ barGone, btnThere }));
await browser.close();
