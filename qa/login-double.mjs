import { chromium, devices } from 'playwright';import { readFileSync } from 'fs';
const BASE='http://127.0.0.1:14224', PW=readFileSync('/home/luke/goattech/ramjet-rebuild/data/.qa-password','utf8').trim();
for(const [name,dev] of [['iphone',devices['iPhone 13']],['desktop',null]]){
 const browser=await chromium.launch(),page=await (await browser.newContext(dev||{viewport:{width:1280,height:800}})).newPage();let posts=0,errs=[];page.on('request',r=>{if(r.url().endsWith('/api/auth/login')&&r.method()==='POST')posts++});page.on('pageerror',e=>errs.push(String(e)));
 await page.goto(BASE+'/login');await page.locator('input').nth(0).fill('qa');await page.locator('input').nth(1).fill(PW);
 await page.evaluate(()=>{const form=document.querySelector('form');form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 await page.waitForURL(BASE+'/',{timeout:9000});await page.waitForTimeout(400);
 console.log(name,'posts',posts,'hubRows',await page.locator('a.row').count(),'pageerrors',errs.length);if(posts!==1)throw Error('duplicate login POST');await browser.close();
}
