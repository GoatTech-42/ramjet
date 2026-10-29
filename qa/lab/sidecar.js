const http = require('http');
const { WebSocketServer } = require('/tmp/fullapp/node/node_modules/ws');
const wss = new WebSocketServer({ noServer: true });
function frame(id, type, payload) {
  const p = payload || Buffer.alloc(0);
  const b = Buffer.alloc(5 + p.length);
  b.writeUInt32BE(id >>> 0, 0); b.writeUInt8(type, 4); p.copy(b, 5);
  return b;
}
const HOP = new Set(['connection','upgrade','sec-websocket-key','sec-websocket-version','sec-websocket-extensions','host','content-length']);
const srv = http.createServer((req,res)=>{res.writeHead(404);res.end();});
srv.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      let m; try { m = JSON.parse(data.toString('utf8')); } catch { return; }
      if (m.cancel) return;
      const id = m.id;
      try {
        const hdrs = {};
        for (const [k,v] of (m.headers||[])) { const lk=String(k).toLowerCase(); if(!HOP.has(lk)) hdrs[lk]=v; }
        console.log('FETCH', m.method||'GET', m.url);
        const r = await fetch(m.url, { method: m.method||'GET', headers: hdrs, redirect: 'manual' });
        const rh = []; r.headers.forEach((v,k)=>{ if(!HOP.has(k)) rh.push([k,v]); });
        ws.send(frame(id, 0, Buffer.from(JSON.stringify({status:r.status, text:r.statusText||'', headers:rh}))));
        const buf = Buffer.from(await r.arrayBuffer());
        for (let off=0; off<buf.length; off+=65536) ws.send(frame(id, 1, buf.subarray(off, off+65536)));
        ws.send(frame(id, 2));
        console.log('DONE', r.status, buf.length, 'bytes');
      } catch (e) { console.log('FAIL', String(e)); try { ws.send(frame(id, 3, Buffer.from(String(e && e.message || e)))); } catch {} }
    });
  });
});
srv.listen(8080, '127.0.0.1', ()=>console.log('ramjet sidecar on 8080'));
