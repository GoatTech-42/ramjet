                                                                                 
pub mod devices;
pub mod store;
pub mod rate;
pub mod wisp;
use axum::{body::{to_bytes},extract::{State,Request},http::{HeaderMap,StatusCode,Method},response::Response};
use crate::{Shared,apps,lite::{json_ord,json_err,OJ}};
use serde_json::Value;
fn err(s:StatusCode,m:&str)->Response{json_err(s,m)}
pub fn cookie(h:&HeaderMap)->Option<String>{
 let mut found=None;
 for header in h.get_all("cookie"){let text=header.to_str().ok()?;for p in text.split(';') {let Some((k,v))=p.trim().split_once('=')else{continue};if k=="rj2_session"{if found.is_some(){return None} if v.len()!=43||!v.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'){return None}found=Some(v.to_string())}}}found
}
pub fn user(st:&crate::AppState,h:&HeaderMap)->Option<String>{st.auth_db.user(&cookie(h)?)}
pub fn csrf(h:&HeaderMap)->bool{h.contains_key("x-ramjet-js")||{let mut v=h.get_all("sec-fetch-site").iter();v.next().and_then(|x|x.to_str().ok())==Some("same-origin")&&v.next().is_none()}}
fn ok()->Response{apps::ok_true()}
fn issue(u:&str,t:&str)->Response{let mut r=json_ord(StatusCode::OK,vec![("ok",OJ::Bool(true)),("user",OJ::Str(u.into()))]);set_cookie(&mut r,t);r}
fn set_cookie(r:&mut Response,t:&str){r.headers_mut().insert("set-cookie",format!("rj2_session={t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000").parse().unwrap());}
pub fn admin_name()->String{std::env::var("RJ_ADMIN").unwrap_or("luke".into())}
fn approval(st:&crate::AppState)->Result<bool,Response>{match apps::read_store(&st.data_dir.join("config.json")){apps::StoreRead::Missing=>Ok(true),apps::StoreRead::Corrupt=>Err(apps::io_fail()),apps::StoreRead::Ok(v)=>Ok(v.get("requireApproval").and_then(Value::as_bool).unwrap_or(true))}}
fn text(v:&Value,k:&str)->String{apps::js_trim(&apps::js_string(&v[k])).to_lowercase()}
async fn pair_block<F>(st:std::sync::Arc<crate::AppState>,f:F)->Response where F:FnOnce(std::sync::Arc<crate::AppState>)->Response+Send+'static{
 static S:std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>>=std::sync::OnceLock::new();
 let permit=match S.get_or_init(||std::sync::Arc::new(tokio::sync::Semaphore::new(8))).clone().try_acquire_owned(){Ok(p)=>p,Err(_)=>return err(StatusCode::SERVICE_UNAVAILABLE,"try again in a moment")};
 match tokio::task::spawn_blocking(move||{let _permit=permit;f(st)}).await{Ok(r)=>r,Err(e)=>{tracing::warn!("pair task failed: {e}");apps::io_fail()}}
}
async fn request_device(st:&std::sync::Arc<crate::AppState>,known:Option<devices::DeviceAuth>,token:Option<String>)->Option<devices::DeviceIdentity>{
 if let Some(auth)=known{return auth.0}
 let token=token?;devices::resolve_bounded(st.clone(),token).await.ok().flatten().map(|(u,id)|devices::DeviceIdentity(u,id))
}
pub async fn dispatch(State(shared):State<Shared>,mut req:Request)->Response{
 let device=request_device(&shared.0,req.extensions().get::<devices::DeviceAuth>().cloned(),devices::bearer_token(req.headers())).await;req.extensions_mut().insert(devices::DeviceAuth(device.clone()));
 let actor=user(&shared.0,req.headers()).or_else(||device.map(|d|d.0));let mutation=req.method()!=Method::GET&&req.method()!=Method::HEAD&&req.method()!=Method::OPTIONS;
 let response=dispatch_inner(State(shared.clone()),req).await;
 if mutation&&response.status().is_success(){if let Some(u)=actor{if shared.0.auth_db.touch(&u).is_err(){tracing::error!("activity update failed after committed mutation; no sweeper enabled");}}}
 response
}
async fn dispatch_inner(State(shared):State<Shared>,req:Request)->Response{
 let peer=req.extensions().get::<axum::extract::ConnectInfo<std::net::SocketAddr>>().map(|p|p.0);
 let st=&shared.0;let path=req.uri().path().to_string();let method=req.method().clone();let h=req.headers().clone();let token=cookie(&h);
 let cu=user(st,&h);let cu_none=cu.is_none();
 let identity=req.extensions().get::<devices::DeviceAuth>().and_then(|a|a.0.clone());
 let dev=if cu.is_none(){identity.as_ref().map(|d|d.0.clone())}else{None};                                
 let u=cu.or_else(||dev.clone());
 if deferred(&path,&method){return err(StatusCode::NOT_IMPLEMENTED,"this part isn't ready yet.")}
 let ip=rate::client_ip(&h,peer);
 if let Some(ra)=st.rates.window(format!("rg:{}",u.as_deref().unwrap_or(&ip)),5000,3600000){return limited(ra,"slow down a bit")}
 let open=matches!((path.as_str(),method.as_str()),("/api/auth/login","POST")|("/api/auth/signup","POST")|("/api/auth/claim","POST")|("/api/auth/logout","POST")|("/api/devices/pair","POST")|("/api/devices/pair/status","GET")|("/api/devices/pair/consume","POST")|("/api/pfetch","POST"));
 if !open&&u.is_none(){return err(StatusCode::UNAUTHORIZED,"not signed in")}
                                                                                                     
                                                                                      
                                                                                        
                                      
 if matches!(method,Method::POST|Method::PUT|Method::DELETE)&&dev.is_none()&&!(path=="/api/pfetch"&&cu_none)&&!csrf(&h){return err(StatusCode::FORBIDDEN,"forbidden")}
 if dev.is_some()&&!devices::scope_allows(&path,method.as_str()){return err(StatusCode::FORBIDDEN,"this device can't do that")}
 let query:std::collections::HashMap<String,String>=url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes()).into_owned().collect();
                                                                                                          
                                                                                            
                                                                                         
                                                                               
 let body=match tokio::time::timeout(std::time::Duration::from_secs(30),to_bytes(req.into_body(),(1<<20)+1)).await{Ok(Ok(b)) if b.len()<=(1<<20)=>b,Ok(Ok(_))=>return apps::too_large(),Ok(Err(_))=>return err(StatusCode::BAD_REQUEST,"bad body"),Err(_)=>return err(StatusCode::REQUEST_TIMEOUT,"body timeout")};
 let parsed=||serde_json::from_slice::<Value>(&body).map_err(|_|err(StatusCode::BAD_REQUEST,"bad json"));
 match(path.as_str(),method.as_str()){
 ("/api/auth/login","POST")=>{
  let v=match parsed(){Ok(v)=>v,Err(r)=>return r};let name=text(&v,"username");let pass=v["password"].as_str().unwrap_or("");
  if let Some(ra)=st.rates.window(format!("spray:{ip}"),120,600000){return limited(ra,"too many tries - wait a few minutes")}
  let pair=format!("pair:{name}:{ip}");let acct=format!("backoff:{name}");
                                                                               
                                                                               
  if let Some(ra)=st.rates.blocked(pair.clone()){return limited(ra,"too many tries - wait a few minutes")}
  let login_state=st.clone();let login_name=name.clone();let login_pass=pass.to_string();
  let outcome=match tokio::task::spawn_blocking(move||login_state.auth_db.login(&login_name,&login_pass)).await{Ok(r)=>r,Err(_)=>return apps::io_fail()};
  if !matches!(&outcome,Ok(store::Login::Ok(_))){
   if let Some(ra)=st.rates.blocked(pair.clone()).or_else(||st.rates.blocked(acct.clone())){return limited(ra,"too many tries - wait a few minutes")}
   st.rates.fail(pair.clone());st.rates.fail(acct.clone());
  }else{st.rates.reset(&pair);st.rates.reset(&acct);}
  match outcome{Ok(store::Login::Ok(id))=>match st.auth_db.issue(&id){Ok(t)=>issue(&name,&t),Err(_)=>apps::io_fail()},Ok(store::Login::Bad)=>err(StatusCode::UNAUTHORIZED,"wrong username or password"),Ok(store::Login::Pending)=>err(StatusCode::FORBIDDEN,"your account is waiting for approval"),Ok(store::Login::Banned)=>err(StatusCode::FORBIDDEN,"this account is turned off"),Err(_)=>apps::io_fail()}
 },
 ("/api/auth/signup"|"/api/auth/claim","POST")=>{
  let v=match parsed(){Ok(v)=>v,Err(r)=>return r};let name=text(&v,"username");let pass=v["password"].as_str().unwrap_or("");
  if ["admin","administrator","root","ramjet","support","system"].contains(&name.as_str())||name==admin_name(){return err(StatusCode::BAD_REQUEST,"that name is taken")}
  if name.len()<2||name.len()>24||!name.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b"_.-".contains(&b)){return err(StatusCode::BAD_REQUEST,"usernames are 2-24 characters: letters, numbers, . _ -")}
  if pass.encode_utf16().count()<6{return err(StatusCode::BAD_REQUEST,"password needs 6+ characters")}
  if let Some(ra)=st.rates.window(format!("signup:{ip}"),40,600000){return limited(ra,"too many tries - wait a few minutes")}
  let pending=match approval(st){Ok(p)=>p,Err(r)=>return r};
  let cs=st.clone();let cn=name.clone();let cp=pass.to_string();let claimed=match tokio::task::spawn_blocking(move||cs.auth_db.claim(&cn,&cp,pending)).await{Ok(r)=>r,Err(_)=>return apps::io_fail()};match claimed{Ok(())=>if pending{json_ord(StatusCode::OK,vec![("ok",OJ::Bool(true)),("pending",OJ::Bool(true))])}else{match st.auth_db.issue(&name){Ok(t)=>issue(&name,&t),Err(_)=>apps::io_fail()}},Err(e)=>if e.starts_with("too many"){err(StatusCode::TOO_MANY_REQUESTS,&e)}else if e=="that name is taken"{err(StatusCode::BAD_REQUEST,&e)}else{apps::io_fail()}}
 },
 ("/api/auth/logout","POST")=>{if let Some(t)=token{if st.auth_db.logout(&t).is_err(){return apps::io_fail()}}let mut r=ok();r.headers_mut().insert("set-cookie","rj2_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0".parse().unwrap());r},
 ("/api/auth/me","GET")=>{let u=u.unwrap();json_ord(StatusCode::OK,vec![("ok",OJ::Bool(true)),("user",OJ::Str(u.clone())),("admin",OJ::Bool(u==admin_name()))])},
 ("/api/auth/password"|"/api/auth/change-password","POST")=>{
  let v=match parsed(){Ok(v)=>v,Err(r)=>return r};let t=token.unwrap();let old=v["current"].as_str().unwrap_or("undefined");
  let pwkey=format!("password:{}:{ip}",u.as_deref().unwrap_or(""));
  if let Some(ra)=st.rates.blocked(pwkey.clone()){return limited(ra,"too many tries - wait a few minutes")}
  let ps=st.clone();let pt=t.clone();let po=old.to_string();
  let verified=tokio::task::spawn_blocking(move||ps.auth_db.verify_password(&pt,&po)).await.unwrap_or(None);
  if verified!=Some(true){st.rates.fail(pwkey.clone());return err(StatusCode::UNAUTHORIZED,"current password is wrong")}
  st.rates.reset(&pwkey);
  let Some(new)=v["next"].as_str().filter(|s|s.encode_utf16().count()>=6)else{return err(StatusCode::BAD_REQUEST,"password needs 6+ characters")};let ps=st.clone();let pt=t.clone();let po=old.to_string();let pn=new.to_string();
  let changed=match tokio::task::spawn_blocking(move||ps.auth_db.password(&pt,&po,&pn)).await{Ok(r)=>r,Err(_)=>return apps::io_fail()};match changed{Ok(nt)=>{st.lite.cred_cache.lock().unwrap_or_else(|e|e.into_inner()).clear();let mut r=ok();set_cookie(&mut r,&nt);r},Err(_)=>apps::io_fail()}
 },
 ("/api/prefs","GET")=>apps::prefs::get(&st.data_dir,&u.unwrap()),
 ("/api/prefs","POST")=>apps::prefs::post(&st.data_dir,&u.unwrap(),&body),
 ("/api/apps/downloads/enqueue","POST")=>{if let Some(ra)=st.rates.window(format!("dl:{}",u.as_deref().unwrap_or("")),30,3600000){return limited(ra,"slow down a bit")}apps::downloads::enqueue(shared.0.clone(),&u.unwrap(),&body).await},
 ("/api/apps/downloads/list","GET")=>apps::downloads::list(&st.data_dir,&u.unwrap()),
 ("/api/apps/downloads/file","GET")=>apps::downloads::file(&st.data_dir,&u.unwrap(),&query).await,
 ("/api/apps/downloads/cancel","POST")=>apps::downloads::cancel(&u.unwrap(),&body,&st.data_dir),
 ("/api/apps/downloads/stage/init","POST")=>{if let Some(ra)=st.rates.window(format!("dl:{}",u.as_deref().unwrap_or("")),30,3600000){return limited(ra,"slow down a bit")}let un=u.unwrap();apps::downloads::stage_init(&st.data_dir,&un,&apps::downloads::sess_hash(&cookie(&h).unwrap_or_default()),&body)},
 ("/api/apps/downloads/stage/part","POST")=>{let un=u.unwrap();let sess=apps::downloads::sess_hash(&cookie(&h).unwrap_or_default());let hdr=|k:&str|h.get(k).and_then(|v|v.to_str().ok());apps::downloads::stage_part(&st.data_dir,&un,&sess,&query,hdr("x-chunk-offset"),hdr("x-chunk-len"),hdr("x-chunk-sha256"),&body)},
 ("/api/apps/downloads/stage/complete","POST")=>{let un=u.unwrap();apps::downloads::stage_complete(&st.data_dir,&un,&apps::downloads::sess_hash(&cookie(&h).unwrap_or_default()),&body)},
 ("/api/apps/downloads/stage/cancel","POST")=>{let un=u.unwrap();apps::downloads::stage_cancel(&un,&apps::downloads::sess_hash(&cookie(&h).unwrap_or_default()),&body,&st.data_dir)},
 ("/api/devices/pair","POST")=>{
  if let Some(ra)=st.rates.window(format!("devpair:{ip}"),30,600000){return limited(ra,"too many tries - wait a few minutes")}
  pair_block(st.clone(),move|s|devices::pair(&s,&body)).await
 },
 ("/api/devices/pair/status","GET")=>{
  let Some(poll)=query.get("poll").and_then(|p|devices::poll_handle(p)) else{return err(StatusCode::BAD_REQUEST,"bad request")};
  if let Some(ra)=st.rates.window(format!("devpoll:{poll}"),660,600000){return limited(ra,"too many tries - wait a few minutes")}
  pair_block(st.clone(),move|s|devices::pair_status(&s,&poll)).await
 },
 ("/api/devices/pair/consume","POST")=>{
  if let Some(ra)=st.rates.window(format!("devconsume:{ip}"),240,600000){return limited(ra,"too many tries - wait a few minutes")}
  pair_block(st.clone(),move|s|devices::pair_consume(&s,&body)).await
 },
 ("/api/devices/pair/lookup","POST")=>{let un=u.unwrap();pair_block(st.clone(),move|s|devices::pair_lookup(&s,&un,&body)).await},
 ("/api/devices/approve","POST")=>{let un=u.unwrap();pair_block(st.clone(),move|s|devices::approve(&s,&un,&body)).await},
 ("/api/devices/deny","POST")=>{let un=u.unwrap();pair_block(st.clone(),move|s|devices::deny(&s,&un,&body)).await},
 ("/api/devices","GET")=>{let un=u.unwrap();pair_block(st.clone(),move|s|devices::list(&s,&un)).await},
 ("/api/devices/revoke","POST")=>if dev.is_some(){{let own=identity.unwrap();devices::revoke_known(st,&own.0,&own.1,&body)}}else{devices::revoke(st,&u.unwrap(),&body)},
 (p,_) if p.starts_with("/api/apps/amp/")=>{
  let un=u.unwrap();let sub=&p[13..];
  match (method.as_str(),sub){
                                                                                            
                                                                                                         
   ("GET","/search")=>apps::amp_media::search(st,&amp_track(st,&un),query.get("q").map(String::as_str).unwrap_or("")).await,
   ("GET","/art")=>apps::amp_media::art(st,&amp_track(st,&un),query.get("src").map(String::as_str).unwrap_or(""),query.get("id").map(String::as_str).unwrap_or(""),query.get("u").map(String::as_str).unwrap_or("")).await,
   ("GET","/stream")|("HEAD","/stream")=>{
    let range=apps::amp_media::effective_range(h.get("range").and_then(|v|v.to_str().ok()),h.get("if-range").and_then(|v|v.to_str().ok()));
    apps::amp_media::stream(st,&amp_track(st,&un),st.guard.bytes_left(&un),query.get("src").map(String::as_str).unwrap_or(""),query.get("id").map(String::as_str).unwrap_or(""),range,method==Method::HEAD).await
   },
   _=>apps::amp::handle(&st.data_dir,&un,method.as_str(),sub,query.get("id").map(String::as_str),&body),
  }
 },
 (p,_) if p.starts_with("/api/apps/sage/")=>apps::sage::handle(&st,&u.unwrap(),method.as_str(),&p[14..],query.get("id").map(String::as_str),&body).await,
 (p,_) if p.starts_with("/api/apps/browse/render/")=>{let un=u.unwrap();apps::browse_render::handle_checked(&st.data_dir,&un,dev.is_some(),if dev.is_some(){identity.as_ref().map(|d|d.1.clone())}else{None}.as_deref(),Some(&st.auth_db),method.as_str(),&p[24..],&query,&body).await},
 (p,_) if p.starts_with("/api/apps/browse/")=>{let un=u.unwrap();apps::browse::handle(&st.data_dir,&un,token.as_deref(),method.as_str(),&p[16..],&body)},
 (p,_) if p.starts_with("/api/apps/flick/")=>apps::flick::handle(&st,&u.unwrap(),method.as_str(),&p[16..],&query,&body).await,
 (p,_) if p.starts_with("/api/apps/jetstream/")=>{
  let un=u.unwrap();let sub=&p[19..];
  if sub=="/thumb/ticket"&&method==Method::POST {
                                                                                                                               
   return match wisp::thumb_ticket(&st.data_dir,&un){Some(t)=>json_ord(StatusCode::OK,vec![("ok",OJ::Bool(true)),("ticket",OJ::Str(t))]),None=>apps::io_fail()};
  }
  let up=apps::jetstream_up::AppUp(st.as_ref(),Some(st.clone()));                                             
  let qp:Vec<(String,String)>=query.iter().map(|(k,v)|(k.clone(),v.clone())).collect();
  let clock: apps::jetstream_feedroutes::Clock = std::sync::Arc::new(||apps::millis());
  if let Some(r)=apps::jetstream_up::handle_up(&st.jetstream_js,&up,&st.data_dir,&un,method.as_str(),sub,&qp,&clock).await{return r}
  apps::jetstream::handle(&st.data_dir,&un,method.as_str(),sub,&body)
 },
 (p,_) if p.starts_with("/api/admin/")=>{
  let username=u.unwrap();if username!=admin_name(){return err(StatusCode::FORBIDDEN,"admin only")}
  if p=="/api/admin/users"&&method==Method::GET {return match(st.auth_db.list(),approval(st)){(Ok(rows),Ok(a))=>{let rows=rows.iter().map(|v|{format!("{{\"name\":{},\"status\":{},\"created\":{}}}",v["name"],v["status"],v["created"])}).map(OJ::Raw).collect();json_ord(StatusCode::OK,vec![("ok",OJ::Bool(true)),("users",OJ::Arr(rows)),("requireApproval",OJ::Bool(a))])},_=>apps::io_fail()}}
  if method!=Method::POST{return err(StatusCode::METHOD_NOT_ALLOWED,"bad method")}
  let v=match parsed(){Ok(v)=>v,Err(r)=>return r};let target=text(&v,"name");if target==admin_name(){return err(StatusCode::BAD_REQUEST,"that's you")}
  let op=&p[11..];if !["approve","ban","unban","remove","logout"].contains(&op){return err(StatusCode::NOT_FOUND,"not found")}
  if ["ban","remove"].contains(&op){
   let key=format!("backoff:{username}");
   if let Some(ra)=st.rates.blocked(key.clone()){return limited(ra,"too many tries - wait a few minutes")}
   let ps=st.clone();let pt=token.unwrap();let pp=v["current"].as_str().unwrap_or("undefined").to_string();
   let verified=tokio::task::spawn_blocking(move||ps.auth_db.verify_password(&pt,&pp)).await.unwrap_or(None);
   if verified!=Some(true){st.rates.fail(key);return err(StatusCode::UNAUTHORIZED,"current password is wrong")}
   st.rates.reset(&key);
  }
  match st.auth_db.admin(&target,op){Ok(true)=>{st.lite.cred_cache.lock().unwrap_or_else(|e|e.into_inner()).clear();ok()},Ok(false)=>err(StatusCode::NOT_FOUND,"no such user"),Err(e) if e=="remove not implemented"=>err(StatusCode::NOT_IMPLEMENTED,"this part isn't ready yet."),Err(_)=>apps::io_fail()}
 },
 (p,_) if p.starts_with("/api/auth/")||p.starts_with("/api/apps/banter/")||p.starts_with("/api/banter/")=>err(StatusCode::NOT_IMPLEMENTED,"this part isn't ready yet."),
 ("/api/sys","GET")=>crate::sys::handle(st),
 ("/api/adblock-stats","GET")=>st.adblock.stats_handler(&u.unwrap()),
 ("/api/pfetch","POST")=>{
                                                                                          
                                                                                             
                                                                            
  let cookie_user=user(st,&h);
  crate::pfetch::handle(st,cookie_user,&body).await
 },
 _=>err(StatusCode::NOT_FOUND,"not found")
 }
}

pub fn boot_check(dir:&std::path::Path)->std::io::Result<()>{
 use std::os::unix::fs::MetadataExt;
 let m=dir.symlink_metadata()?;if !m.is_dir()||m.mode()&0o777!=0o700||m.uid()!=unsafe{libc::geteuid()}{return Err(std::io::Error::other("DATA owner/mode mismatch"))}
 let p=dir.join(format!(".inc2-dirsync-probe-{}",std::process::id()));
 use std::io::Write;use std::os::unix::fs::OpenOptionsExt;
 let result=(||{let mut f=std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&p)?;f.write_all(b"probe")?;f.sync_all()?;std::fs::File::open(dir)?.sync_all()?;std::fs::remove_file(&p)?;std::fs::File::open(dir)?.sync_all()})();
 result
}

fn amp_track(st:&crate::AppState,user:&str)->apps::amp_media::Track{
 let dd=st.data_dir.to_string_lossy().to_string();let u=user.to_string();let g=st.guard.clone();
 std::sync::Arc::new(move |n:i64|g.track_bytes(&dd,&u,n))
}

fn limited(ra:u64,m:&str)->Response{let mut r=err(StatusCode::TOO_MANY_REQUESTS,m);r.headers_mut().insert("retry-after",ra.max(1).to_string().parse().unwrap());r}

pub fn deferred(p:&str,m:&Method)->bool{matches!((p,m.as_str()),("/api/banter/state",_)|("/api/auth/export",_)|("/api/auth/sudo","POST")|("/api/auth/sessions","GET")|("/api/auth/sessions/revoke","POST")|("/api/auth/rename","POST"))}
#[cfg(test)]mod gate_tests{
 use super::*;
 #[test]fn csrf_exact(){let mut h=HeaderMap::new();assert!(!csrf(&h));h.insert("sec-fetch-site","same-origin".parse().unwrap());assert!(csrf(&h));h.append("sec-fetch-site","cross-site".parse().unwrap());assert!(!csrf(&h));h.insert("x-ramjet-js","".parse().unwrap());assert!(csrf(&h))}
 #[test]fn no_bearer_and_duplicate_cookie(){let mut h=HeaderMap::new();h.insert("authorization",format!("Bearer {}",store::token()).parse().unwrap());assert!(cookie(&h).is_none());let t=store::token();h.insert("cookie",format!("bad=%; rj2_session={t}").parse().unwrap());assert_eq!(cookie(&h),Some(t.clone()));h.append("cookie",format!("rj2_session={t}").parse().unwrap());assert!(cookie(&h).is_none())}
 #[test]fn deferred_exact_methods(){assert!(deferred("/api/banter/state",&Method::GET));assert!(deferred("/api/auth/rename",&Method::POST));assert!(!deferred("/api/auth/rename",&Method::GET));assert!(!deferred("/api/prefs",&Method::POST))}
}
