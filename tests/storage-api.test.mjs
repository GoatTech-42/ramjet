import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './fixtures/start-server.mjs';
import { Auth } from '../core/auth.js';

async function start(root) {
  const {child,base,stop}=await startServer(root);
  try {
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'reviewer',password:'storage-test-password'})});
  assert.equal(login.status,200); const cookie=login.headers.get('set-cookie').split(';')[0];
  return { child, stop, async raw(path){return fetch(base+path,{headers:{cookie}});}, async api(path,data){const r=await fetch(base+path,{method:data?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};} };
  } catch(e) { await stop(); throw e; }
}

test('real APIs use isolated root; export, restart, chat decrypt and corruption protection',async()=>{
  const roots=[mkdtempSync(join(tmpdir(),'rj-api-a-')),mkdtempSync(join(tmpdir(),'rj-api-b-'))];
  let server;
  try {
    for(const root of roots)new Auth(root).createUser('reviewer','storage-test-password');
    server=await start(roots[0]);const {api}=server;
    const pl=await api('/api/apps/amp/playlists',{name:'Persisted'});assert.equal(pl.status,200);
    assert.equal((await api('/api/apps/amp/playlists/rename',{id:pl.data.playlist.id,name:'Renamed'})).status,200);
    assert.equal((await api('/api/apps/jetstream/history',{id:'dQw4w9WgXcQ',title:'Saved video',duration:'3:00'})).status,200);
    assert.equal((await api('/api/apps/browse/bookmarks',{name:'Example',url:'https://example.com/'})).status,200);
    const conv=await api('/api/apps/sage/conversations',{messages:[{role:'user',content:'Persist this conversation'}]});assert.equal(conv.status,200);
    const group=await api('/api/apps/banter/group',{name:'Storage test'});assert.equal(group.status,200);
    const room=group.data.room.id;
    assert.equal((await api('/api/apps/banter/msg',{room,type:'text',text:'encrypted persistence fixture'})).status,200);
    const image=Buffer.from('storage-image-fixture');
    assert.equal((await api('/api/apps/banter/msg',{room,type:'image',data:image.toString('base64')})).status,200);
    const exported=await api('/api/auth/export');assert.equal(exported.data.jetstream_history[0].title,'Saved video');assert.equal(exported.data.amp_playlists[0].name,'Renamed');assert.equal(exported.data.browse_bookmarks[0].name,'Example');assert.equal(exported.data.sage_conversations[0].id,conv.data.id);
    const keyBefore=readFileSync(join(roots[0],'banter2/key'));assert.equal(statSync(join(roots[0],'banter2/key')).mode&0o777,0o600);
    const logs=readdirSync(join(roots[0],'banter2/msgs'));assert(logs.length);assert(!readFileSync(join(roots[0],'banter2/msgs',logs[0]),'utf8').includes('encrypted persistence fixture'));
    await server.stop();server=await start(roots[0]);
    assert.equal((await server.api('/api/apps/amp/playlists')).data.playlists[0].name,'Renamed');
    assert.equal((await server.api('/api/apps/jetstream/history')).data.items[0].title,'Saved video');
    const msgs=(await server.api('/api/apps/banter/msgs?room='+room)).data.msgs;assert(msgs.some(m=>m.text==='encrypted persistence fixture'));const media=msgs.find(m=>m.type==='image');assert(media);const decrypted=await server.raw('/api/apps/banter/media?id='+media.media);assert.equal(decrypted.status,200);assert.deepEqual(Buffer.from(await decrypted.arrayBuffer()),image);
    assert.deepEqual(readFileSync(join(roots[0],'banter2/key')),keyBefore);
    const path=join(roots[0],'amp-playlists.json');writeFileSync(path,'{corrupt');
    assert.equal((await server.api('/api/apps/amp/playlists',{name:'Must not overwrite'})).status,500);assert.equal(readFileSync(path,'utf8'),'{corrupt');
    await server.stop();server=await start(roots[1]);
    assert.equal((await server.api('/api/apps/amp/playlists')).data.playlists.length,0);assert.equal((await server.api('/api/apps/browse/bookmarks')).data.bookmarks.length,0);assert.equal((await server.api('/api/apps/sage/conversations')).data.conversations.length,0);assert.equal((await server.api('/api/apps/banter/state')).data.rooms.length,0);
  }finally{if(server&&server.child.exitCode===null)await server.stop();for(const root of roots)rmSync(root,{recursive:true});}
});
