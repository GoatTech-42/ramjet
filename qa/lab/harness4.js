// SW-restart mid-session revive test: candidate fix vs known old 404-restart failure
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const BASE='http://127.0.0.1:14224'; const SHOTS='/tmp/fullapp/shots';
const PW=fs.readFileSync('/tmp/fullapp/fixpw','utf8').trim();
const mode=process.argv[2]||'new'; // 'new' = candidate dist, 'old' = old bytes
const ev={mode,timeline:[]}; const t0=Date.now();
const tl=s=>{ev.timeline.push({ms:Date.now()-t0,s});console.log('TL',Date.now()-t0,s);};
(async()=>{
  const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:'new',
    args:['--no-sandbox','--disable-dev-shm-usage'],userDataDir:'/tmp/fullapp/chrome-t4-'+mode});
  const page=await browser.newPage(); await page.setViewport({width:1440,height:900});
  page.on('console',m=>tl('console:'+m.type()+':'+m.text().slice(0,140)));
  page.on('pageerror',e=>tl('pageerror:'+String(e).slice(0,140)));
  await page.goto(BASE+'/login',{waitUntil:'networkidle2'});
  await page.evaluate((u,p)=>{const vis=el=>!!(el.offsetWidth||el.offsetHeight);const ins=[...document.querySelectorAll('input')].filter(vis);const pw=ins.find(i=>i.type==='password');const tx=ins.find(i=>i!==pw);const set=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};set(tx,u);set(pw,p);[...document.querySelectorAll('button')].find(b=>/log ?in|sign ?in/i.test(b.textContent)).click();},'qavis',PW);
  await new Promise(r=>setTimeout(r,2500));
  await page.goto(BASE+'/browse',{waitUntil:'networkidle2'});
  await new Promise(r=>setTimeout(r,2000));
  await page.evaluate(()=>{const vis=el=>!!(el.offsetWidth||el.offsetHeight);const i=[...document.querySelectorAll('input')].filter(vis).find(i=>/url|address|search|site|web/i.test((i.placeholder||'')+(i.name||'')+(i.id||'')));i.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'http://127.0.0.1:8090/');i.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('button')].find(b=>/^\s*go\s*$/i.test(b.textContent)).click();});
  let ok=false; for(let i=0;i<20&&!ok;i++){await new Promise(r=>setTimeout(r,1000));for(const f of page.frames()){try{const t=await f.evaluate(()=>document.body?document.body.innerText:'');if(t&&t.includes('RJ-QA-FIXTURE'))ok=true;}catch(e){}}}
  tl('control render='+ok);
  const cdp=await page.createCDPSession();
  await cdp.send('ServiceWorker.enable');
  let vid=null;
  cdp.on('ServiceWorker.workerVersionUpdated',e=>{ for(const v of (e.versions||[])) if(v.status==='activated') vid=v.versionId; });
  await new Promise(r=>setTimeout(r,1200));
  // stop the worker = simulated SW restart (the production failure condition)
  try{ await cdp.send('ServiceWorker.stopWorker',{scopeURL:BASE+'/a/',versionId:String(vid)}); tl('SW STOPPED (simulated restart), versionId='+vid); }
  catch(e){ tl('stopWorker err '+String(e).slice(0,140)); }
  await new Promise(r=>setTimeout(r,1500));
  // same-session controller nav: click the fixture link inside the controlled frame
  let clicked=false;
  for(const f of page.frames()){ try{ clicked=await f.evaluate(()=>{const a=[...document.querySelectorAll('a')].find(a=>/page two/i.test(a.textContent)); if(a){a.click();return true} return false;}); if(clicked) break; }catch(e){} }
  tl('page-two click='+clicked);
  let ok2=false, body='';
  for(let i=0;i<20&&!ok2;i++){await new Promise(r=>setTimeout(r,1000));for(const f of page.frames()){try{const t=await f.evaluate(()=>document.body?document.body.innerText:'');if(t&&t.includes('RJ-QA-FIXTURE-PAGE2'))ok2=true; if(t&&t.trim().length>0&&t.trim().length<400)body=t.trim();}catch(e){}}}
  tl('PAGE2 after SW restart render='+ok2+' body='+JSON.stringify(body.slice(0,200)));
  await page.screenshot({path:SHOTS+'/t4-'+mode+'-after-restart-nav.png'}).catch(()=>{});
  // retry once (user hitting the link again after the error)
  let clicked2=false;
  for(const f of page.frames()){ try{ clicked2=await f.evaluate(()=>{const a=[...document.querySelectorAll('a')].find(a=>/page two/i.test(a.textContent)); if(a){a.click();return true} return false;}); if(clicked2) break; }catch(e){} }
  if(!clicked2){ try{ await page.reload({waitUntil:'domcontentloaded'}); await new Promise(r=>setTimeout(r,3000)); await page.evaluate(()=>{const vis=el=>!!(el.offsetWidth||el.offsetHeight);const i=[...document.querySelectorAll('input')].filter(vis).find(i=>/url|address|search|site|web/i.test((i.placeholder||'')+(i.name||'')+(i.id||'')));i.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'http://127.0.0.1:8090/page2.html');i.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('button')].find(b=>/^\s*go\s*$/i.test(b.textContent)).click();}); tl('retry via page reload + direct page2 submit'); }catch(e){ tl('retry err '+String(e).slice(0,100)); } }
  let ok3=false, body3='';
  for(let i=0;i<15&&!ok3;i++){await new Promise(r=>setTimeout(r,1000));for(const f of page.frames()){try{const t=await f.evaluate(()=>document.body?document.body.innerText:'');if(t&&t.includes('RJ-QA-FIXTURE-PAGE2'))ok3=true; if(t&&t.trim().length>0&&t.trim().length<400)body3=t.trim();}catch(e){}}}
  tl('RETRY render='+ok3+' body='+JSON.stringify(body3.slice(0,160)));
  await page.screenshot({path:SHOTS+'/t4-'+mode+'-retry.png'}).catch(()=>{});
  for (const t of await browser.targets()) if (t.type()==='service_worker') { try{ const s=await t.createCDPSession();
    const r=await s.send('Runtime.evaluate',{expression:'JSON.stringify({revive:typeof reviveThenRoute,state:self.registration&&self.registration.active&&self.registration.active.state})',returnByValue:true});
    tl('SW-final '+JSON.stringify(r.result.value)); }catch(e){ tl('SW-final err'); } }
  fs.writeFileSync(SHOTS+'/t4-'+mode+'-evidence.json',JSON.stringify(ev,null,2));
  tl('DONE'); process.exit(0);
})().catch(e=>{ev.fatal=String(e);fs.writeFileSync(SHOTS+'/t4-'+mode+'-evidence.json',JSON.stringify(ev,null,2));console.error('FATAL',String(e).slice(0,300));process.exit(1);});
