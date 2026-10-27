                                                                                 
                                                                                 
                                                                              
                                                                                    
                                                                                       
                                                                                      
                                                                                      
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use crate::lite::{json_ord, json_err, OJ};
use crate::apps::{self, js_slice16, js_string, js_trim, js_ws_collapse, parse_body2, BodyErr};
use serde_json::json;

const CODE_ABC: &[u8] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";                                                    
const CODE_TTL_MS: i64 = 10 * 60 * 1000;
struct Delivery { token: String, id: String, expires: i64, consumed: Option<i64> }
static PAIR_LOCK: Mutex<()> = Mutex::new(());
static PENDING_TOKENS: OnceLock<Mutex<HashMap<String, Delivery>>> = OnceLock::new();                               
static APPROVE_FAILS: OnceLock<Mutex<HashMap<String, (u32, i64)>>> = OnceLock::new();

fn map<T>(m: &'static OnceLock<Mutex<HashMap<String, T>>>) -> std::sync::MutexGuard<'_, HashMap<String, T>> {
    m.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner())
}
                                                                                      
fn gen_code() -> Option<String> {
    use rand::RngCore;
    let mut b = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut b);
    let mut x = u64::from_be_bytes(b);
    let mut s = String::with_capacity(8);
    for _ in 0..8 { s.push(CODE_ABC[(x % 30) as usize] as char); x /= 30; }
    Some(s.chars().rev().collect())
}
fn fmt_code(c: &str) -> String { format!("{}-{}", &c[..4], &c[4..]) }
fn norm_code(v: &Value) -> String {
    js_string(v).chars().filter(|c| !matches!(c, '-' | ' ')).map(|c| c.to_ascii_uppercase()).collect()
}
fn code_ok(c: &str) -> bool { c.len() == 8 && c.bytes().all(|b| CODE_ABC.contains(&b)) }
fn clean_name(v: &Value) -> String { js_slice16(js_trim(&js_ws_collapse(&js_string(v))), 40).to_string() }

fn limited(secs: u64) -> Response {
    let mut r = json_err(StatusCode::TOO_MANY_REQUESTS, "too many tries - wait a few minutes");
    r.headers_mut().insert("retry-after", secs.max(1).to_string().parse().unwrap());
    r
}
fn dead_code(state: &str) -> Response {
    let state = if matches!(state,"expired"|"consumed"|"superseded"|"denied") { state } else { "unknown" };
    json_ord(StatusCode::GONE, vec![("ok",OJ::Bool(false)),("state",OJ::Str(state.into())),("error",OJ::Str((if state=="expired" { "that code ran out of time." } else { "that code isn't valid anymore." }).into()))])
}
fn no_code() -> Response { dead_code("unknown") }
fn code_failure(st:&crate::AppState,code:&str)->Response {
    match st.auth_db.pair_code_info(code) { Ok(Some((_,state,_)))=>dead_code(&state),Ok(None)=>no_code(),Err(_)=>apps::io_fail() }
}
fn cooldown(user:&str)->Option<Response>{
    let n=super::store::pair_now();let mut m=map(&APPROVE_FAILS);m.retain(|_,(_,until)|*until>=n-600000);
    m.get(user).filter(|(_,until)|*until>n).map(|(_,until)|limited(((*until-n+999)/1000) as u64))
}
fn wrong_code(user:&str){let mut m=map(&APPROVE_FAILS);let e=m.entry(user.into()).or_insert((0,0));e.0+=1;e.1=super::store::pair_now();if e.0>=5{e.0=0;e.1+=60000;}}
fn replay_live(at:i64,n:i64)->bool{n.saturating_sub(at)<60000}
fn sweep_deliveries(st:&crate::AppState)->Result<(),String>{
    st.auth_db.pair_sweep()?;let n=super::store::pair_now();map(&PENDING_TOKENS).retain(|_,v|match v.consumed {Some(at)=>replay_live(at,n),None=>v.expires>n});Ok(())
}


                        
pub fn pair(st: &crate::AppState, body: &[u8]) -> Response {
    let b = match parse_body2(body, 65536) { Ok(Some(v)) => v, Ok(None) => json!({}), Err(BodyErr::TooLarge) => return apps::too_large() };
    let _serial=PAIR_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    if sweep_deliveries(st).is_err(){return apps::io_fail()}
    let client=b["deviceId"].as_str().filter(|v|!v.is_empty()&&v.len()<=128&&v.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'||c==b'_'));
    if b.get("deviceId").is_some()&&client.is_none(){return json_err(StatusCode::BAD_REQUEST,"bad device id")}
    let name = clean_name(&b["name"]);
    let Some(poll) = apps::hex_id(12) else { return apps::io_fail() };            
    let mut code = None;
    for _ in 0..8 {                                                                   
        let Some(c) = gen_code() else { return apps::io_fail() };
        match st.auth_db.pair_pending_by_code(&c) {
            Ok(None) => { code = Some(c); break; }
            Ok(Some(_)) => continue,
            Err(_) => return apps::io_fail(),
        }
    }
    let Some(code) = code else { return apps::io_fail() };
    let expires = super::store::pair_now() + CODE_TTL_MS;
    if st.auth_db.pair_create_scoped(&poll, &code, &name, expires, client).is_err() { return apps::io_fail(); }
    json_ord(StatusCode::OK, vec![
        ("ok", OJ::Bool(true)), ("code", OJ::Str(fmt_code(&code))),
        ("poll", OJ::Str(poll)), ("expires", OJ::U64(expires as u64)),                                
    ])
}
pub fn poll_handle(poll:&str)->Option<String>{
    let poll=js_trim(poll);
    (poll.len()==24&&poll.bytes().all(|b|b.is_ascii_hexdigit())).then(||poll.to_ascii_lowercase())
}
pub fn pair_status(st: &crate::AppState, poll: &str) -> Response {
    let _serial=PAIR_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    if sweep_deliveries(st).is_err(){return apps::io_fail()}
    match st.auth_db.pair_info(poll) {
        Ok(Some((state,_,_))) if matches!(state.as_str(),"pending"|"approved"|"denied") => json_ord(StatusCode::OK,vec![("ok",OJ::Bool(true)),("state",OJ::Str(state))]),
        Ok(Some((state,_,_)))=>dead_code(&state),Ok(None)=>no_code(),Err(_)=>apps::io_fail(),
    }
}
pub fn pair_consume(st:&crate::AppState,body:&[u8])->Response {
    let b=match parse_body2(body,65536){Ok(Some(v))=>v,Ok(None)=>return json_err(StatusCode::BAD_REQUEST,"bad request"),Err(BodyErr::TooLarge)=>return apps::too_large()};
    let Some(poll)=b.get("poll").and_then(Value::as_str).and_then(poll_handle) else{return json_err(StatusCode::BAD_REQUEST,"bad request")};let _serial=PAIR_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    if sweep_deliveries(st).is_err(){return apps::io_fail()}
    let state=match st.auth_db.pair_info(&poll){Ok(Some((s,_,_)))=>s,Ok(None)=>return no_code(),Err(_)=>return apps::io_fail()};
    if state=="pending"{return json_err(StatusCode::CONFLICT,"not approved yet")}
    if state=="denied"{return dead_code("denied")}
    let mut deliveries=map(&PENDING_TOKENS);
    let Some(delivery)=deliveries.get_mut(&poll) else {return if state=="approved"||state=="consumed"{dead_code("consumed")}else{dead_code(&state)}};
    if state=="approved" {
        match st.auth_db.pair_consume_atomic(&poll){Ok(true)=>delivery.consumed=Some(super::store::pair_now()),Ok(false)=>return match st.auth_db.pair_info(&poll){Ok(Some((state,_,_)))=>dead_code(&state),_=>no_code()},Err(_)=>return apps::io_fail()}
    } else if state!="consumed" {return dead_code(&state)}
                                                                     
    if st.auth_db.device_resolve(&delivery.token).ok().flatten().is_none(){return dead_code("consumed")}
    json_ord(StatusCode::OK,vec![("ok",OJ::Bool(true)),("state",OJ::Str("consumed".into())),("token",OJ::Str(delivery.token.clone())),("id",OJ::Str(delivery.id.clone()))])
}

                           
                                                                                  
                                                                
pub fn pair_lookup(st:&crate::AppState,user:&str,body:&[u8])->Response{
    let b=match parse_body2(body,65536){Ok(Some(v))=>v,Ok(None)=>return json_err(StatusCode::BAD_REQUEST,"bad request"),Err(BodyErr::TooLarge)=>return apps::too_large()};
    if let Some(r)=cooldown(user){return r}let _serial=PAIR_LOCK.lock().unwrap_or_else(|e|e.into_inner());if let Some(r)=cooldown(user){return r}
    let code=norm_code(&b["code"]);
    match st.auth_db.pair_code_info(&code){
        Ok(Some((_,state,name))) if state=="pending"=>json_ord(StatusCode::OK,vec![("ok",OJ::Bool(true)),("name",OJ::Str(name))]),
        Ok(None)=>{wrong_code(user);no_code()},Ok(Some((_,state,_)))=>dead_code(&state),Err(_)=>apps::io_fail(),
    }
}
pub fn approve(st:&crate::AppState,user:&str,body:&[u8])->Response{
    let b=match parse_body2(body,65536){Ok(Some(v))=>v,Ok(None)=>return json_err(StatusCode::BAD_REQUEST,"bad request"),Err(BodyErr::TooLarge)=>return apps::too_large()};
    if let Some(r)=cooldown(user){return r}let _serial=PAIR_LOCK.lock().unwrap_or_else(|e|e.into_inner());if let Some(r)=cooldown(user){return r}
    let code=norm_code(&b["code"]);
    let (poll,name)=match st.auth_db.pair_code_info(&code){Ok(Some((poll,state,name))) if state=="pending"=>(poll,name),Ok(None)=>{wrong_code(user);return no_code()},Ok(Some((_,state,_)))=>return dead_code(&state),Err(_)=>return apps::io_fail()};
    let Some(id)=apps::hex_id(4)else{return apps::io_fail()};let Some(token)=apps::hex_id(24)else{return apps::io_fail()};
    match st.auth_db.pair_approve_atomic(&poll,user,&id,&token){Ok(true)=>{},Ok(false)=>return code_failure(st,&code),Err(_)=>return apps::io_fail()}
    let expires=match st.auth_db.pair_info(&poll){Ok(Some((state,_,exp))) if state=="approved"=>exp,Ok(Some((state,_,_)))=>return dead_code(&state),_=>return apps::io_fail()};
    map(&PENDING_TOKENS).insert(poll,Delivery{token,id:id.clone(),expires,consumed:None});map(&APPROVE_FAILS).remove(user);
    json_ord(StatusCode::OK,vec![("ok",OJ::Bool(true)),("device",OJ::Raw(format!("{{\"id\":{},\"name\":{}}}",serde_json::to_string(&id).unwrap(),serde_json::to_string(&name).unwrap())))])
}
pub fn deny(st: &crate::AppState,user:&str, body: &[u8]) -> Response {
    let b = match parse_body2(body, 65536) { Ok(Some(v)) => v, Ok(None) => return json_err(StatusCode::BAD_REQUEST, "bad request"), Err(BodyErr::TooLarge) => return apps::too_large() };
    if let Some(r)=cooldown(user){return r}
    let _serial=PAIR_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    if let Some(r)=cooldown(user){return r}
    let code = norm_code(&b["code"]);
    let found = if code_ok(&code) {
        match st.auth_db.pair_pending_by_code(&code) { Ok(r) => r, Err(_) => return apps::io_fail() }
    } else { None };
    let Some((poll, _)) = found else { if matches!(st.auth_db.pair_code_info(&code),Ok(None)){wrong_code(user)}return code_failure(st,&code); };
    match st.auth_db.pair_deny_atomic(&poll){Ok(true)=>{},Ok(false)=>return code_failure(st,&code),Err(_)=>return apps::io_fail()}
    apps::ok_true()
}
pub fn list(st: &crate::AppState, user: &str) -> Response {
    let _serial=PAIR_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    if sweep_deliveries(st).is_err(){return apps::io_fail()}
    let rows = match st.auth_db.device_list(user) { Ok(r) => r, Err(_) => return apps::io_fail() };
                                                     
    let arr: Vec<OJ> = rows.iter().map(|(id, name, created, last)| OJ::Raw(format!(
        "{{\"id\":{},\"name\":{},\"created\":{},\"last_used\":{}}}",
        serde_json::to_string(id).unwrap(), serde_json::to_string(name).unwrap(), created,
        last.map(|v| v.to_string()).unwrap_or_else(|| "null".into())))).collect();
    json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("devices", OJ::Arr(arr))])
}
pub fn revoke(st: &crate::AppState, user: &str, body: &[u8]) -> Response {
    let b = match parse_body2(body, 65536) { Ok(Some(v)) => v, Ok(None) => return json_err(StatusCode::BAD_REQUEST, "bad request"), Err(BodyErr::TooLarge) => return apps::too_large() };
    let id = js_string(&b["id"]);
    match st.auth_db.device_revoke(user, &id) {
        Ok(true) => { crate::apps::browse_render::revoke_device(user,&id); apps::ok_true() }                                                     
        Ok(false) => json_err(StatusCode::NOT_FOUND, "that device is gone"),
        Err(_) => apps::io_fail(),
    }
}

                                                                                                   
pub fn revoke_known(st:&crate::AppState,user:&str,id:&str,body:&[u8])->Response{
 let b=match parse_body2(body,65536){Ok(Some(v))=>v,Ok(None)=>return json_err(StatusCode::BAD_REQUEST,"bad request"),Err(BodyErr::TooLarge)=>return apps::too_large()};
 if js_string(&b["id"])!=id{return json_err(StatusCode::FORBIDDEN,"this device can't do that")}
 revoke(st,user,body)
}
pub fn revoke_self(st: &crate::AppState, h: &axum::http::HeaderMap, body: &[u8]) -> Response {
    let b = match parse_body2(body, 65536) { Ok(Some(v)) => v, Ok(None) => return json_err(StatusCode::BAD_REQUEST, "bad request"), Err(BodyErr::TooLarge) => return apps::too_large() };
    let own = bearer_token(h).and_then(|t| resolve_token(st, &t));
    let Some((u, id)) = own else { return json_err(StatusCode::UNAUTHORIZED, "not signed in") };
    if js_string(&b["id"]) != id { return json_err(StatusCode::FORBIDDEN, "this device can't do that") }
    revoke(st, &u, body)
}

pub fn start_pair_sweeper(st:std::sync::Arc<crate::AppState>){
    tokio::spawn(async move{let mut ticks=tokio::time::interval(Duration::from_secs(5));loop{ticks.tick().await;let st=st.clone();let _=tokio::task::spawn_blocking(move||{let _serial=PAIR_LOCK.lock().unwrap_or_else(|e|e.into_inner());if sweep_deliveries(&st).is_err(){tracing::warn!("pair expiry sweep failed");}}).await;}});
}

                                                                              
pub fn token_shape(t: &str) -> bool {
    t.len() == 48 && t.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
pub fn bearer_token(h: &axum::http::HeaderMap) -> Option<String> {
    let t = h.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ")?;
    if token_shape(t) { Some(t.to_string()) } else { None }
}
#[derive(Clone)]
pub struct DeviceIdentity(pub String,pub String);
#[derive(Clone)]
pub struct DeviceAuth(pub Option<DeviceIdentity>);
pub fn resolve_token(st:&crate::AppState,token:&str)->Option<(String,String)>{
    if !token_shape(token){return None}
    let(user,id)=st.auth_db.device_resolve(token).ok()??;
    static TOUCH:OnceLock<Mutex<HashMap<String,std::time::Instant>>>=OnceLock::new();
    let touch={let mut m=map(&TOUCH);let n=std::time::Instant::now();m.retain(|_,at|n.duration_since(*at)<Duration::from_secs(600));if m.get(&id).is_some_and(|at|at.elapsed()<Duration::from_secs(60)){false}else{if m.len()>=10000{m.clear()}m.insert(id.clone(),n);true}};
    if touch{let _=st.auth_db.device_touch(&id);}Some((user,id))
}
fn resolve_slots()->&'static std::sync::Arc<tokio::sync::Semaphore>{static S:OnceLock<std::sync::Arc<tokio::sync::Semaphore>>=OnceLock::new();S.get_or_init(||std::sync::Arc::new(tokio::sync::Semaphore::new(16)))}
pub async fn resolve_bounded(st:std::sync::Arc<crate::AppState>,token:String)->Result<Option<(String,String)>,()>{
    resolve_with_slots(st,token,resolve_slots().clone()).await
}
async fn resolve_with_slots(st:std::sync::Arc<crate::AppState>,token:String,slots:std::sync::Arc<tokio::sync::Semaphore>)->Result<Option<(String,String)>,()>{
    if !token_shape(&token){return Ok(None)}
    let permit=slots.try_acquire_owned().map_err(|_|())?;
    match tokio::task::spawn_blocking(move||{let _permit=permit;resolve_token(&st,&token)}).await{Ok(v)=>Ok(v),Err(e)=>{tracing::warn!("device resolution task failed: {e}");Err(())}}
}
pub fn bearer_user(st: &crate::AppState, h: &axum::http::HeaderMap) -> Option<String> {
    resolve_token(st, &bearer_token(h)?).map(|(u, _)| u)
}
                                                                                             
pub fn scope_allows(path: &str, method: &str) -> bool {
    path.starts_with("/api/apps/sage/")
        || path.starts_with("/api/apps/amp/")
        || (path.starts_with("/api/apps/flick/") && method == "GET")                                                                                    
        || path.starts_with("/api/apps/browse/render/")                                                                            
        || path.starts_with("/api/apps/jetstream/")                                          
        || path == "/api/jetstream/thumb" || path.starts_with("/api/jetstream/thumb/")                                                              
        || (path == "/api/auth/me" && method == "GET")                                               
        || (path == "/api/devices/revoke" && method == "POST")
        || (path == "/api/prefs" && method == "GET")
        || (path == "/api/devices/pair/status" && method == "GET")
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn fixture(user:&str)->crate::AppState {
        use std::os::unix::fs::PermissionsExt;
        let dir=std::env::temp_dir().join(format!("pair-v34-{}",apps::hex_id(8).unwrap()));std::fs::create_dir_all(&dir).unwrap();
        let db=dir.join("auth.db");std::fs::write(&db,b"").unwrap();std::fs::set_permissions(&db,std::fs::Permissions::from_mode(0o600)).unwrap();
        let auth_db=super::super::store::AuthStore::open(&db).unwrap();auth_db.claim(user,"fixture pass",false).unwrap();
        crate::AppState{data_dir:dir.clone(),auth_db,tickets:Default::default(),guard:std::sync::Arc::new(crate::guard::Guard::load(&dir.to_string_lossy())),rates:Default::default(),egress_client:None,pfetch_client:None,adblock:crate::adblock::Adblock::load(&dir),started:std::time::Instant::now(),local_http:reqwest::Client::new(),searx_url:"http://127.0.0.1:1".into(),ytdlp:"/bin/false".into(),proxy_url:String::new(),lite:crate::lite::LiteState::new(),jetstream_js:crate::apps::jetstream_up::Js::new()}
    }
    async fn response_json(r:Response)->Value {serde_json::from_slice(&axum::body::to_bytes(r.into_body(),65536).await.unwrap()).unwrap()}
    #[tokio::test]async fn legitimate_terminal_codes_do_not_spend_budget_and_success_resets(){
        let user="reset-fixture";let st=fixture(user);
        st.auth_db.pair_create_scoped("111111111111111111111111","AB23CD45","tv",super::super::store::pair_now()+600000,None).unwrap();assert!(st.auth_db.pair_deny_atomic("111111111111111111111111").unwrap());
        for _ in 0..8{assert_eq!(approve(&st,user,b"{\"code\":\"AB23CD45\"}").status(),StatusCode::GONE);assert_eq!(deny(&st,user,b"{\"code\":\"AB23CD45\"}").status(),StatusCode::GONE);}
        assert!(cooldown(user).is_none());for body in [b"{".as_slice(),b"{}",b"{\"poll\":1}",b"{\"poll\":null}",b"[]"]{assert_eq!(pair_consume(&st,body).status(),StatusCode::BAD_REQUEST);}
        assert_eq!(response_json(pair_consume(&st,b"{\"poll\":\"111111111111111111111111\"}")).await,json!({"ok":false,"state":"denied","error":"that code isn't valid anymore."}));
        for _ in 0..4{assert_eq!(deny(&st,user,b"{\"code\":\"BAD\"}").status(),StatusCode::GONE);}
        st.auth_db.pair_create_scoped("valid-reset","AB23CD46","tv",super::super::store::pair_now()+600000,None).unwrap();assert_eq!(approve(&st,user,b"{\"code\":\"AB23CD46\"}").status(),StatusCode::OK);
        assert!(!map(&APPROVE_FAILS).contains_key(user));
        for _ in 0..5{assert_eq!(deny(&st,user,b"{\"code\":\"BAD\"}").status(),StatusCode::GONE);}
        assert_eq!(pair_lookup(&st,user,b"{\"code\":\"BAD\"}").status(),StatusCode::TOO_MANY_REQUESTS);map(&APPROVE_FAILS).remove(user);
    }
    #[tokio::test]async fn pregate_resolution_saturation_fails_fast(){let st=std::sync::Arc::new(fixture("saturated-fixture"));let slots=std::sync::Arc::new(tokio::sync::Semaphore::new(16));let permit=slots.clone().acquire_many_owned(16).await.unwrap();assert!(resolve_with_slots(st.clone(),"a".repeat(48),slots.clone()).await.is_err());assert!(resolve_with_slots(st,"garbage".into(),slots).await.unwrap().is_none());drop(permit);}
    #[test]fn replay_exact_boundaries(){for(age,live)in[(59999,true),(60000,false),(60001,false)]{assert_eq!(replay_live(1000,1000+age),live)}}
    #[tokio::test]
    async fn consume_poll_replay_and_shared_lookup_budget(){
        let st=fixture("delivery-fixture");let created=response_json(pair(&st,b"{\"name\":\"tv\",\"deviceId\":\"tv-A\"}")).await;
        let poll=created["poll"].as_str().unwrap();let code=created["code"].as_str().unwrap();
        let req=serde_json::to_vec(&json!({"poll":poll})).unwrap();
        assert_eq!(pair_consume(&st,&req).status(),StatusCode::CONFLICT);
        assert_eq!(approve(&st,"delivery-fixture",&serde_json::to_vec(&json!({"code":code})).unwrap()).status(),StatusCode::OK);
        let status=response_json(pair_status(&st,poll)).await;assert_eq!(status,json!({"ok":true,"state":"approved"}));
        let a=response_json(pair_consume(&st,&req)).await;let b=response_json(pair_consume(&st,&req)).await;assert_eq!(a,b);assert_eq!(a["state"],"consumed");
        assert_eq!(pair_status(&st,poll).status(),StatusCode::GONE);
        {let _serial=PAIR_LOCK.lock().unwrap_or_else(|e|e.into_inner());map(&PENDING_TOKENS).get_mut(poll).unwrap().consumed=Some(super::super::store::pair_now()-60001);}
        assert_eq!(pair_consume(&st,&req).status(),StatusCode::GONE);
        for _ in 0..5 {assert_eq!(pair_lookup(&st,"budget-user",b"{\"code\":\"BAD\"}").status(),StatusCode::GONE);}
        assert_eq!(approve(&st,"budget-user",b"{\"code\":\"BAD\"}").status(),StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(pair_lookup(&st,"budget-user",b"{\"code\":\"BAD\"}").status(),StatusCode::TOO_MANY_REQUESTS);
    }
    #[test]
    fn code_shape_and_norm() {
        for _ in 0..64 {
            let c = gen_code().unwrap();
            assert!(code_ok(&c), "{c}");
            assert_eq!(fmt_code(&c).len(), 9);
        }
        assert_eq!(norm_code(&json!("ab23- cd45")), "AB23CD45");
        assert!(!code_ok("AB23CD4O"));                
        assert!(!code_ok("AB23CD41"));                
        assert!(!code_ok("short"));
    }
    #[test]
    fn scope_matrix() {
        assert!(scope_allows("/api/apps/sage/conversations", "POST"));
        assert!(scope_allows("/api/apps/amp/stream", "GET"));
        assert!(scope_allows("/api/apps/flick/search", "GET"));
        assert!(scope_allows("/api/apps/flick/trending", "GET"));
        assert!(!scope_allows("/api/apps/flick/search", "POST"));                            
        assert!(!scope_allows("/api/apps/flick", "GET"));                                                               
        assert!(scope_allows("/api/prefs", "GET"));
        assert!(scope_allows("/api/devices/pair/status", "GET"));
        assert!(!scope_allows("/api/prefs", "POST"));
        assert!(!scope_allows("/api/admin/users", "GET"));
        assert!(!scope_allows("/api/auth/password", "POST"));
        assert!(scope_allows("/api/devices/revoke", "POST"));
        assert!(!scope_allows("/api/devices/revoke", "GET"));
        assert!(!scope_allows("/api/devices", "GET"));
        assert!(!scope_allows("/api/media-bridge/ticket", "POST"));
        assert!(!scope_allows("/api/apps/browse/sync", "GET"));
        assert!(scope_allows("/api/auth/me", "GET"));
        assert!(!scope_allows("/api/auth/me", "POST"));
        assert!(scope_allows("/api/apps/jetstream/stream", "GET"));                           
        assert!(scope_allows("/api/jetstream/thumb", "GET"));
    }
}
