// usage: node gen.js <r32-amp-addon.js> [casesDir=cases] [outDir=golden]
// Runs the r32 source's own ymSearch/scSearch/auSearch over each case input and writes the exact
// JSON.stringify output. Point casesDir at captured live payloads (same {yt|sc|au} shape) to regenerate.
const fs=require('fs'),path=require('path');
let src=fs.readFileSync(process.argv[2],'utf8').replace(/^import .*$/mg,'').replace('export async function register','async function register').replace(/new URL\([^;]*import\.meta\.url\)/g,"'x'").replace(/fileURLToPath\(('x')\)/g,"'x'");
const cdir=process.argv[3]||'cases', odir=process.argv[4]||'golden';
fs.mkdirSync(odir,{recursive:true});
const load=(FIX)=>new Function('FIX',"const promisify=f=>f,execFile=null,randomBytes=null,readJson=null,writeJson=null,readBody=null,fileURLToPath=x=>x;"+src+
 "\n;scFetchJson=async()=>FIX.sc;globalThis.fetch=async(u)=>({ok:true,status:200,json:async()=>String(u).includes('music.youtube')?FIX.yt:FIX.au});\nreturn {yt:ymSearch,sc:scSearch,au:auSearch};")(FIX);
(async()=>{let n=0;
 for(const f of fs.readdirSync(cdir).filter(f=>f.endsWith('.json')).sort()){
  const c=JSON.parse(fs.readFileSync(path.join(cdir,f),'utf8')); const fn=load(c); const name=f.replace(/\.json$/,'');
  for(const k of ['yt','sc','au']) if(k in c){
    let out; try{ out=JSON.stringify(await fn[k]('q')); }catch(e){ out='THROW'; }
    fs.writeFileSync(path.join(odir,name+'.'+k+'.json'),out===undefined?'undefined':out); n++; }
 } console.log(n,'goldens'); })();
