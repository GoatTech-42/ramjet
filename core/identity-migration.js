// Stopped-only account migration. No live handler calls this module.
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, existsSync, statSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { readJson } from './util.js';

export const ACCOUNT_STORES = ['users','guard','user-prefs','amp-playlists','browse-bookmarks','browse-sync','sage-conversations','jetstream-history','jetstream-likes','jetstream-dislikes','jetstream-subs','jetstream-settings'];
const has = (o,k) => Object.hasOwn(o,k);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = v => v && typeof v==='object' && !Array.isArray(v);
function moveKey(map, oldName, newName) {
  if(!object(map))throw new Error('invalid identity map');
  if(has(map,newName))throw new Error('destination identity already has stored data');
  if(has(map,oldName)){map[newName]=map[oldName];delete map[oldName];}
}
function migrateChat(state, oldName, newName) {
  if(!object(state)||!object(state.rooms))throw new Error('invalid chat state');
  for(const k of ['friends','reqs','reads','codes']){if(!object(state[k]))throw new Error('invalid chat identity map');moveKey(state[k],oldName,newName);}
  const change=v=>v===oldName?newName:v;
  for(const room of Object.values(state.rooms)){
    if(!Array.isArray(room.members))throw new Error('invalid chat membership');
    if(room.members.includes(newName))throw new Error('destination identity in chat membership');
    room.members=room.members.map(change);room.owner=change(room.owner);
  }
  for(const list of Object.values(state.friends)){
    if(!Array.isArray(list)||list.includes(newName))throw new Error('chat relationship collision');
    for(let i=0;i<list.length;i++)list[i]=change(list[i]);
  }
  for(const req of Object.values(state.reqs))for(const k of ['in','out']){
    if(!Array.isArray(req[k])||req[k].includes(newName))throw new Error('chat request collision');
    req[k]=req[k].map(change);
  }
}
function migrateBody(body, oldName, newName) {
  if(!object(body))throw new Error('invalid encrypted chat body');
  if(body.reply?.from===newName)throw new Error('destination reply identity collision');
  if(body.reply?.from===oldName)body.reply.from=newName;
  if(body.votes){moveKey(body.votes,oldName,newName);}
  if(body.reacts)for(const key of Object.keys(body.reacts)){
    const list=body.reacts[key];if(!Array.isArray(list)||list.includes(newName))throw new Error('reaction identity collision');
    body.reacts[key]=list.map(u=>u===oldName?newName:u);
  }
  return body;
}
function openBody(bytes,key){
  if(bytes.length<28)throw new Error('invalid encrypted chat record');
  const d=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));d.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(bytes.subarray(12,-16)),d.final()]).toString('utf8'));
}
function sealBody(body,key){
  const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);
  return Buffer.concat([iv,c.update(JSON.stringify(body)),c.final(),c.getAuthTag()]).toString('base64');
}
export function planIdentity(root, oldName, newName, {protectedNames=[]}={}) {
  const old=String(oldName).trim().toLowerCase(),next=String(newName).trim().toLowerCase();
  if(!/^[a-z0-9_.-]{2,24}$/.test(next)||old===next)throw new Error('invalid destination name');
  if(protectedNames.includes(old)||protectedNames.includes(next))throw new Error('protected identity cannot be renamed');
  if(existsSync(join(root,'.identity-migration.json')))throw new Error('unfinished identity migration');
  const users=readJson(join(root,'users.json'),null);
  if(!object(users)||!has(users,old))throw new Error('source account missing');
  if(has(users,next))throw new Error('destination account exists');
  const changes=[];
  function add(path,bytes){const original=readFileSync(join(root,path));if(!original.equals(bytes))changes.push({path,original,bytes,mode:statSync(join(root,path)).mode&0o777});}
  for(const name of ACCOUNT_STORES){const path=name+'.json';if(!existsSync(join(root,path)))continue;const map=readJson(join(root,path),null);moveKey(map,old,next);add(path,Buffer.from(JSON.stringify(map,null,2)));}
  if(existsSync(join(root,'sessions.json'))){const map=readJson(join(root,'sessions.json'),null);if(!object(map))throw new Error('invalid sessions');for(const session of Object.values(map)){if(session.user===next)throw new Error('destination session collision');if(session.user===old)session.user=next;}add('sessions.json',Buffer.from(JSON.stringify(map,null,2)));}
  const statePath='banter2/state.json';
  if(existsSync(join(root,statePath))){const state=readJson(join(root,statePath),null);migrateChat(state,old,next);add(statePath,Buffer.from(JSON.stringify(state,null,2)));}
  const msgDir=join(root,'banter2/msgs');
  if(existsSync(msgDir)){
    const files=readdirSync(msgDir).filter(n=>n.endsWith('.jsonl'));
    if(files.length){const raw=readFileSync(join(root,'banter2/key'),'utf8').trim();if(!/^[a-f0-9]{64}$/i.test(raw))throw new Error('invalid chat key');const key=Buffer.from(raw,'hex');
      for(const file of files){if(!/^[a-z0-9-]+\.jsonl$/i.test(file))throw new Error('unexpected chat log path');
        const path='banter2/msgs/'+file;const lines=readFileSync(join(root,path),'utf8').split('\n').filter(Boolean);let changed=false;
        const out=lines.map(line=>{const record=JSON.parse(line);if(record.from===next)throw new Error('destination message identity collision');
          const body=openBody(Buffer.from(record.b,'base64'),key);const before=JSON.stringify(body);migrateBody(body,old,next);
          if(record.from===old){record.from=next;changed=true;}
          if(JSON.stringify(body)!==before){record.b=sealBody(body,key);changed=true;}
          return JSON.stringify(record);
        });
        if(changed)add(path,Buffer.from(out.join('\n')+'\n'));
      }
    }
  }
  return {oldName:old,newName:next,changes};
}
function syncFile(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function atomic(path,bytes,mode=0o600){const tmp=path+'.identity-tmp';writeFileSync(tmp,bytes,{mode});syncFile(tmp);renameSync(tmp,path);const fd=openSync(join(path,'..'),'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
export function requireStopped(root){
  const lock=readJson(join(root,'.server-lock.json'),null);
  if(lock){if(!Number.isInteger(lock.pid)||lock.pid<1)throw new Error('invalid server lock');try{process.kill(lock.pid,0);}catch(e){if(e.code==='ESRCH')return;throw new Error('server state cannot be verified');}throw new Error('stop the server before identity migration');}
}
export function recoverIdentity(root){
  const path=join(root,'.identity-migration.json');if(!existsSync(path))return;
  const journal=readJson(path,null);validateJournal(journal);if(journal.status==='committed'){unlinkSync(path);return;}
  rollbackIdentity(root);
}
function acquireLock(root){
 mkdirSync(root,{recursive:true});
 const claim=join(root,'.identity-lock-claim');
 // Serialize stale PID-lock removal. Never reclaim a stranded claim automatically.
 // A crash here fails closed until an operator confirms all writers stopped.
 const fd=openSync(claim,'wx',0o600);closeSync(fd);
 const path=join(root,'.server-lock.json');
 try{
  requireStopped(root);
  if(existsSync(path))unlinkSync(path);
  writeFileSync(path,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});
 }finally{unlinkSync(claim);}
 const release=()=>{try{const lock=readJson(path,null);if(lock?.pid===process.pid)unlinkSync(path);}catch{}};
 return release;
}
export function serverIdentityLock(root){
 const release=acquireLock(root);
 try{recoverIdentity(root);}catch(e){release();throw e;}
 process.once('exit',release);
}
export function applyIdentity(root,plan,{afterWrite=()=>{}}={}){
 const release=acquireLock(root),journalPath=join(root,'.identity-migration.json');
 let installed=false;
 try{
  if(existsSync(journalPath))throw new Error('unfinished identity migration');
  for(const change of plan.changes)if(!readFileSync(join(root,change.path)).equals(change.original))throw new Error('state changed after preflight');
  const id=randomUUID(),dir=join(root,'.identity-snapshots',id);mkdirSync(dir,{recursive:true,mode:0o700});
  const journal={version:1,id,entries:plan.changes.map((c,i)=>({path:c.path,index:i,hash:hash(c.original),mode:c.mode})),status:'prepared'};
  for(let i=0;i<plan.changes.length;i++){const backup=join(dir,String(i));writeFileSync(backup,plan.changes[i].original,{mode:0o600});syncFile(backup);}
  syncFile(dir);atomic(journalPath,Buffer.from(JSON.stringify(journal)));installed=true;
  for(let i=0;i<plan.changes.length;i++){const c=plan.changes[i];atomic(join(root,c.path),c.bytes,c.mode);afterWrite(i);}
  journal.status='committed';atomic(journalPath,Buffer.from(JSON.stringify(journal)));unlinkSync(journalPath);
  return {snapshot:id,files:plan.changes.length};
 }catch(e){if(installed){rollbackIdentity(root);throw new Error('identity migration rolled back');}throw e;}
 finally{release();}
}

function validateJournal(journal){
 if(!object(journal)||journal.version!==1||!['prepared','committed'].includes(journal.status)||!Array.isArray(journal.entries)||!/^[-a-f0-9]{36}$/.test(journal.id||''))throw new Error('invalid migration journal');
 const paths=new Set();journal.entries.forEach((e,index)=>{
  if(!object(e)||!(/^(?:banter2\/(?:state\.json|msgs\/[a-z0-9-]+\.jsonl))$/i.test(e.path)||ACCOUNT_STORES.concat('sessions').map(n=>n+'.json').includes(e.path))||e.index!==index||!Number.isInteger(e.mode)||e.mode<0||e.mode>0o777||!/^[a-f0-9]{64}$/.test(e.hash)||paths.has(e.path))throw new Error('invalid journal entry');
  paths.add(e.path);
 });
}
export function rollbackIdentity(root){
  const path=join(root,'.identity-migration.json'),journal=readJson(path,null);
  validateJournal(journal);
  const dir=join(root,'.identity-snapshots',journal.id);
  // Validate every snapshot before writing even one restore file.
  const backups=journal.entries.map(e=>{
    if(!/^(?:[a-z0-9-]+\.json|banter2\/(?:state\.json|msgs\/[a-z0-9-]+\.jsonl))$/i.test(e.path)||!Number.isInteger(e.index))throw new Error('invalid journal path');
    const bytes=readFileSync(join(dir,String(e.index)));if(hash(bytes)!==e.hash)throw new Error('snapshot hash mismatch');return {e,bytes};
  });
  for(const {e,bytes} of backups)atomic(join(root,e.path),bytes,e.mode);unlinkSync(path);
}
