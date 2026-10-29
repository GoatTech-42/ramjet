// DISCRIMINATING transition run: per-file atomic-rename cutover + full instrumentation
const puppeteer = require('puppeteer-core');
const fs = require('fs'); const crypto = require('crypto');
const { execSync } = require('child_process');
const BASE='http://127.0.0.1:14224'; const SHOTS='/tmp/fullapp/shots'; const D='/tmp/fullapp/dist-live';
const PW=fs.readFileSync('/tmp/fullapp/fixpw','utf8').trim();
const ev={timeline:[],shas:{},requests:[]}; const t0=Date.now();
const tl=s=>{ev.timeline.push({ms:Date.now()-t0,s});console.log('TL',Date.now()-t0,s);};
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0,12);
async function servedSha(path){ try{ const b=await (await fetch(BASE+path)).text(); return crypto.createHash('sha256').update(b).digest('hex').slice(0,12);}catch(e){ return 'ERR'; } }
(async()=>{
  const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:'new',
    args:['--no-sandbox','--disable-dev-shm-usage'],userDataDir:'/tmp/fullapp/chrome-t5'});
  const page=await browser.newPage(); await page.setViewport({width:1440,height:900});
  page.on('console',m=>tl('console:'+m.type()+':'+m.text().slice(0,130)));
  page.on('pageerror',e=>tl('PAGEERROR:'+String(e).slice(0,200)));
  page.on('error',e=>tl('PAGE-CRASH:'+String(e).slice(0,160)));
  page.on('framenavigated',f=>{ if(f===page.mainFrame()) tl('NAV -> '+f.url().slice(0,90)); });
  page.on('load',()=>tl('LOAD settled'));
  page.on('requestfailed',r=>ev.requests.push({ms:Date.now()-t0,fail:r.url().slice(0,110)}));
  page.on('response',r=>{const u=r.url(); if(/browse|engine|player-boot|media-bridge|404|500/.test(u)||r.status()>=400) ev.requests.push({ms:Date.now()-t0,s:r.status(),u:u.slice(0,110)});});
  const cdp=await page.createCDPSession();
  await cdp.send('Inspector.enable').catch(()=>{});
  cdp.on('Inspector.targetCrashed',()=>tl('CDP TARGET CRASHED'));
  let swScope=null;
  await cdp.send('ServiceWorker.enable').catch(()=>{});
  cdp.on('ServiceWorker.workerRegistrationUpdated',e=>{ swScope=e.registrations[0]&&e.registrations[0].scopeURL; tl('SW-reg-update '+JSON.stringify(e.registrations.map(r=>({scope:r.scopeURL})))); });
  cdp.on('ServiceWorker.workerVersionUpdated',e=>tl('SW-ver '+JSON.stringify((e.versions||[]).map(v=>({status:v.status,url:v.scriptURL&&v.scriptURL.split('/').pop()})))));
  // login + positive control on OLD dist
  await page.goto(BASE+'/login',{waitUntil:'networkidle2'});
  await page.evaluate((u,p)=>{const vis=el=>!!(el.offsetWidth||el.offsetHeight);const ins=[...document.querySelectorAll('input')].filter(vis);const pw=ins.find(i=>i.type==='password');const tx=ins.find(i=>i!==pw);const set=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};set(tx,u);set(pw,p);[...document.querySelectorAll('button')].find(b=>/log ?in|sign ?in/i.test(b.textContent)).click();},'qavis',PW);
  await new Promise(r=>setTimeout(r,2500));
  await page.goto(BASE+'/browse',{waitUntil:'networkidle2'});
  await new Promise(r=>setTimeout(r,2000));
  const submit=async()=>{ await page.evaluate(()=>{const vis=el=>!!(el.offsetWidth||el.offsetHeight);const i=[...document.querySelectorAll('input')].filter(vis).find(i=>/url|address|search|site|web/i.test((i.placeholder||'')+(i.name||'')+(i.id||'')));i.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'http://127.0.0.1:8090/');i.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('button')].find(b=>/^\s*go\s*$/i.test(b.textContent)).click();}); };
  const waitMarker=async(marker,secs)=>{let ok=false;for(let i=0;i<secs&&!ok;i++){await new Promise(r=>setTimeout(r,1000));for(const f of page.frames()){try{const t=await f.evaluate(()=>document.body?document.body.innerText:'');if(t&&t.includes(marker))ok=true;}catch(e){}}}return ok;};
  await submit(); tl('control1 OLD fixture render='+await waitMarker('RJ-QA-FIXTURE',20));
  ev.shas.preSwap={browseHtml:sha(D+'/pages/browse/browse.html'),boot:sha(D+'/a/player-boot.js'),engine:sha(D+'/assets/engine-CW3CZnKX.js'),servedBrowse:await servedSha('/pages/browse/browse.html'),servedBoot:await servedSha('/a/player-boot.js')};
  tl('preSwap shas '+JSON.stringify(ev.shas.preSwap));
  // ATOMIC PER-FILE CUTOVER: 12 replaces + 3 adds, temp+rename each, then delete 2 orphan chunks
  const files=execSync('cd /tmp/fullapp/staged && find . -type f | sed s%^./%%').toString().trim().split('\n');
  const oldOnly=['assets/engine-CW3CZnKX.js','assets/browse-B1tm1wCq.js'];
  let n=0;
  for(const f of files){ const s='/tmp/fullapp/staged/'+f, d=D+'/'+f;
    if(fs.existsSync(d)&&sha(s)===sha(d)) continue; // 59 equal untouched
    fs.mkdirSync(require('path').dirname(d),{recursive:true});
    fs.copyFileSync(s,d+'.tmp-cutover'); fs.renameSync(d+'.tmp-cutover',d); n++; }
  for(const f of oldOnly){ try{ fs.unlinkSync(D+'/'+f); }catch(e){} }
  tl('ATOMIC CUTOVER done: '+n+' files renamed per-file, 2 orphans deleted');
  ev.shas.postSwap={browseHtml:sha(D+'/pages/browse/browse.html'),boot:sha(D+'/a/player-boot.js'),engine:sha(D+'/assets/engine-CIkLOPyp.js'),servedBrowse:await servedSha('/pages/browse/browse.html'),servedBoot:await servedSha('/a/player-boot.js')};
  tl('postSwap shas '+JSON.stringify(ev.shas.postSwap));
  // same-session (NO reload): old in-memory engine + old running SW; click page-two in old frame
  let clicked=false;
  for(const f of page.frames()){ try{ clicked=await f.evaluate(()=>{const a=[...document.querySelectorAll('a')].find(a=>/page two/i.test(a.textContent)); if(a){a.click();return true} return false;}); if(clicked) break; }catch(e){} }
  tl('same-session page-two click='+clicked);
  tl('same-session PAGE2 render='+await waitMarker('RJ-QA-FIXTURE-PAGE2',15));
  await page.screenshot({path:SHOTS+'/t5-01-same-session-page2.png'}).catch(()=>{});
  // SW restart mid-session on the transition state (old page engine + SW reloaded from NEW disk bytes)
  try{ await cdp.send('ServiceWorker.stopWorker',{scopeURL:swScope||BASE+'/a/'}); tl('SW stopped (restart)'); }catch(e){ tl('stopWorker err2 '+String(e).slice(0,140)); }
  await new Promise(r=>setTimeout(r,1500));
  await submit(); tl('post-restart submit done');
  tl('post-restart fixture render='+await waitMarker('RJ-QA-FIXTURE',15));
  await page.screenshot({path:SHOTS+'/t5-02-post-restart.png'}).catch(()=>{});
  // now reload /browse (user action) and verify new engine identity + render
  await page.reload({waitUntil:'networkidle2',timeout:15000}).catch(e=>tl('reload err'));
  await new Promise(r=>setTimeout(r,3000));
  ev.shas.postReload={servedBrowse:await servedSha('/pages/browse/browse.html'),servedBoot:await servedSha('/a/player-boot.js')};
  try{ ev.postReloadEngine=await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>/engine-|player-boot|browse-[A-Z]/.test(e.name)).map(e=>e.name.split('/').pop())); }catch(e){ ev.postReloadEngine='eval-detached url='+page.url(); }
  tl('postReload engine '+JSON.stringify(ev.postReloadEngine));
  await submit(); tl('post-reload fixture render='+await waitMarker('RJ-QA-FIXTURE',15));
  await page.screenshot({path:SHOTS+'/t5-03-post-reload.png'}).catch(()=>{});
  for (const t of await browser.targets()) if (t.type()==='service_worker') { try{ const s=await t.createCDPSession();
    const r=await s.send('Runtime.evaluate',{expression:'JSON.stringify({revive:typeof reviveThenRoute})',returnByValue:true});
    tl('SW-final '+t.url().split('/').pop()+' '+JSON.stringify(r.result.value)); }catch(e){ tl('SW-final err'); } }
  fs.writeFileSync(SHOTS+'/t5-evidence.json',JSON.stringify(ev,null,2));
  tl('DONE'); process.exit(0);
})().catch(e=>{ev.fatal=String(e).slice(0,400);fs.writeFileSync(SHOTS+'/t5-evidence.json',JSON.stringify(ev,null,2));console.error('FATAL',ev.fatal);process.exit(1);});
