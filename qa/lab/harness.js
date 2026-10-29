const puppeteer = require('puppeteer-core');
const fs = require('fs');
const BASE = 'http://127.0.0.1:14224';
const SHOTS = '/tmp/fullapp/shots';
const PW = fs.readFileSync('/tmp/fullapp/fixpw','utf8').trim();
const mode = process.argv[2] || 'desktop';
const vp = mode === 'mobile'
  ? {width:390, height:844, isMobile:true, hasTouch:true, deviceScaleFactor:2}
  : {width:1440, height:900, deviceScaleFactor:1};
const ev = {mode, console:[], pageerrors:[], requestfailed:[], steps:[], sw:{}, engine:{}, frames:[]};
const P = n => `${SHOTS}/${mode}-${n}.png`;
function logStep(s){ ev.steps.push({t:new Date().toISOString(), s}); console.log('STEP', s); }
(async()=>{
  const browser = await puppeteer.launch({executablePath:'/usr/bin/google-chrome', headless:'new',
    args:['--no-sandbox','--disable-dev-shm-usage','--window-size='+vp.width+','+vp.height],
    userDataDir:`/tmp/fullapp/chrome-${mode}`});
  const page = await browser.newPage();
  await page.setViewport(vp);
  page.on('console', m=>ev.console.push({type:m.type(), text:m.text().slice(0,300)}));
  page.on('pageerror', e=>ev.pageerrors.push(String(e).slice(0,300)));
  page.on('requestfailed', r=>ev.requestfailed.push({url:r.url().slice(0,200), err:r.failure()&&r.failure().errorText}));
  ev.responses=[]; page.on('response', r=>{const u=r.url(); if(/\/api\//.test(u)) ev.responses.push({s:r.status(), u:u.slice(0,140)});});
  // 1 login page
  await page.goto(BASE+'/login', {waitUntil:'networkidle2', timeout:20000});
  await page.screenshot({path:P('01-login')});
  logStep('login page loaded: '+page.url());
  // adaptive form fill
  const filled = await page.evaluate((u,p)=>{
    const vis = el => !!(el.offsetWidth||el.offsetHeight||el.getClientRects().length);
    const inputs=[...document.querySelectorAll('input')].filter(vis);
    const pw=inputs.find(i=>i.type==='password');
    const txt=inputs.find(i=>i!==pw && ['text','','email'].includes(i.type||''));
    if(!pw||!txt) return {ok:false, inputs:inputs.map(i=>({name:i.name,type:i.type,id:i.id}))};
    const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; d.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));};
    set(txt,u); set(pw,p); return {ok:true};
  }, 'qavis', PW);
  logStep('form fill: '+JSON.stringify(filled));
  await Promise.all([
    page.waitForNavigation({waitUntil:'networkidle2', timeout:15000}).catch(e=>'nav-timeout'),
    page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(b=>/log ?in|sign ?in|continue|enter/i.test(b.textContent)); (b||document.querySelector('button')).click();})
  ]);
  await new Promise(r=>setTimeout(r,1500));
  await page.screenshot({path:P('02-after-login')});
  logStep('after login url: '+page.url());
  const hubStamp = await page.evaluate(()=>document.body.innerText.match(/b732600|candidate-b732600|RAMJET_SOURCE_SHA[^\\n]{0,60}/g));
  logStep('hub stamp: '+JSON.stringify(hubStamp));
  // settings
  await page.goto(BASE+'/settings', {waitUntil:'networkidle2', timeout:15000});
  await page.screenshot({path:P('03-settings')});
  const setStamp = await page.evaluate(()=>document.body.innerText.match(/b732600|candidate-b732600/g));
  logStep('settings stamp: '+JSON.stringify(setStamp));
  // browse
  await page.goto(BASE+'/browse', {waitUntil:'networkidle2', timeout:15000});
  await new Promise(r=>setTimeout(r,2500));
  await page.screenshot({path:P('04-browse-empty')});
  ev.sw = await page.evaluate(async()=>{
    const regs = await navigator.serviceWorker.getRegistrations();
    return {controller: navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL,
      regs: regs.map(r=>({scope:r.scope, active:r.active&&{url:r.active.scriptURL,state:r.active.state},
        waiting:r.waiting&&{url:r.waiting.scriptURL,state:r.waiting.state}, installing:r.installing&&{url:r.installing.scriptURL,state:r.installing.state}}))};
  });
  logStep('sw: '+JSON.stringify(ev.sw));
  // SW internals via CDP
  const targets = await browser.targets();
  for (const t of targets) if (t.type()==='service_worker') {
    try { const s = await t.createCDPSession();
      const r = await s.send('Runtime.evaluate',{expression:'JSON.stringify({revive: typeof reviveThenRoute, url: location.href})', returnByValue:true});
      ev.sw[t.url()] = r.result.value; } catch(e){ ev.sw[t.url()]='err:'+e; }
  }
  // engine identity from resource timings
  ev.engine.beforeNav = await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>/engine-|player-boot/.test(e.name)).map(e=>e.name));
  // submit fixture URL in browse address bar
  const addrFound = await page.evaluate(()=>{
    const vis = el => !!(el.offsetWidth||el.offsetHeight||el.getClientRects().length);
    const i=[...document.querySelectorAll('input')].filter(vis).find(i=>/url|address|search|site|web/i.test((i.placeholder||'')+(i.name||'')+(i.id||''))) || [...document.querySelectorAll('input')].filter(vis)[0];
    if(!i) return false;
    i.focus(); const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    d.call(i,'http://127.0.0.1:8090/'); i.dispatchEvent(new Event('input',{bubbles:true}));
    return (i.placeholder||i.name||i.id||'input'); });
  logStep('address input: '+JSON.stringify(addrFound));
  if(addrFound){
    const goClicked = await page.evaluate(()=>{ const vis=el=>!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length);
      const b=[...document.querySelectorAll('button')].filter(vis).find(b=>/^\s*go\s*$/i.test(b.textContent));
      if(b){b.click(); return 'go-button';} return null; });
    logStep('go click: '+goClicked);
    if(!goClicked) await page.keyboard.press('Enter');
    ev.allRespAfterGo=[]; page.on('response', r=>ev.allRespAfterGo.push({s:r.status(),u:r.url().slice(0,120)}));
    let markerOk=false;
    for (let i=0;i<24 && !markerOk;i++){ await new Promise(r=>setTimeout(r,1000));
      for (const f of page.frames()){ try{ const t=await f.evaluate(()=>document.body?document.body.innerText:''); if(t&&t.includes('RJ-QA-FIXTURE')) markerOk=true; }catch(e){} }
      if (page.url().includes('RJ-QA') ) markerOk=true; }
    logStep('marker wait result: '+markerOk);
    ev.swAfter = await page.evaluate(async()=>{ const regs=await navigator.serviceWorker.getRegistrations();
      return {controller: navigator.serviceWorker.controller&&navigator.serviceWorker.controller.scriptURL,
        regs: regs.map(r=>({scope:r.scope, active:r.active&&{url:r.active.scriptURL,state:r.active.state}, waiting:r.waiting&&{url:r.waiting.scriptURL,state:r.waiting.state}}))}; });
    for (const t of await browser.targets()) if (t.type()==='service_worker') { try{ const s=await t.createCDPSession();
      const r=await s.send('Runtime.evaluate',{expression:'JSON.stringify({revive: typeof reviveThenRoute, url: location.href})', returnByValue:true});
      ev.swAfter[t.url()]=r.result.value; }catch(e){ ev.swAfter[t.url()]='err:'+e; } }
    await page.screenshot({path:P('05-browse-fixture')});
    ev.frames = await Promise.all(page.frames().map(async f=>{
      let marker=null; try{ marker = await f.evaluate(()=>document.body?document.body.innerText.slice(0,200):null);}catch(e){}
      return {url:f.url(), marker}; }));
    logStep('frames: '+JSON.stringify(ev.frames.map(f=>({url:f.url, has:(f.marker||'').includes('RJ-QA-FIXTURE')}))));
    ev.engine.afterNav = await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>/engine-|player-boot/.test(e.name)).map(e=>e.name)).catch(e=>String(e));
  }
  if (mode==='transition') {
    logStep('SWAPPING dist to candidate bytes');
    const { execSync } = require('child_process');
    execSync('rm -rf /tmp/fullapp/dist-live && cp -r /tmp/fullapp/staged /tmp/fullapp/dist-live');
    ev.swapDone = true;
    await page.goto(BASE+'/browse', {waitUntil:'networkidle2', timeout:15000}).catch(e=>logStep('reload err '+e));
    await new Promise(r=>setTimeout(r,4000));
    await page.screenshot({path:P('06-after-swap-browse')});
    ev.swPostSwap = await page.evaluate(async()=>{ const regs=await navigator.serviceWorker.getRegistrations();
      return {controller: navigator.serviceWorker.controller&&navigator.serviceWorker.controller.scriptURL,
        regs: regs.map(r=>({scope:r.scope, active:r.active&&{url:r.active.scriptURL,state:r.active.state}, waiting:r.waiting&&{url:r.waiting.scriptURL,state:r.waiting.state}, installing:r.installing&&{url:r.installing.scriptURL,state:r.installing.state}}))}; });
    logStep('swPostSwap: '+JSON.stringify(ev.swPostSwap)); fs.writeFileSync(`${SHOTS}/${mode}-evidence.json`, JSON.stringify(ev,null,2));
    for (const t of await browser.targets()) if (t.type()==='service_worker') { try{ const s=await t.createCDPSession();
      const r=await s.send('Runtime.evaluate',{expression:'JSON.stringify({revive: typeof reviveThenRoute, url: location.href})', returnByValue:true});
      ev.swPostSwap[t.url()]=r.result.value; }catch(e){ ev.swPostSwap[t.url()]='err:'+e; } }
    // served bytes identity: what does /browse reference now, and what engine did the page load
    try{ ev.postSwapEngine = await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>/engine-|player-boot|browse-/.test(e.name)).map(e=>e.name)); }catch(e){ ev.postSwapEngine='detached: '+e; }
    try{ ev.postSwapServed = await page.evaluate(async()=>{ const h=await (await fetch('/pages/browse/browse.html')).text();
      return {engine:(h.match(/engine-[A-Za-z0-9_-]+/)||[])[0]||null, browse:(h.match(/browse-[A-Za-z0-9_-]+\.js/)||[])[0]||null}; }); }catch(e){ ev.postSwapServed='detached: '+e; }
    // does the same-session nav still render after swap
    let addr2=false;
    for (let att=0; att<3 && !addr2; att++){ try{ addr2 = await page.evaluate(()=>{ const vis=el=>!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length);
      const i=[...document.querySelectorAll('input')].filter(vis).find(i=>/url|address|search|site|web/i.test((i.placeholder||'')+(i.name||'')+(i.id||'')));
      if(!i) return false; i.focus(); const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      d.call(i,'http://127.0.0.1:8090/'); i.dispatchEvent(new Event('input',{bubbles:true})); return true; }); }catch(e){ logStep('addr2 attempt '+att+' detached'); await new Promise(r=>setTimeout(r,3000)); } }
    if (addr2) { let g2=false; try{ g2 = await page.evaluate(()=>{ const b=[...document.querySelectorAll('button')].find(b=>/^\s*go\s*$/i.test(b.textContent)); if(b){b.click();return true} return false; }); }catch(e){}
      if(!g2) try{ await page.keyboard.press('Enter'); }catch(e){}
      let ok2=false; for (let i=0;i<14 && !ok2;i++){ await new Promise(r=>setTimeout(r,1000));
        for (const f of page.frames()){ try{ const t=await f.evaluate(()=>document.body?document.body.innerText:''); if(t&&t.includes('RJ-QA-FIXTURE')) ok2=true; if(t&&/failed to load|isn.t ready|error/i.test(t)) ev.postSwapErrText=t.slice(0,200); }catch(e){} } }
      ev.postSwapMarker = ok2; logStep('post-swap marker: '+ok2);
      await page.screenshot({path:P('07-post-swap-fixture')});
    }
  }
  fs.writeFileSync(`${SHOTS}/${mode}-evidence.json`, JSON.stringify(ev,null,2));
  try{await browser.close();}catch(e){}
  logStep('DONE');
})().catch(e=>{ ev.fatal=String(e); try{fs.writeFileSync(`${SHOTS}/${mode}-evidence.json`,JSON.stringify(ev,null,2))}catch(_){} console.error('FATAL',e); process.exit(1); });
