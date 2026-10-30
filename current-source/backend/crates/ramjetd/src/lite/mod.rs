                                                                   
                                                                                     
                                                                                       
                                            
pub mod auth;
pub mod imgsearch;
pub mod media;
pub mod page;
pub mod sheet;
pub mod ssrf;
pub mod video;
pub mod yt;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub use crate::Shared;

pub struct LiteState {
    pub bad: Mutex<HashMap<String, (u32, Instant)>>,
    pub hits: Mutex<VecDeque<Instant>>,
    pub live: std::sync::atomic::AtomicU32,
    pub cred_cache: Mutex<HashMap<String, (String, Instant)>>,                                                   
    pub video_busy: std::sync::atomic::AtomicU32,
    pub video_reserved: std::sync::atomic::AtomicU64,                                                            
    pub video_progress: Mutex<std::collections::HashMap<String, u64>>,                                                                                                                     
    pub video_error: Mutex<std::collections::HashMap<String, String>>,                                                                            
    pub video_job: Mutex<Option<(String, u32, String)>>,                                                                   
    pub video_jobs: Mutex<std::collections::HashMap<String, usize>>,
    pub video_serving: Mutex<std::collections::HashMap<String, usize>>,                                                          
    pub searx: imgsearch::SearxState,
    pub search_cache: Mutex<HashMap<String, (u32, Vec<yt::YtVideo>, Option<String>, Instant)>>,                                                                                                           
    pub search_walk: tokio::sync::Mutex<()>,                                                                                                                   
    #[cfg(test)]
    pub cont_stub: Mutex<Vec<Result<(Vec<yt::YtVideo>, Option<String>), String>>>,                                                        
}

impl LiteState {
    pub fn new() -> Self {
        Self {
            bad: Mutex::new(HashMap::new()),
            hits: Mutex::new(VecDeque::new()),
            live: 0.into(),
            cred_cache: Mutex::new(HashMap::new()),
            video_busy: 0.into(),
            video_reserved: 0.into(),
            video_progress: Mutex::new(std::collections::HashMap::new()),
            video_error: Mutex::new(std::collections::HashMap::new()),
            video_job: Mutex::new(None),
            video_jobs: Mutex::new(std::collections::HashMap::new()),
            video_serving: Mutex::new(std::collections::HashMap::new()),
            searx: imgsearch::SearxState::new(),
            search_cache: Mutex::new(HashMap::new()),
            search_walk: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            cont_stub: Mutex::new(Vec::new()),
        }
    }
}

pub fn router(state: Shared) -> Router<Shared> {
    Router::new()
        .route("/health", get(health))
        .route("/search", get(search))
        .route("/sheet", get(sheet_handler))
        .route("/imgsearch", get(imgsearch::handler))
        .route("/imgsheet", get(imgsearch::sheet_handler))
        .route("/page", get(page::handler))
        .route("/media", get(media::handler))
        .route("/video", get(video::handler))
        .fallback(not_found)
                                                                                  
                                                                                   
                                                                                 
        .layer(axum::middleware::from_fn_with_state(state, lite_gate))
}

async fn not_found() -> Response {
                                          
    json_err(StatusCode::NOT_FOUND, "not found")
}

                                                                                    
                                                                                 
                                                                    
pub fn json_err(status: StatusCode, msg: &str) -> Response {
    let body = format!("{{\"ok\":false,\"error\":{}}}", serde_json::to_string(msg).unwrap());
    raw_json(status, body)
}

                                                                              
pub fn json_err_x(status: StatusCode, v: Value) -> Response {
                                                                                          
    debug_assert!(
        v.as_object().is_some_and(|o| o.keys().all(|k| matches!(k.as_str(), "error" | "seconds" | "est_mb" | "page"))),
        "json_err_x body carries keys beyond error + the enumerated list"
    );
    let mut body = format!("{{\"ok\":false,\"error\":{}", serde_json::to_string(&v["error"].as_str().unwrap_or("error")).unwrap());
                                                                                 
    for k in ["seconds", "est_mb", "page"] {
        if let Some(val) = v.get(k) {
            body.push_str(&format!(",{:?}:{}", k, serde_json::to_string(val).unwrap()));
        }
    }
    body.push('}');
    raw_json(status, body)
}

                                                                     
                                                                            
                                                                            
                                                                             
                                                                           
                                                                              
                                                                          
                                                                             
               
pub enum OJ {
    Null,
    Bool(bool),
    U64(u64),
    Num(i64),
    Str(String),
    Arr(Vec<OJ>),
    Obj(Vec<(String, OJ)>),
    Val(serde_json::Value),                                                    
    Raw(String),                                                                          
}
impl OJ {
    fn emit(&self, out: &mut String) {
        match self {
            OJ::Null => out.push_str("null"),
            OJ::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            OJ::U64(n) => out.push_str(&n.to_string()),
            OJ::Num(n) => out.push_str(&n.to_string()),
            OJ::Str(s) => out.push_str(&serde_json::to_string(s).unwrap()),
            OJ::Arr(a) => {
                out.push('[');
                for (i, x) in a.iter().enumerate() { if i > 0 { out.push(','); } x.emit(out); }
                out.push(']');
            }
            OJ::Obj(o) => {
                out.push('{');
                for (i, (k, x)) in o.iter().enumerate() {
                    if i > 0 { out.push(','); }
                    out.push_str(&serde_json::to_string(k).unwrap());
                    out.push(':');
                    x.emit(out);
                }
                out.push('}');
            }
            OJ::Val(v) => out.push_str(&serde_json::to_string(v).unwrap()),
            OJ::Raw(t) => out.push_str(t),
        }
    }
}
pub fn json_ord(status: StatusCode, pairs: Vec<(&str, OJ)>) -> Response {
    let mut s = String::with_capacity(256);
    OJ::Obj(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()).emit(&mut s);
    raw_json(status, s)
}

fn raw_json(status: StatusCode, body: String) -> Response {
    let mut r = (status, body).into_response();
    let h = r.headers_mut();
    h.insert(axum::http::header::CONTENT_TYPE, "application/json; charset=utf-8".parse().unwrap());
    h.insert(axum::http::header::CACHE_CONTROL, "no-store".parse().unwrap());
    r
}

                                                                                                      

pub fn iso_now() -> String {
                                     
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
                                 
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}


async fn lite_gate(State((st, _)): State<Shared>, req: Request<Body>, next: Next) -> Response {
    let now = Instant::now();
    let peer=req.extensions().get::<axum::extract::ConnectInfo<std::net::SocketAddr>>().map(|p|p.0);
    let ip = crate::auth_api::rate::client_ip(req.headers(),peer);
    {
        let bad = st.lite.bad.lock().unwrap();
        if let Some((_, until)) = bad.get(&ip) {
                                                  
            if *until > now { let mut r=json_err(StatusCode::TOO_MANY_REQUESTS, "locked out, try later");r.headers_mut().insert("retry-after",until.duration_since(now).as_secs().saturating_add(1).to_string().parse().unwrap());return r; }
        }
    }
    let credential=req.headers().get("authorization").and_then(|v|v.to_str().ok()).map(str::to_owned);
    let auth_state=st.clone();
    let authorized=tokio::task::spawn_blocking(move||auth::cred_ok(&auth_state,credential.as_deref())).await.unwrap_or(false);
    if !authorized {
        let mut bad = st.lite.bad.lock().unwrap();
        let e = bad.entry(ip).or_insert((0, now));
        e.0 += 1;
        if e.0 >= 10 { e.1 = now + Duration::from_secs(900); e.0 = 0; }
                                                                         
        let mut r = json_err(StatusCode::UNAUTHORIZED, "unauthorized");
        r.headers_mut().insert("www-authenticate", "Bearer".parse().unwrap());
        return r;
    }
    st.lite.bad.lock().unwrap().remove(&ip);
    let method = req.method().clone();
    if method != axum::http::Method::GET && method != axum::http::Method::HEAD {
                                              
        return json_err(StatusCode::METHOD_NOT_ALLOWED, "GET only");
    }
    {
        let mut hits = st.lite.hits.lock().unwrap();
        while hits.front().map(|t| now.duration_since(*t) > Duration::from_secs(60)).unwrap_or(false) { hits.pop_front(); }
                                              
        if hits.len() >= 60 { return json_err(StatusCode::TOO_MANY_REQUESTS, "rate limit: 60 per minute"); }
        hits.push_back(now);
    }
    if st.lite.live.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= 5 {
        st.lite.live.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                                              
        return json_err(StatusCode::TOO_MANY_REQUESTS, "too many at once (max 5)");
    }
    let path = req.uri().path().to_string();
    let q = req.uri().query().unwrap_or("").to_string();
    let qshort: String = q.split('&').find(|p| p.starts_with("q=")).map(|p| p[2..].chars().take(40).collect()).unwrap_or_default();
    let pshort: String = q.split('&').find(|p| p.starts_with("page=")).map(|p| p[5..].to_string()).unwrap_or_default();
    let t0 = Instant::now();
    let resp = next.run(req).await;
    st.lite.live.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    let line = format!("{} GET {} q={} page={} {} {}ms\n", iso_now(), path, qshort, pshort, resp.status().as_u16(), t0.elapsed().as_millis());
    let _ = std::fs::OpenOptions::new().create(true).append(true).open(st.data_dir.join("lite-access.log")).map(|mut f| { use std::io::Write; let _ = f.write_all(line.as_bytes()); });
    resp
}

pub fn qparam(params: &HashMap<String, String>, k: &str) -> String {
    params.get(k).cloned().unwrap_or_default()
}

                                                                               
                                                                             
                                                                      
pub fn page_num(params: &HashMap<String, String>) -> Result<u32, Response> {
    let raw = params.get("page").and_then(|p| p.parse::<u64>().ok()).unwrap_or(1);
    if raw > 10000 { return Err(json_err(StatusCode::BAD_REQUEST, "page too large")); }
    Ok(raw.clamp(1, 10000) as u32)
}

async fn health() -> Response {
                                                                                  
    json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("service", OJ::Str("ramjet-lite".into())), ("time", OJ::Str(iso_now()))])
}

async fn search(State((st, _)): State<Shared>, Query(params): Query<HashMap<String, String>>) -> Response {
    let q = qparam(&params, "q").trim().to_string();
    if q.is_empty() || q.len() > 120 { return json_err(StatusCode::BAD_REQUEST, "q required, under 120 chars"); }
    let pg = match page_num(&params) { Ok(p) => p, Err(r) => return r };
    let (rs, hm) = match yt::search_pages(&st, &q, pg).await {
        Ok(r) => r,
        Err(e) => return json_err(StatusCode::BAD_GATEWAY, &e.chars().take(160).collect::<String>()),
    };
    let rs: Vec<_> = rs.iter().collect();                                                          
                                                                                                      
    let mut lines: Vec<OJ> = Vec::new();
    let out: Vec<OJ> = rs.iter().map(|v| {
        let label = [yt::clip(&v.title, 52), yt::clip(&v.channel, 20), if v.duration.is_empty() { String::new() } else { yt::clip(&v.duration, 9) }, yt::fmt_views(&v.views)]
            .into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" - ");
        let line = format!("{label}||{}", v.id);
        lines.push(OJ::Str(line.clone()));
        OJ::Obj(vec![
            ("id".into(), OJ::Str(v.id.clone())),
            ("title".into(), OJ::Str(v.title.clone())),
            ("channel".into(), OJ::Str(v.channel.clone())),
            ("duration".into(), OJ::Str(v.duration.clone())),
            ("views".into(), OJ::Str(v.views.clone())),
            ("label".into(), OJ::Str(label)),
            ("line".into(), OJ::Str(line)),
            ("thumb".into(), OJ::Str(format!("/api/lite/media?kind=image&u={}", urlenc(&format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", v.id))))),
            ("video".into(), OJ::Str(format!("/api/lite/video?id={}", v.id))),
        ])
    }).collect();
                                                                                                      
    json_ord(StatusCode::OK, vec![
        ("ok", OJ::Bool(true)),
        ("q", OJ::Str(q)),
        ("results", OJ::Arr(out)),
        ("lines", OJ::Arr(lines)),
        ("page", OJ::U64(pg as u64)),
        ("per_page", OJ::U64(8)),
        ("has_more", OJ::Bool(hm)),
        ("next_page", if hm { OJ::U64(pg as u64 + 1) } else { OJ::Null }),
    ])
}

async fn sheet_handler(State((st, _)): State<Shared>, Query(params): Query<HashMap<String, String>>) -> Response {
    let q = qparam(&params, "q").trim().to_string();
    if q.is_empty() || q.len() > 120 { return json_err(StatusCode::BAD_REQUEST, "q required, under 120 chars"); }
    let n: usize = params.get("n").and_then(|p| p.parse().ok()).unwrap_or(8).clamp(1, 8);
    let pg = match page_num(&params) { Ok(p) => p, Err(r) => return r };
    let (page_items, hm) = match yt::search_pages(&st, &q, pg).await { Ok(r) => r, Err(e) => return json_err(StatusCode::BAD_GATEWAY, &e.chars().take(160).collect::<String>()) };
    let mut rs = page_items;
    rs.truncate(n);
    if rs.is_empty() && hm {
                                                                                    
                                                                                
                                                                                       
        let mut r = json_err(StatusCode::SERVICE_UNAVAILABLE, "still loading - try again");
        r.headers_mut().insert(axum::http::header::RETRY_AFTER, "1".parse().unwrap());
        return r;
    }
    if rs.is_empty() {
        return match sheet::message_image(if pg > 1 { "No more results" } else { "No results found" }).await {
            Ok(buf) => img_response(buf, "image/jpeg", "no-store"),
            Err(e) => json_err(StatusCode::BAD_GATEWAY, &e),
        };
    }
    match sheet::make_sheet(&st, &rs).await {
        Ok(buf) => img_response(buf, "image/jpeg", "no-store"),
        Err(e) => json_err(StatusCode::BAD_GATEWAY, &e.chars().take(160).collect::<String>()),
    }
}

pub fn img_response(buf: Vec<u8>, mime: &str, cc: &str) -> Response {
    Response::builder()
        .header(axum::http::header::CONTENT_TYPE, mime)
        .header(axum::http::header::CONTENT_LENGTH, buf.len())
        .header(axum::http::header::CACHE_CONTROL, cc)
        .body(axum::body::Body::from(buf))
        .unwrap()
}

pub fn urlenc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

                                                    
pub fn tmp_path(tag: &str) -> std::path::PathBuf {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    std::env::temp_dir().join(format!("rj-{tag}-{}-{n}-{t}", std::process::id()))
}
