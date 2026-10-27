                                                                                    
                                                                                  
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use std::path::PathBuf;
use std::sync::Arc;
use crate::AppState;

type Shared = (Arc<AppState>, PathBuf);

const ENGINE_CSP: &str = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; font-src 'self'";
const READER_CSP: &str = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'sha256-N5L2PHwxMu1hRF6CV7edkZg9sVjmkB30mHoh89Ai6S8='; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; font-src 'self'";
fn engine_headers(builder: axum::http::response::Builder, csp: &str) -> axum::http::response::Builder {
    builder.header("content-security-policy", csp).header("x-content-type-options", "nosniff").header("referrer-policy", "no-referrer")
}

const IMG_PERMITS:usize=8;                                                                 
const IMG_MAX_WAITERS:usize=256;                                                       
const IMG_WAIT:std::time::Duration=std::time::Duration::from_secs(20);
struct ImgGate{sem:tokio::sync::Semaphore,waiting:std::sync::atomic::AtomicUsize}
static IMG_GATE:ImgGate=ImgGate{sem:tokio::sync::Semaphore::const_new(IMG_PERMITS),waiting:std::sync::atomic::AtomicUsize::new(0)};
struct WaitSlot<'a>(&'a std::sync::atomic::AtomicUsize);
impl Drop for WaitSlot<'_>{fn drop(&mut self){self.0.fetch_sub(1,std::sync::atomic::Ordering::SeqCst);}}
                                                                                       
                                                                               
async fn img_acquire(g:&'static ImgGate,max:usize,wait:std::time::Duration)->Result<tokio::sync::SemaphorePermit<'static>,()>{
    if let Ok(p)=g.sem.try_acquire(){return Ok(p)}
    if g.waiting.fetch_add(1,std::sync::atomic::Ordering::SeqCst)>=max{g.waiting.fetch_sub(1,std::sync::atomic::Ordering::SeqCst);return Err(())}
    let _slot=WaitSlot(&g.waiting);
    match tokio::time::timeout(wait,g.sem.acquire()).await{Ok(Ok(p))=>Ok(p),_=>Err(())}
}
fn busy_503()->Response{Response::builder().status(503).header(header::RETRY_AFTER,"2").header(header::CACHE_CONTROL,"no-store").body(Body::empty()).unwrap()}

fn redirect(loc: String) -> Response {
    let mut r = StatusCode::FOUND.into_response();
    r.headers_mut().insert(header::LOCATION, loc.parse().unwrap());
    r
}

pub async fn handler(State((st, _)): State<Shared>, req: Request<Body>) -> Response {
                                                                                   
    if req.method() != axum::http::Method::GET && req.method() != axum::http::Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();                    
    }
    let uri = req.uri().clone();
    let path = uri.path().trim_start_matches("/searx");
    let q = uri.query().unwrap_or("");
    let head_only = req.method() == axum::http::Method::HEAD;
    let cookie_hdr = req.headers().get(header::COOKIE).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    if path!="/img"{
        let user=crate::auth_api::user(&st,req.headers());
        let peer=req.extensions().get::<axum::extract::ConnectInfo<std::net::SocketAddr>>().map(|p|p.0);
        let actor=user.unwrap_or_else(||crate::auth_api::rate::client_ip(req.headers(),peer));
        let bucket=if path=="/reader"{"reader"}else{"search"};let limit=if path=="/reader"{30}else{60};
        if let Some(wait)=st.rates.window(format!("searx:{bucket}:{actor}"),limit,60000){return Response::builder().status(429).header(header::RETRY_AFTER,wait.to_string()).header(header::CACHE_CONTROL,"no-store").body(Body::from("slow down a bit.")).unwrap()}
        if !crate::apps::browse_render::memory_ok(&st.data_dir){return Response::builder().status(503).header(header::CACHE_CONTROL,"no-store").body(Body::from("the box is short on memory right now - try again in a bit")).unwrap()}
    }
    if path == "/img" {
                                                                                                    
                                                                                                      
        let _permit=match img_acquire(&IMG_GATE,IMG_MAX_WAITERS,IMG_WAIT).await{Ok(p)=>p,Err(()) =>return busy_503()};
        return match tokio::time::timeout(std::time::Duration::from_secs(12),img_proxy(&st,q,head_only)).await{Ok(r)=>r,Err(_)=>StatusCode::BAD_GATEWAY.into_response()};
    }
    if path == "/reader" {
        let tu = qp(q, "u").unwrap_or_default();
        let body = crate::searx_reader::reader_page_skin(&st, &tu, crate::searx_page::skin(cookie_hdr.as_deref())).await;
        let mut b = engine_headers(Response::builder().status(200), READER_CSP)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(body)).unwrap();
        if head_only { *b.body_mut() = Body::empty(); }
        return b;
    }
    if path != "/search" && path != "/" && path != "" { return redirect("/searx/search".into()); }
    search_page(&st, q, cookie_hdr.as_deref(), head_only).await
}

fn qp(query: &str, k: &str) -> Option<String> {
    url::form_urlencoded::parse(query.as_bytes()).find(|(kk, _)| kk == k).map(|(_, v)| v.into_owned())
}
fn qp_has(query: &str, k: &str) -> bool {
    url::form_urlencoded::parse(query.as_bytes()).any(|(kk, _)| kk == k)
}
fn parse_cookie<'a>(hdr: &'a str, name: &str) -> Option<&'a str> {
    for part in hdr.split(';') {
        let part = part.trim();
        if let Some((k, v)) = part.split_once('=') { if k.trim() == name { return Some(v.trim()); } }
    }
    None
}

async fn search_page(st: &std::sync::Arc<AppState>, query: &str, cookie_hdr: Option<&str>, head_only: bool) -> Response {
    let q = qp(query, "q").unwrap_or_default().trim().to_string();
                                                                                          
    if let Some(bang) = crate::searx_page::sx_bang(&q) {
        let j = serde_json::to_string(&bang).unwrap().replace('<', "\\u003c");
        let body = format!("<!doctype html><meta charset=utf-8><title>Opening</title><body style=\"background:#0a0a0a;color:#aaa;font:15px system-ui;padding:24px\">Opening...<script>var u={};location.replace(u)</script>", j);
        return engine_headers(Response::builder().status(200), ENGINE_CSP)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(body)).unwrap();
    }
    let page = qp(query, "p").and_then(|v| js_parse_int(&v)).unwrap_or(1).max(1);                                         
    let cat = qp(query, "c").unwrap_or_else(|| "general".into());
    let ck = cookie_hdr.and_then(|h| parse_cookie(h, "rjss")).and_then(|v| js_parse_int(v));                                     
    let mut safe: i64 = if qp_has(query, "s") { qp(query, "s").and_then(|v| js_parse_int(&v)).unwrap_or(-1) } else { ck.unwrap_or(-1) };                              
    if ![0, 1, 2].contains(&safe) { safe = 0; }
    let want_imgs = !q.is_empty() && cat == "general" && page == 1;
                                                                                    
                                                                                  
    let rail=async {if want_imgs{match tokio::time::timeout(std::time::Duration::from_secs(4),crate::searx_fetch::sx_fetch_rail(st,&q,safe)).await{Ok(r) if !r.down=>r.data,_=>None}}else{None}};
    let foreground=async {if q.is_empty(){None}else{Some(crate::searx_fetch::sx_fetch(st,&q,page,&cat,safe).await)}};
    let (result,img_data)=tokio::join!(foreground,rail);
    let (down, data) = match &result { None => (false, None), Some(r) => (r.down, r.data.as_ref()) };
    let failure = result.as_ref().and_then(|r| r.failure).or(if down { Some(crate::searx_page::Failure::Unavailable) } else { None });
    let html = crate::searx_page::sx_page_state(&q, page, failure, data, &cat, safe, img_data.as_ref(), crate::searx_page::skin(cookie_hdr));
    let mut b = engine_headers(Response::builder().status(200), ENGINE_CSP)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store");
    if qp_has(query, "s") {
        b = b.header(header::SET_COOKIE, format!("rjss={}; Path=/searx; Max-Age=31536000; SameSite=Lax; HttpOnly; Secure", safe));
    }
    let mut r = b.body(Body::from(html)).unwrap();
    if head_only { *r.body_mut() = Body::empty(); }
    r
}

                                                                        
fn js_parse_int(s: &str) -> Option<i64> {
    let t = s.trim_start();
    let t = t.strip_prefix('+').unwrap_or(t);
    let (neg, t) = match t.strip_prefix('-') { Some(r) => (true, r), None => (false, t) };
    let digits: usize = t.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 { return None; }
    let v: i64 = t[..digits].parse().ok()?;
    Some(if neg { -v } else { v })
}

async fn img_proxy(st: &AppState, query: &str,head_only:bool) -> Response {
    let get = |k: &str| -> Option<String> {
        url::form_urlencoded::parse(query.as_bytes()).find(|(kk, _)| kk == k).map(|(_, v)| v.into_owned())
    };
    let Some(u) = get("u") else { return StatusCode::BAD_REQUEST.into_response() };
    let Ok(t) = url::Url::parse(&u) else { return StatusCode::BAD_REQUEST.into_response() };
    if t.scheme() != "http" && t.scheme() != "https" { return StatusCode::BAD_REQUEST.into_response(); }
                                                                                   
                                                                                         
    let host_ok = match t.host_str() { Some(h) => crate::lite::ssrf::safe_lookup(h).await.is_ok(), None => false };
    if !host_ok { return StatusCode::BAD_REQUEST.into_response(); }
    let Some(client) = &st.egress_client else { return StatusCode::BAD_GATEWAY.into_response() };                
    let resp = match client.get(t.as_str())
        .header("accept", "image/*").header("user-agent", "Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(10))
        .send().await {
        Ok(r) => r,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let status = resp.status();
    if status.is_redirection() {
                                                                                      
                                                                                       
        let hops: Option<i64> = match get("h") {
            None => Some(0),
            Some(v) => js_parse_int(&v),
        };
        let Some(hops) = hops.filter(|&h| h < 3) else { return StatusCode::NOT_FOUND.into_response() };
        let Some(loc) = resp.headers().get("location").and_then(|v| v.to_str().ok()) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let Ok(nx) = t.join(loc) else { return StatusCode::NOT_FOUND.into_response() };
        return redirect(format!("/searx/img?h={}&u={}", hops + 1, crate::searx_fetch::enc_component(nx.as_str())));                                                               
    }
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let ct_ok = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"].iter().any(|p| ct.starts_with(p));
    if status != StatusCode::OK || !ct_ok { return StatusCode::NOT_FOUND.into_response(); }
    if resp.content_length().is_some_and(|n|n>3_000_000){return StatusCode::NOT_FOUND.into_response()}
                                                       
    let mut buf = Vec::new();
    let mut stream = resp;
    loop {
        match stream.chunk().await {
            Ok(Some(c)) => { if buf.len().saturating_add(c.len())>3_000_000{return StatusCode::NOT_FOUND.into_response()}buf.extend_from_slice(&c); }
            Ok(None) => break,
            Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
        }
    }
    Response::builder().status(200)
        .header(header::CONTENT_TYPE, ct)
        .header(header::CONTENT_LENGTH,buf.len())
        .header(header::CACHE_CONTROL, "private, max-age=86400")
        .header("x-content-type-options", "nosniff")
        .body(if head_only{Body::empty()}else{Body::from(buf)}).unwrap()
}

#[cfg(test)]
mod security_header_tests {
    #[tokio::test]async fn reserve_missing_or_malformed_fails_closed(){
        let st=std::sync::Arc::new(crate::auth_api::devices::tests::fixture("reserve-fixture"));
                                                                                                        
                                                                                                        
                                                                                                          
                                                                                                   
                                                                                                     
                                                                                                       
                                                                                  
        let forced=matches!(crate::apps::browse_render::hooks().guard,Some(true));
        for text in [None,Some("{}"),Some("not json")]{if let Some(text)=text{std::fs::write(st.data_dir.join("ilhsmc.json"),text).unwrap();}
            let req=Request::builder().uri("/searx/search?q=fixture").body(Body::empty()).unwrap();let r=handler(State((st.clone(),std::path::PathBuf::new())),req).await;
            assert_eq!(r.status(),if forced{StatusCode::OK}else{StatusCode::SERVICE_UNAVAILABLE},"forced_guard={forced} reserve={text:?}");
        }
    }

    use super::*;
    #[test] fn reader_script_hash_matches_exact_inline_bytes() {
        use sha2::{Digest, Sha256}; use base64::Engine;
        let script = include_str!("../assets/reader-go.js").strip_prefix("<script>").unwrap().strip_suffix("</script>").unwrap();
        let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(script.as_bytes()));
        assert!(READER_CSP.contains(&format!("'sha256-{hash}'")));
    }
    #[test] fn all_engine_header_sets_are_closed() {
        for csp in [ENGINE_CSP, READER_CSP] {
            let r = engine_headers(Response::builder().status(200), csp).body(Body::empty()).unwrap();
            assert_eq!(r.headers()["x-content-type-options"], "nosniff");
            assert_eq!(r.headers()["referrer-policy"], "no-referrer");
            for directive in ["base-uri 'none'", "form-action 'self'", "frame-ancestors 'self'", "font-src 'self'"] { assert!(csp.contains(directive)); }
        }
    }
}

#[cfg(test)]
mod img_gate_tests {
    use super::*;
    use std::sync::atomic::Ordering::SeqCst;
    fn gate(n:usize)->&'static ImgGate{Box::leak(Box::new(ImgGate{sem:tokio::sync::Semaphore::new(n),waiting:std::sync::atomic::AtomicUsize::new(0)}))}
    #[tokio::test]async fn waiter_gets_permit_when_one_frees(){
        let g=gate(1);let p=img_acquire(g,4,std::time::Duration::from_secs(2)).await.unwrap();
        let w=tokio::spawn(img_acquire(g,4,std::time::Duration::from_secs(2)));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;assert_eq!(g.waiting.load(SeqCst),1);
        drop(p);assert!(w.await.unwrap().is_ok());assert_eq!(g.waiting.load(SeqCst),0);
    }
    #[tokio::test]async fn queue_cap_fails_fast_and_counts_stay_exact(){
        let g=gate(1);let _p=img_acquire(g,1,std::time::Duration::from_secs(2)).await.unwrap();
        let w=tokio::spawn(img_acquire(g,1,std::time::Duration::from_secs(5)));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let t=std::time::Instant::now();assert!(img_acquire(g,1,std::time::Duration::from_secs(5)).await.is_err());assert!(t.elapsed()<std::time::Duration::from_millis(500));
        assert_eq!(g.waiting.load(SeqCst),1);w.abort();let _=w.await;assert_eq!(g.waiting.load(SeqCst),0);
    }
    #[tokio::test]async fn wait_timeout_returns_err_and_releases_slot(){
        let g=gate(1);let _p=img_acquire(g,4,std::time::Duration::from_secs(1)).await.unwrap();
        assert!(img_acquire(g,4,std::time::Duration::from_millis(100)).await.is_err());assert_eq!(g.waiting.load(SeqCst),0);
    }
    #[test]fn busy_503_has_retry_after_and_no_store(){let r=busy_503();assert_eq!(r.status(),503);assert_eq!(r.headers()["retry-after"],"2");assert_eq!(r.headers()["cache-control"],"no-store");}
}
