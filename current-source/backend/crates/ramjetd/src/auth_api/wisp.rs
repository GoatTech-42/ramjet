                                                                                
                                                                           
use std::{collections::HashMap,sync::Mutex,time::Duration};
use axum::{extract::{Request,State},http::{HeaderValue,StatusCode},response::Response,body::Body};
use super::{store, cookie, user,csrf};
use crate::{Shared,lite::{json_err,json_ord,OJ}};
pub struct Tickets{map:Mutex<HashMap<String,Ticket>>,slots:std::sync::Arc<tokio::sync::Semaphore>}
impl Default for Tickets{fn default()->Self{Self{map:Mutex::new(HashMap::new()),slots:std::sync::Arc::new(tokio::sync::Semaphore::new(64))}}}
struct Ticket{token:String,user:String,expires:i64,reserved:bool}
impl Tickets{
 pub fn mint(&self,token:String,user:String)->Option<String>{let key=crate::apps::hex_id(24)?;let mut m=self.map.lock().ok()?;m.retain(|_,v|v.expires>store::now());if m.len()>=500{return None}m.insert(key.clone(),Ticket{token,user,expires:store::now()+90000,reserved:false});Some(key)}
 fn reserve(&self,key:&str)->Option<(String,String)>{let mut m=self.map.lock().ok()?;let t=m.get_mut(key)?;if t.expires<=store::now()||t.reserved{return None}t.reserved=true;Some((t.token.clone(),t.user.clone()))}
 fn release(&self,key:&str){if let Ok(mut m)=self.map.lock(){if let Some(t)=m.get_mut(key){t.reserved=false}}}
 fn consume(&self,key:&str){if let Ok(mut m)=self.map.lock(){m.remove(key);}}
}
pub fn mint(st:&crate::AppState,h:&axum::http::HeaderMap)->Response{
 if !csrf(h){return json_err(StatusCode::FORBIDDEN,"forbidden")}
 let (Some(t),Some(u))=(cookie(h),user(st,h))else{return json_err(StatusCode::UNAUTHORIZED,"not signed in")};
 match st.tickets.mint(t,u){Some(k)=>json_ord(StatusCode::OK,vec![("ok",OJ::Bool(true)),("ticket",OJ::Str(k))]),None=>json_err(StatusCode::SERVICE_UNAVAILABLE,"try again later")}
}
fn failure(s:StatusCode,m:&str)->Response{json_err(s,m)}
pub async fn relay(State(shared):State<Shared>,mut req:Request)->Response{
 let st=shared.0;
 let Some(key)=socket_key(req.uri().path()) else{return failure(StatusCode::NOT_FOUND,"not found")};
 let key=key.to_owned();
 if req.method()!=axum::http::Method::GET{return failure(StatusCode::METHOD_NOT_ALLOWED,"bad method")}
 if !req.headers().get("upgrade").is_some_and(|v|v.as_bytes().eq_ignore_ascii_case(b"websocket"))||!req.headers().get("connection").and_then(|v|v.to_str().ok()).is_some_and(|s|s.split(',').any(|v|v.trim().eq_ignore_ascii_case("upgrade"))){return failure(StatusCode::BAD_REQUEST,"bad request")}
 let Some((token,owner))=st.tickets.reserve(&key)else{return failure(StatusCode::UNAUTHORIZED,"not signed in")};
 if st.auth_db.user(&token).as_deref()!=Some(owner.as_str()){st.tickets.consume(&key);return failure(StatusCode::UNAUTHORIZED,"not signed in")}
 let permit=match st.tickets.slots.clone().try_acquire_owned(){Ok(p)=>p,Err(_)=>{st.tickets.release(&key);return failure(StatusCode::SERVICE_UNAVAILABLE,"try again later")}};
 let downstream=hyper::upgrade::on(&mut req);
 let request_headers=req.headers().clone();
 drop(req);
 let result=tokio::time::timeout(Duration::from_secs(8),connect_upstream(&request_headers,"wisp-sidecar:8080","/pws-t/relay/")).await;
 let (headers,upstream)=match result{Ok(Ok(v))=>v,_=>{st.tickets.release(&key);return failure(StatusCode::BAD_GATEWAY,"transport unavailable")}};
                                                                                
                                                                                
 if st.auth_db.user(&token).as_deref()!=Some(owner.as_str()){st.tickets.consume(&key);return failure(StatusCode::UNAUTHORIZED,"not signed in")}
 st.tickets.consume(&key);
 let mut out=Response::new(Body::empty());*out.status_mut()=StatusCode::SWITCHING_PROTOCOLS;
 out.headers_mut().insert("connection",HeaderValue::from_static("Upgrade"));out.headers_mut().insert("upgrade",HeaderValue::from_static("websocket"));out.headers_mut().insert("cache-control",HeaderValue::from_static("no-store"));
 for k in ["sec-websocket-accept","sec-websocket-protocol","sec-websocket-extensions"]{if let Some(v)=headers.get(k){out.headers_mut().insert(k,v.clone());}}
 tokio::spawn(async move{
  let _permit=permit;
  let Ok(Ok(down))=tokio::time::timeout(Duration::from_secs(8),downstream).await else{return};
  let mut down=hyper_util::rt::TokioIo::new(down);let mut up=hyper_util::rt::TokioIo::new(upstream);
                                                                               
                                                                             
  let _=tokio::time::timeout(Duration::from_secs(3600),tokio::io::copy_bidirectional(&mut down,&mut up)).await;
 });out
}
#[cfg(test)]mod tests{use super::*;#[test]fn single_reservation_release_consume(){let ts=Tickets::default();let k=ts.mint("token".into(),"user".into()).unwrap();assert_eq!(k.len(),48);assert!(ts.reserve(&k).is_some());assert!(ts.reserve(&k).is_none());ts.release(&k);assert!(ts.reserve(&k).is_some());ts.consume(&k);assert!(ts.reserve(&k).is_none())}}

async fn connect_upstream(request_headers:&axum::http::HeaderMap,target:&str,upstream_path:&str)->Result<(axum::http::HeaderMap,hyper::upgrade::Upgraded),()>{
  let tcp=tokio::net::TcpStream::connect(target).await.map_err(|_|())?;
  let io=hyper_util::rt::TokioIo::new(tcp);
  let (mut sender,conn)=hyper::client::conn::http1::handshake(io).await.map_err(|_|())?;
  tokio::spawn(async move{let _=conn.with_upgrades().await;});
  let mut up=hyper::Request::builder().method("GET").uri(upstream_path).header("host","wisp-sidecar:8080").header("connection","Upgrade").header("upgrade","websocket");
  for k in ["sec-websocket-key","sec-websocket-version","sec-websocket-protocol","sec-websocket-extensions"]{for v in request_headers.get_all(k){up=up.header(k,v)}}
  let mut r=sender.send_request(up.body(http_body_util::Empty::<axum::body::Bytes>::new()).map_err(|_|())?).await.map_err(|_|())?;
  if r.status()!=StatusCode::SWITCHING_PROTOCOLS{return Err(())}
  let headers=r.headers().clone();let upstream=hyper::upgrade::on(&mut r).await.map_err(|_|())?;
  Ok((headers,upstream))
}
#[cfg(test)]mod relay_tests{
 use super::*;use tokio::io::{AsyncReadExt,AsyncWriteExt};
 #[tokio::test]async fn strips_credentials_rewrites_and_tunnels(){
  let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let addr=listener.local_addr().unwrap().to_string();
  let server=tokio::spawn(async move{
   let(mut s,_)=listener.accept().await.unwrap();let mut b=Vec::new();let mut byte=[0;1];while !b.ends_with(b"\r\n\r\n"){s.read_exact(&mut byte).await.unwrap();b.push(byte[0]);assert!(b.len()<8192)}let req=String::from_utf8(b).unwrap();assert!(req.starts_with("GET /wisp/ HTTP/1.1\r\n"));assert!(!req.to_lowercase().contains("cookie"));assert!(!req.to_lowercase().contains("authorization"));assert!(!req.contains("SECRET"));assert!(req.to_lowercase().contains("sec-websocket-protocol: wisp-v2"));
   s.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: test\r\nSec-WebSocket-Protocol: wisp-v2\r\n\r\n").await.unwrap();let mut data=[0;4];s.read_exact(&mut data).await.unwrap();assert_eq!(&data,b"ping");s.write_all(b"pong").await.unwrap();
  });
  let mut h=axum::http::HeaderMap::new();h.insert("cookie","SECRET".parse().unwrap());h.insert("authorization","Bearer SECRET".parse().unwrap());h.insert("sec-websocket-key","key".parse().unwrap());h.insert("sec-websocket-version","13".parse().unwrap());h.insert("sec-websocket-protocol","wisp-v2".parse().unwrap());let(headers,up)=connect_upstream(&h,&addr,"/wisp/").await.unwrap();assert_eq!(headers["sec-websocket-protocol"],"wisp-v2");let mut io=hyper_util::rt::TokioIo::new(up);io.write_all(b"ping").await.unwrap();let mut b=[0;4];io.read_exact(&mut b).await.unwrap();assert_eq!(&b,b"pong");server.await.unwrap();
 }
 #[tokio::test]async fn non101_rejected(){let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let addr=listener.local_addr().unwrap().to_string();let server=tokio::spawn(async move{let(mut s,_)=listener.accept().await.unwrap();let mut b=[0;4096];let _=s.read(&mut b).await;s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await.unwrap()});assert!(connect_upstream(&axum::http::HeaderMap::new(),&addr,"/wisp/").await.is_err());server.await.unwrap();}
}

                                                                             
                                                                          
                                                                         
                                                                              
                                                                              
pub fn socket_key(path:&str)->Option<&str>{
 let tail=path.strip_prefix("/api/media-bridge/")?;
 let key=tail.strip_suffix('/')?;
 if key.len()!=48||!key.bytes().all(|b|b.is_ascii_hexdigit()&&!b.is_ascii_uppercase()){return None}
 Some(key)
}
                                                                           
                                                                               
pub async fn ticket(State(shared):State<Shared>,req:Request)->Response{
 let st=&shared.0;let h=req.headers();
 let peer=req.extensions().get::<axum::extract::ConnectInfo<std::net::SocketAddr>>().map(|p|p.0);
 let actor=user(st,h);
 let ip=super::rate::client_ip(h,peer);
 if let Some(ra)=st.rates.window(format!("rg:{}",actor.as_deref().unwrap_or(&ip)),5000,3600000){let mut r=json_err(StatusCode::TOO_MANY_REQUESTS,"slow down a bit");r.headers_mut().insert("retry-after",ra.max(1).to_string().parse().unwrap());return r}
 mint(st,h)
}
#[cfg(test)]mod pws_tests{
 use super::*;use tokio::io::{AsyncReadExt,AsyncWriteExt};
 #[test]fn path_selection_and_exact_shape(){let key="a".repeat(48);assert_eq!(socket_key(&format!("/api/media-bridge/{key}/")),Some(key.as_str()));for p in [format!("/api/media-bridge/{key}"),format!("/api/media-bridge/{key}/extra/"),format!("/api/media-bridge/{}/","A".repeat(48)),"/api/media-bridge/a/".into(),format!("/pws-t/{key}/"),format!("/wisp-t/{key}/")]{assert!(socket_key(&p).is_none())}}
 #[tokio::test]async fn pws_path_strips_ticket_and_preserves_frame_bytes(){
  let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let addr=listener.local_addr().unwrap().to_string();
  let server=tokio::spawn(async move{
   let(mut s,_)=listener.accept().await.unwrap();let mut b=Vec::new();let mut byte=[0;1];while !b.ends_with(b"\r\n\r\n"){s.read_exact(&mut byte).await.unwrap();b.push(byte[0]);assert!(b.len()<8192)}let req=String::from_utf8(b).unwrap();assert!(req.starts_with("GET /pws-t/relay/ HTTP/1.1\r\n"));assert!(!req.contains("SECRET"));assert!(!req.to_lowercase().contains("cookie"));assert!(!req.to_lowercase().contains("authorization"));
   s.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: test\r\n\r\n").await.unwrap();let mut b=[0;7];s.read_exact(&mut b).await.unwrap();assert_eq!(b,[0x82,5,0,0,0,1,2]);s.write_all(&[0x82,5,0,0,0,1,2]).await.unwrap();
  });let mut h=axum::http::HeaderMap::new();h.insert("cookie","SECRET".parse().unwrap());h.insert("authorization","SECRET".parse().unwrap());h.insert("sec-websocket-key","key".parse().unwrap());h.insert("sec-websocket-version","13".parse().unwrap());let(_,up)=connect_upstream(&h,&addr,"/pws-t/relay/").await.unwrap();let mut io=hyper_util::rt::TokioIo::new(up);io.write_all(&[0x82,5,0,0,0,1,2]).await.unwrap();let mut b=[0;7];io.read_exact(&mut b).await.unwrap();assert_eq!(b,[0x82,5,0,0,0,1,2]);server.await.unwrap();
 }
}

                                                                                        
                                                                                     
                                                                                         
                                                                                             
pub const THUMB_TTL_MS: i64 = 6 * 3600 * 1000;

fn thumb_key(d: &std::path::Path) -> Option<Vec<u8>> {
    let p = d.join("thumb-ticket-key");
    if let Ok(b) = std::fs::read(&p) {
        if b.len() == 32 { return Some(b); }
        let _ = std::fs::remove_file(&p);                                                                        
    }
    let mut b = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut b);
    #[cfg(unix)] {
        use std::io::Write; use std::os::unix::fs::OpenOptionsExt;
                                                                                     
                                                                                               
        let tmp = d.join(format!("thumb-ticket-key.{}.{}.tmp", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|x| x.as_nanos()).unwrap_or(0)));
        let _ = std::fs::remove_file(&tmp);
        let wrote = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)
            .and_then(|mut f| f.write_all(&b).and_then(|_| f.sync_all())).is_ok();
        if wrote {
            if let Ok(existing) = std::fs::read(&p) { if existing.len() == 32 { let _ = std::fs::remove_file(&tmp); return Some(existing); } }
            if std::fs::rename(&tmp, &p).is_ok() { return Some(b.to_vec()); }
        }
        let _ = std::fs::remove_file(&tmp);
        return std::fs::read(&p).ok().filter(|b| b.len() == 32);                                      
    }
    #[cfg(not(unix))] { std::fs::write(&p, b).ok()?; }
    Some(b.to_vec())
}

                                                                           
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut k = [0u8; 64];
    if key.len() > 64 { k[..32].copy_from_slice(&Sha256::digest(key)); } else { k[..key.len()].copy_from_slice(key); }
    let mut inner = [0u8; 64]; let mut outer = [0u8; 64];
    for i in 0..64 { inner[i] = k[i] ^ 0x36; outer[i] = k[i] ^ 0x5c; }
    let mut h = Sha256::new(); h.update(inner); h.update(msg);
    let ih = h.finalize();
    let mut h = Sha256::new(); h.update(outer); h.update(ih);
    h.finalize().into()
}

                                                                                       
                                                                                
pub fn thumb_ticket(d: &std::path::Path, user: &str) -> Option<String> {
                                                                                                         
    if user.is_empty() || user.len() > 64 || !user.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.') { return None; }
    let key = thumb_key(d)?;
    let exp = store::now() + THUMB_TTL_MS;
    let msg = format!("thumb:{user}:{exp}");
    let sig = hmac_sha256(&key, msg.as_bytes());
    Some(format!("{user}:{exp}:{}", &hex(&sig)[..24]))
}

                                                                           
                                                                                   
                                                       
pub fn thumb_ticket_user(d: &std::path::Path, ticket: &str) -> Option<String> {
    let (user, rest) = ticket.split_once(':')?;
    let (exp_s, sig) = rest.split_once(':')?;
                                                                                                         
    if user.is_empty() || exp_s.len() > 16 || sig.len() != 24 || !sig.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) { return None; }
    let exp: i64 = exp_s.parse().ok()?;
    if exp.to_string() != exp_s { return None; }
    if exp <= store::now() { return None; }
    let key = thumb_key(d)?;
    let msg = format!("thumb:{user}:{exp}");
    let want = hmac_sha256(&key, msg.as_bytes());
    let got = hex::decode(sig)?;                                              
    if got.len() != 12 { return None; }
                                                  
    let mut d = 0u8; for i in 0..12 { d |= want[i] ^ got[i]; }
    if d != 0 { return None; }
    Some(user.to_string())
}

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
mod hex { pub fn decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 { return None; }
    (0..s.len()/2).map(|i| u8::from_str_radix(&s[2*i..2*i+2], 16).ok()).collect()
} }

#[cfg(test)]mod expired_thumb_test{use super::*;#[test]fn signed_expired_ticket_is_rejected(){let d=std::env::temp_dir().join(format!("expired-thumb-{}",crate::apps::hex_id(8).unwrap()));std::fs::create_dir_all(&d).unwrap();let key=thumb_key(&d).unwrap();let exp=store::now()-1;let sig=hex(&hmac_sha256(&key,format!("thumb:expired-fixture:{exp}").as_bytes()));let ticket=format!("expired-fixture:{exp}:{}",&sig[..24]);assert!(thumb_ticket_user(&d,&ticket).is_none());}}
