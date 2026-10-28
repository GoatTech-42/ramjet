                                                                                           
                                                                                            
                                                                                              
   
                                                             
                                                                                             
                                                                                            
                                                                                            
                                                                                        
                                                                                        
                                                                                     
                                                                                    
                                                                                            
                                                                                                    
                                    
                                                                                               
                                                                                                 
                                                                                              
                                                                              
                                                                                            
                                                                                             
                                                                                              
                                                                                         
                                                                                             
                                                                                           
                                                                                             
                                                                                            
                                                                                               
                                                                          
                                                                                             
                                                                                       
                                                                           
                                                
                                                                                             
                                                       
                                                                                        
                                                                                           
                                                                                           
                                                                                          
                                              
                                                                                          
                                                                                          
                                                                                          
                                                                              
                                                                                   
                                                                               
                                                                                      
                                                                                        
                                                                                     
                                                                                     

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::Response;
use serde_json::Value;

const HOP: &[&str] = &["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "content-encoding", "content-length"];
                                                                                           
                                                                                          
                                                                                         
const MAX_HEADER_PAIRS: usize = 64;
const MAX_HEADER_BYTES: usize = 16 * 1024;                           
                                                                                               
const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const DROP_REQ: &[&str] = &["host", "connection", "content-length", "accept-encoding", "x-forwarded-for", "x-real-ip", "forwarded", "via",
    "transfer-encoding", "te", "upgrade", "expect", "keep-alive", "trailer", "proxy-authorization", "proxy-authenticate",
    "cf-connecting-ip", "true-client-ip", "x-ramjet-js", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"];

fn fail(code: StatusCode, msg: &str) -> Response {
                                                                                             
                                                                                     
    let safe: String = msg.chars().filter(|c| matches!(c, ' '..='~')).collect();
    Response::builder().status(code).header("x-rj-error", safe).header(header::CACHE_CONTROL, "no-store").body(Body::empty()).unwrap()
}

                                                                                             
fn failed() -> Response {
    Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{\"ok\":false,\"error\":\"failed\"}")).unwrap()
}

                                                                                 
fn js_str(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() { i.to_string() } else if let Some(u) = n.as_u64() { u.to_string() } else {
                let f = n.as_f64().unwrap_or(0.0);
                if f.fract() == 0.0 && f.abs() < 1e21 { format!("{f:.0}") } else { format!("{f}") }
            }
        }
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a.iter().map(|x| js_str(Some(x))).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

                                                                                       
                                                                                              
fn b64_lenient(s: &str) -> Vec<u8> {
    fn val(b: u8) -> Option<u32> {
        match b { b'A'..=b'Z' => Some((b - b'A') as u32), b'a'..=b'z' => Some((b - b'a' + 26) as u32), b'0'..=b'9' => Some((b - b'0' + 52) as u32), b'+' | b'-' => Some(62), b'/' | b'_' => Some(63), _ => None }
    }
    let mut out = Vec::new(); let mut acc = 0u32; let mut n = 0u32;
    for &b in s.as_bytes() {
        if b == b'=' { break; }
        let Some(v) = val(b) else { continue };
        acc = (acc << 6) | v; n += 1;
        if n == 4 { out.push((acc >> 16) as u8); out.push((acc >> 8) as u8); out.push(acc as u8); acc = 0; n = 0; }
    }
    match n { 2 => out.push((acc >> 4) as u8), 3 => { out.push((acc >> 10) as u8); out.push((acc >> 2) as u8); } _ => {} }
    out
}

                                                                                           
                                                                                             
                                                                                        
                                                            
fn b64_strict(s: &str) -> Option<Vec<u8>> {
    let s: String = s.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let mut pad = 0u32;
    for &c in s.as_bytes() {
        match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' | b'-' | b'_' => { if pad > 0 { return None; } }
            b'=' => { pad += 1; if pad > 2 { return None; } }
            _ => return None,
        }
    }
    if s.len() % 4 == 1 { return None; }
    Some(b64_lenient(&s))
}

fn encode_uri_component(s: &str) -> String {
    let mut o = String::new();
    for b in s.as_bytes() {
        match b { b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => o.push(*b as char), _ => o.push_str(&format!("%{b:02X}")) }
    }
    o
}

#[derive(Debug)]
pub struct Prepared {
    pub method: String,
    pub url: url::Url,
    pub headers: Vec<(String, String)>,                                       
    pub body: Option<Vec<u8>>,
}

                                                                                             
pub fn prepare(ad: &crate::adblock::Adblock, user: &str, v: &Value) -> Result<Prepared, Response> {
    match v { Value::Object(_) => {}, Value::Null => return Err(failed()), _ => return Err(fail(StatusCode::BAD_REQUEST, "url")) }
    let url_s = match v.get("url") { Some(Value::String(s)) => s.clone(), _ => return Err(fail(StatusCode::BAD_REQUEST, "url")) };
    let u = url::Url::parse(&url_s).map_err(|_| fail(StatusCode::BAD_REQUEST, "url"))?;
    if u.scheme() != "http" && u.scheme() != "https" { return Err(fail(StatusCode::BAD_REQUEST, "proto")); }
    if !u.username().is_empty() || u.password().is_some() { return Err(fail(StatusCode::BAD_REQUEST, "url")); }
    let host = u.host_str().unwrap_or("");
                                                                                            
                                                                                      
    if host.starts_with('[') { return Err(fail(StatusCode::FORBIDDEN, "blocked address")); }
                                                                                         
                                                                                      
    if let Ok(ip) = host.parse::<std::net::IpAddr>() { if ip.is_ipv6() || crate::lite::ssrf::blocked_ip(ip) || hairpin().ip_hit(ip) { return Err(fail(StatusCode::FORBIDDEN, "blocked address")); } }
    if hairpin().host_hit(host) { return Err(fail(StatusCode::FORBIDDEN, "blocked address")); }               
    if v.get("ab") != Some(&Value::Bool(false)) && ad.is_ad_host(host) { ad.note_blocked(user); return Err(fail(StatusCode::BAD_GATEWAY, "adblock")); }
    let mut headers: Vec<(String, String)> = vec![];
    match v.get("headers") {
        None | Some(Value::Null) => {}
        Some(Value::Array(arr)) => {
            if arr.len() > MAX_HEADER_PAIRS { return Err(fail(StatusCode::BAD_REQUEST, "bad")); }      
            let mut hbytes = 0usize;
            for e in arr {
                                                                                                  
                let Value::Array(pair) = e else { return Err(fail(StatusCode::BAD_REQUEST, "bad")) };
                let k = js_str(pair.first()); let lk = k.to_lowercase();
                if DROP_REQ.contains(&lk.as_str()) || lk.starts_with("x-forwarded-") { continue; }
                let val = js_str(pair.get(1));
                if let Some(ex) = headers.iter_mut().find(|(n, _)| *n == lk) { hbytes += 2 + val.len(); ex.1.push_str(if lk == "cookie" { "; " } else { ", " }); ex.1.push_str(&val); }
                else { hbytes += lk.len() + val.len(); headers.push((lk, val)); }
                if hbytes > MAX_HEADER_BYTES { return Err(fail(StatusCode::BAD_REQUEST, "bad")); }      
            }
        }
                                                                                          
        Some(_) => return Err(fail(StatusCode::BAD_REQUEST, "bad")),
    }
    headers.push(("accept-encoding".into(), "gzip, br".into()));
    let mut body_bytes = None;
    match v.get("body") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => {}
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => {}
        Some(Value::String(s)) if s.is_empty() => {}
        Some(Value::String(s)) => { let Some(b) = b64_strict(s) else { return Err(fail(StatusCode::BAD_REQUEST, "bad")) }; headers.push(("content-length".into(), b.len().to_string())); body_bytes = Some(b); }      
        Some(Value::Array(a)) => {                                                    
            let mut b = Vec::new();
            for x in a { let Some(n) = x.as_u64().filter(|n| *n <= 255) else { return Err(failed()) }; b.push(n as u8); }
            headers.push(("content-length".into(), b.len().to_string())); body_bytes = Some(b);
        }
        Some(_) => return Err(failed()),
    }
                                                                  
    let mraw = match v.get("method") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => "GET".to_string(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => "GET".into(),
        Some(Value::String(s)) if s.is_empty() => "GET".into(),
        Some(x) => js_str(Some(x)),
    };
    let m = mraw.to_uppercase();
    if !METHODS.contains(&m.as_str()) { return Err(fail(StatusCode::BAD_REQUEST, "bad")); }      
    Ok(Prepared { method: m, url: u, headers, body: body_bytes })
}

                                                                             
                                                                                  
struct Hairpin { hosts: Vec<String>, ips: Vec<std::net::IpAddr> }
impl Hairpin {
    fn parse(s: &str) -> Hairpin {
        let mut hosts = vec![]; let mut ips = vec![];
        for t in s.split(',').map(|t| t.trim().trim_end_matches('.').to_lowercase()).filter(|t| !t.is_empty()) {
            if let Ok(ip) = t.parse::<std::net::IpAddr>() { ips.push(ip); } else { hosts.push(t); }
        }
        Hairpin { hosts, ips }
    }
    fn host_hit(&self, h: &str) -> bool { let h = h.trim_end_matches('.'); self.hosts.iter().any(|x| x == h) }
    fn ip_hit(&self, ip: std::net::IpAddr) -> bool { self.ips.contains(&ip) }
}
fn hairpin() -> &'static Hairpin {
    static H: std::sync::OnceLock<Hairpin> = std::sync::OnceLock::new();
    H.get_or_init(|| Hairpin::parse(&std::env::var("RJ_HAIRPIN_HOSTS").unwrap_or_default()))
}

                                                                                         
                                                                                            
async fn connect_lookup(host: &str) -> Result<(), Response> {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = h.parse::<std::net::IpAddr>() {
        if crate::lite::ssrf::blocked_ip(ip) || hairpin().ip_hit(ip) { return Err(fail(StatusCode::BAD_GATEWAY, "blocked address")); }
        return Ok(());
    }
    match crate::lite::ssrf::resolve_host(h).await {
        Ok(list) => v4_gate(list.into_iter().filter(|a| a.is_ipv4()).collect(), h),
        Err(_) => Err(fail(StatusCode::BAD_GATEWAY, &format!("getaddrinfo ENOTFOUND {h}"))),
    }
}

                                                                                         
                                                                                        
fn v4_gate(v4s: Vec<std::net::IpAddr>, h: &str) -> Result<(), Response> {
    if v4s.is_empty() { return Err(fail(StatusCode::BAD_GATEWAY, &format!("getaddrinfo ENOTFOUND {h}"))); }
    if v4s.iter().any(|a| crate::lite::ssrf::blocked_ip(*a) || hairpin().ip_hit(*a)) { return Err(fail(StatusCode::BAD_GATEWAY, "blocked address")); }
    Ok(())
}

fn upstream_msg(e: &reqwest::Error, u: &url::Url) -> String {
    let m = if e.is_timeout() { "timeout".to_string() }
        else if e.is_connect() { format!("connect ECONNREFUSED {}:{}", u.host_str().unwrap_or(""), u.port_or_known_default().unwrap_or(0)) }
        else { "upstream".to_string() };
    m.chars().take(80).collect()
}

pub async fn handle(st: &crate::AppState, cookie_user: Option<String>, body: &[u8]) -> Response {
    let Some(user) = cookie_user else { return fail(StatusCode::UNAUTHORIZED, "signin") };
    let v: Value = match serde_json::from_slice(body) { Ok(v) => v, Err(_) => return fail(StatusCode::BAD_REQUEST, "bad") };
    let prep = match prepare(&st.adblock, &user, &v) { Ok(p) => p, Err(r) => return r };
    let host = prep.url.host_str().unwrap_or("").to_string();
    if let Err(r) = connect_lookup(&host).await { return r; }
    let Some(client) = st.pfetch_client.as_ref() else { return fail(StatusCode::BAD_GATEWAY, "egress unavailable") };
    execute(client, &prep, &st.guard, &st.data_dir.to_string_lossy(), &user).await
}

                                                                                          
                                                                                            
                                                
const MAX_QUEUE_PER_HOST: usize = 64;
struct HostSlot { sem: std::sync::Arc<tokio::sync::Semaphore>, waiting: std::sync::atomic::AtomicUsize }
fn host_slot(key: &str) -> std::sync::Arc<HostSlot> {
    static S: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, std::sync::Weak<HostSlot>>>> = std::sync::OnceLock::new();
    let mut map = S.get_or_init(Default::default).lock().unwrap();
    if let Some(s) = map.get(key).and_then(|w| w.upgrade()) { return s; }
    map.retain(|_, w| w.strong_count() > 0);                                                              
    let s = std::sync::Arc::new(HostSlot { sem: std::sync::Arc::new(tokio::sync::Semaphore::new(24)), waiting: std::sync::atomic::AtomicUsize::new(0) });
    map.insert(key.to_string(), std::sync::Arc::downgrade(&s));
    s
}
                                                                                         
                                                                               
                                                                                    
struct QueueSlot { slot: std::sync::Arc<HostSlot> }
impl Drop for QueueSlot { fn drop(&mut self) { self.slot.waiting.fetch_sub(1, std::sync::atomic::Ordering::SeqCst); } }
fn enter(slot: &std::sync::Arc<HostSlot>) -> Option<QueueSlot> {
    if slot.waiting.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= MAX_QUEUE_PER_HOST { slot.waiting.fetch_sub(1, std::sync::atomic::Ordering::SeqCst); return None; }
    Some(QueueSlot { slot: slot.clone() })
}

                                                                                             
                                                                                           
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_RESPONSE_DURATION: std::time::Duration = std::time::Duration::from_secs(120);

pub async fn execute(client: &reqwest::Client, prep: &Prepared, guard: &std::sync::Arc<crate::guard::Guard>, data_dir: &str, user: &str) -> Response {
                                                                                      
                                                                                           
                                                                                              
                                                                                         
                                                                                            
                                                                                              
                                                               
    let method = match Method::from_bytes(prep.method.as_bytes()) { Ok(m) => m, Err(_) => return fail(StatusCode::BAD_REQUEST, "bad") };
    let mut hm = HeaderMap::new();
    for (k, v) in &prep.headers {
        if k == "content-length" { continue; }                                                
        let Ok(name) = HeaderName::from_bytes(k.as_bytes()) else { return fail(StatusCode::BAD_REQUEST, "bad") };
        if v.chars().any(|c| c as u32 > 0xFF) { return fail(StatusCode::BAD_REQUEST, "bad"); }                               
        let Ok(val) = HeaderValue::from_str(v) else { return fail(StatusCode::BAD_REQUEST, "bad") };
        hm.append(name, val);
    }
    let slot_key = format!("{}:{}", prep.url.host_str().unwrap_or(""), prep.url.port_or_known_default().unwrap_or(0));
    let slot = host_slot(&slot_key);
    let Some(queue) = enter(&slot) else { return fail(StatusCode::SERVICE_UNAVAILABLE, "busy") };                    
    let permit = slot.sem.clone().acquire_owned().await.unwrap();                                  
    drop(queue);                                                           
    let started = std::time::Instant::now();                                                     
    let mut rb = client.request(method, prep.url.as_str()).headers(hm);
    if let Some(b) = &prep.body { rb = rb.body(b.clone()); }
    let resp = match rb.send().await { Ok(r) => r, Err(e) => return fail(StatusCode::BAD_GATEWAY, &upstream_msg(&e, &prep.url)) };
                                                                                            
                                                                                              
    let hbytes: usize = resp.headers().iter().map(|(k, v)| k.as_str().len() + v.as_bytes().len()).sum();
    if hbytes > 8 * 1024 { return fail(StatusCode::BAD_GATEWAY, "response headers"); }
    let status = resp.status();
    let raw: Vec<[String; 2]> = resp.headers().iter()
        .filter(|(k, _)| !HOP.contains(&k.as_str()))
        .map(|(k, v)| [k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()]).collect();
    let mut b = Response::builder()
        .header("x-rj-status", status.as_u16().to_string())
        .header("x-rj-text", encode_uri_component(status.canonical_reason().unwrap_or("")))
        .header("x-rj-headers", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, serde_json::to_string(&raw).unwrap()))
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_TYPE, "application/octet-stream");
    if let Some(ce) = resp.headers().get(header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()) { b = b.header("content-encoding", ce); }
    let dd = data_dir.to_string(); let un = user.to_string(); let g = guard.clone();
    let mut total = 0usize;
    let stream = futures::StreamExt::map(resp.bytes_stream(), move |item| {
        let _permit = &permit;                                                                
        match item {
            Ok(bytes) => {
                total += bytes.len();
                g.track_bytes(&dd, &un, bytes.len() as i64);                                   
                if total > MAX_RESPONSE_BYTES || started.elapsed() > MAX_RESPONSE_DURATION {
                    return Err(std::io::Error::other("pfetch response cap"));                     
                }
                Ok(bytes)
            }
            Err(e) => Err(std::io::Error::other(e)),
        }
    });
    b.body(Body::from_stream(stream)).unwrap()
}

#[cfg(test)]
mod pfetch_tests {
    use super::*;
    fn adblock_with(hosts: &str) -> crate::adblock::Adblock {
        let dir = std::env::temp_dir().join(format!("pf-ad-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("adblock-hosts.txt"), hosts).unwrap();
        crate::adblock::Adblock::load(&dir)
    }
    fn prep(ad: &crate::adblock::Adblock, v: &str) -> Result<Prepared, Response> { prepare(ad, "u1", &serde_json::from_str(v).unwrap()) }

    #[test]
    fn header_merge_drop_and_forced_accept_encoding() {
        let ad = adblock_with("");
        let p = prep(&ad, r#"{"url":"https://example.com/p","headers":[["X-A","1"],["x-a","2"],["Cookie","a=1"],["cookie","b=2"],["Host","evil"],["Accept-Encoding","identity"],["X-Forwarded-For","1.1.1.1"],["X-Forwarded-Host","evil"],["X-Forwarded-Proto","https"],["Transfer-Encoding","chunked"],["TE","trailers"],["Upgrade","h2c"],["Expect","100-continue"],["Keep-Alive","timeout=5"],["Proxy-Authorization","Basic x"],["Proxy-Authenticate","x"],["Trailer","x"],["CF-Connecting-IP","1.1.1.1"],["True-Client-IP","1.1.1.1"],["X-Ramjet-JS","1"],["Sec-Fetch-Site","same-origin"]]}"#).unwrap();
        assert_eq!(p.headers, vec![
            ("x-a".to_string(), "1, 2".to_string()),
            ("cookie".to_string(), "a=1; b=2".to_string()),
            ("accept-encoding".to_string(), "gzip, br".to_string()),
        ]);
        assert_eq!(p.method, "GET");
        let p = prep(&ad, r#"{"url":"https://example.com/","method":"post","body":"aGVsbG8"}"#).unwrap();                       
        assert_eq!(p.method, "POST");
        assert_eq!(p.body.as_deref(), Some(b"hello".as_slice()));
        assert!(p.headers.contains(&("content-length".to_string(), "5".to_string())));
        assert!(p.headers.contains(&("accept-encoding".to_string(), "gzip, br".to_string())));
    }

    #[tokio::test]
    async fn refusal_matrix() {
        let ad = adblock_with("ads.fixture\n");
        let code_msg = |r: Response| (r.status(), r.headers()["x-rj-error"].to_str().unwrap().to_string());
        assert_eq!(code_msg(prep(&ad, "{}").unwrap_err()), (StatusCode::BAD_REQUEST, "url".into()));
        assert_eq!(code_msg(prep(&ad, r#"{"url":"ftp://x/"}"#).unwrap_err()), (StatusCode::BAD_REQUEST, "proto".into()));
        assert_eq!(code_msg(prep(&ad, r#"{"url":"http://user:pw@example.com/"}"#).unwrap_err()), (StatusCode::BAD_REQUEST, "url".into()));
        assert_eq!(code_msg(prep(&ad, r#"{"url":"http://127.0.0.1:9/"}"#).unwrap_err()), (StatusCode::FORBIDDEN, "blocked address".into()));
        assert_eq!(code_msg(prep(&ad, r#"{"url":"http://[::1]/"}"#).unwrap_err()), (StatusCode::FORBIDDEN, "blocked address".into()));
        assert_eq!(code_msg(prep(&ad, r#"{"url":"http://192.168.1.1/"}"#).unwrap_err()), (StatusCode::FORBIDDEN, "blocked address".into()));
        assert_eq!(code_msg(prep(&ad, r#"{"url":"http://ads.fixture/"}"#).unwrap_err()), (StatusCode::BAD_GATEWAY, "adblock".into()));
        assert_eq!(ad.stats_for("u1"), (1, 1));
                                                                                                
        assert_eq!(code_msg(prep(&ad, r#"{"url":"http://www.ads.fixture/"}"#).unwrap_err()), (StatusCode::BAD_GATEWAY, "adblock".into()));
        assert_eq!(code_msg(prep(&ad, "[]").unwrap_err()), (StatusCode::BAD_REQUEST, "url".into()));
        assert!(connect_lookup("127.0.0.1").await.is_err());                                                                    
                                                                                          
        let pub1: std::net::IpAddr = "8.8.8.8".parse().unwrap(); let pub2: std::net::IpAddr = "1.1.1.1".parse().unwrap();
        assert!(v4_gate(vec![pub1, pub2], "ok.fixture").is_ok());
        for bad in ["10.0.0.1", "192.168.0.1", "169.254.1.1", "127.0.0.2"] { let b: std::net::IpAddr = bad.parse().unwrap(); assert!(v4_gate(vec![pub1, b, pub2], "mixed.fixture").is_err(), "{bad}"); assert!(v4_gate(vec![b], "only.fixture").is_err()); }
        assert!(v4_gate(vec![], "none.fixture").is_err());
                                                                                          
        assert_eq!(code_msg(prep(&ad, r#"{"url":"http://[2606:4700::1]/"}"#).unwrap_err()), (StatusCode::FORBIDDEN, "blocked address".into()));
        assert_eq!(code_msg(prep(&ad, r#"{"url":"http://2130706433/"}"#).unwrap_err()), (StatusCode::FORBIDDEN, "blocked address".into()));                        
        for form in ["http://127.1/", "http://0x7f.1/", "http://0177.1/", "http://127.0.0.1./"] {                  
            assert_eq!(code_msg(prep(&ad, &format!(r#"{{"url":"{form}"}}"#)).unwrap_err()), (StatusCode::FORBIDDEN, "blocked address".into()), "{form}");
        }
                                                                                       
        let r = fail(StatusCode::BAD_REQUEST, "a
b\u{0}c\u{e9}d");
        assert_eq!(r.headers()["x-rj-error"].to_str().unwrap(), "abcd");
                                                                                                   
        assert_eq!(code_msg(prep(&ad, r#"{"url":"https://example.com/","method":"CONNECT"}"#).unwrap_err()), (StatusCode::BAD_REQUEST, "bad".into()));
        assert_eq!(code_msg(prep(&ad, r#"{"url":"https://example.com/","method":"QUERY"}"#).unwrap_err()), (StatusCode::BAD_REQUEST, "bad".into()));
        for m in ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "get"] { assert!(prep(&ad, &format!(r#"{{"url":"https://example.com/","method":"{m}"}}"#)).is_ok(), "{m}"); }
        for (b, ok) in [("aGVsbG8", true), ("aGVsbG8=", true), ("aGVsbG8!", false), ("aGVsbG=8", false), ("a", false), ("aGVsbG8===", false), ("aGVsbG8\u{0007}", false), ("aGVs\nbG8", true), ("aGVs\rbG8\r\n", true), ("aGVs bG8\t", true)] {
                                                                                      
                                                                                     
            let v = serde_json::json!({"url":"https://example.com/","method":"POST","body":b});
            assert_eq!(prepare(&ad, "u1", &v).is_ok(), ok, "{b}");
        }
                                                                 
        let many = (0..65).map(|i| format!(r#"["x-h{i}","v"]"#)).collect::<Vec<_>>().join(",");
        assert_eq!(code_msg(prep(&ad, &format!(r#"{{"url":"https://example.com/","headers":[{many}]}}"#)).unwrap_err()), (StatusCode::BAD_REQUEST, "bad".into()));
        let big = format!(r#"{{"url":"https://example.com/","headers":[["x-pad","{}"]]}}"#, "v".repeat(17 * 1024));
        assert_eq!(code_msg(prep(&ad, &big).unwrap_err()), (StatusCode::BAD_REQUEST, "bad".into()));
                                                                                           
        let hp = Hairpin::parse(" box.example.com , 203.0.113.7 ,, 2001:db8::1 , BOX2.EXAMPLE.COM.");
        assert!(hp.host_hit("box.example.com") && hp.host_hit("box.example.com."));
        assert!(hp.host_hit("box2.example.com."));                                          
        assert!(!hp.host_hit("sub.box.example.com"));
        assert!(hp.ip_hit("203.0.113.7".parse().unwrap()) && hp.ip_hit("2001:db8::1".parse().unwrap()));
        assert!(!hp.ip_hit("203.0.113.8".parse().unwrap()));
        assert!(Hairpin::parse("").hosts.is_empty() && Hairpin::parse("").ips.is_empty());                 
                                                                                      
        let slot = std::sync::Arc::new(HostSlot { sem: std::sync::Arc::new(tokio::sync::Semaphore::new(24)), waiting: std::sync::atomic::AtomicUsize::new(0) });
        let mut held = Vec::new();
        for _ in 0..MAX_QUEUE_PER_HOST { held.push(enter(&slot).expect("queue slot")); }
        assert!(enter(&slot).is_none());                       
        drop(held);
        assert_eq!(slot.waiting.load(std::sync::atomic::Ordering::SeqCst), 0);
                                                                                         
                                                   
        let slot2 = std::sync::Arc::new(HostSlot { sem: std::sync::Arc::new(tokio::sync::Semaphore::new(1)), waiting: std::sync::atomic::AtomicUsize::new(0) });
        let _exhaust = slot2.sem.clone().try_acquire_owned().unwrap();
        {
            let q = enter(&slot2).unwrap();
            assert_eq!(slot2.waiting.load(std::sync::atomic::Ordering::SeqCst), 1);
            let acquire = slot2.sem.clone().acquire_owned();
            tokio::pin!(acquire);
            assert!(tokio::time::timeout(std::time::Duration::from_millis(50), &mut acquire).await.is_err());                
            drop(acquire); drop(q);                                              
        }
        assert_eq!(slot2.waiting.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(code_msg(prep(&ad, r#"{"url":"https://example.com/","headers":{"x":"1"}}"#).unwrap_err()), (StatusCode::BAD_REQUEST, "bad".into()));
        assert_eq!(code_msg(prep(&ad, r#"{"url":"https://example.com/","headers":[1]}"#).unwrap_err()), (StatusCode::BAD_REQUEST, "bad".into()));
                                                                                          
        let null_r = prepare(&ad, "u1", &Value::Null).unwrap_err();
        assert_eq!(null_r.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn header_round_trip_and_error_path() {
        let app = axum::Router::new().route("/echo", axum::routing::get(|| async {
            Response::builder()
                .header("x-test-a", "yes").header("set-cookie", "a=1").header("set-cookie", "b=2")
                .header("content-encoding", "gzip").header("content-type", "text/html")
                .body(Body::from("compressed-bytes")).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/echo", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let ad = adblock_with("");
        let st_dir = std::env::temp_dir().join(format!("pf-rt-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&st_dir).unwrap();
        let guard = std::sync::Arc::new(crate::guard::Guard::load(&st_dir.to_string_lossy()));
        let client = reqwest::Client::builder().no_proxy().gzip(false).brotli(false).build().unwrap();
                                                                                           
        let p = Prepared { method: "GET".into(), url: url::Url::parse(&url).unwrap(), headers: vec![("accept-encoding".into(), "gzip, br".into())], body: None };
        let r = execute(&client, &p, &guard, &st_dir.to_string_lossy(), "u1").await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()["x-rj-status"], "200");
        assert_eq!(r.headers()["x-rj-text"], "OK");
        assert_eq!(r.headers()["content-encoding"], "gzip");
        assert_eq!(r.headers()["content-type"], "application/octet-stream");
        let decoded: Vec<Vec<String>> = serde_json::from_slice(&base64::Engine::decode(&base64::engine::general_purpose::STANDARD, r.headers()["x-rj-headers"].as_bytes()).unwrap()).unwrap();
        assert!(decoded.contains(&vec!["x-test-a".to_string(), "yes".to_string()]));
        assert_eq!(decoded.iter().filter(|p| p[0] == "set-cookie").count(), 2);
        assert!(!decoded.iter().any(|p| p[0] == "content-encoding" || p[0] == "content-length" || p[0] == "connection" || p[0] == "transfer-encoding"));
        let body = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        assert_eq!(body.as_ref(), b"compressed-bytes");                                               
        assert_eq!(guard.snapshot()["u1"]["bytes"].as_i64().unwrap(), 16);                                  
        server.abort();
                                                                                    
        let app2 = axum::Router::new().route("/big", axum::routing::get(|| async {
                                                                                       
                                                                               
            let mut b = Response::builder();
            for i in 0..80 { b = b.header(format!("x-pad-{i}"), "v".repeat(128)); }
            b.body(Body::from("x")).unwrap()
        }));
        let listener2 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url2 = format!("http://{}/big", listener2.local_addr().unwrap());
        let server2 = tokio::spawn(async move { axum::serve(listener2, app2).await.unwrap() });
        let p = Prepared { method: "GET".into(), url: url::Url::parse(&url2).unwrap(), headers: vec![("accept-encoding".into(), "gzip, br".into())], body: None };
        let r = execute(&client, &p, &guard, &st_dir.to_string_lossy(), "u1").await;
        assert_eq!((r.status(), r.headers()["x-rj-error"].to_str().unwrap().to_string()), (StatusCode::BAD_GATEWAY, "response headers".into()));
        server2.abort();
                                                                                         
        for (m, hs) in [
            ("GET\rX", vec![("accept-encoding".to_string(), "gzip, br".to_string())]),
            ("GET", vec![("x bad".to_string(), "1".to_string())]),
            ("GET", vec![("x-a".to_string(), "a\nb".to_string())]),
            ("GET", vec![("x-a".to_string(), "a\u{0}b".to_string())]),
            ("GET", vec![("x-a".to_string(), "caf\u{4e2d}".to_string())]),
        ] {
            let p = Prepared { method: m.into(), url: url::Url::parse(&url).unwrap(), headers: hs.clone(), body: None };                                        
            let r = execute(&client, &p, &guard, &st_dir.to_string_lossy(), "u1").await;
            assert_eq!((r.status(), r.headers()["x-rj-error"].to_str().unwrap().to_string()), (StatusCode::BAD_REQUEST, "bad".into()), "{m} {hs:?}");
        }
                                                                                          
                                                                                              
        let p = Prepared { method: "GET".into(), url: url::Url::parse("http://127.0.0.1:1/").unwrap(), headers: vec![("x-a".to_string(), "caf\u{e9}".to_string())], body: None };
        let r = execute(&client, &p, &guard, &st_dir.to_string_lossy(), "u1").await;
        assert_eq!(r.status(), StatusCode::BAD_GATEWAY);
                                                                       
        let p = Prepared { method: "GET".into(), url: url::Url::parse("http://127.0.0.1:1/").unwrap(), headers: vec![], body: None };
        let r = execute(&client, &p, &guard, &st_dir.to_string_lossy(), "u1").await;
        assert_eq!(r.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(r.headers()["x-rj-error"], "connect ECONNREFUSED 127.0.0.1:1");
        assert_eq!(r.headers()["cache-control"], "no-store");
        assert!(axum::body::to_bytes(r.into_body(), 100).await.unwrap().is_empty());
        let _ = ad;
    }
}
