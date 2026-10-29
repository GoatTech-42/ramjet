const http=require('http'),fs=require('fs'),path=require('path');
const MIME={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png'};
const srv=http.createServer((req,res)=>{let p=path.join(process.env.FIXTURE_DIR||require('path').join(__dirname,'fixture'),req.url==='/'?'index.html':req.url.split('?')[0]);
fs.readFile(p,(e,d)=>{if(e){res.writeHead(404);res.end('nf');return;}res.writeHead(200,{'content-type':MIME[path.extname(p)]||'application/octet-stream'});res.end(d);});
}); srv.on('connection', c=>console.log('TCP-CONN from', c.remoteAddress, c.remotePort, new Date().toISOString())); srv.on('request',(q,r)=>console.log('REQ',q.method,q.url)); srv.listen(8090,'127.0.0.1',()=>console.log('fixture on 8090'));
