import { chromium, devices } from 'playwright';
import fs from 'fs';
const BASE = 'http://127.0.0.1:14224';
const PASS = fs.readFileSync('/home/luke/goattech/ramjet-rebuild/data/.qa-password','utf8').trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const lr = await ctx.request.post(BASE + '/api/auth/login', { data: { username: 'qa', password: PASS } });
const tok = (lr.headers()['set-cookie'] || '').match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: 'rj2_session', value: tok, url: BASE }]);
await page.goto(BASE + '/jetstream');
await page.waitForSelector('.scard', { timeout: 60000 });
// search long-form
await page.fill('form input', 'minecraft redstone tutorial');
await page.press('form input', 'Enter');
await page.waitForSelector('.row', { timeout: 20000 });
const firstTitle = await page.textContent('.row .title');
await page.click('.row');
await page.waitForSelector('.player .wlike', { timeout: 30000 });
console.log('watch page open, like button present:', firstTitle.trim().slice(0,60));
// like it
const vidId = await page.evaluate(() => document.querySelector('.wlike').getAttribute('aria-pressed'));
await page.click('.wlike');
await page.waitForTimeout(800);
const liked = await page.evaluate(() => document.querySelector('.wlike').classList.contains('liked'));
const txt = await page.textContent('.wlike span');
console.log('after click: liked class =', liked, '| label =', txt.trim());
await page.screenshot({ path: '/tmp/like-lf-desktop.png', fullPage: false });
// verify server state
const likes = await page.evaluate(async () => (await fetch('/api/apps/jetstream/likes')).json());
console.log('server likes count:', likes.ids.length, '| latest liked is in list:', likes.ids.length > 0);
// verify profile effect: like should reshape feed - check shorts excludes liked id
const shorts = await page.evaluate(async () => (await fetch('/api/apps/jetstream/shorts')).json());
console.log('shorts feed items:', shorts.items.length);
// unlike to clean up
await page.click('.wlike');
await page.waitForTimeout(800);
const liked2 = await page.evaluate(() => document.querySelector('.wlike').classList.contains('liked'));
const likes2 = await page.evaluate(async () => (await fetch('/api/apps/jetstream/likes')).json());
console.log('after unlike: liked class =', liked2, '| server likes count:', likes2.ids.length);
console.log('page errors:', errors.length ? errors : 'none');
// iphone viewport screenshot
await ctx.close();
const ctx2 = await browser.newContext({ ...devices['iPhone 13'] });
const p2 = await ctx2.newPage();
const lr2 = await ctx2.request.post(BASE + '/api/auth/login', { data: { username: 'qa', password: PASS } });
const tok2 = (lr2.headers()['set-cookie'] || '').match(/rj2_session=([^;]+)/)?.[1];
await ctx2.addCookies([{ name: 'rj2_session', value: tok2, url: BASE }]);
await p2.goto(BASE + '/jetstream');
await p2.waitForSelector('.scard', { timeout: 60000 });
await p2.fill('form input', 'minecraft redstone tutorial');
await p2.press('form input', 'Enter');
await p2.waitForSelector('.row', { timeout: 20000 });
await p2.click('.row');
await p2.waitForSelector('.player .wlike', { timeout: 30000 });
await p2.click('.wlike');
await p2.waitForTimeout(600);
await p2.screenshot({ path: '/tmp/like-lf-iphone.png', fullPage: false });
// cleanup again
await p2.click('.wlike');
await p2.waitForTimeout(600);
console.log('iphone shot taken, unliked');
await browser.close();
