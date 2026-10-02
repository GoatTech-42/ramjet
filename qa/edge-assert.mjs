import { chromium, devices } from 'playwright';
import { readFileSync } from 'fs';
const PW=readFileSync('/home/luke/goattech/ramjet-rebuild/data/.qa-password','utf8').trim(),BASE='http://127.0.0.1:14224';
for (const [name,dev] of [['iphone',devices['iPhone 13']],['desktop',null]]) {
 const browser=await chromium.launch(); const ctx=await browser.newContext(dev||{viewport:{width:1280,height:800}});const page=await ctx.newPage();
 let errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(BASE+'/login');await page.locator('input').nth(0).fill('qa');await page.locator('input').nth(1).fill(PW);await page.locator('button[type=submit]').click();await page.waitForURL(BASE+'/',{timeout:9000});
 for (const app of ['jetstream','amp']) { await page.goto(BASE+'/'+app);const huge='x'.repeat(8192);await page.locator('input').fill(huge);const response=page.waitForResponse(r=>r.url().includes(`/api/apps/${app}/search`));await page.locator('input').press('Enter');let r=await response;await page.waitForTimeout(300);let text=await page.locator(app==='amp'?'.error':'.err').first().textContent();console.log(name,app,r.status(),JSON.stringify(text));if(r.status()!==400||!text.includes('under 120'))throw Error('bad oversize UX'); }
 await page.goto(BASE+'/sage');const textarea=page.locator('.composer textarea');await textarea.fill('x'.repeat(8192));await textarea.press('Enter');await page.waitForTimeout(250);let msg=await page.locator('.error').textContent(),draft=await textarea.inputValue(),count=await page.locator('.msg.mine').count();console.log(name,'sage',JSON.stringify(msg),'draft-kept',draft.length,'messages',count);if(!msg.includes('under 4,000')||draft.length!==8192||count!==0)throw Error('sage oversize UX');
 // server protects direct API calls too, with no provider call
 const raw=await page.evaluate(async huge=>{let r=await fetch('/api/apps/sage/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:huge}]})});return {status:r.status,text:await r.text()};},'x'.repeat(8192));console.log(name,'sage API',raw.status,raw.text.slice(0,120));if(raw.status!==400)throw Error('server accepted overlong turn');
 console.log(name,'pageerrors',errors.length);await page.screenshot({path:`/tmp/qa-sage-oversize-${name}.png`});await browser.close();
}
