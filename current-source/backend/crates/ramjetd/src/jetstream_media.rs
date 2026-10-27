                                                                                   
                                                                                  
                                                                                              
                                                                                                          
                                                                                                              
                                                                                                            
                                                                                        
                                                                                           
                                                                           
                                                                                                     
                                                                                               
                                                                    
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use url::Url;

use crate::lite::json_err;
use crate::Shared;

const MAX_THUMB: usize = 4_000_000;
const MAX_URL: usize = 4096;
const MAX_STREAMS: usize = 16;
const BODY_TOTAL: Duration = Duration::from_secs(120);                                                         
const USER_STREAM_MAX: usize = 3;                                               
const NEG_TTL: Duration = Duration::from_secs(45);                                                            
const HOP_WAIT: Duration = Duration::from_secs(30);                                                       
const CHUNK_STALL: Duration = Duration::from_secs(15);

                                                                                               
                                           
pub fn router() -> Router<Shared> {
    Router::new()
        .route("/api/apps/jetstream/vsrc", get(vsrc_handler).fallback(bad_method))
        .route("/api/apps/jetstream/stream", get(stream_handler).fallback(bad_method))
        .route("/api/apps/jetstream/watch", get(watch_handler).fallback(bad_method))
        .route("/api/apps/jetstream/thumb", get(thumb_id_handler).fallback(bad_method))
        .route("/api/jetstream/thumb", get(thumb_handler).fallback(bad_method))
        .route("/api/apps/jetstream/captions", get(captions_handler).fallback(bad_method))
}

async fn bad_method() -> Response { json_err(StatusCode::METHOD_NOT_ALLOWED, "bad method") }

                                                                          

#[derive(Clone, Copy)]
pub struct Policy {
    pub media_ok: fn(&Url) -> bool,
    pub thumb_ok: fn(&Url) -> bool,
                                                                                    
    pub pin: bool,
}

pub const PROD: Policy = Policy { media_ok: media_host_ok, thumb_ok: thumb_host_ok, pin: true };

fn plain_https(u: &Url) -> bool {
    u.scheme() == "https" && u.username().is_empty() && u.password().is_none()
        && matches!(u.port(), None | Some(443)) && matches!(u.host(), Some(url::Host::Domain(_)))
}

                                                                                       
pub fn media_host_ok(u: &Url) -> bool {
    if !plain_https(u) { return false; }
    let h = u.host_str().unwrap_or("").to_ascii_lowercase();
    match h.strip_suffix(".googlevideo.com") {
        Some(sub) => !sub.is_empty() && !sub.starts_with('.') && sub.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.'),
        None => false,
    }
}

                                                
pub fn thumb_host_ok(u: &Url) -> bool {
    if !plain_https(u) { return false; }
    let h = u.host_str().unwrap_or("").to_ascii_lowercase();
    match h.strip_suffix(".ytimg.com") {
        Some("i") => true,
        Some(s) => s.len() == 2 && s.starts_with('i') && s.as_bytes()[1].is_ascii_digit(),
        None => false,
    }
}

                                                                                   

static STREAM_CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();

fn stream_client(st: &crate::AppState) -> Result<reqwest::Client, ()> {
                                                                     
    if st.egress_client.is_none() { return Err(()); }
    #[cfg(test)] if st.proxy_url == "test-direct" { return Ok(reqwest::Client::builder().no_proxy().build().map_err(|_| ())?); }                   
    STREAM_CLIENT.get_or_init(|| crate::egress::build_stream(&st.proxy_url).ok()).clone().ok_or(())
}

fn slot() -> Result<OwnedSemaphorePermit, ()> {
    SLOTS.get_or_init(|| Arc::new(Semaphore::new(MAX_STREAMS))).clone().try_acquire_owned().map_err(|_| ())
}

static USER_STREAMS: OnceLock<std::sync::Mutex<HashMap<String, (Arc<Semaphore>, std::time::Instant)>>> = OnceLock::new();
                                                                                           
fn user_permit(user: &str) -> Option<OwnedSemaphorePermit> {
    let sem = {
        let mut g = USER_STREAMS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
        if g.len() >= 512 && !g.contains_key(user) {
            if let Some(k) = g.iter().min_by_key(|(_, v)| v.1).map(|(k, _)| k.clone()) { g.remove(&k); }
        }
        let e = g.entry(user.to_string()).or_insert_with(|| (Arc::new(Semaphore::new(USER_STREAM_MAX)), std::time::Instant::now()));
        e.1 = std::time::Instant::now();
        e.0.clone()
    };
    sem.try_acquire_owned().ok()
}

                                                                          

#[derive(Debug, PartialEq, Eq)]
pub enum LegErr { BadUrl, Blocked, Timeout, Upstream, Expired, TooBig, Busy, Down }

fn leg_err(e: LegErr) -> Response {
    let (c, m) = match e {
        LegErr::BadUrl => (StatusCode::BAD_REQUEST, "bad url"),
        LegErr::Blocked => (StatusCode::FORBIDDEN, "that host is not allowed"),
        LegErr::Timeout => (StatusCode::GATEWAY_TIMEOUT, "timed out"),
        LegErr::Upstream => (StatusCode::BAD_GATEWAY, "upstream error"),
        LegErr::Expired => (StatusCode::GONE, "that stream link expired, reload the video"),
        LegErr::TooBig => (StatusCode::BAD_GATEWAY, "too big"),
        LegErr::Busy => (StatusCode::TOO_MANY_REQUESTS, "too many streams, try again in a moment"),
        LegErr::Down => (StatusCode::BAD_GATEWAY, "egress unavailable"),
    };
    json_err(c, m)
}

                                                                         

fn parse_u(raw: &str) -> Result<Url, LegErr> {
    if raw.is_empty() || raw.len() > MAX_URL { return Err(LegErr::BadUrl); }
    Url::parse(raw).map_err(|_| LegErr::BadUrl)
}

                                                                                  
pub async fn fetch(client: &reqwest::Client, pol: &Policy, start: Url, ok: fn(&Url) -> bool, range: Option<&str>, hdrs: &[(&str, &str)]) -> Result<(reqwest::Response, Url), LegErr> {
    let mut u = start;
    for hop in 0..=4 {
        if !ok(&u) { return Err(LegErr::Blocked); }
        if pol.pin {
            let host = u.host_str().ok_or(LegErr::BadUrl)?;
            crate::lite::ssrf::pin_t(host).await.map_err(|e| match e {
                crate::lite::ssrf::SsrfErr::Transport => LegErr::Upstream,
                _ => LegErr::Blocked,
            })?;
        }
        let mut rq = client.get(u.as_str()).header("accept-encoding", "identity");
        if let Some(r) = range { rq = rq.header("range", r); }
        for (k, v) in hdrs { rq = rq.header(*k, *v); }
        let resp = match tokio::time::timeout(HOP_WAIT, rq.send()).await {
            Err(_) => return Err(LegErr::Timeout),
            Ok(Err(e)) => return Err(if e.is_timeout() { LegErr::Timeout } else { LegErr::Upstream }),
            Ok(Ok(r)) => r,
        };
        if resp.status().is_redirection() {
            if hop == 4 { return Err(LegErr::Upstream); }
            let loc = resp.headers().get("location").and_then(|v| v.to_str().ok()).ok_or(LegErr::Upstream)?;
            u = u.join(loc).map_err(|_| LegErr::Upstream)?;
            continue;
        }
        return Ok((resp, u));
    }
    Err(LegErr::Upstream)
}

fn upstream_status(s: StatusCode) -> Result<(), LegErr> {
    match s.as_u16() {
        200 | 206 | 416 => Ok(()),
        403 | 404 | 410 => Err(LegErr::Expired),
        _ => Err(LegErr::Upstream),
    }
}

                                                                              

async fn thumb_handler(State((st, _)): State<Shared>, Query(q): Query<HashMap<String, String>>, headers: HeaderMap) -> Response {
                                                                                               
                                                                                              
                                                                                                               
    if crate::auth_api::user(&st, &headers).or_else(|| crate::auth_api::devices::bearer_user(&st, &headers))
        .or_else(|| q.get("t").and_then(|t| crate::auth_api::wisp::thumb_ticket_user(&st.data_dir, t)).filter(|u| st.auth_db.user_enabled(u))).is_none() { return json_err(StatusCode::UNAUTHORIZED, "not signed in"); }
    match thumb(&st, &PROD, q.get("u").map(String::as_str).unwrap_or("")).await { Ok(r) => r, Err(e) => leg_err(e) }
}

async fn thumb(st: &crate::AppState, pol: &Policy, u: &str) -> Result<Response, LegErr> {
    let client = stream_client(st).map_err(|_| LegErr::Down)?;
    let _ts = thumb_slot().map_err(|_| LegErr::Busy)?;            
    thumb_with(&client, pol, u).await
}

pub async fn thumb_with(client: &reqwest::Client, pol: &Policy, u: &str) -> Result<Response, LegErr> {
    let (resp, _) = fetch(client, pol, parse_u(u)?, pol.thumb_ok, None, &[]).await?;
    if resp.status().as_u16() != 200 { return Err(upstream_status(resp.status()).err().unwrap_or(LegErr::Upstream)); }
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if !matches!(ct.as_str(), "image/jpeg" | "image/webp" | "image/png" | "image/avif" | "image/gif") { return Err(LegErr::Upstream); }
    if resp.content_length().map_or(false, |n| n as usize > MAX_THUMB) { return Err(LegErr::TooBig); }
    let body = read_capped(resp, None, MAX_THUMB).await?;
    Ok(Response::builder().status(200)
        .header(header::CONTENT_TYPE, ct)
        .header(header::CONTENT_LENGTH, body.len())
        .header(header::CACHE_CONTROL, "private, max-age=86400")
        .header("x-content-type-options", "nosniff")
        .body(Body::from(body)).unwrap())
}

async fn read_capped(mut resp: reqwest::Response, first: Option<axum::body::Bytes>, cap: usize) -> Result<Vec<u8>, LegErr> {
    let mut out: Vec<u8> = Vec::new();
    if let Some(f) = first { out.extend_from_slice(&f); }
    if out.len() > cap { return Err(LegErr::TooBig); }
    loop {
        match tokio::time::timeout(CHUNK_STALL, resp.chunk()).await {
            Err(_) => return Err(LegErr::Timeout),
            Ok(Err(_)) => return Err(LegErr::Upstream),
            Ok(Ok(None)) => return Ok(out),
            Ok(Ok(Some(c))) => { out.extend_from_slice(&c); if out.len() > cap { return Err(LegErr::TooBig); } }
        }
    }
}


                                                                                                   

const THUMB_HOST: &str = "https://i.ytimg.com";

                                                                                                    
                                                                                        
pub async fn thumb_id_with(client: &reqwest::Client, pol: &Policy, base: &str, id: &str, lite: bool) -> Option<Vec<u8>> {
    let names: &[&str] = if lite { &["hqdefault", "mqdefault"] } else { &["maxresdefault", "sddefault", "hqdefault", "mqdefault"] };
    for name in names {
        let Ok(u) = Url::parse(&format!("{base}/vi/{id}/{name}.jpg")) else { continue };
        let leg = async {
            let (resp, _) = fetch(client, pol, u, pol.thumb_ok, None, &[]).await.ok()?;
            if !resp.status().is_success() { return None; }
                                                                 
            let ct_ok = resp.headers().get("content-type").and_then(|v| v.to_str().ok())
                .map(|v| v.split(';').next().unwrap_or("").trim().to_ascii_lowercase().starts_with("image/")).unwrap_or(false);
            if !ct_ok { return None; }
            read_capped(resp, None, MAX_THUMB).await.ok()
        };
        let Ok(Some(buf)) = tokio::time::timeout(Duration::from_secs(8), leg).await else { continue };
        if *name != "mqdefault" && buf.len() < 6000 { continue; }
        return Some(buf);
    }
    None
}

fn valid_id(id: &str) -> bool { id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') }

fn q_id(q: &HashMap<String, String>) -> String { q.get("id").map(|s| s.trim().to_string()).unwrap_or_default() }

fn track_for(st: &Arc<crate::AppState>, user: String) -> Track {
    let st = st.clone();
    Arc::new(move |n: usize| st.guard.track_bytes(&st.data_dir.to_string_lossy(), &user, n as i64))
}

                                                                                                      
                                                                                         
                                                                                                                        
pub type PullHook = dyn Fn(&str, &str) + Send + Sync;
static PULL_HOOK: OnceLock<Arc<PullHook>> = OnceLock::new();
                                                               
pub fn set_pull_hook(h: Arc<PullHook>) -> bool { PULL_HOOK.set(h).is_ok() }
const PULL_REFRESH: Duration = Duration::from_secs(10);
#[cfg(test)]static TEST_PULL_CALLS:OnceLock<std::sync::Mutex<HashMap<(String,String),usize>>>=OnceLock::new();
fn pull_notify(user: &str, id: &str) {
    #[cfg(test)]{*TEST_PULL_CALLS.get_or_init(Default::default).lock().unwrap().entry((user.into(),id.into())).or_default()+=1;}

    if let Some(h) = PULL_HOOK.get() {
        static LAST: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<(String, String), std::time::Instant>>> = std::sync::OnceLock::new();
        {
            let mut last = LAST.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
            let now = std::time::Instant::now();
            let key = (user.to_string(), id.to_string());
            if last.get(&key).is_some_and(|at| now.duration_since(*at) < Duration::from_secs(1)) { return; }
            last.retain(|_, at| now.duration_since(*at) < Duration::from_secs(1));
            last.insert(key, now);
        }
        let (h, u, i) = (h.clone(), user.to_string(), id.to_string());
        tokio::task::spawn_blocking(move || h(&u, &i));
    }
}
                                                                                                                                
fn track_pull(st: &Arc<crate::AppState>, user: String, id: String) -> Track {
    let base = track_for(st, user.clone());
    if PULL_HOOK.get().is_none() { return base; }
    throttled_notify(base, user, id, PULL_REFRESH)
}
fn throttled_notify(base: Track, user: String, id: String, every: Duration) -> Track {
    let last = std::sync::Mutex::new(std::time::Instant::now());
    Arc::new(move |n: usize| {
        base(n);
        let mut l = last.lock().unwrap();
        if l.elapsed() >= every { *l = std::time::Instant::now(); drop(l); pull_notify(&user, &id); }
    })
}

static THUMB_SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
                                                                            
fn thumb_slot() -> Result<OwnedSemaphorePermit, ()> {
    THUMB_SLOTS.get_or_init(|| Arc::new(Semaphore::new(8))).clone().try_acquire_owned().map_err(|_| ())
}

type ThumbJob = futures::future::Shared<futures::future::BoxFuture<'static, Option<Vec<u8>>>>;
static THUMB_INFLIGHT: OnceLock<std::sync::Mutex<HashMap<String, ThumbJob>>> = OnceLock::new();
                                                                                      
                                                                             
async fn thumb_id_shared(client: &reqwest::Client, id: &str, lite: bool) -> Option<Vec<u8>> {
    use futures::FutureExt;
    let key = format!("{id}:{}", if lite { "l" } else { "f" });
    let job = {
        let mut g = THUMB_INFLIGHT.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
        if let Some(j) = g.get(&key) { j.clone() } else {
            let (tx, rx) = tokio::sync::oneshot::channel::<Option<Vec<u8>>>();
            let (c, i, k) = (client.clone(), id.to_string(), key.clone());
            tokio::spawn(async move {
                let r = thumb_id_with(&c, &PROD, THUMB_HOST, &i, lite).await;
                THUMB_INFLIGHT.get().unwrap().lock().unwrap_or_else(|e| e.into_inner()).remove(&k);
                let _ = tx.send(r);
            });
            let j = rx.map(|r| r.unwrap_or(None)).boxed().shared();
            g.insert(key, j.clone());
            j
        }
    };
    job.await
}

async fn thumb_id_handler(State((st, _)): State<Shared>, Query(q): Query<HashMap<String, String>>, headers: HeaderMap) -> Response {
    let id = q_id(&q);
    if !valid_id(&id) { return json_err(StatusCode::BAD_REQUEST, "bad id"); }
    let Some(user) = crate::auth_api::user(&st, &headers).or_else(|| crate::auth_api::devices::bearer_user(&st, &headers))
        .or_else(|| q.get("t").and_then(|t| crate::auth_api::wisp::thumb_ticket_user(&st.data_dir, t)).filter(|u| st.auth_db.user_enabled(u))) else { return json_err(StatusCode::UNAUTHORIZED, "not signed in") };
                                                                                                                   
                                                                                                             
    let Ok(client) = stream_client(&st) else { return json_err(StatusCode::BAD_GATEWAY, "no thumb") };
    let Ok(_ts) = thumb_slot() else { return json_err(StatusCode::TOO_MANY_REQUESTS, "too many thumbs, try again in a moment") };
    let lite = q.get("lite").map(String::as_str) == Some("1");
    match thumb_id_shared(&client, &id, lite).await {
        None => json_err(StatusCode::BAD_GATEWAY, "no thumb"),
        Some(buf) => {
            track_for(&st, user)(buf.len());
            Response::builder().status(200)
                .header(header::CONTENT_TYPE, "image/jpeg").header(header::CACHE_CONTROL, "private, max-age=86400")                                    
                .header("x-content-type-options", "nosniff")
                .header(header::CONTENT_LENGTH, buf.len()).body(Body::from(buf)).unwrap()
        }
    }
}

                                                                                                          

#[derive(Clone)]
pub struct ResolveCfg { pub ytdlp: std::path::PathBuf, pub proxy: String }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hd { pub video_url: String, pub audio_url: String, pub quality: String }

pub struct Entry {
    url: std::sync::Mutex<Option<String>>,                                                                   
    mux: tokio::sync::OnceCell<Vec<String>>,                                                     
    pub quality: String,
    pub title: String,
    pub channel: String,
    pub channel_id: String,
    pub duration: f64,
    pub hd: Option<Hd>,
    pub hd_vp9: Option<Hd>,
    pub hd_l: Option<Hd>,
    pub hd_lvp9: Option<Hd>,
    expires: std::time::Instant,
}

const HUMAN: &str = "can't load this video - try another";
const NO_STREAM: &str = "no playable stream for this one";
const RESOLVE_TTL: Duration = Duration::from_secs(600);
const RESOLVE_CAP: usize = 200;
pub const YTDLP_OUT_MAX: usize = 32 * 1024 * 1024;

use serde_json::Value;
fn vs<'a>(f: &'a Value, k: &str) -> &'a str { f.get(k).and_then(Value::as_str).unwrap_or("") }
fn vn(f: &Value, k: &str) -> f64 { f.get(k).and_then(Value::as_f64).unwrap_or(0.0) }
fn direct(f: &Value) -> bool { !vs(f, "url").is_empty() && vs(f, "protocol") == "https" }
fn none_codec(c: &str) -> bool { c.is_empty() || c == "none" }
                                                 
fn eff(f: &Value) -> f64 { let (w, h) = (vn(f, "width"), vn(f, "height")); if w != 0.0 && h != 0.0 { w.min(h) } else if h != 0.0 { h } else { w } }
fn fps(f: &Value) -> f64 { let x = vn(f, "fps"); if x == 0.0 { 30.0 } else { x } }
fn js_num(x: f64) -> String { if x.fract() == 0.0 { format!("{}", x as i64) } else { format!("{x}") } }
fn quality_of(f: &Value) -> String {
    let n = vs(f, "format_note");
    if !n.is_empty() { return n.to_string(); }
    match f.get("height").and_then(Value::as_f64) { Some(h) if h != 0.0 => format!("{}p", js_num(h)), _ => "undefinedp".into() }
}
fn clip(s: &str, n: usize) -> String { s.chars().take(n).collect() }

                                                                                         
fn pick_cap<'a>(list: &[&'a Value], cap: f64) -> Option<&'a Value> {
    let w: Vec<&Value> = list.iter().copied().filter(|f| eff(f) <= cap).collect();
    let b = w.first().copied().or(list.last().copied())?;
    Some(w.iter().copied().find(|f| fps(f) <= 30.0 && eff(f) == eff(b)).unwrap_or(b))
}

fn sort_desc<'a>(v: &mut Vec<&'a Value>, key: impl Fn(&Value) -> f64) {
    v.sort_by(|a, b| key(b).partial_cmp(&key(a)).unwrap_or(std::cmp::Ordering::Equal));                        
}

fn mux_list(data: &Value) -> Vec<String> {
    let mut m: Vec<&Value> = data.get("formats").and_then(Value::as_array).map(|a| a.iter()
        .filter(|f| direct(f) && !vs(f, "vcodec").is_empty() && vs(f, "vcodec") != "none" && !vs(f, "acodec").is_empty() && vs(f, "acodec") != "none" && vs(f, "ext") == "mp4").collect()).unwrap_or_default();
    let h = |f: &Value| { let x = vn(f, "height"); if x == 0.0 { 360.0 } else { x } };
    m.sort_by(|a, b| (h(a) - 360.0).abs().partial_cmp(&(h(b) - 360.0).abs()).unwrap_or(std::cmp::Ordering::Equal));                       
    m.iter().map(|f| vs(f, "url").to_string()).collect()
}

                                                                                     
pub fn build_entry(data: &Value) -> Result<Entry, String> {
    let empty = vec![];
    let fmts: Vec<&Value> = data.get("formats").and_then(Value::as_array).unwrap_or(&empty).iter().collect();
    let mut videos: Vec<&Value> = fmts.iter().copied().filter(|f| direct(f) && none_codec(vs(f, "acodec")) && vs(f, "vcodec").starts_with("avc1") && eff(f) > 360.0).collect();
    sort_desc(&mut videos, eff);
    let video = pick_cap(&videos, 1080.0);
    let mut audios: Vec<&Value> = fmts.iter().copied().filter(|f| direct(f) && none_codec(vs(f, "vcodec")) && (vs(f, "ext") == "m4a" || vs(f, "acodec").starts_with("mp4a"))).collect();
    sort_desc(&mut audios, |f| vn(f, "abr"));
    let audio = audios.first().copied();
    let is_vp9 = |c: &str| c.starts_with("vp9") || c.starts_with("vp09");
    let mut vp9s: Vec<&Value> = fmts.iter().copied().filter(|f| direct(f) && none_codec(vs(f, "acodec")) && is_vp9(vs(f, "vcodec")) && eff(f) > 360.0).collect();
    sort_desc(&mut vp9s, eff);
    let vpick = pick_cap(&vp9s, 1080.0);
    let (lvideo, lvpick) = (pick_cap(&videos, 720.0), pick_cap(&vp9s, 720.0));
    let hd_of = |v: Option<&Value>| match (v, audio) {
        (Some(v), Some(a)) => Some(Hd { video_url: vs(v, "url").into(), audio_url: vs(a, "url").into(), quality: quality_of(v) }),
        _ => None,
    };
    let hd_ok = (video.is_some() && audio.is_some()) || (vpick.is_some() && audio.is_some());
    let mut url = None;
    let quality;
    if !hd_ok {
                                                                                                      
                                                                                                   
        let pick = fmts.iter().copied().find(|f| direct(f) && !vs(f, "vcodec").is_empty() && vs(f, "vcodec") != "none");
        url = pick.map(|f| vs(f, "url").to_string());
        quality = pick.map(quality_of).unwrap_or_default();
    } else {
        quality = quality_of(video.or(vpick).unwrap());
    }
    Ok(Entry {
        url: std::sync::Mutex::new(url),
        mux: tokio::sync::OnceCell::new(),
        quality,
        title: clip(vs(data, "title"), 200),
        channel: clip(if !vs(data, "channel").is_empty() { vs(data, "channel") } else { vs(data, "uploader") }, 200),
        channel_id: clip(if !vs(data, "channel_id").is_empty() { vs(data, "channel_id") } else { vs(data, "uploader_id") }, 64),
        duration: vn(data, "duration"),
        hd: hd_of(video), hd_vp9: hd_of(vpick), hd_l: hd_of(lvideo), hd_lvp9: hd_of(lvpick),
        expires: std::time::Instant::now() + RESOLVE_TTL,
    })
}

                                                                                               
                                                                                       

                                                                                             
                                                                                             
                                                                  
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapTrack { pub lang: String, pub name: String, pub kind: &'static str, pub url: String }

                                                                                               
const CAP_LANGS_MAX: usize = 64;

                                                                                                 
                                                                                             
                                                                                               
                                                                                               
                                                                                            
                                                                               
pub fn caption_tracks(data: &Value) -> Vec<CapTrack> {
    let mut out: Vec<CapTrack> = Vec::new();
    for (key, kind) in [("subtitles", "manual"), ("automatic_captions", "auto")] {
        let Some(map) = data.get(key).and_then(Value::as_object) else { continue };
        let mut langs: Vec<&String> = map.keys().collect();
        langs.sort();
        for k in langs {
            if out.len() >= CAP_LANGS_MAX { return out; }
            let lang = k.trim();
            if lang.is_empty() || lang.len() > 32 { continue; }
            let Some(arr) = map.get(k).and_then(Value::as_array) else { continue };
            let Some(t) = arr.iter().find(|t| vs(t, "ext") == "vtt" && vs(t, "url").starts_with("https://")) else { continue };
            let raw = vs(t, "name").trim();
            let name = if raw.is_empty() { lang.to_string() } else { clip(raw, 100) };
            out.push(CapTrack { lang: lang.to_string(), name, kind, url: vs(t, "url").to_string() });
        }
    }
    out
}

                                                                                           
                                                                                              
                                                                                            
                                                                               
pub fn pick_transcript_track<'a>(tracks: &'a [CapTrack], pref: Option<&str>) -> Option<&'a CapTrack> {
    let find = |kind: &str, lang: Option<&str>| tracks.iter().find(|t| t.kind == kind && lang.map_or(true, |l| t.lang == l));
    find("manual", pref).or_else(|| find("manual", Some("en"))).or_else(|| find("manual", None))
        .or_else(|| find("auto", pref)).or_else(|| find("auto", Some("en"))).or_else(|| find("auto", None))
}

                                                                                           
                                                                                                
                                                                                             
                                                                                               
                                                                                              
                                                                        
pub fn vtt_to_text(vtt: &str, cap: usize) -> String {
    let mut out = String::new();
    let mut prev = String::new();
    let (mut header, mut skip_block) = (true, false);
    for raw in vtt.lines() {
        let l = raw.trim();
        if l.is_empty() { header = false; skip_block = false; continue; }
        if header || skip_block { continue; }
        if l.starts_with("NOTE") || l == "STYLE" || l == "REGION" { skip_block = true; continue; }
        if l.contains("-->") || l.bytes().all(|b| b.is_ascii_digit()) { continue; }
        let mut clean = String::with_capacity(l.len());
        let mut in_tag = false;
        for c in l.chars() { match c { '<' => in_tag = true, '>' => in_tag = false, _ if !in_tag => clean.push(c), _ => {} } }
        let clean = clean.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ");
        let clean = clean.trim();
        if clean.is_empty() || clean == prev { continue; }
        if !out.is_empty() { out.push(' '); }
        out.push_str(clean);
        prev = clean.to_string();
        if out.len() >= cap { break; }
    }
    clip(&out, cap)
}

                                                                                               
                                                                                          

const CAP_VTT_MAX: usize = 2 << 20;                          
const CAP_CACHE_MAX: usize = 512;                                               

                                                                                               
                                                                                               
                                                                          
pub fn cap_host_ok(u: &Url) -> bool {
    plain_https(u) && u.host_str().map(|h| h.eq_ignore_ascii_case("www.youtube.com")).unwrap_or(false)
}

                                                                                             
                                                                                         
pub fn cap_lang_ok(l: &str) -> bool {
    !l.is_empty() && l.len() <= 32 && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

                                                                                               
                                                                                              
                                                                                           
                                                                        
static RESOLVE_CAPS: OnceLock<std::sync::Mutex<(HashMap<String, (Vec<CapTrack>, std::time::Instant)>, std::collections::VecDeque<String>)>> = OnceLock::new();

fn caps_put(id: &str, tracks: Vec<CapTrack>, expires: std::time::Instant) {
    let mut g = RESOLVE_CAPS.get_or_init(Default::default).lock().unwrap();
    if !g.0.contains_key(id) && g.0.len() >= CAP_CACHE_MAX {
        if let Some(k) = g.1.pop_front() { g.0.remove(&k); }
    }
    if g.0.insert(id.to_string(), (tracks, expires)).is_none() { g.1.push_back(id.to_string()); }
}

fn caps_get(id: &str) -> Option<Vec<CapTrack>> {
    let g = RESOLVE_CAPS.get_or_init(Default::default).lock().unwrap();
    g.0.get(id).filter(|(_, t)| *t > std::time::Instant::now()).map(|(v, _)| v.clone())
}

                                                                                              
                                                                                             
                                                                                               
                                                                   
async fn cap_fetch(client: &reqwest::Client, pol: &Policy, ok: fn(&Url) -> bool, url: &str, track: &Track) -> Result<Vec<u8>, LegErr> {
    let u = Url::parse(url).map_err(|_| LegErr::BadUrl)?;
    let (r, _) = fetch(client, pol, u, ok, None, &[("user-agent", GV_UA)]).await?;
    match r.status().as_u16() {
        200 => {}
        403 | 410 => return Err(LegErr::Expired),
        _ => return Err(LegErr::Upstream),
    }
    let b = read_capped(r, None, CAP_VTT_MAX).await?;
    if !b.starts_with(b"WEBVTT") { return Err(LegErr::Upstream); }
    track(b.len());
    Ok(b)
}

                                                                                                   
                                                                                             
                                                                                              
                                                                                                
                                                                                              
                                                                        
pub fn captions_json(id: &str, tracks: &[CapTrack]) -> String {
    let mut b = String::from("{\"ok\":true,\"tracks\":[");
    let mut first = true;
    for t in tracks.iter().filter(|t| cap_lang_ok(&t.lang)) {
        if !first { b.push(','); }
        first = false;
        let auto = t.kind == "auto";
        let src = format!("/api/apps/jetstream/captions?id={id}&lang={}{}", crate::lite::urlenc(&t.lang), if auto { "&auto=1" } else { "" });
        b += &format!("{{\"lang\":{},\"label\":{},\"auto\":{},\"src\":{}}}", jstr(&t.lang), jstr(&t.name), auto, jstr(&src));
    }
    b.push_str("]}");
    b
}

                                                                                                     
                                                                                            
async fn captions_handler(State((st, _)): State<Shared>, Query(q): Query<HashMap<String, String>>, headers: HeaderMap) -> Response {
    let id = q_id(&q);
    if !valid_id(&id) { return json_err(StatusCode::BAD_REQUEST, "bad video id"); }
    let Some(user) = crate::auth_api::user(&st, &headers).or_else(|| crate::auth_api::devices::bearer_user(&st, &headers)) else { return json_err(StatusCode::UNAUTHORIZED, "not signed in") };
    if st.guard.bytes_left(&user) <= 0 { return out_of_bandwidth(); }
                                                                                 
    let want = match q.get("lang") {
        None => None,
        Some(l) => {
            let l = l.trim();
            if !cap_lang_ok(l) { return json_err(StatusCode::BAD_REQUEST, "bad lang"); }
            Some((l.to_string(), q.get("auto").map(String::as_str) == Some("1")))
        }
    };
    let cfg = cfg_of(&st);
    if resolve_budgeted(&st, &cfg, &user, &id, false).await.is_err() { return json_err(StatusCode::BAD_GATEWAY, HUMAN); }
    let tracks = caps_get(&id).unwrap_or_default();
    let Some((lang, auto)) = want else {
        return Response::builder().status(StatusCode::OK)
            .header("content-type", "application/json; charset=utf-8")
            .header("cache-control", "no-store")
            .body(Body::from(captions_json(&id, &tracks))).unwrap();
    };
    let kind = if auto { "auto" } else { "manual" };
    let find = |ts: &[CapTrack]| ts.iter().find(|t| t.lang == lang && t.kind == kind).map(|t| t.url.clone());
    let Some(url) = find(&tracks) else { return json_err(StatusCode::NOT_FOUND, "no such caption track"); };
    let Ok(client) = stream_client(&st) else { return json_err(StatusCode::BAD_GATEWAY, "can't load captions for this one"); };
                                                                                           
    let track = track_for(&st, user.clone());
    let vtt_ok = |b: Vec<u8>| Response::builder().status(StatusCode::OK)
        .header("content-type", "text/vtt; charset=utf-8")
        .header("cache-control", "private, no-store")
        .body(Body::from(b)).unwrap();
    match cap_fetch(&client, &PROD, cap_host_ok, &url, &track).await {
        Ok(b) => vtt_ok(b),
        Err(LegErr::Expired) => {
                                                                                                    
            if resolve_budgeted(&st, &cfg, &user, &id, true).await.is_err() { return json_err(StatusCode::BAD_GATEWAY, "can't load captions for this one"); }
            let Some(fresh) = find(&caps_get(&id).unwrap_or_default()) else { return json_err(StatusCode::NOT_FOUND, "no such caption track"); };
            match cap_fetch(&client, &PROD, cap_host_ok, &fresh, &track).await {
                Ok(b) => vtt_ok(b),
                Err(_) => json_err(StatusCode::BAD_GATEWAY, "can't load captions for this one"),
            }
        }
        Err(_) => json_err(StatusCode::BAD_GATEWAY, "can't load captions for this one"),
    }
}

async fn run_ytdlp(cfg: &ResolveCfg, extra: &[&str], id: &str) -> Result<Value, String> {
                                                                                                                                                 
                                                                                               
                                                                       
    let _slots = match crate::apps::jetstream_up::ytdlp_take(&crate::apps::jetstream_up::YTDLP_LANE_MEDIA).await {
        Ok(s) => s, _ => return Err(HUMAN.to_string()),
    };
    let mut cmd = tokio::process::Command::new(&cfg.ytdlp);
    cmd.args(["--no-playlist", "--no-warnings", "--skip-download"]);
    cmd.args(extra);
    if !cfg.proxy.is_empty() { cmd.args(["--proxy", &cfg.proxy]); }                                               
    cmd.args(["-j", "--", &format!("https://www.youtube.com/watch?v={id}")]);
    cmd.kill_on_drop(true).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
                                                                                                                     
    let run = async {
        use tokio::io::AsyncReadExt;
        let mut child = cmd.spawn().map_err(|_| HUMAN.to_string())?;
        let (mut so, mut se) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
        let mut out = Vec::new();
                                                                                                          
        let err_task = tokio::spawn(async move { let mut e = Vec::new(); let _ = (&mut se).take(64 * 1024).read_to_end(&mut e).await; e });
        let mut so_cap = (&mut so).take(YTDLP_OUT_MAX as u64 + 1);
        let r1 = so_cap.read_to_end(&mut out).await;
        if r1.is_err() || out.len() > YTDLP_OUT_MAX { let _ = child.kill().await; err_task.abort(); return Err(HUMAN.to_string()); }
        let status = child.wait().await.map_err(|_| HUMAN.to_string())?;
        if !status.success() {
            let err = err_task.await.unwrap_or_default();
            tracing::warn!("jetstream ytdlp fail {id} {}", clip(String::from_utf8_lossy(&err).trim().lines().last().unwrap_or(""), 160));
            return Err(HUMAN.to_string());
        }
        Ok(out)
    };
    let out = match tokio::time::timeout(Duration::from_secs(30), run).await { Ok(r) => r?, Err(_) => return Err(HUMAN.into()) };
    serde_json::from_slice(&out).map_err(|_| HUMAN.to_string())
}

async fn resolve_via_ytdlp(cfg: ResolveCfg, id: String) -> Result<Arc<Entry>, String> {
    let data = run_ytdlp(&cfg, &["--extractor-args", "youtube:skip=hls,dash"], &id).await?;
    let e = build_entry(&data)?;
                                                                                              
    caps_put(&id, caption_tracks(&data), e.expires);
    if !(e.hd.is_some() || e.hd_vp9.is_some()) {
                                                                                          
                                                                                                 
                                                                                                    
        let m = mux_via_android(&cfg, &id).await;
        let mut u = e.url.lock().unwrap();
        let first = m.as_ref().and_then(|m| m.first().cloned()).or_else(|| u.clone());
        match (m, first) {
            (Some(m), Some(f)) => { *u = Some(f); drop(u); let _ = e.mux.set(m); }
            (Some(_), None) => { drop(u); return Err(NO_STREAM.into()); }                                            
            (None, Some(_)) => { drop(u); }                                                                                          
            (None, None) => { drop(u); return Err(HUMAN.to_string()); }                                                     
        }
    }
    Ok(Arc::new(e))
}

                                                                                                 
async fn mux_via_android(cfg: &ResolveCfg, id: &str) -> Option<Vec<String>> {
    match run_ytdlp(cfg, &["--extractor-args", "youtube:player_client=android"], id).await { Ok(d) => Some(mux_list(&d)), Err(_) => None }
}

                                                       
pub async fn mux_url(cfg: &ResolveCfg, id: &str, e: &Entry) -> Option<String> {
    if let Some(u) = e.url.lock().unwrap().clone() { return Some(u); }
                                                                                            
                                                                                             
    let m = e.mux.get_or_try_init(|| async { mux_via_android(cfg, id).await.filter(|m| !m.is_empty()).ok_or(()) }).await.ok()?;
    let first = m.first().cloned();
    if let Some(f) = &first { *e.url.lock().unwrap() = Some(f.clone()); }
    first
}

type Job = futures::future::Shared<futures::future::BoxFuture<'static, Result<Arc<Entry>, String>>>;
struct ResolveStore { map: HashMap<String, Arc<Entry>>, order: std::collections::VecDeque<String>, inflight: HashMap<String, Job>, neg: HashMap<String, (String, std::time::Instant)> }
static RESOLVED: OnceLock<std::sync::Mutex<ResolveStore>> = OnceLock::new();

                                                                                                  
pub async fn resolve_stream(cfg: &ResolveCfg, id: &str, force: bool) -> Result<Arc<Entry>, String> {
    use futures::FutureExt;
    let store = RESOLVED.get_or_init(|| std::sync::Mutex::new(ResolveStore { map: HashMap::new(), order: Default::default(), inflight: HashMap::new(), neg: HashMap::new() }));
    let job = {
        let mut s = store.lock().unwrap();
        if !force { if let Some(h) = s.map.get(id) { if h.expires > std::time::Instant::now() { return Ok(h.clone()); } } }
                                                                                                
                                                                               
        if let Some((m, at)) = s.neg.get(id) {
            if at.elapsed() < NEG_TTL { return Err(m.clone()); }
            s.neg.remove(id);
        }
        if let Some(j) = s.inflight.get(id) { j.clone() } else {
            let (cfg2, id2) = (cfg.clone(), id.to_string());
                                                                                                      
                                                                                                   
                                                                                                 
            let (tx, rx) = tokio::sync::oneshot::channel::<Result<Arc<Entry>, String>>();
            tokio::spawn(async move {
                let r = resolve_via_ytdlp(cfg2, id2.clone()).await;
                {
                    let mut s = RESOLVED.get().unwrap().lock().unwrap();
                    s.inflight.remove(&id2);
                    if let Ok(e) = &r {
                        if s.map.insert(id2.clone(), e.clone()).is_none() { s.order.push_back(id2.clone()); }
                        while s.map.len() > RESOLVE_CAP { if let Some(k) = s.order.pop_front() { s.map.remove(&k); } else { break; } }
                    } else if let Err(m) = &r {
                        if s.neg.len() >= 512 { s.neg.clear(); }                                                  
                        s.neg.insert(id2.clone(), (m.clone(), std::time::Instant::now()));
                    }
                }
                let _ = tx.send(r);
            });
            let j = rx.map(|r| r.unwrap_or_else(|_| Err("resolve job lost".to_string()))).boxed().shared();
            s.inflight.insert(id.to_string(), j.clone());
            j
        }
    };
    job.await
}

                                                                                                   
                                                                                              
                                                                                        
async fn resolve_budgeted(st: &Arc<crate::AppState>, cfg: &ResolveCfg, user: &str, id: &str, force: bool) -> Result<Arc<Entry>, String> {
    if !force {
        if let Some(hit) = RESOLVED.get().and_then(|m| m.lock().unwrap().map.get(id).filter(|e| e.expires > std::time::Instant::now()).cloned()) { return Ok(hit); }
    }
                                                                                            
                                                      
    let neg_live = RESOLVED.get().and_then(|m| m.lock().unwrap().neg.get(id).map(|(_, at)| at.elapsed() < NEG_TTL)).unwrap_or(false);
    if !neg_live && st.rates.window(format!("resolve:{user}"), 60, 3600000).is_some() { return Err(HUMAN.to_string()); }
    resolve_stream(cfg, id, force).await
}

                                                                                      
                                                                                         
                                                    
fn record_play_once(st: &Arc<crate::AppState>, user: &str, id: &str, e: &Entry) {
    static LAST: OnceLock<std::sync::Mutex<HashMap<(String, String), std::time::Instant>>> = OnceLock::new();
    {
        let mut last = LAST.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
        let now = std::time::Instant::now();
        let key = (user.to_string(), id.to_string());
        if last.get(&key).is_some_and(|at| now.duration_since(*at) < Duration::from_secs(600)) { return; }
        last.retain(|_, at| now.duration_since(*at) < Duration::from_secs(600));
        last.insert(key, now);
    }
    let (d, u, i, t, c, dur) = (st.data_dir.clone(), user.to_string(), id.to_string(), e.title.clone(), e.channel.clone(), e.duration);
    tokio::task::spawn_blocking(move || crate::apps::jetstream::record_play(&d, &u, &i, &t, &c, dur));
}

                                                              
fn budget_for(st: &Arc<crate::AppState>, user: &str) -> Budget {
    let (st, u) = (st.clone(), user.to_string());
    Arc::new(move || st.guard.bytes_left(&u))
}

                                                                                      

pub type Track = Arc<dyn Fn(usize) + Send + Sync>;
                                                                                      
pub type Budget = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type Refresh<'a> = &'a (dyn Fn() -> futures::future::BoxFuture<'static, Option<String>> + Send + Sync);

fn bodiless(status: u16) -> Response {
    Response::builder().status(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY)).body(Body::empty()).unwrap()
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Rng { From(u64, Option<u64>), Suffix(u64) }

                                                                                                                  
pub fn parse_range(h: &str) -> Option<Rng> {
    let r = h.strip_prefix("bytes=")?;
    let (a, b) = r.split_once('-')?;
    if !a.bytes().all(|c| c.is_ascii_digit()) || !b.bytes().all(|c| c.is_ascii_digit()) { return None; }
    let n = |s: &str| s.parse::<u64>().unwrap_or(u64::MAX);
    match (a.is_empty(), b.is_empty()) {
        (true, true) => None,
        (true, false) => Some(Rng::Suffix(n(b))),
        (false, true) => Some(Rng::From(n(a), None)),
        (false, false) => if n(b) < n(a) { None } else { Some(Rng::From(n(a), Some(n(b)))) },                                                 
    }
}

static GV_SIZE: OnceLock<std::sync::Mutex<(HashMap<String, (u64, std::time::Instant)>, std::collections::VecDeque<String>)>> = OnceLock::new();
fn size_get(u: &str) -> Option<u64> {
    let g = GV_SIZE.get_or_init(Default::default).lock().unwrap();
    g.0.get(u).filter(|(_, t)| t.elapsed() < Duration::from_secs(1800)).map(|(s, _)| *s)
}
fn size_put(u: &str, n: u64) {
    let mut g = GV_SIZE.get_or_init(Default::default).lock().unwrap();
    if g.0.len() >= 512 { if let Some(k) = g.1.pop_front() { g.0.remove(&k); } }
    if g.0.insert(u.to_string(), (n, std::time::Instant::now())).is_none() { g.1.push_back(u.to_string()); }
}
fn total_of(h: &HeaderMap) -> Option<u64> {
    let v = h.get("content-range")?.to_str().ok()?.trim_end();
    let t = v.rsplit('/').next()?;
    if t.is_empty() || !t.bytes().all(|c| c.is_ascii_digit()) { return None; }
    t.parse().ok()
}

                                                                                                         
                                                                                                                   
pub fn fail_status(st: u16) -> u16 { if (200..400).contains(&st) { 502 } else { st } }

pub const GV_UA: &str = "ramjet-jetstream/1.2";

                                                                         
fn window_of(h: &HeaderMap) -> Option<(u64, u64, u64)> {
    let s = h.get("content-range")?.to_str().ok()?.trim().strip_prefix("bytes ")?;
    let (ab, t) = s.split_once('/')?;
    let (a, b) = ab.split_once('-')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?, t.trim().parse().ok()?))
}

                                                                                              
                                                                                          
                                                                                             
                                                                                              
                                                                                               
                                                                                            
                              
#[derive(Debug, PartialEq, Eq)]
enum Chosen { Etag(String), Lm(String) }

                                                                                           
                                                                                             
                                                                                         
                                                                                       
                                                                                  
fn strong_etag(t: &str) -> bool {
    let Some(inner) = t.strip_prefix('"').and_then(|s| s.strip_suffix('"')) else { return false; };
    inner.bytes().all(|b| b == 0x21 || (0x23..=0x7e).contains(&b))
}

fn chosen_validator(etag: Option<String>, lm: Option<String>) -> Option<Chosen> {
    match etag {
        Some(t) if strong_etag(&t) => Some(Chosen::Etag(t)),
                                                                                        
                                                                                         
                                                                                            
        _ => lm.filter(|l| httpdate::parse_http_date(l).is_ok()).map(Chosen::Lm),
    }
}
struct Walk {
    client: reqwest::Client,
    pol: Policy,
    u: String,
    next: u64,                                                                                 
    total: u64,                                                      
    extent: u64,                                                            
    delivered: u64,                                                          
    chosen: Chosen,
    cap: u64,
    deadline: Duration,
}

                                                                                             
                                                                                                
                                                                                                
                                                                                           
                                                                                            
                                                                                           
                                                                                             
                           
pub const MIN_STREAM_RATE: u64 = 64 << 10;                                     
pub const WALK_DEADLINE_MAX: Duration = Duration::from_secs(30 * 60);                          
fn full_deadline(total: u64) -> Duration {
    BODY_TOTAL.max(Duration::from_secs(2 * (total / MIN_STREAM_RATE + 1))).min(WALK_DEADLINE_MAX)
}

                                                                                             
                                                                                           
                                                                      
#[cfg(test)]
thread_local! { static DEADLINE_OVERRIDE: std::cell::Cell<Option<Duration>> = const { std::cell::Cell::new(None) }; }

                                                                                               
                                                                                           
enum Mode { Capped { cap: u64 }, Full { deadline: Duration }, Walk(Walk) }

                                                                                                  
                                                                                                    
                                                                                                  
                                                                           
pub fn gv_proxy<'a>(client: &'a reqwest::Client, pol: &'a Policy, mut u: String, range: Option<&'a str>, if_range: Option<&'a str>, refresh: Option<Refresh<'a>>, cap: u64, track: Track, budget: Option<Budget>, hold: Option<OwnedSemaphorePermit>) -> futures::future::BoxFuture<'a, Response> {
    Box::pin(async move {
        let permit = match slot() { Ok(p) => p, Err(_) => return bodiless(429) };
                                                                                               
                                                                                       
        let rm = range.and_then(parse_range);
        let go = |url: &str, r: Option<String>, with_ir: bool| {
            let parsed = Url::parse(url);
            let (c, p) = (client.clone(), *pol);
            let ir = if with_ir && r.is_some() && rm.is_some() { if_range.map(str::to_owned) } else { None };
            async move {
                let Ok(pu) = parsed else { return Err(LegErr::BadUrl) };
                let mut h: Vec<(&str, &str)> = vec![("user-agent", GV_UA)];
                if let Some(i) = ir.as_deref() { h.push(("if-range", i)); }
                fetch(&c, &p, pu, p.media_ok, r.as_deref(), &h).await.map(|x| x.0)
            }
        };
        let mut hdr_range: Option<String> = None;
                                                                                                       
        let probe_size = |u: String, at: u64| {
            let go = &go;
            async move {
                if let Some(n) = size_get(&u) { return Ok(Some(n)); }
                let pr_range = Some(format!("bytes={at}-{at}"));
                let mut pr = go(&u, pr_range.clone(), false).await.map_err(|_| 502u16)?;
                if pr.status().as_u16() == 416 {
                    if let Some(t) = total_of(pr.headers()) { size_put(&u, t); }
                    return Err(416u16);
                }
                if matches!(pr.status().as_u16(), 403 | 410) {
                    drop(pr);
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    pr = go(&u, pr_range, false).await.map_err(|_| 502u16)?;
                }
                let ps = pr.status().as_u16();
                if ps != 206 && ps != 200 { return Err(ps); }
                let t = total_of(pr.headers());
                if let Some(t) = t { size_put(&u, t); }
                Ok(t)
            }
        };
        let oob = |size: u64| Response::builder().status(416).header("content-range", format!("bytes */{size}")).body(Body::empty()).unwrap();
        match rm {
            Some(Rng::From(start, end)) => {
                hdr_range = Some(format!("bytes={start}-{}", end.map(|e| e.min(start.saturating_add(cap - 1)).to_string()).unwrap_or_else(|| start.saturating_add(cap - 1).to_string())));                                                             
                if end.is_none() {
                    let size = match probe_size(u.clone(), start).await {
                        Ok(s) => s,
                        Err(416) => return size_get(&u).map(oob).unwrap_or_else(|| bodiless(416)),
                        Err(ps) => {
                            if let (Some(rf), 403 | 410) = (refresh, ps) {
                                if let Some(nu) = rf().await { if nu != u { drop(permit); return gv_proxy(client, pol, nu, range, if_range, None, cap, track, budget, hold).await; } }                                                        
                            }
                            return bodiless(ps);
                        }
                    };
                    if let Some(sz) = size { if start >= sz { return oob(sz); } }
                    hdr_range = Some(match size { Some(sz) => format!("bytes={start}-{}", start.saturating_add(cap - 1).min(sz - 1)), None => format!("bytes={start}-") });
                }
            }
            Some(Rng::Suffix(n)) => {
                                                                                                          
                                                       
                let n = n.min(cap);
                match probe_size(u.clone(), 0).await {
                    Ok(Some(size)) => {
                        if n == 0 || size == 0 { return oob(size); }
                        hdr_range = Some(format!("bytes={}-{}", size.saturating_sub(n), size - 1));
                    }
                    Ok(None) => { hdr_range = Some(format!("bytes=-{n}")); }
                    Err(416) => return size_get(&u).map(oob).unwrap_or_else(|| bodiless(416)),
                    Err(ps) => {
                        if let (Some(rf), 403 | 410) = (refresh, ps) {
                            if let Some(nu) = rf().await { if nu != u { drop(permit); return gv_proxy(client, pol, nu, range, if_range, None, cap, track, budget, hold).await; } }                                                        
                        }
                        return bodiless(ps);
                    }
                }
            }
                                                                                           
                                                                                                 
                                                                                                
            None => { hdr_range = Some(format!("bytes=0-{}", cap.saturating_sub(1))); }
        }
        let mut resp = None;
        for attempt in 0..5u32 {
            let r = match go(&u, hdr_range.clone(), true).await { Ok(r) => r, Err(_) => return bodiless(502) };
            let st = r.status().as_u16();
            if st == 200 || st == 206 { resp = Some(r); break; }
            if st == 416 {
                                                                                                  
                                                                                                
                                                                                                
                                                                                          
                                      
                if rm.is_none() && total_of(r.headers()) == Some(0) {
                    let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).filter(|v| !v.is_empty()).unwrap_or("video/mp4").to_string();
                    let mut b = Response::builder().status(200)
                        .header(header::CONTENT_TYPE, ct)
                        .header(header::CACHE_CONTROL, "private, no-store")
                        .header("accept-ranges", "bytes")
                        .header(header::CONTENT_LENGTH, 0u64);
                    for k in ["etag", "last-modified"] { if let Some(v) = r.headers().get(k) { b = b.header(k, v); } }
                    drop(r);
                    return b.body(Body::empty()).unwrap();
                }
                                                                                                                  
                let cr = r.headers().get("content-range").cloned()
                    .or_else(|| size_get(&u).and_then(|n| format!("bytes */{n}").parse().ok()));
                drop(r);
                let mut b = Response::builder().status(416);
                if let Some(c) = cr { b = b.header("content-range", c); }
                return b.body(Body::empty()).unwrap();
            }
            drop(r);
            if matches!(st, 403 | 410) && attempt < 4 {
                tokio::time::sleep(Duration::from_millis(300 * (attempt as u64 + 1))).await;
                if attempt == 2 {
                    if let Some(rf) = refresh { if let Some(nu) = rf().await { if nu != u { u = nu; } } }
                }
                continue;
            }
            return bodiless(fail_status(st));
        }
        let Some(r) = resp else { return bodiless(502) };
                                                                                      
                                                                                       
        remember_get_meta(&u,r.status(),r.headers());
                                                                                                  
                                                                                                
                                           
        let plain206 = rm.is_none() && r.status().as_u16() == 206;
        let win_len = if plain206 {
            r.headers().get("content-range").and_then(|v| v.to_str().ok())
                .and_then(|c| c.strip_prefix("bytes ")?.split('/').next()?.split_once('-')
                    .and_then(|(a, b)| b.trim().parse::<u64>().ok()?.checked_sub(a.trim().parse::<u64>().ok()?)?.checked_add(1)))
        } else { None };
                                                                             
                                                                                                  
                                                                                             
                                                                                            
                                                                  
        let walk = if plain206 {
            match (window_of(r.headers()), win_len) {
                (Some((0, _, t)), Some(wl)) if wl <= t => {
                    let etag = r.headers().get("etag").and_then(|v| v.to_str().ok()).map(str::to_string);
                    let lm = r.headers().get("last-modified").and_then(|v| v.to_str().ok()).map(str::to_string);
                                                                                             
                                                                                             
                                                                                              
                                                                                         
                                                                                        
                    let Some(chosen) = chosen_validator(etag, lm) else { drop(r); return bodiless(502); };
                    Some(Walk {
                        client: client.clone(), pol: *pol, u: u.clone(), next: wl, total: t, extent: wl, delivered: 0,
                        chosen, cap, deadline: full_deadline(t),
                    })
                }
                _ => { drop(r); return bodiless(502); }
            }
        } else { None };
                                                                                                 
                                                                                             
                                                                                            
                                                                                               
                                                       
        let mut open_len: Option<u64> = None;
        let walk = if walk.is_none() && matches!(rm, Some(Rng::From(_, None))) && r.status().as_u16() == 206 {
            let Some(Rng::From(start, None)) = rm else { unreachable!() };
            match window_of(r.headers()) {
                Some((ws, we, t)) if ws == start && we < t.saturating_sub(1) => {
                    let etag = r.headers().get("etag").and_then(|v| v.to_str().ok()).map(str::to_string);
                    let lm = r.headers().get("last-modified").and_then(|v| v.to_str().ok()).map(str::to_string);
                    match chosen_validator(etag, lm) {
                        Some(chosen) => {
                            open_len = Some(t - start);
                            Some(Walk {
                                client: client.clone(), pol: *pol, u: u.clone(), next: we + 1, total: t, extent: we - ws + 1, delivered: 0,
                                chosen, cap, deadline: full_deadline(t - start),
                            })
                        }
                        None => None,
                    }
                }
                _ => None,
            }
        } else { walk };
        let mut b = Response::builder().status(if plain206 { StatusCode::OK } else { r.status() })
            .header(header::CONTENT_TYPE, r.headers().get("content-type").and_then(|v| v.to_str().ok()).filter(|v| !v.is_empty()).unwrap_or("video/mp4").to_string())
            .header(header::CACHE_CONTROL, "private, no-store");
                                                                                                 
                                                                                                  
                                                                                                    
                                                                                       
        let cl_override: Option<String> = if let Some(w) = &walk { Some(open_len.unwrap_or(w.total).to_string()) } else if hdr_range.is_some() && rm.is_some() && r.status().as_u16() == 200 {
                                                                                                     
                                                                                                      
            r.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).map(|l| l.min(cap).to_string())
        } else { None };
        for k in ["content-length", "content-range", "etag", "last-modified"] {
            if (plain206 || open_len.is_some()) && k == "content-range" { continue; }
            if k == "content-length" && cl_override.is_some() { continue; }
            if let Some(v) = r.headers().get(k) { b = b.header(k, v); }
        }
        if let Some(l) = cl_override { b = b.header("content-length", l); }
        if let (Some(w), Some(_)) = (&walk, open_len) { b = b.header("content-range", format!("bytes {}-{}/{}", w.total - open_len.unwrap(), w.total - 1, w.total)); }
        b = b.header("accept-ranges", "bytes");                                                
                                                                                              
                                                                                                 
                                                                                                
                                                                                            
                                                                                                
                                  
                                                                                                
                                                                                              
                                                     
        let mode = match walk {
            Some(w) => Mode::Walk(w),
            None if rm.is_none() && r.status().as_u16() == 200 => Mode::Full { deadline: r.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).map(full_deadline).unwrap_or(BODY_TOTAL) },
            None => Mode::Capped { cap },
        };
        let deadline = match &mode { Mode::Walk(w) => w.deadline, Mode::Full { deadline } => *deadline, _ => BODY_TOTAL };
        #[cfg(test)]
        let deadline = DEADLINE_OVERRIDE.with(|o| o.get()).unwrap_or(deadline);
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
                                                                                             
                                                                                               
                                                                                   
        let failed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let failed2 = failed.clone();
        tokio::spawn(async move {
            let _permits = (permit, hold);                                                        
                                                                                           
            let mut r = r;
            let mut mode = mode;
            let mut sent = 0u64;
            let fail = |e: std::io::Error| { failed2.store(true, std::sync::atomic::Ordering::SeqCst); let _ = tx.try_send(Err(e)); };
            let produce = async {
                loop {
                    if let Some(b) = &budget { if b() <= 0 { fail(std::io::Error::new(std::io::ErrorKind::Other, "out of bandwidth")); return; } }
                    match tokio::time::timeout(CHUNK_STALL, r.chunk()).await {
                        Err(_) => { fail(std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out")); return; }
                        Ok(Err(_)) => { fail(std::io::Error::new(std::io::ErrorKind::Other, "upstream error")); return; }
                        Ok(Ok(None)) => {
                            let w = match &mut mode { Mode::Walk(w) => w, _ => return };
                                                                                       
                                                                                               
                                                                                              
                                                                                         
                            if w.delivered != w.extent { fail(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "window body length mismatch")); return; }
                            if w.next >= w.total { return; }                           
                                                                                                
                                                                                           
                                                                                             
                                                                                            
                                                                                            
                                                               
                            let end = w.next.saturating_add(w.cap - 1).min(w.total - 1);
                            let rng = format!("bytes={}-{}", w.next, end);
                            let ifr = Some(match &w.chosen { Chosen::Etag(t) => t.clone(), Chosen::Lm(l) => l.clone() });
                            let pu = match Url::parse(&w.u) { Ok(x) => x, Err(_) => { fail(std::io::Error::new(std::io::ErrorKind::Other, "bad url")); return; } };
                            let mut hdrs: Vec<(&str, &str)> = vec![("user-agent", GV_UA)];
                            if let Some(v) = &ifr { hdrs.push(("if-range", v.as_str())); }
                            let (r2, _) = match fetch(&w.client, &w.pol, pu, w.pol.media_ok, Some(&rng), &hdrs).await {
                                Ok(x) => x, Err(_) => { fail(std::io::Error::new(std::io::ErrorKind::Other, "upstream error")); return; }
                            };
                                                                                     
                                                                                         
                                                                                          
                                                                                           
                                                          
                            let ok = r2.status().as_u16() == 206 && match window_of(r2.headers()) {
                                Some((ws, we, wt)) => wt == w.total && ws == w.next && ws <= we && we <= end,
                                None => false,
                            };
                            if !ok { fail(std::io::Error::new(std::io::ErrorKind::Other, "object changed mid-stream")); return; }
                                                                                            
                                                                                          
                                                                             
                                                                                                                    
                                                                                     
                            let id_ok = match &w.chosen {
                                Chosen::Etag(t) => match r2.headers().get("etag").and_then(|v| v.to_str().ok()) {
                                    Some(v) if strong_etag(v) => v == t,
                                    _ => false,
                                },
                                Chosen::Lm(t) => r2.headers().get("last-modified").and_then(|v| v.to_str().ok()) == Some(t.as_str()),
                            };
                            if !id_ok { fail(std::io::Error::new(std::io::ErrorKind::Other, "object changed mid-stream")); return; }
                            let (_, we, _) = window_of(r2.headers()).unwrap();
                            w.extent = we - w.next + 1;
                            w.delivered = 0;
                            w.next = we + 1;
                            r = r2;
                            continue;
                        }
                        Ok(Ok(Some(c))) => {
                                                                                       
                            track(c.len());
                            if let Mode::Walk(w) = &mut mode {
                                w.delivered += c.len() as u64;
                                if w.delivered > w.extent { fail(std::io::Error::new(std::io::ErrorKind::Other, "window overlong")); return; }
                            }
                            let c = match &mode { Mode::Capped { cap } if sent + c.len() as u64 > *cap => c.slice(..(*cap - sent) as usize), _ => c };
                            if c.is_empty() { return; }
                            sent += c.len() as u64;
                            if tx.send(Ok(c)).await.is_err() { return; }                         
                        }
                    }
                }
            };
            tokio::select! {
                _ = tokio::time::sleep(deadline) => fail(std::io::Error::new(std::io::ErrorKind::TimedOut, "body deadline")),
                _ = produce => {}
            }
        });
        b.body(Body::from_stream(futures::stream::poll_fn(move |cx| match rx.poll_recv(cx) {
            std::task::Poll::Ready(None) if failed.load(std::sync::atomic::Ordering::SeqCst) =>
                std::task::Poll::Ready(Some(Err(std::io::Error::new(std::io::ErrorKind::Other, "producer failed")))),
            p => p,
        }))).unwrap()
    })
}


                                                                                      

#[derive(Clone, Default)]
struct Meta { size: u64, ct: String, etag: String, lm: String, ranged: bool }

static GV_META: OnceLock<std::sync::Mutex<(HashMap<String, (Meta, std::time::Instant)>, std::collections::VecDeque<String>)>> = OnceLock::new();
fn meta_get(u: &str) -> Option<Meta> {
    let g = GV_META.get_or_init(Default::default).lock().unwrap();
    g.0.get(u).filter(|(_, t)| t.elapsed() < Duration::from_secs(1800)).map(|(m, _)| m.clone())
}
fn validated_range_total(h:&HeaderMap)->Option<u64>{
 let raw=h.get(header::CONTENT_RANGE)?.to_str().ok()?.strip_prefix("bytes ")?;let(window,total)=raw.split_once('/')?;let(a,b)=window.split_once('-')?;let(a,b,total)=(a.parse::<u64>().ok()?,b.parse::<u64>().ok()?,total.parse::<u64>().ok()?);if a>b||b>=total{return None}Some(total)
}
fn remember_get_meta(u:&str,status:StatusCode,h:&HeaderMap){
                                                                                
    if h.get(header::CONTENT_ENCODING).is_some_and(|v|v.as_bytes()!=b"identity"){return}
    let size=match status.as_u16(){200=>h.get(header::CONTENT_LENGTH).and_then(|v|v.to_str().ok()).and_then(|v|v.parse::<u64>().ok()),206=>validated_range_total(h),_=>None};
    let Some(size)=size else{return};let get=|name:&str|h.get(name).and_then(|v|v.to_str().ok()).unwrap_or("").to_string();
    meta_put(u,Meta{size,ct:if get("content-type").is_empty(){"video/mp4".into()}else{get("content-type")},etag:get("etag"),lm:get("last-modified"),ranged:status==StatusCode::PARTIAL_CONTENT||meta_get(u).is_some_and(|m|m.ranged&&m.size==size)});
}
fn meta_put(u: &str, m: Meta) {
    size_put(u, m.size);
    let mut g = GV_META.get_or_init(Default::default).lock().unwrap();
    if g.0.len() >= 512 { if let Some(k) = g.1.pop_front() { g.0.remove(&k); } }
    if g.0.insert(u.to_string(), (m, std::time::Instant::now())).is_none() { g.1.push_back(u.to_string()); }
}

                                                                                                            
                                                                                           
                                                                                               
                                                                                                                                          
pub fn gv_head<'a>(client: &'a reqwest::Client, pol: &'a Policy, u: String, range: Option<&'a str>, refresh: Option<Refresh<'a>>, cap: u64) -> futures::future::BoxFuture<'a, Response> {
    Box::pin(async move {
        let meta = match meta_get(&u) {
            Some(m) => m,
            None => {
                let go = |url: &str| {
                    let parsed = Url::parse(url);
                    let (c, p) = (client.clone(), *pol);
                    async move {
                        let Ok(pu) = parsed else { return Err(LegErr::BadUrl) };
                        fetch(&c, &p, pu, p.media_ok, Some("bytes=0-0"), &[("user-agent", GV_UA)]).await.map(|x| x.0)
                    }
                };
                let mut pr = match go(&u).await { Ok(r) => r, Err(_) => return bodiless(502) };
                if matches!(pr.status().as_u16(), 403 | 410) {
                    drop(pr);
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    pr = match go(&u).await { Ok(r) => r, Err(_) => return bodiless(502) };
                }
                let ps = pr.status().as_u16();
                if !matches!(ps, 200 | 206 | 416) {
                    drop(pr);
                    if let (Some(rf), 403 | 410) = (refresh, ps) {
                        if let Some(nu) = rf().await { if nu != u { return gv_head(client, pol, nu, range, None, cap).await; } }
                    }
                    return bodiless(fail_status(ps));
                }
                let hs = pr.headers().clone();
                drop(pr);                                                                  
                                                                                                            
                if hs.get(header::CONTENT_ENCODING).is_some_and(|v|v.as_bytes()!=b"identity") { return bodiless(502) }
                let size = match ps {
                    200 => hs.get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()),
                    206 => validated_range_total(&hs),                                                
                    416 => total_of(&hs),                                                                       
                    _ => None,                                                                                      
                };
                let Some(size) = size else { return bodiless(502) };
                let g = |k: &str| hs.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                let m = Meta { size, ct: if g("content-type").is_empty() { "video/mp4".into() } else { g("content-type") }, etag: g("etag"), lm: g("last-modified"), ranged: ps != 200 };
                meta_put(&u, m.clone());
                m
            }
        };
        let size = meta.size;
        let mut b = Response::builder()
            .header(header::CONTENT_TYPE, meta.ct.as_str())
            .header(header::CACHE_CONTROL, "private, no-store")
            .header("accept-ranges", "bytes");
        if !meta.etag.is_empty() { b = b.header("etag", meta.etag.as_str()); }
        if !meta.lm.is_empty() { b = b.header("last-modified", meta.lm.as_str()); }
                                                                                                 
        let win: Option<(u64, u64)> = match range.and_then(parse_range).filter(|_| meta.ranged) {
            None => None,
            Some(Rng::From(a, e)) => {
                if a >= size { return Response::builder().status(416).header("content-range", format!("bytes */{size}")).body(Body::empty()).unwrap(); }
                                                                                                                           
                let validated = chosen_validator((!meta.etag.is_empty()).then(|| meta.etag.clone()), (!meta.lm.is_empty()).then(|| meta.lm.clone())).is_some();
                Some((a, e.map(|e| e.min(size - 1).min(a.saturating_add(cap - 1))).unwrap_or_else(|| if validated { size - 1 } else { a.saturating_add(cap - 1).min(size - 1) })))                                         
            }
            Some(Rng::Suffix(n)) => {
                if n == 0 || size == 0 { return Response::builder().status(416).header("content-range", format!("bytes */{size}")).body(Body::empty()).unwrap(); }
                let n = n.min(cap);                                             
                Some((size.saturating_sub(n), size - 1))
            }
        };
        let r = match win {
            None => b.status(200).header(header::CONTENT_LENGTH, size),
            Some((a, e)) => b.status(206).header("content-range", format!("bytes {a}-{e}/{size}")).header(header::CONTENT_LENGTH, e - a + 1),
        };
        r.body(Body::empty()).unwrap()
    })
}

                                                                                        

fn cfg_of(st: &crate::AppState) -> ResolveCfg { ResolveCfg { ytdlp: st.ytdlp.clone(), proxy: st.proxy_url.clone() } }

fn out_of_bandwidth() -> Response { json_err(StatusCode::TOO_MANY_REQUESTS, "out of bandwidth for now - it resets every hour") }

fn if_range_of(h: &HeaderMap) -> Option<String> { h.get(header::IF_RANGE).and_then(|v| v.to_str().ok()).map(str::to_owned) }
fn range_of(h: &HeaderMap) -> Option<String> { h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_owned) }

fn pick_url(e: &Entry, kind: &str) -> Option<String> {
    let hd = match kind { "video" => e.hd.as_ref().map(|h| &h.video_url), "vp9video" => e.hd_vp9.as_ref().map(|h| &h.video_url),
        "lvideo" => e.hd_l.as_ref().map(|h| &h.video_url), "lvp9video" => e.hd_lvp9.as_ref().map(|h| &h.video_url),
        _ => e.hd.as_ref().map(|h| &h.audio_url) };
    hd.cloned()
}

fn jstr(x: &str) -> String { serde_json::to_string(x).unwrap() }

                                                                                                              
pub fn watch_json(id: &str, e: &Entry, direct: Option<&str>, vp9: bool, lite: bool) -> String {
    let want_vp9 = vp9 && e.hd_vp9.is_some();
    let lite = lite && if want_vp9 { e.hd_lvp9.is_some() } else { e.hd_l.is_some() };
    let pick = if lite { if want_vp9 { e.hd_lvp9.as_ref() } else { e.hd_l.as_ref() } } else if want_vp9 { e.hd_vp9.as_ref() } else { e.hd.as_ref() };
    let mut b = format!("{{\"ok\":true,\"id\":{},\"quality\":{},\"stream\":{},\"direct\":{},\"channel\":{},\"channelId\":{}",
        jstr(id), jstr(&e.quality), jstr(&format!("/api/apps/jetstream/stream?id={id}")),
        direct.map(jstr).unwrap_or_else(|| "null".into()), jstr(&e.channel), jstr(&e.channel_id));
    if let Some(h) = pick {
        let kind = if lite { if want_vp9 { "lvp9video" } else { "lvideo" } } else if want_vp9 { "vp9video" } else { "video" };
        b += &format!(",\"hd\":{{\"quality\":{},\"video\":{},\"audio\":{},\"directVideo\":{},\"directAudio\":{}}}",
            jstr(&h.quality), jstr(&format!("/api/apps/jetstream/vsrc?id={id}&kind={kind}")), jstr(&format!("/api/apps/jetstream/vsrc?id={id}&kind=audio")),
            jstr(&h.video_url), jstr(&h.audio_url));
    }
    b.push('}');
    b
}

static DEAD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

                                                                                                    
                                                                                                 
                                                                                                     
pub fn mark_dead(dir: &std::path::Path, id: &str) -> bool {
    let _g = DEAD_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let f = dir.join("jetstream-dead.json");
    let mut ids: Vec<String> = match std::fs::read_to_string(&f) {
        Ok(t) => match serde_json::from_str::<Value>(&t).ok().and_then(|v| v.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())) {
            Some(ids) => ids,
            None => return false,
        },
        Err(_) => Vec::new(),                               
    };
    if ids.iter().any(|x| x == id) { return true; }
    ids.insert(0, id.to_string());
    ids.truncate(500);
    let tmp = dir.join(format!(".jetstream-dead.json.{}.tmp", std::process::id()));
    let body = serde_json::json!({ "ids": ids }).to_string();
    let wrote = std::fs::write(&tmp, body).is_ok() && std::fs::rename(&tmp, &f).is_ok();
    if !wrote { let _ = std::fs::remove_file(&tmp); return true; }
                                                                                                            
    DEAD_HOOK.with_hook(&id.to_string());
    true
}

                                                                                                                     
pub struct DeadHook;
pub static DEAD_HOOK: DeadHook = DeadHook;
static DEAD_CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
impl DeadHook {
    fn with_hook(&self, _id: &String) {
        DEAD_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        crate::apps::jetstream_feed::on_dead();
    }
}
pub fn dead_hook_calls() -> usize { DEAD_CALLS.load(std::sync::atomic::Ordering::SeqCst) }

async fn watch_handler(State((st, _)): State<Shared>, Query(q): Query<HashMap<String, String>>, headers: HeaderMap) -> Response {
    let id = q_id(&q);
    if !valid_id(&id) { return json_err(StatusCode::BAD_REQUEST, "bad video id"); }
    let Some(user) = crate::auth_api::user(&st, &headers).or_else(|| crate::auth_api::devices::bearer_user(&st, &headers)) else { return json_err(StatusCode::UNAUTHORIZED, "not signed in") };
    let cfg = cfg_of(&st);
    match resolve_budgeted(&st, &cfg, &user, &id, false).await {
        Ok(e) => {
            let body = watch_json(&id, &e, e.url.lock().unwrap().clone().as_deref(), q.get("vp9").map(String::as_str) == Some("1"), q.get("lite").map(String::as_str) == Some("1"));
            { let mut r = axum::response::IntoResponse::into_response((StatusCode::OK, body)); r.headers_mut().insert(header::CONTENT_TYPE, "application/json; charset=utf-8".parse().unwrap()); r.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().unwrap()); r }
        }
        Err(m) => {
                                                                                                      
                                                                                                       
                                                                                    
            if m == NO_STREAM && st.rates.window(format!("markdead:{user}"), 10, 3600000).is_none() && !mark_dead(&st.data_dir, &id) { return crate::apps::io_fail(); }                                              
            json_err(StatusCode::BAD_GATEWAY, if m == NO_STREAM { NO_STREAM } else { HUMAN })
        }
    }
}

fn cached_head(id:&str,kind:Option<&str>,headers:&HeaderMap)->Response{
    let miss=||Response::builder().status(503).header(header::RETRY_AFTER,"1").header(header::CACHE_CONTROL,"no-store").body(Body::empty()).unwrap();
    let entry=RESOLVED.get().and_then(|m|m.lock().ok()?.map.get(id).filter(|e|e.expires>std::time::Instant::now()).cloned());
    let Some(entry)=entry else{return miss()};
                                                                                            
                                                                                       
                                                                                          
                                                                                           
                                                                               
    let url=match kind{
        Some(k)=>match pick_url(&entry,k){Some(u)=>u,None=>return bodiless(404)},
        None=>match entry.url.lock().unwrap().clone(){Some(u)=>u,None=>return miss()},
    };let Some(meta)=meta_get(&url)else{return miss()};
    head_meta(meta,range_of(headers).as_deref(),if kind.is_some_and(|k|k!="audio"){8<<20}else{4<<20})
}
fn head_meta(meta:Meta,range:Option<&str>,cap:u64)->Response{
    let validated=chosen_validator((!meta.etag.is_empty()).then(||meta.etag.clone()),(!meta.lm.is_empty()).then(||meta.lm.clone())).is_some();
    let mut b=Response::builder().header(header::CONTENT_TYPE,meta.ct).header(header::CACHE_CONTROL,"private, no-store").header("accept-ranges","bytes");
    if !meta.etag.is_empty(){b=b.header("etag",meta.etag)}if !meta.lm.is_empty(){b=b.header("last-modified",meta.lm)}
    let window=match range.and_then(parse_range).filter(|_|meta.ranged){Some(Rng::From(a,e))=>{if a>=meta.size{return Response::builder().status(416).header("content-range",format!("bytes */{}",meta.size)).body(Body::empty()).unwrap()}Some((a,match e{Some(e)=>e.min(a.saturating_add(cap-1)).min(meta.size-1),None if validated=>meta.size-1,None=>a.saturating_add(cap-1).min(meta.size-1)}))},Some(Rng::Suffix(n))=>{if n==0||meta.size==0{return Response::builder().status(416).header("content-range",format!("bytes */{}",meta.size)).body(Body::empty()).unwrap()}let n=n.min(cap);Some((meta.size.saturating_sub(n),meta.size-1))},None=>None};
    if let Some((a,e))=window{b.status(206).header("content-range",format!("bytes {a}-{e}/{}",meta.size)).header(header::CONTENT_LENGTH,e-a+1).body(Body::empty()).unwrap()}else{b.status(200).header(header::CONTENT_LENGTH,meta.size).body(Body::empty()).unwrap()}
}
                                                                                                                                                                                                                                                                               
#[cfg(not(test))] fn handler_policy() -> &'static Policy { &PROD }
#[cfg(test)] fn handler_policy() -> &'static Policy { static P: Policy = Policy { media_ok: test_loopback_ok, thumb_ok: test_loopback_ok, pin: false }; &P }
#[cfg(test)] fn test_loopback_ok(u: &Url) -> bool { u.scheme() == "http" && u.host_str() == Some("127.0.0.1") }

async fn vsrc_inner(State((st, _)): State<Shared>, method: Method, Query(q): Query<HashMap<String, String>>, headers: HeaderMap) -> Response {
    let id = q_id(&q);
    let kind = q.get("kind").cloned().unwrap_or_default();
    if !valid_id(&id) { return json_err(StatusCode::BAD_REQUEST, "bad video id"); }
    if !["video", "audio", "vp9video", "lvideo", "lvp9video"].contains(&kind.as_str()) { return json_err(StatusCode::BAD_REQUEST, "bad kind"); }
    let Some(user) = crate::auth_api::user(&st, &headers).or_else(|| crate::auth_api::devices::bearer_user(&st, &headers)) else { return json_err(StatusCode::UNAUTHORIZED, "not signed in") };
    if st.guard.bytes_left(&user) <= 0 { return out_of_bandwidth(); }
    if method==Method::HEAD{return cached_head(&id,Some(&kind),&headers)}
    let Ok(client) = stream_client(&st) else { return bodiless(502) };
    let cfg = cfg_of(&st);
    let Ok(s) = resolve_budgeted(&st, &cfg, &user, &id, false).await else { return bodiless(502) };
    if s.hd.is_none() { return bodiless(404); }
    if (kind == "vp9video" && s.hd_vp9.is_none()) || (kind == "lvideo" && s.hd_l.is_none()) || (kind == "lvp9video" && s.hd_lvp9.is_none()) { return bodiless(404); }
    let Some(u) = pick_url(&s, &kind) else { return bodiless(404) };
                                                                                                           
    let first_leg = headers.get(axum::http::header::RANGE).and_then(|v| v.to_str().ok()).map_or(true, |r| r.starts_with("bytes=0-"));
    let (rcfg, rid, rkind) = (cfg.clone(), id.clone(), kind.clone());
    let refresh = move || -> futures::future::BoxFuture<'static, Option<String>> {
        let (c, i, k) = (rcfg.clone(), rid.clone(), rkind.clone());
        Box::pin(async move { resolve_stream(&c, &i, true).await.ok().and_then(|e| pick_url(&e, &k)) })
    };
    let cap = if kind == "audio" { 4 << 20 } else { 8 << 20 };
    if method == Method::HEAD { return gv_head(&client, handler_policy(), u, range_of(&headers).as_deref(), Some(&refresh), cap).await; }
    let Some(hold) = user_permit(&user) else { return bodiless(429) };                                 
    let resp = gv_proxy(&client, handler_policy(), u, range_of(&headers).as_deref(), if_range_of(&headers).as_deref(), Some(&refresh), cap, track_pull(&st, user.clone(), id.clone()), Some(budget_for(&st, &user)), Some(hold)).await;
                                                                                                        
    if resp.status().is_success() { pull_notify(&user, &id); if first_leg { record_play_once(&st, &user, &id, &s); } }
    resp
}

                                                                               
                                                                             
const MEDIA_LOG_CAP: u64 = 512 * 1024;

                                                                                     
                                                                                      
                                                                                 
                                                                                 
                                                                                   
                                                                                   
fn log_leg(st: &Arc<crate::AppState>, route: &str, method: &Method, id_raw: &str, status: StatusCode, t0: std::time::Instant) {
    let id = if valid_id(id_raw) { id_raw } else { "-" };
    let line = format!("{} {} {} id={} {} {}ms\n", crate::lite::iso_now(), method.as_str(), route, id, status.as_u16(), t0.elapsed().as_millis());
    let p = st.data_dir.join("jetstream-media-access.log");
    if let Ok(m) = std::fs::metadata(&p) {
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            if m.permissions().mode() & 0o777 != 0o600 {
                let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
            }
        }
        if m.len() >= MEDIA_LOG_CAP {
            if let Ok(b) = std::fs::read(&p) {
                let cut = b.iter().position(|&c| c == b'\n').map(|i| i + 1).unwrap_or(0) + b.len() / 2;
                let cut = b[cut.min(b.len())..].iter().position(|&c| c == b'\n').map(|i| cut + i + 1).unwrap_or(b.len());
                let _ = std::fs::write(&p, &b[cut..]);
            }
        }
    }
    let mut oo = std::fs::OpenOptions::new();
    oo.create(true).append(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; oo.mode(0o600); }
    let _ = oo.open(&p).map(|mut f| { use std::io::Write; let _ = f.write_all(line.as_bytes()); });
}

async fn stream_handler(State((st, a)): State<Shared>, method: Method, Query(q): Query<HashMap<String, String>>, headers: HeaderMap) -> Response {
    let (t0, m, id) = (std::time::Instant::now(), method.clone(), q_id(&q));
    let r = stream_inner(State((st.clone(), a)), method, Query(q), headers).await;
    log_leg(&st, "/stream", &m, &id, r.status(), t0);
    r
}

async fn vsrc_handler(State((st, a)): State<Shared>, method: Method, Query(q): Query<HashMap<String, String>>, headers: HeaderMap) -> Response {
    let (t0, m, id) = (std::time::Instant::now(), method.clone(), q_id(&q));
    let r = vsrc_inner(State((st.clone(), a)), method, Query(q), headers).await;
    log_leg(&st, "/vsrc", &m, &id, r.status(), t0);
    r
}

async fn stream_inner(State((st, _)): State<Shared>, method: Method, Query(q): Query<HashMap<String, String>>, headers: HeaderMap) -> Response {
    let id = q_id(&q);
    if !valid_id(&id) { return json_err(StatusCode::BAD_REQUEST, "bad video id"); }
    let Some(user) = crate::auth_api::user(&st, &headers).or_else(|| crate::auth_api::devices::bearer_user(&st, &headers)) else { return json_err(StatusCode::UNAUTHORIZED, "not signed in") };
    if st.guard.bytes_left(&user) <= 0 { return out_of_bandwidth(); }
    if method==Method::HEAD{return cached_head(&id,None,&headers)}
    let Ok(client) = stream_client(&st) else { return bodiless(502) };
    let cfg = cfg_of(&st);
    let Ok(s) = resolve_budgeted(&st, &cfg, &user, &id, false).await else { return bodiless(502) };
    let Some(mu) = mux_url(&cfg, &id, &s).await else { return bodiless(404) };
                                                                                                           
    let first_leg = headers.get(axum::http::header::RANGE).and_then(|v| v.to_str().ok()).map_or(true, |r| r.starts_with("bytes=0-"));
    let (rcfg, rid) = (cfg.clone(), id.clone());
    let refresh = move || -> futures::future::BoxFuture<'static, Option<String>> {
        let (c, i) = (rcfg.clone(), rid.clone());
        Box::pin(async move { let e = resolve_stream(&c, &i, true).await.ok()?; mux_url(&c, &i, &e).await })
    };
    if method == Method::HEAD { return gv_head(&client, handler_policy(), mu, range_of(&headers).as_deref(), Some(&refresh), 4 << 20).await; }
    let Some(hold) = user_permit(&user) else { return bodiless(429) };                                 
    let resp = gv_proxy(&client, handler_policy(), mu, range_of(&headers).as_deref(), if_range_of(&headers).as_deref(), Some(&refresh), 4 << 20, track_pull(&st, user.clone(), id.clone()), Some(budget_for(&st, &user)), Some(hold)).await;
    if resp.status().is_success() { pull_notify(&user, &id); if first_leg { record_play_once(&st, &user, &id, &s); } }
    resp
}

#[cfg(test)]mod head_admission_tests{use super::*;
 #[tokio::test]async fn cold_head_does_not_resolve_or_stamp(){let st=Arc::new(crate::auth_api::devices::tests::fixture("cold-head-fixture"));let token="d".repeat(48);st.auth_db.device_insert("head-fixture-device","cold-head-fixture","tv","roku",&token).unwrap();let mut headers=HeaderMap::new();headers.insert("authorization",format!("Bearer {token}").parse().unwrap());for stream in [false,true]{let mut q=HashMap::new();q.insert("id".into(),"HEADFIXTURE".into());q.insert("kind".into(),"video".into());let r=if stream{stream_handler(State((st.clone(),Default::default())),Method::HEAD,Query(q),headers.clone()).await}else{vsrc_handler(State((st.clone(),Default::default())),Method::HEAD,Query(q),headers.clone()).await};assert_eq!(r.status(),StatusCode::SERVICE_UNAVAILABLE);assert_eq!(r.headers()[header::RETRY_AFTER],"1");assert_eq!(r.headers()[header::CACHE_CONTROL],"no-store");assert!(axum::body::to_bytes(r.into_body(),100).await.unwrap().is_empty());assert_eq!(TEST_PULL_CALLS.get_or_init(Default::default).lock().unwrap().get(&("cold-head-fixture".into(),"HEADFIXTURE".into())).copied().unwrap_or(0),0);assert!(!st.data_dir.join("jetstream-playback.json").exists());}if let Some(s)=RESOLVED.get(){let s=s.lock().unwrap();assert!(!s.map.contains_key("HEADFIXTURE")&&!s.inflight.contains_key("HEADFIXTURE"));}}
 #[tokio::test]async fn real_get_warms_production_head_handler(){
    let app=axum::Router::new().route("/media",axum::routing::get(||async{Response::builder().header("content-type","video/mp4").header("content-length","4").header("etag","fixture-etag").body(Body::from("data")).unwrap()}));
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}/media",listener.local_addr().unwrap());let server=tokio::spawn(async move{axum::serve(listener,app).await.unwrap()});
    let st=Arc::new(crate::auth_api::devices::tests::fixture("warm-head-fixture"));let token="e".repeat(48);st.auth_db.device_insert("warm-head-device","warm-head-fixture","tv","roku",&token).unwrap();
    let mut headers=HeaderMap::new();headers.insert("authorization",format!("Bearer {token}").parse().unwrap());let mut q=HashMap::new();q.insert("id".into(),"WARMFIXTURE".into());
    let store=RESOLVED.get_or_init(||std::sync::Mutex::new(ResolveStore{map:HashMap::new(),order:Default::default(),inflight:HashMap::new(),neg:HashMap::new()}));store.lock().unwrap().map.insert("WARMFIXTURE".into(),Arc::new(Entry{url:std::sync::Mutex::new(Some(url.clone())),mux:tokio::sync::OnceCell::new(),quality:String::new(),title:String::new(),channel:String::new(),channel_id:String::new(),duration:0.0,hd:None,hd_vp9:None,hd_l:None,hd_lvp9:None,expires:std::time::Instant::now()+RESOLVE_TTL}));
    let cold=stream_handler(State((st.clone(),Default::default())),Method::HEAD,Query(q.clone()),headers.clone()).await;assert_eq!(cold.status(),StatusCode::SERVICE_UNAVAILABLE);
    fn local(u:&Url)->bool{u.host_str()==Some("127.0.0.1")}let policy=Policy{media_ok:local,thumb_ok:local,pin:false};let client=reqwest::Client::new();let r=gv_proxy(&client,&policy,url,None,None,None,4<<20,Arc::new(|_|{}),None,None).await;assert_eq!(r.status(),StatusCode::OK);assert_eq!(axum::body::to_bytes(r.into_body(),100).await.unwrap().as_ref(),b"data");
    server.abort();let warm=stream_handler(State((st.clone(),Default::default())),Method::HEAD,Query(q.clone()),headers.clone()).await;assert_eq!(warm.status(),StatusCode::OK);assert_eq!(warm.headers()[header::CONTENT_LENGTH],"4");assert_eq!(warm.headers()[header::ETAG],"fixture-etag");headers.insert(header::RANGE,"bytes=10-19".parse().unwrap());let range=stream_handler(State((st,Default::default())),Method::HEAD,Query(q),headers).await;assert_eq!(range.status(),StatusCode::OK);assert_eq!(range.headers()[header::CONTENT_LENGTH],"4");
 }
 #[tokio::test]async fn warm_head_without_url_for_kind_is_404_not_503(){
    let st=Arc::new(crate::auth_api::devices::tests::fixture("warm-head-404-fixture"));let token="e".repeat(48);st.auth_db.device_insert("head-404-device","warm-head-404-fixture","tv","roku",&token).unwrap();let mut headers=HeaderMap::new();headers.insert("authorization",format!("Bearer {token}").parse().unwrap());
    let store=RESOLVED.get_or_init(||std::sync::Mutex::new(ResolveStore{map:HashMap::new(),order:Default::default(),inflight:HashMap::new(),neg:HashMap::new()}));
    store.lock().unwrap().map.insert("HEAD404FIX0".into(),Arc::new(Entry{url:std::sync::Mutex::new(Some("http://127.0.0.1/unused".into())),mux:tokio::sync::OnceCell::new(),quality:String::new(),title:String::new(),channel:String::new(),channel_id:String::new(),duration:0.0,hd:None,hd_vp9:None,hd_l:None,hd_lvp9:None,expires:std::time::Instant::now()+RESOLVE_TTL}));
    let mut q=HashMap::new();q.insert("id".into(),"HEAD404FIX0".into());q.insert("kind".into(),"video".into());
    let r=vsrc_handler(State((st.clone(),Default::default())),Method::HEAD,Query(q),headers.clone()).await;
    assert_eq!(r.status(),StatusCode::NOT_FOUND);assert!(r.headers().get(header::RETRY_AFTER).is_none());assert!(axum::body::to_bytes(r.into_body(),100).await.unwrap().is_empty());
                                                                                                    
    let mut q=HashMap::new();q.insert("id".into(),"HEAD404COLD".into());q.insert("kind".into(),"video".into());
    let r=vsrc_handler(State((st,Default::default())),Method::HEAD,Query(q),headers).await;
    assert_eq!(r.status(),StatusCode::SERVICE_UNAVAILABLE);assert_eq!(r.headers()[header::RETRY_AFTER],"1");
 }
 #[test]fn get_metadata_validation_and_ttl(){
    let mut h=HeaderMap::new();h.insert("content-range","bytes 10-19/100".parse().unwrap());h.insert("content-type","video/mp4".parse().unwrap());remember_get_meta("fixture-valid206",StatusCode::PARTIAL_CONTENT,&h);assert_eq!(meta_get("fixture-valid206").unwrap().size,100);
    for (i,range)in["bytes 10-19/*","bytes 10-19/bad","bytes 10-19/15","bad/100"].iter().enumerate(){h.insert("content-range",range.parse().unwrap());let key=format!("fixture-bad206-{i}");remember_get_meta(&key,StatusCode::PARTIAL_CONTENT,&h);assert!(meta_get(&key).is_none());}
    h.insert("content-length","100".parse().unwrap());remember_get_meta("fixture-valid206",StatusCode::OK,&h);let merged=head_meta(meta_get("fixture-valid206").unwrap(),Some("bytes=10-19"),100);assert_eq!(merged.status(),StatusCode::PARTIAL_CONTENT);assert_eq!(merged.headers()[header::CONTENT_LENGTH],"10");h.remove("content-length");
    remember_get_meta("fixture-nolength200",StatusCode::OK,&h);assert!(meta_get("fixture-nolength200").is_none());h.insert("content-length","100".parse().unwrap());remember_get_meta("fixture-error500",StatusCode::INTERNAL_SERVER_ERROR,&h);assert!(meta_get("fixture-error500").is_none());
    h.insert("content-encoding","gzip".parse().unwrap());remember_get_meta("fixture-gzip",StatusCode::OK,&h);assert!(meta_get("fixture-gzip").is_none());h.remove("content-encoding");remember_get_meta("fixture-expired-meta",StatusCode::OK,&h);
    {let mut c=GV_META.get().unwrap().lock().unwrap();c.0.get_mut("fixture-expired-meta").unwrap().1=std::time::Instant::now()-Duration::from_secs(1801);}assert!(meta_get("fixture-expired-meta").is_none());
    remember_get_meta("fixture-full200range",StatusCode::OK,&h);let r=head_meta(meta_get("fixture-full200range").unwrap(),Some("bytes=10-19"),4<<20);assert_eq!(r.status(),StatusCode::OK);assert_eq!(r.headers()[header::CONTENT_LENGTH],"100");                                            
 }
 #[tokio::test]async fn gv_head_probe_refuses_encoded_representations(){
    let app=axum::Router::new()
        .route("/enc",axum::routing::get(||async{Response::builder().status(206).header("content-range","bytes 0-0/100").header("content-type","video/mp4").header("content-encoding","gzip").body(Body::from("x")).unwrap()}))
        .route("/plain",axum::routing::get(||async{Response::builder().status(206).header("content-range","bytes 0-0/100").header("content-type","video/mp4").body(Body::from("x")).unwrap()}));
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let base=listener.local_addr().unwrap();let server=tokio::spawn(async move{axum::serve(listener,app).await.unwrap()});
    fn local(u:&Url)->bool{u.host_str()==Some("127.0.0.1")}let policy=Policy{media_ok:local,thumb_ok:local,pin:false};
                                                                                        
                                                                                        
                                                                                     
    let client=reqwest::Client::builder().gzip(false).brotli(false).build().unwrap();
    let enc=gv_head(&client,&policy,format!("http://{base}/enc"),None,None,4<<20).await;assert_eq!(enc.status(),StatusCode::BAD_GATEWAY);
    let plain=gv_head(&client,&policy,format!("http://{base}/plain"),None,None,4<<20).await;assert_eq!(plain.status(),StatusCode::OK);assert_eq!(plain.headers()[header::CONTENT_LENGTH],"100");
    server.abort();
 }
 #[test]fn cached_headers_range(){let r=head_meta(Meta{size:1000,ct:"video/mp4".into(),ranged:true,..Default::default()},Some("bytes=10-19"),100);assert_eq!(r.status(),StatusCode::PARTIAL_CONTENT);assert_eq!(r.headers()[header::CONTENT_LENGTH],"10");}
}
#[cfg(test)]
mod watch_tests {
    use super::*;
    fn hd_from(v: &Value) -> Option<Hd> {
        if v.is_null() { return None; }
        Some(Hd { video_url: vs(v, "videoUrl").into(), audio_url: vs(v, "audioUrl").into(), quality: vs(v, "quality").into() })
    }
    fn entry_from(v: &Value) -> Entry {
        Entry { url: std::sync::Mutex::new(v["url"].as_str().map(String::from)), mux: tokio::sync::OnceCell::new(),
            quality: vs(v, "quality").into(), title: vs(v, "title").into(), channel: vs(v, "channel").into(), channel_id: vs(v, "channelId").into(), duration: 0.0,
            hd: hd_from(&v["hd"]), hd_vp9: hd_from(&v["hdVp9"]), hd_l: hd_from(&v["hdL"]), hd_lvp9: hd_from(&v["hdLVp9"]),
            expires: std::time::Instant::now() + RESOLVE_TTL }
    }

    #[test]
    fn watch_body_matches_real_r32_bytes_for_all_16_cases() {
        let g: Value = serde_json::from_str(include_str!("../tests/golden/r32_watch.json")).unwrap();
        let cases = g["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 16);
        for c in cases {
            let e = entry_from(&g["entries"][c["name"].as_str().unwrap()]);
            let direct = e.url.lock().unwrap().clone();
            let got = watch_json("abcDEF12345", &e, direct.as_deref(), c["vp9"].as_bool().unwrap(), c["lite"].as_bool().unwrap());
            assert_eq!(got, c["body"].as_str().unwrap(), "case {} vp9={} lite={}", c["name"], c["vp9"], c["lite"]);
        }
    }

    #[test]
    fn mark_dead_is_newest_first_deduped_capped_and_atomic() {
        let d = std::env::temp_dir().join(format!("rj-dead-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let c0 = dead_hook_calls();
        mark_dead(&d, "aaaaaaaaaaa"); mark_dead(&d, "bbbbbbbbbbb"); mark_dead(&d, "aaaaaaaaaaa");
        assert_eq!(dead_hook_calls() - c0, 2, "feed on_dead fires once per NEWLY dead id, not for the duplicate (r32 returns early)");
        assert_eq!(std::fs::read_to_string(d.join("jetstream-dead.json")).unwrap(), r#"{"ids":["bbbbbbbbbbb","aaaaaaaaaaa"]}"#);
        for i in 0..600 { mark_dead(&d, &format!("id{i:09}")); }
        let v: Value = serde_json::from_str(&std::fs::read_to_string(d.join("jetstream-dead.json")).unwrap()).unwrap();
        assert_eq!(v["ids"].as_array().unwrap().len(), 500);
        assert_eq!(v["ids"][0], "id000000599");
        assert!(std::fs::read_dir(&d).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")), "no temp left behind");
    }
}

#[cfg(test)]
mod pull_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    static LAST: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pull_hook_seam_is_noop_by_default_nonblocking_and_throttled() {
                                                                                             
        pull_notify("u", "aaaaaaaaaaa");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(CALLS.load(SeqCst), 0, "default is a no-op");
                                                                                                      
        assert!(set_pull_hook(Arc::new(|u: &str, i: &str| { CALLS.fetch_add(1, SeqCst); *LAST.lock().unwrap() = format!("{u}/{i}"); std::thread::sleep(Duration::from_secs(5)); })));
        assert!(!set_pull_hook(Arc::new(|_: &str, _: &str| {})), "second install refused");
        let t = std::time::Instant::now();
        pull_notify("luke", "bbbbbbbbbbb");
        for _ in 0..100 { pull_notify("luke", "bbbbbbbbbbb"); }
        assert!(t.elapsed() < Duration::from_millis(50), "slow hook delayed the caller by {:?}", t.elapsed());
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(CALLS.load(SeqCst), 1);
        assert_eq!(*LAST.lock().unwrap(), "luke/bbbbbbbbbbb");
                                                                                                        
        let tracked = Arc::new(AtomicUsize::new(0));
        let t2 = tracked.clone();
        let tr = throttled_notify(Arc::new(move |n| { t2.fetch_add(n, SeqCst); }), "u2".into(), "ccccccccccc".into(), Duration::from_millis(200));
        let before = CALLS.load(SeqCst);
        for _ in 0..30 { tr(1000); tokio::time::sleep(Duration::from_millis(20)).await; }                  
        tokio::time::sleep(Duration::from_millis(100)).await;
        let extra = CALLS.load(SeqCst) - before;
        assert_eq!(tracked.load(SeqCst), 30_000, "every chunk is still billed");
        assert_eq!(extra, 1, "global 1s per-(user,id) dedupe also bounds range-flow refreshes");
                                      
        let b2 = CALLS.load(SeqCst);
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(CALLS.load(SeqCst), b2);
    }
}

#[cfg(test)]
mod r13_tests {
    use super::*;

    fn local(u: &Url) -> bool { u.host_str() == Some("127.0.0.1") }
    fn pol() -> Policy { Policy { media_ok: local, thumb_ok: local, pin: false } }
    fn test_entry(url: Option<String>) -> Entry {
        Entry { url: std::sync::Mutex::new(url), mux: tokio::sync::OnceCell::new(), quality: String::new(), title: "T".into(), channel: "C".into(), channel_id: String::new(), duration: 0.0, hd: None, hd_vp9: None, hd_l: None, hd_lvp9: None, expires: std::time::Instant::now() + RESOLVE_TTL }
    }
    fn fake_ytdlp(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let d = std::env::temp_dir().join(format!("rj-r13-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let (script, count) = (d.join("yt.sh"), d.join("count"));
        let _ = std::fs::remove_file(&count);
        std::fs::write(&script, format!("#!/bin/sh\necho x >> \"{}\"\nexit 1\n", count.display())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        (script, count)
    }
    fn count_lines(p: &std::path::Path) -> usize { std::fs::read_to_string(p).map(|s| s.lines().count()).unwrap_or(0) }

                                                                                                  
                                                                      
    #[tokio::test]
    async fn gv_proxy_clamps_explicit_end_and_suffix_to_cap() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen2 = seen.clone();
        let app = axum::Router::new().route("/media", axum::routing::get(move |h: HeaderMap| {
            let seen = seen2.clone();
            async move {
                let total = 10000u64;
                let r = h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from);
                if let Some(r) = &r { seen.lock().unwrap().push(r.clone()); }
                let (a, b) = match r.as_deref().and_then(|r| r.strip_prefix("bytes=")).and_then(|r| r.split_once('-')).and_then(|(a, b)| a.parse::<u64>().ok().zip(b.parse::<u64>().ok())) {
                    Some((a, b)) if b >= a && b < total => (a, b),
                    _ => (0, total - 1),
                };
                Response::builder().status(206).header("content-type", "video/mp4").header("etag", "\"w1\"")
                    .header("content-range", format!("bytes {a}-{b}/{total}"))
                    .header("content-length", (b - a + 1).to_string())
                    .body(Body::from(vec![b'x'; (b - a + 1) as usize])).unwrap()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        for (range, want_cr) in [("bytes=100-9999", "bytes 100-611/10000"), ("bytes=-700", "bytes 9488-9999/10000")] {
            let r = gv_proxy(&client, &pol(), url.clone(), Some(range), None, None, 512, track.clone(), None, None).await;
            assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT, "{range}");
            assert_eq!(r.headers()[header::CONTENT_RANGE], want_cr, "{range}");
            assert_eq!(axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap().len(), 512, "{range}");
        }
        server.abort();
        assert_eq!(*seen.lock().unwrap(), vec!["bytes=100-611".to_string(), "bytes=9488-9999".to_string()]);
                                                                                                                                        
    }

                                                                                              
                                                                                             
                                                
    #[tokio::test]
    async fn gv_proxy_plain_get_walks_all_windows_to_the_true_total() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::<(String, Option<String>)>::new()));
        let seen2 = seen.clone();
        let app = axum::Router::new().route("/media", axum::routing::get(move |h: HeaderMap| {
            let seen = seen2.clone();
            async move {
                let total = 10000u64;
                let r = h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from);
                let ifr = h.get(header::IF_RANGE).and_then(|v| v.to_str().ok()).map(String::from);
                if let Some(r) = &r { seen.lock().unwrap().push((r.clone(), ifr.clone())); }
                let (a, b) = match r.as_deref().and_then(|r| r.strip_prefix("bytes=")).and_then(|r| r.split_once('-')).and_then(|(a, b)| a.parse::<u64>().ok().zip(b.parse::<u64>().ok())) {
                    Some((a, b)) if b >= a && b < total => (a, b),
                    _ => (0, total - 1),
                };
                Response::builder().status(206).header("content-type", "video/mp4")
                    .header("etag", "\"e1\"")
                    .header("content-range", format!("bytes {a}-{b}/{total}"))
                    .header("content-length", (b - a + 1).to_string())
                    .body(Body::from(vec![b'x'; (b - a + 1) as usize])).unwrap()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, None).await;
        assert_eq!(r.status(), StatusCode::OK, "the walk serves a 200, never an unsolicited 206");
        assert_eq!(r.headers()[header::CONTENT_LENGTH], "10000", "the 200 carries the TRUE total, not the window length");
        assert!(r.headers().get(header::CONTENT_RANGE).is_none(), "no content-range on a 200");
        assert_eq!(r.headers()["etag"], "\"e1\"", "etag carried so a later Ranged ask can bind with If-Range");
        assert_eq!(axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap().len(), 10000, "full body streamed via internal windows");
        server.abort();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 20, "10000 bytes at a 512 cap = 20 internal windows");
        assert_eq!(seen[0], ("bytes=0-511".to_string(), None));
        assert_eq!(seen[1], ("bytes=512-1023".to_string(), Some("\"e1\"".to_string())), "window 2+ carries If-Range identity");
        assert_eq!(seen[19], ("bytes=9728-9999".to_string(), Some("\"e1\"".to_string())));
    }

                                                                                           
                                               
    #[tokio::test]
    async fn if_range_ignored_when_client_sent_no_range() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::<(Option<String>, Option<String>)>::new()));
        let seen2 = seen.clone();
        let app = axum::Router::new().route("/media", axum::routing::get(move |h: HeaderMap| {
            let seen = seen2.clone();
            async move {
                let total = 600u64;
                let rng = h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from);
                let ir = h.get(header::IF_RANGE).and_then(|v| v.to_str().ok()).map(String::from);
                seen.lock().unwrap().push((rng.clone(), ir));
                let (a, b) = match rng.as_deref().and_then(|r| r.strip_prefix("bytes=")).and_then(|r| r.split_once('-')).and_then(|(a, b)| a.parse::<u64>().ok().zip(b.parse::<u64>().ok())) {
                    Some((a, b)) if b >= a && b < total => (a, b),
                    _ => (0, total - 1),
                };
                Response::builder().status(206).header("content-type", "video/mp4").header("etag", "\"w1\"")
                    .header("content-range", format!("bytes {a}-{b}/{total}"))
                    .header("content-length", (b - a + 1).to_string())
                    .body(Body::from(vec![b'x'; (b - a + 1) as usize])).unwrap()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let r = gv_proxy(&client, &pol(), url.clone(), None, Some("\"etag-x\""), None, 512, track.clone(), None, None).await;
        assert_eq!(r.status(), StatusCode::OK);
                                                                                             
                                                                                          
        assert_eq!(axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap().len(), 600);
        let r2 = gv_proxy(&client, &pol(), url, Some("bytes=0-100"), Some("\"etag-x\""), None, 512, track, None, None).await;
        assert_eq!(r2.status(), StatusCode::PARTIAL_CONTENT);
        server.abort();
        assert_eq!(*seen.lock().unwrap(), vec![
            (Some("bytes=0-511".to_string()), None),                                                                          
            (Some("bytes=512-599".to_string()), Some("\"w1\"".to_string())),                                                                         
            (Some("bytes=0-100".to_string()), Some("\"etag-x\"".to_string())),                                                
        ], "client if-range rides only with a client range; walk continuations carry the captured identity");
    }

                                                                                             
                                                                                   
                                                                                          
                                                                       
    #[tokio::test]
    async fn gv_proxy_plain_get_walk_aborts_on_identity_change() {
        let app = axum::Router::new().route("/media", axum::routing::get(|h: HeaderMap| async move {
            let total = 10000u64;
            if h.get(header::IF_RANGE).is_some() {
                return Response::builder().status(200).header("content-length", total.to_string()).body(Body::from(vec![b'y'; total as usize])).unwrap();
            }
            Response::builder().status(206).header("content-type", "video/mp4").header("etag", "\"e1\"")
                .header("content-range", format!("bytes 0-511/{total}")).header("content-length", "512")
                .body(Body::from(vec![b'x'; 512])).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, None).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert!(axum::body::to_bytes(r.into_body(), 1 << 20).await.is_err(), "identity change aborts the body");
        server.abort();
    }

                                                                                                 
    #[tokio::test]
    async fn gv_proxy_plain_get_walk_aborts_on_total_mismatch() {
        let app = axum::Router::new().route("/media", axum::routing::get(|h: HeaderMap| async move {
            let r = h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from).unwrap_or_default();
            let (a, b, t) = if r.starts_with("bytes=512-") { (512u64, 1023u64, 9999u64) } else { (0, 511, 10000) };
            Response::builder().status(206).header("content-type", "video/mp4").header("etag", "\"w1\"")
                .header("content-range", format!("bytes {a}-{b}/{t}")).header("content-length", (b - a + 1).to_string())
                .body(Body::from(vec![b'x'; (b - a + 1) as usize])).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, None).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert!(axum::body::to_bytes(r.into_body(), 1 << 20).await.is_err(), "total mismatch aborts the body");
        server.abort();
    }

                                                                                                
                                                                                      
    #[tokio::test]
    async fn gv_proxy_plain_get_without_a_validator_fails_closed() {
        let app = axum::Router::new().route("/media", axum::routing::get(|| async {
            Response::builder().status(206).header("content-type", "video/mp4")
                .header("content-range", "bytes 0-511/10000").header("content-length", "512")
                .body(Body::from(vec![b'x'; 512])).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, None).await;
        assert_eq!(r.status(), StatusCode::BAD_GATEWAY, "no validator: fail closed, never an unverifiable splice");
        server.abort();
    }

                                                                                     
    #[tokio::test]
    async fn gv_proxy_plain_get_with_unknown_total_fails_closed() {
        let app = axum::Router::new().route("/media", axum::routing::get(|| async {
            Response::builder().status(206).header("content-type", "video/mp4").header("etag", "\"w1\"")
                .header("content-range", "bytes 0-511/*").header("content-length", "512")
                .body(Body::from(vec![b'x'; 512])).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, None).await;
        assert_eq!(r.status(), StatusCode::BAD_GATEWAY, "unknown total fails closed");
        server.abort();
    }

                                                                                         
                                                                                            
                                                                                             
    #[test]
    fn chosen_validator_strong_weak_and_missing() {
        let good_lm = "Mon, 24 Jun 2024 02:22:13 GMT";
        let lm = || Some(good_lm.to_string());
        let lmv = || Some(Chosen::Lm(good_lm.to_string()));
                                                                                            
        assert_eq!(chosen_validator(Some("\"a\"".into()), lm()), Some(Chosen::Etag("\"a\"".into())));
        assert_eq!(chosen_validator(Some("\"\"".into()), lm()), Some(Chosen::Etag("\"\"".into())));
                                                                                           
        for bad in ["W/\"a\"", "", "   ", "abc123", "\"unterminated", "\"a\"b\"", "\"a b\""] {
            assert_eq!(chosen_validator(Some(bad.into()), lm()), lmv(), "{bad:?} is no strong etag");
            assert_eq!(chosen_validator(Some(bad.into()), None), None, "{bad:?} alone fails closed");
        }
                                                                                                
        assert_eq!(chosen_validator(None, lm()), lmv());
        assert_eq!(chosen_validator(None, Some("Sunday, 06-Nov-94 08:49:37 GMT".into())), Some(Chosen::Lm("Sunday, 06-Nov-94 08:49:37 GMT".into())), "RFC 850 accepted");
        assert_eq!(chosen_validator(None, Some("Sun Nov  6 08:49:37 1994".into())), Some(Chosen::Lm("Sun Nov  6 08:49:37 1994".into())), "asctime accepted");
        for bad in ["", "   ", "not a date", "24 Jun 2024", "Mon, 24 Jun 2024 02:22:13", "Mon, 24 Foo 2024 02:22:13 GMT"] {
            assert_eq!(chosen_validator(None, Some(bad.into())), None, "garbage lm {bad:?} fails closed");
        }
    }

                                                                                          
                                                     
    #[tokio::test]
    async fn gv_proxy_plain_get_walk_aborts_on_a_changed_etag() {
        let app = axum::Router::new().route("/media", axum::routing::get(|h: HeaderMap| async move {
            let total = 10000u64;
            let r = h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from).unwrap_or_default();
            let tag = if r.starts_with("bytes=512-") { "\"w2\"" } else { "\"w1\"" };
            let (a, b) = if r.starts_with("bytes=512-") { (512, 1023) } else { (0, 511) };
            Response::builder().status(206).header("content-type", "video/mp4").header("etag", tag)
                .header("content-range", format!("bytes {a}-{b}/{total}")).header("content-length", (b - a + 1).to_string())
                .body(Body::from(vec![b'x'; (b - a + 1) as usize])).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, None).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert!(axum::body::to_bytes(r.into_body(), 1 << 20).await.is_err(), "changed etag aborts the walk");
        server.abort();
    }

                                                                                          
                                                                                 
    #[tokio::test]
    async fn gv_proxy_plain_get_walk_aborts_on_a_weak_or_missing_etag() {
        for mode in ["weak", "missing"] {
            let app = axum::Router::new().route("/media", axum::routing::get(move |h: HeaderMap| async move {
                let total = 10000u64;
                let r = h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from).unwrap_or_default();
                let cont = r.starts_with("bytes=512-");
                let (a, b) = if cont { (512, 1023) } else { (0, 511) };
                let mut rb = Response::builder().status(206).header("content-type", "video/mp4")
                    .header("last-modified", "Mon, 24 Jun 2024 02:22:13 GMT")
                    .header("content-range", format!("bytes {a}-{b}/{total}")).header("content-length", (b - a + 1).to_string());
                rb = if cont && mode == "weak" { rb.header("etag", "W/\"w1\"") } else if !cont { rb.header("etag", "\"w1\"") } else { rb };
                rb.body(Body::from(vec![b'x'; (b - a + 1) as usize])).unwrap()
            }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/media", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let client = reqwest::Client::new();
            let track: Track = Arc::new(|_| {});
            let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, None).await;
            assert_eq!(r.status(), StatusCode::OK, "{mode}");
            assert!(axum::body::to_bytes(r.into_body(), 1 << 20).await.is_err(), "{mode} etag aborts - no downgrade to lm");
            server.abort();
        }
    }

                                                                                     
                                                                                   
                                                                    
    #[tokio::test]
    async fn gv_proxy_plain_get_walk_aborts_on_a_changed_last_modified() {
        let app = axum::Router::new().route("/media", axum::routing::get(|h: HeaderMap| async move {
            let total = 10000u64;
            let r = h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from).unwrap_or_default();
            let cont = r.starts_with("bytes=512-");
            let (a, b) = if cont { (512, 1023) } else { (0, 511) };
            let lm = if cont { "Tue, 25 Jun 2024 02:22:13 GMT" } else { "Mon, 24 Jun 2024 02:22:13 GMT" };
            Response::builder().status(206).header("content-type", "video/mp4")
                .header("last-modified", lm)
                .header("content-range", format!("bytes {a}-{b}/{total}")).header("content-length", (b - a + 1).to_string())
                .body(Body::from(vec![b'x'; (b - a + 1) as usize])).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, None).await;
        assert_eq!(r.status(), StatusCode::OK, "window-1 LM is valid, so the walk is built");
        assert!(axum::body::to_bytes(r.into_body(), 1 << 20).await.is_err(), "changed LM aborts the walk");
        server.abort();
    }

                                                                                      
                                                                                       
    #[tokio::test]
    async fn gv_proxy_plain_get_walk_creation_rejects_weak_or_garbage_validators() {
        for mode in ["weak-etag-only", "garbage-lm-only"] {
            let app = axum::Router::new().route("/media", axum::routing::get(move |h: HeaderMap| async move {
                let total = 10000u64;
                let r = h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from).unwrap_or_default();
                let (a, b) = if r.starts_with("bytes=512-") { (512, 1023) } else { (0, 511) };
                let mut rb = Response::builder().status(206).header("content-type", "video/mp4")
                    .header("content-range", format!("bytes {a}-{b}/{total}")).header("content-length", (b - a + 1).to_string());
                rb = if mode == "weak-etag-only" { rb.header("etag", "W/\"w1\"") } else { rb.header("last-modified", "not a date") };
                rb.body(Body::from(vec![b'x'; (b - a + 1) as usize])).unwrap()
            }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/media", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let client = reqwest::Client::new();
            let track: Track = Arc::new(|_| {});
            let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, None).await;
            assert_eq!(r.status(), StatusCode::BAD_GATEWAY, "{mode}: no usable validator fails closed at creation");
            server.abort();
        }
    }

                                                                                       
    #[test]
    fn full_deadline_floor_scale_and_hard_max() {
        assert_eq!(full_deadline(10000), BODY_TOTAL);                                               
        assert_eq!(full_deadline(48 << 20), Duration::from_secs(1538));                                                           
        assert_eq!(full_deadline(64 << 20), WALK_DEADLINE_MAX);                                                                  
        assert_eq!(full_deadline(1 << 40), WALK_DEADLINE_MAX);                                                 
        assert_eq!(full_deadline(u64::MAX), WALK_DEADLINE_MAX);
    }

                                                                                               
                                                                                   
    #[tokio::test]
    async fn gv_proxy_plain_get_walk_aborts_on_a_short_window_body() {
        let app = axum::Router::new().route("/media", axum::routing::get(|h: HeaderMap| async move {
            let total = 10000u64;
            let r = h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from).unwrap_or_default();
            if r.starts_with("bytes=512-") {
                return Response::builder().status(206).header("content-type", "video/mp4").header("etag", "\"w1\"")
                    .header("content-range", format!("bytes 512-1023/{total}")).header("content-length", "400")
                    .body(Body::from(vec![b'x'; 400])).unwrap();                                                       
            }
            Response::builder().status(206).header("content-type", "video/mp4").header("etag", "\"w1\"")
                .header("content-range", format!("bytes 0-511/{total}")).header("content-length", "512")
                .body(Body::from(vec![b'x'; 512])).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, None).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert!(axum::body::to_bytes(r.into_body(), 1 << 20).await.is_err(), "short window aborts - no hole spliced");
        server.abort();
    }

                                                                             
    #[tokio::test]
    async fn gv_proxy_plain_get_walk_aborts_on_start_mismatch() {
        let app = axum::Router::new().route("/media", axum::routing::get(|h: HeaderMap| async move {
            let total = 10000u64;
            let r = h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from).unwrap_or_default();
            if r.starts_with("bytes=512-") {
                return Response::builder().status(206).header("content-type", "video/mp4").header("etag", "\"w1\"")
                    .header("content-range", format!("bytes 0-511/{total}")).header("content-length", "512")
                    .body(Body::from(vec![b'x'; 512])).unwrap();                      
            }
            Response::builder().status(206).header("content-type", "video/mp4").header("etag", "\"w1\"")
                .header("content-range", format!("bytes 0-511/{total}")).header("content-length", "512")
                .body(Body::from(vec![b'x'; 512])).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, None).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert!(axum::body::to_bytes(r.into_body(), 1 << 20).await.is_err(), "start mismatch aborts");
        server.abort();
    }

                                                                                             
    #[tokio::test]
    async fn gv_proxy_plain_get_walk_falls_back_to_last_modified_for_if_range() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::<Option<String>>::new()));
        let seen2 = seen.clone();
        let app = axum::Router::new().route("/media", axum::routing::get(move |h: HeaderMap| {
            let seen = seen2.clone();
            async move {
                let total = 10000u64;
                let ifr = h.get(header::IF_RANGE).and_then(|v| v.to_str().ok()).map(String::from);
                seen.lock().unwrap().push(ifr);
                let r = h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from).unwrap_or_default();
                let (a, b) = match r.strip_prefix("bytes=").and_then(|r| r.split_once('-')).and_then(|(a, b)| a.parse::<u64>().ok().zip(b.parse::<u64>().ok())) {
                    Some((a, b)) if b >= a && b < total => (a, b),
                    _ => (0, total - 1),
                };
                Response::builder().status(206).header("content-type", "video/mp4")
                    .header("last-modified", "Wed, 21 Oct 2015 07:28:00 GMT")
                    .header("content-range", format!("bytes {a}-{b}/{total}")).header("content-length", (b - a + 1).to_string())
                    .body(Body::from(vec![b'x'; (b - a + 1) as usize])).unwrap()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, None).await;
        assert_eq!(axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap().len(), 10000);
        server.abort();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 20, "20 exact-extent windows");
        assert_eq!(seen[1], Some("Wed, 21 Oct 2015 07:28:00 GMT".to_string()), "If-Range fell back to last-modified");
    }

                                                                                           
    #[tokio::test]
    async fn gv_proxy_plain_get_disconnect_stops_the_walk() {
        let seen = Arc::new(std::sync::Mutex::new(0usize));
        let seen2 = seen.clone();
        let app = axum::Router::new().route("/media", axum::routing::get(move |h: HeaderMap| {
            let seen = seen2.clone();
            async move {
                let total = 10000u64;
                *seen.lock().unwrap() += 1;
                let r = h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from).unwrap_or_default();
                let (a, b) = match r.strip_prefix("bytes=").and_then(|r| r.split_once('-')).and_then(|(a, b)| a.parse::<u64>().ok().zip(b.parse::<u64>().ok())) {
                    Some((a, b)) if b >= a && b < total => (a, b),
                    _ => (0, total - 1),
                };
                Response::builder().status(206).header("content-type", "video/mp4").header("etag", "\"w1\"")
                    .header("content-range", format!("bytes {a}-{b}/{total}")).header("content-length", (b - a + 1).to_string())
                    .body(Body::from(vec![b'x'; (b - a + 1) as usize])).unwrap()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, None).await;
        drop(r);                                                     
        tokio::time::sleep(Duration::from_millis(100)).await;
        server.abort();
        assert_eq!(*seen.lock().unwrap(), 1, "no further upstream windows after the reader went away");
    }

                                                                                                
                                                                            
    #[tokio::test]
    async fn gv_proxy_plain_get_passes_a_bodiless_length_upstream_through_chunked() {
        let app = axum::Router::new().route("/full", axum::routing::get(|| async {
                                                                                         
            let st = futures::stream::iter(vec![Ok::<_, std::io::Error>(vec![b'x'; 10000])]);
            Response::builder().status(200).header("content-type", "video/mp4").body(Body::from_stream(st)).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/full", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, None).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert!(r.headers().get(header::CONTENT_LENGTH).is_none(), "no guessed length");
        assert_eq!(axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap().len(), 10000);
        server.abort();
    }

                                                                                               
                                                                                               
                                                                                     
    #[tokio::test]
    async fn gv_proxy_parked_body_releases_its_permit_at_the_deadline() {
        let app = axum::Router::new().route("/media", axum::routing::get(|h: HeaderMap| async move {
            let total = 10000u64;
            let r = h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from).unwrap_or_default();
            let (a, b) = match r.strip_prefix("bytes=").and_then(|r| r.split_once('-')).and_then(|(a, b)| a.parse::<u64>().ok().zip(b.parse::<u64>().ok())) {
                Some((a, b)) if b >= a && b < total => (a, b),
                _ => (0, total - 1),
            };
            Response::builder().status(206).header("content-type", "video/mp4").header("etag", "\"w1\"")
                .header("content-range", format!("bytes {a}-{b}/{total}")).header("content-length", (b - a + 1).to_string())
                .body(Body::from(vec![b'x'; (b - a + 1) as usize])).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let sem = Arc::new(tokio::sync::Semaphore::new(1));
        let hold = Some(sem.clone().acquire_owned().await.unwrap());
        DEADLINE_OVERRIDE.with(|o| o.set(Some(Duration::from_millis(150))));
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, hold).await;
        DEADLINE_OVERRIDE.with(|o| o.set(None));
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(sem.available_permits(), 0, "the permit is held while the body is parked");
        tokio::time::sleep(Duration::from_millis(600)).await;                              
        assert_eq!(sem.available_permits(), 1, "the timer released the permit with the body entirely unpolled");
                                                                                          
        assert!(axum::body::to_bytes(r.into_body(), 1 << 20).await.is_err(), "producer failure surfaces as a body error");
        server.abort();
    }

                                                                                                
                                                                                   
    #[tokio::test]
    async fn gv_proxy_disconnect_during_upstream_wait_releases() {
        let seen = Arc::new(std::sync::Mutex::new(0usize));
        let seen2 = seen.clone();
        let app = axum::Router::new().route("/media", axum::routing::get(move |h: HeaderMap| {
            let seen = seen2.clone();
            async move {
                let total = 10000u64;
                *seen.lock().unwrap() += 1;
                let r = h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from).unwrap_or_default();
                if r.starts_with("bytes=512-") {
                    tokio::time::sleep(Duration::from_millis(300)).await;                        
                    return Response::builder().status(206).header("content-type", "video/mp4").header("etag", "\"w1\"")
                        .header("content-range", format!("bytes 512-1023/{total}")).header("content-length", "512")
                        .body(Body::from(vec![b'x'; 512])).unwrap();
                }
                Response::builder().status(206).header("content-type", "video/mp4").header("etag", "\"w1\"")
                    .header("content-range", format!("bytes 0-511/{total}")).header("content-length", "512")
                    .body(Body::from(vec![b'x'; 512])).unwrap()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let sem = Arc::new(tokio::sync::Semaphore::new(1));
        let hold = Some(sem.clone().acquire_owned().await.unwrap());
        DEADLINE_OVERRIDE.with(|o| o.set(Some(Duration::from_secs(10))));                                     
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, hold).await;
        DEADLINE_OVERRIDE.with(|o| o.set(None));
        assert_eq!(r.status(), StatusCode::OK);
                                                                                           
                                                                                   
        let mut s = r.into_body().into_data_stream();
        let mut got = 0usize;
        while got < 512 {
            let c = futures::StreamExt::next(&mut s).await.expect("window 1 chunk").expect("window 1 ok");
            got += c.len();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;                                
        assert_eq!(*seen.lock().unwrap(), 2, "window 2 request observed at the upstream");
        drop(s);                                                                          
        tokio::time::sleep(Duration::from_millis(900)).await;
        assert_eq!(sem.available_permits(), 1, "disconnect mid-fetch released the permit once the fetch returned");
        assert_eq!(*seen.lock().unwrap(), 2, "no window 3 after the disconnect");
        server.abort();
    }

                                                                                        
    #[tokio::test]
    async fn gv_proxy_plain_get_walk_aborts_when_the_budget_is_out() {
        let app = axum::Router::new().route("/media", axum::routing::get(|h: HeaderMap| async move {
            let total = 10000u64;
            let r = h.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from).unwrap_or_default();
            let (a, b) = match r.strip_prefix("bytes=").and_then(|r| r.split_once('-')).and_then(|(a, b)| a.parse::<u64>().ok().zip(b.parse::<u64>().ok())) {
                Some((a, b)) if b >= a && b < total => (a, b),
                _ => (0, total - 1),
            };
            Response::builder().status(206).header("content-type", "video/mp4").header("etag", "\"w1\"")
                .header("content-range", format!("bytes {a}-{b}/{total}")).header("content-length", (b - a + 1).to_string())
                .body(Body::from(vec![b'x'; (b - a + 1) as usize])).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/media", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let budget: Option<Budget> = Some(Arc::new(|| 0));
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, budget, None).await;
        assert_eq!(r.status(), StatusCode::OK, "headers commit before the body is pulled");
        assert!(axum::body::to_bytes(r.into_body(), 1 << 20).await.is_err(), "out of bandwidth aborts the body");
        server.abort();
    }

    #[tokio::test]
    async fn gv_proxy_plain_get_against_range_ignoring_upstream_streams_the_full_body() {
        let app = axum::Router::new().route("/full", axum::routing::get(|| async {
            Response::builder().status(200).header("content-type", "video/mp4").header("content-length", "10000").body(Body::from(vec![b'x'; 10000])).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/full", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let r = gv_proxy(&client, &pol(), url, None, None, None, 512, track, None, None).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()[header::CONTENT_LENGTH], "10000", "upstream's truthful length passes through");
        assert_eq!(axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap().len(), 10000, "a range-ignoring upstream's full body IS the contract now");
        server.abort();
    }

                                                                                                  
                                                                       
    #[tokio::test]
    async fn gv_proxy_caps_upstream_200_that_ignored_range() {
        let app = axum::Router::new().route("/full", axum::routing::get(|| async {
            Response::builder().status(200).header("content-type", "video/mp4").header("content-length", "10000").body(Body::from(vec![b'x'; 10000])).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/full", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let r = gv_proxy(&client, &pol(), url, Some("bytes=0-511"), None, None, 512, track, None, None).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()[header::CONTENT_LENGTH], "512");
        assert_eq!(axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap().len(), 512);
        server.abort();
    }

                                                                                               
                                                                                          
    #[tokio::test]
    async fn gv_proxy_budget_zero_aborts_stream() {
        let app = axum::Router::new().route("/full", axum::routing::get(|| async {
            Response::builder().status(200).header("content-type", "video/mp4").header("content-length", "10000").body(Body::from(vec![b'x'; 10000])).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/full", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let track: Track = Arc::new(|_| {});
        let budget: Budget = Arc::new(|| 0i64);
        let r = gv_proxy(&client, &pol(), url, None, None, None, 4 << 20, track, Some(budget), None).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert!(axum::body::to_bytes(r.into_body(), 1 << 20).await.is_err(), "budget zero must error the body");
        server.abort();
    }

                                                                                                
                                    
    #[test]
    fn user_permit_caps_at_three_per_user() {
        let u = format!("r13up{}", std::process::id());
        let (p1, p2, p3) = (user_permit(&u), user_permit(&u), user_permit(&u));
        assert!(p1.is_some() && p2.is_some() && p3.is_some());
        assert!(user_permit(&u).is_none(), "4th concurrent stream for one user is refused");
        assert!(user_permit(&format!("{u}-other")).is_some(), "other users are unaffected");
        drop(p1);
        assert!(user_permit(&u).is_some(), "a finished stream frees the slot");
    }

                                                                                                     
    #[test]
    fn mark_dead_corrupt_store_is_false_and_untouched() {
        let d = std::env::temp_dir().join(format!("rj-dead-corrupt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("jetstream-dead.json"), b"this is not json").unwrap();
        assert!(!mark_dead(&d, "aaaaaaaaaaa"), "corrupt store: mark_dead reports failure");
        assert_eq!(std::fs::read(d.join("jetstream-dead.json")).unwrap(), b"this is not json", "corrupt store is never overwritten");
        let _ = std::fs::remove_file(d.join("jetstream-dead.json"));
        assert!(mark_dead(&d, "aaaaaaaaaaa"), "missing store starts fresh");
    }

                                                                                                   
                                                                 
    #[tokio::test]
    async fn failed_resolve_negative_caches_even_for_force() {
        let (script, count) = fake_ytdlp("neg");
        let cfg = ResolveCfg { ytdlp: script, proxy: String::new() };
        let id = format!("NEG{:08}", std::process::id() % 100000000);
        assert!(resolve_stream(&cfg, &id, false).await.is_err());
        assert_eq!(count_lines(&count), 1, "first resolve ran yt-dlp once");
        assert!(resolve_stream(&cfg, &id, false).await.is_err());
        assert!(resolve_stream(&cfg, &id, true).await.is_err());
        assert_eq!(count_lines(&count), 1, "retry and forced retry are served by the negative cache");
    }

                                                                                                 
                                                                       
    #[tokio::test]
    async fn mux_url_failed_android_run_is_not_cached() {
        let (script, count) = fake_ytdlp("mux");
        let cfg = ResolveCfg { ytdlp: script, proxy: String::new() };
        let e = test_entry(None);
        assert!(mux_url(&cfg, "MUXTEST0001", &e).await.is_none());
        let first = count_lines(&count);
        assert!(first >= 1, "android run happened");
        assert!(mux_url(&cfg, "MUXTEST0001", &e).await.is_none());
        assert!(count_lines(&count) > first, "failure was not cached: the second call ran yt-dlp again");
    }

                                                                                                  
    #[tokio::test]
    async fn resolve_budgeted_cache_hit_is_free_and_over_budget_refused() {
        let st = Arc::new(crate::auth_api::devices::tests::fixture("r13-budget-user"));
        let cfg = ResolveCfg { ytdlp: "/bin/false".into(), proxy: String::new() };
        let (user, miss, hit) = ("r13-budget-user", format!("MISS{:07}", std::process::id() % 10000000), format!("HIT{:08}", std::process::id() % 100000000));
        for _ in 0..60 { st.rates.window(format!("resolve:{user}"), 60, 3600000); }
        assert!(matches!(resolve_budgeted(&st, &cfg, user, &miss, false).await, Err(m) if m == HUMAN), "61st distinct resolve in an hour is refused");
        let store = RESOLVED.get_or_init(|| std::sync::Mutex::new(ResolveStore { map: HashMap::new(), order: Default::default(), inflight: HashMap::new(), neg: HashMap::new() }));
        store.lock().unwrap().map.insert(hit.clone(), Arc::new(test_entry(Some("http://127.0.0.1/unused".into()))));
        assert!(resolve_budgeted(&st, &cfg, user, &hit, false).await.is_ok(), "cache hits are free even over budget");
    }

                                                                                           
                                                                                                        
    #[tokio::test]
    async fn resolve_budgeted_neg_hit_does_not_consume_budget() {
        let st = Arc::new(crate::auth_api::devices::tests::fixture("r13-negbudget-user"));
        let (script, count) = fake_ytdlp("negb");
        let cfg = ResolveCfg { ytdlp: script, proxy: String::new() };
        let (neg_id, fresh_id) = (format!("NEGB{:07}", std::process::id() % 10000000), format!("FRESH{:06}", std::process::id() % 1000000));
        assert!(resolve_stream(&cfg, &neg_id, false).await.is_err(), "failing resolve plants the neg entry");
        assert_eq!(count_lines(&count), 1);
        for _ in 0..59 { st.rates.window(format!("resolve:r13-negbudget-user"), 60, 3600000); }
        assert!(resolve_budgeted(&st, &cfg, "r13-negbudget-user", &neg_id, false).await.is_err(), "neg hit answers with the cached failure");
        assert!(resolve_budgeted(&st, &cfg, "r13-negbudget-user", &fresh_id, false).await.is_err(), "fresh resolve spawns and fails");
        assert_eq!(count_lines(&count), 2, "fresh resolve was not budget-refused - the neg hit did not consume charge #60");
    }

                                                                                         
    #[tokio::test]
    async fn thumb_id_rejects_non_image_content_type() {
        let app = axum::Router::new()
            .route("/html/vi/{id}/{name}", axum::routing::get(|| async { Response::builder().header("content-type", "text/html").body(Body::from(vec![b'x'; 7000])).unwrap() }))
            .route("/img/vi/{id}/{name}", axum::routing::get(|| async { Response::builder().header("content-type", "image/jpeg").body(Body::from(vec![0xFFu8; 7000])).unwrap() }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        assert!(thumb_id_with(&client, &pol(), &format!("{base}/html"), "TID11111111", false).await.is_none(), "text/html is not a thumbnail");
        assert_eq!(thumb_id_with(&client, &pol(), &format!("{base}/img"), "TID11111111", false).await.map(|b| b.len()), Some(7000), "image/jpeg serves");
        server.abort();
    }

                                                                                              
                                                                        
    #[tokio::test]
    async fn record_play_once_dedupes_within_window() {
        let st = Arc::new(crate::auth_api::devices::tests::fixture("r13-rec-user"));
        let id = format!("REC{:08}", std::process::id() % 100000000);
        let e = test_entry(None);
        record_play_once(&st, "r13-rec-user", &id, &e);
        let f = st.data_dir.join("jetstream-playback.json");
        let mut b1 = None;
        for _ in 0..20 { if let Ok(b) = std::fs::read(&f) { b1 = Some(b); break; } tokio::time::sleep(Duration::from_millis(100)).await; }
        let b1 = b1.expect("record_play wrote the playback store within 2s");
        assert_eq!(String::from_utf8_lossy(&b1).matches(id.as_str()).count(), 1);
        tokio::time::sleep(Duration::from_millis(50)).await;
        record_play_once(&st, "r13-rec-user", &id, &e);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(std::fs::read(&f).unwrap(), b1, "second call inside the window is a no-op");
    }

                                                                        
    #[test]
    fn head_meta_open_ended_follows_the_chosen_validator_like_the_get() {
                                                                                                
                                                                                                                  
        let lm = "Mon, 24 Jun 2024 02:22:13 GMT";
        for (etag, lmv, want_cr, want_cl) in [
            ("\"e1\"", "", "bytes 100-9999/10000", "9900"),
            ("", lm, "bytes 100-9999/10000", "9900"),
            ("\"e1\"", lm, "bytes 100-9999/10000", "9900"),
            ("W/\"w1\"", "", "bytes 100-611/10000", "512"),
            ("", "not a date", "bytes 100-611/10000", "512"),
            ("W/\"w1\"", "not a date", "bytes 100-611/10000", "512"),
            ("", "", "bytes 100-611/10000", "512"),
        ] {
            let m = Meta { size: 10000, ct: "video/mp4".into(), etag: etag.into(), lm: lmv.into(), ranged: true };
            let r = head_meta(m, Some("bytes=100-"), 512);
            assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT, "{etag:?}/{lmv:?}");
            assert_eq!((r.headers()[header::CONTENT_RANGE].to_str().unwrap(), r.headers()[header::CONTENT_LENGTH].to_str().unwrap()), (want_cr, want_cl), "{etag:?}/{lmv:?}");
        }
                                                                                                                
        let m = Meta { size: 10000, ct: "video/mp4".into(), etag: "\"e1\"".into(), ranged: true, ..Default::default() };
        assert_eq!(head_meta(m, Some("bytes=100-9999"), 512).headers()[header::CONTENT_RANGE], "bytes 100-611/10000");
        let m = Meta { size: 10000, ct: "video/mp4".into(), etag: "\"e1\"".into(), ranged: false, ..Default::default() };
        assert_eq!(head_meta(m, Some("bytes=100-"), 512).status(), StatusCode::OK);
    }

    #[test]
    fn head_meta_clamps_explicit_end_and_suffix_to_cap() {
        let m = Meta { size: 10000, ct: "video/mp4".into(), ranged: true, ..Default::default() };
        let r = head_meta(m.clone(), Some("bytes=100-9999"), 512);
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 100-611/10000");
        assert_eq!(r.headers()[header::CONTENT_LENGTH], "512");
        let r = head_meta(m, Some("bytes=-700"), 512);
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 9488-9999/10000");
        assert_eq!(r.headers()[header::CONTENT_LENGTH], "512");
    }

                                                                                               
                                                                                            
                                                    
    #[test]
    fn caption_tracks_extracts_manual_then_auto_vtt_only() {
        let d = serde_json::json!({
            "subtitles": { "en": [ {"ext":"srv3","url":"https://x/en.srv3"}, {"ext":"vtt","url":"https://x/en.vtt","name":"English"} ],
                           "fr": [ {"ext":"vtt","url":"https://x/fr.vtt","name":""} ] },
            "automatic_captions": { "en": [ {"ext":"vtt","url":"https://x/en-auto.vtt","name":"English"} ],
                                    "zz": [ {"ext":"json3","url":"https://x/zz.json3"} ] }
        });
        let t = caption_tracks(&d);
        assert_eq!(t.len(), 3, "manual en+fr, auto en; srv3/json3 skipped");
        assert_eq!((t[0].lang.as_str(), t[0].kind, t[0].name.as_str(), t[0].url.as_str()), ("en", "manual", "English", "https://x/en.vtt"));
        assert_eq!((t[1].lang.as_str(), t[1].kind, t[1].name.as_str()), ("fr", "manual", "fr"), "empty name falls back to the lang code");
        assert_eq!((t[2].lang.as_str(), t[2].kind), ("en", "auto"), "manual kinds all list before auto");
    }

    #[test]
    fn caption_tracks_absent_or_junk_is_empty_not_error() {
        assert!(caption_tracks(&serde_json::json!({})).is_empty(), "the common case: no keys, no tracks");
        assert!(caption_tracks(&serde_json::json!({"subtitles": null, "automatic_captions": []})).is_empty());
        assert!(caption_tracks(&serde_json::json!({"subtitles": {"en": "junk"}})).is_empty());
        assert!(caption_tracks(&serde_json::json!({"subtitles": {"en": [{"ext":"vtt","url":"http://insecure/x.vtt"}]}})).is_empty(), "https only");
        assert!(caption_tracks(&serde_json::json!({"subtitles": {"": [{"ext":"vtt","url":"https://x/a.vtt"}]}})).is_empty(), "empty lang skipped");
        assert!(caption_tracks(&serde_json::json!({"automatic_captions": {"en": []}})).is_empty(), "no vtt entry, no track");
    }

    #[test]
    fn caption_tracks_caps_language_count() {
        let mut m = serde_json::Map::new();
        for i in 0..80 { m.insert(format!("l{i:02}"), serde_json::json!([{"ext":"vtt","url":"https://x/a.vtt"}])); }
        let d = serde_json::json!({ "automatic_captions": m });
        assert_eq!(caption_tracks(&d).len(), CAP_LANGS_MAX);
    }

    #[test]
    fn pick_transcript_track_prefers_manual_then_language() {
        let t = caption_tracks(&serde_json::json!({
            "subtitles": { "en": [{"ext":"vtt","url":"https://x/en.vtt"}] },
            "automatic_captions": { "fr": [{"ext":"vtt","url":"https://x/fr-auto.vtt"}], "en": [{"ext":"vtt","url":"https://x/en-auto.vtt"}] }
        }));
        assert_eq!(pick_transcript_track(&t, Some("fr")).map(|x| (x.lang.as_str(), x.kind)), Some(("en", "manual")), "house choice: accurate English manual beats a preferred-language auto");
        assert_eq!(pick_transcript_track(&t, Some("en")).map(|x| (x.lang.as_str(), x.kind)), Some(("en", "manual")));
        assert_eq!(pick_transcript_track(&t, None).map(|x| (x.lang.as_str(), x.kind)), Some(("en", "manual")));
        let auto_only = caption_tracks(&serde_json::json!({ "automatic_captions": { "fr": [{"ext":"vtt","url":"https://x/f.vtt"}] } }));
        assert_eq!(pick_transcript_track(&auto_only, Some("en")).map(|x| (x.lang.as_str(), x.kind)), Some(("fr", "auto")), "any auto beats nothing");
        assert!(pick_transcript_track(&[], None).is_none(), "no tracks, no transcript - honest empty");
    }

    #[test]
    fn vtt_to_text_strips_structure_and_rolling_duplicates() {
        let vtt = "WEBVTT\nKind: captions\nLanguage: en\n\nNOTE this is a note\nspanning lines\n\n1\n00:00:00.000 --> 00:00:02.000\nhello <c>world</c> &amp; friends\n\n2\n00:00:02.000 --> 00:00:04.000\nhello <c>world</c> &amp; friends\na second line\n\n00:00:04.000 --> 00:00:06.000 position:0%\na second line\nthird &quot;quoted&#39;\n";
        assert_eq!(vtt_to_text(vtt, 4096), "hello world & friends a second line third \"quoted'");
        assert_eq!(vtt_to_text("", 100), "");
        assert_eq!(vtt_to_text("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nabcdef\n", 3), "abc", "char cap honored");
    }
                                                                                          
                                                                                            
    static CAPS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn cap_host_ok_exact_host_plain_https_only() {
        for u in ["https://www.youtube.com/api/timedtext?v=x", "https://WWW.YOUTUBE.COM/api/timedtext"] {
            assert!(cap_host_ok(&Url::parse(u).unwrap()), "{u}");
        }
        for u in ["http://www.youtube.com/api/timedtext", "https://m.youtube.com/api/timedtext",
                  "https://youtube.com/api/timedtext", "https://www.youtube.com.evil.test/x",
                  "https://www.youtube.com:8443/x", "https://user@www.youtube.com/x"] {
            assert!(!cap_host_ok(&Url::parse(u).unwrap()), "{u}");
        }
    }

    #[test]
    fn cap_lang_ok_gate() {
        assert!(cap_lang_ok("en") && cap_lang_ok("en-US") && cap_lang_ok("zh_Hans") && cap_lang_ok("a.1") && cap_lang_ok(&"a".repeat(32)));
        for l in ["", "en US", "en/x", "en?x", "e\u{00e9}", "en%20US"] { assert!(!cap_lang_ok(l), "{l:?}"); }
        assert!(!cap_lang_ok(&"a".repeat(33)));
    }

    #[test]
    fn captions_json_fixed_shape_ready_srcs() {
        let tracks = vec![
            CapTrack { lang: "en".into(), name: "English".into(), kind: "manual", url: "https://up/en.vtt".into() },
            CapTrack { lang: "en".into(), name: "English (auto)".into(), kind: "auto", url: "https://up/en-a.vtt".into() },
            CapTrack { lang: "fr".into(), name: "fran\u{00e7}ais".into(), kind: "manual", url: "https://up/fr.vtt".into() },
            CapTrack { lang: "en US".into(), name: "unfetchable".into(), kind: "manual", url: "https://up/bad.vtt".into() },
        ];
        let got = captions_json("abcDEF12345", &tracks);
        let want = "{\"ok\":true,\"tracks\":[\
{\"lang\":\"en\",\"label\":\"English\",\"auto\":false,\"src\":\"/api/apps/jetstream/captions?id=abcDEF12345&lang=en\"},\
{\"lang\":\"en\",\"label\":\"English (auto)\",\"auto\":true,\"src\":\"/api/apps/jetstream/captions?id=abcDEF12345&lang=en&auto=1\"},\
{\"lang\":\"fr\",\"label\":\"fran\u{00e7}ais\",\"auto\":false,\"src\":\"/api/apps/jetstream/captions?id=abcDEF12345&lang=fr\"}]}";
        assert_eq!(got, want, "fixed key order; upstream URLs never surface; unfetchable lang dropped");
    }

    #[test]
    fn caps_cache_lives_and_dies_with_entry_expiry() {
        let _g = CAPS_LOCK.lock().unwrap();
        let v = vec![CapTrack { lang: "en".into(), name: "English".into(), kind: "manual", url: "https://up/x.vtt".into() }];
        caps_put("CAPSCACHE01", v.clone(), std::time::Instant::now() + Duration::from_secs(60));
        assert_eq!(caps_get("CAPSCACHE01"), Some(v));
        caps_put("CAPSCACHE02", vec![], std::time::Instant::now() - Duration::from_secs(1));
        assert_eq!(caps_get("CAPSCACHE02"), None, "expires WITH the resolve entry: never served stale");
        assert_eq!(caps_get("CAPSCACHE99"), None);
    }

    #[test]
    fn caps_cache_lru_bounded() {
        let _g = CAPS_LOCK.lock().unwrap();
        for i in 0..CAP_CACHE_MAX { caps_put(&format!("LRU{i:08}"), vec![], std::time::Instant::now() + Duration::from_secs(60)); }
        caps_put("LRUZNEW000", vec![], std::time::Instant::now() + Duration::from_secs(60));
        assert!(caps_get("LRUZNEW000").is_some());
        assert!(RESOLVE_CAPS.get().unwrap().lock().unwrap().0.len() <= CAP_CACHE_MAX, "bounded like GV_SIZE");
    }

    #[tokio::test]
    async fn cap_fetch_vtt_ok_billed_and_magic_enforced() {
        let app = axum::Router::new()
            .route("/good", axum::routing::get(|| async { "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n" }))
            .route("/html", axum::routing::get(|| async { "<html>not vtt</html>" }))
            .route("/dead", axum::routing::get(|| async { StatusCode::FORBIDDEN }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        let client = reqwest::Client::new();
        let billed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let b2 = billed.clone();
        let track: Track = Arc::new(move |n: usize| { b2.fetch_add(n, std::sync::atomic::Ordering::Relaxed); });
        let body = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n";
        let got = cap_fetch(&client, &pol(), local, &format!("{base}/good"), &track).await.unwrap();
        assert_eq!(got, body.as_bytes());
        assert_eq!(billed.load(std::sync::atomic::Ordering::Relaxed), body.len(), "billed once, exact bytes, on success only");
        assert!(matches!(cap_fetch(&client, &pol(), local, &format!("{base}/html"), &track).await, Err(LegErr::Upstream)), "200 without the WEBVTT magic is not a caption file");
        let before = billed.load(std::sync::atomic::Ordering::Relaxed);
        assert!(matches!(cap_fetch(&client, &pol(), local, &format!("{base}/dead"), &track).await, Err(LegErr::Expired)), "403/410 -> Expired for the one bounded refresh");
        assert_eq!(billed.load(std::sync::atomic::Ordering::Relaxed), before, "failures are not billed");
        server.abort();
    }

    #[tokio::test]
    async fn cap_fetch_over_cap_is_toobig() {
        let big = format!("WEBVTT\n\n{}", "x".repeat(CAP_VTT_MAX + 1024));
        let app = axum::Router::new().route("/big", axum::routing::get(move || { let big = big.clone(); async move { big } }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/big", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        let client = reqwest::Client::new();
        let noop: Track = Arc::new(|_| {});
        assert!(matches!(cap_fetch(&client, &pol(), local, &url, &noop).await, Err(LegErr::TooBig)), "2 MiB read cap enforced");
        server.abort();
    }

    #[tokio::test]
    async fn captions_handler_auth_id_lang_gates_and_metadata_body() {
        let _cg = CAPS_LOCK.lock().unwrap();
        let st = Arc::new(crate::auth_api::devices::tests::fixture("captions-fixture"));
        let token = "c".repeat(48);
        st.auth_db.device_insert("captions-fixture-device", "captions-fixture", "tv", "roku", &token).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        let vid = "CAPSFIX0001";
        let store = RESOLVED.get_or_init(|| std::sync::Mutex::new(ResolveStore { map: HashMap::new(), order: Default::default(), inflight: HashMap::new(), neg: HashMap::new() }));
        store.lock().unwrap().map.insert(vid.into(), Arc::new(test_entry(None)));
        let tracks = vec![CapTrack { lang: "en".into(), name: "English".into(), kind: "manual", url: "https://up/en.vtt".into() }];
        caps_put(vid, tracks.clone(), std::time::Instant::now() + RESOLVE_TTL);

        let mut q = HashMap::new(); q.insert("id".into(), vid.to_string());
        assert_eq!(captions_handler(State((st.clone(), Default::default())), Query(q.clone()), HeaderMap::new()).await.status(), StatusCode::UNAUTHORIZED);
        let mut q0 = HashMap::new(); q0.insert("id".into(), "nope".to_string());
        assert_eq!(captions_handler(State((st.clone(), Default::default())), Query(q0), headers.clone()).await.status(), StatusCode::BAD_REQUEST);
        let r = captions_handler(State((st.clone(), Default::default())), Query(q.clone()), headers.clone()).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()[header::CONTENT_TYPE], "application/json; charset=utf-8");
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
        let body = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        assert_eq!(body.as_ref(), captions_json(vid, &tracks).as_bytes(), "metadata body is exactly captions_json");
        let mut q2 = q.clone(); q2.insert("lang".into(), "de".into());
        assert_eq!(captions_handler(State((st.clone(), Default::default())), Query(q2), headers.clone()).await.status(), StatusCode::NOT_FOUND);
        let mut q3 = q.clone(); q3.insert("lang".into(), "en".into()); q3.insert("auto".into(), "1".into());
        assert_eq!(captions_handler(State((st.clone(), Default::default())), Query(q3), headers).await.status(), StatusCode::NOT_FOUND, "manual track never served as auto");
    }

    #[tokio::test]
    async fn captions_handler_bad_lang_never_resolves() {
                                                                                            
                                                                                              
        let st = Arc::new(crate::auth_api::devices::tests::fixture("captions-lang-fixture"));
        let token = "b".repeat(48);
        st.auth_db.device_insert("captions-lang-device", "captions-lang-fixture", "tv", "roku", &token).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        for bad in ["en US".to_string(), "a".repeat(33), "en%20US".to_string()] {
            let mut q = HashMap::new(); q.insert("id".into(), "CAPSFIX0002".into()); q.insert("lang".into(), bad.clone());
            let r = captions_handler(State((st.clone(), Default::default())), Query(q), headers.clone()).await;
            assert_eq!(r.status(), StatusCode::BAD_REQUEST, "{bad:?}");
        }
    }

}
#[cfg(test)] #[path = "jetstream_stamp_tests.rs"] mod stamp_tests;

#[cfg(test)]
mod media_access_log_tests {
    use super::*;
    fn fix(name: &str) -> (Arc<crate::AppState>, HeaderMap) {
        let st = Arc::new(crate::auth_api::devices::tests::fixture(name));
        let token = "f".repeat(48);
        st.auth_db.device_insert(&format!("{name}-dev"), name, "tv", "roku", &token).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        (st, headers)
    }
    fn q_of(id: &str) -> Query<HashMap<String, String>> {
        let mut q = HashMap::new();
        q.insert("id".into(), id.to_string());
        Query(q)
    }
    #[tokio::test]
    async fn head_probe_logs_allowlisted_line_only() {
        let (st, headers) = fix("media-log-fixture");
        let r = stream_handler(State((st.clone(), Default::default())), Method::HEAD, q_of("MEDIALOG001"), headers).await;
        assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);                              
        let log = std::fs::read_to_string(st.data_dir.join("jetstream-media-access.log")).unwrap();
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(lines.len(), 1);
        let l = lines[0];
        assert!(l.contains("HEAD /stream id=MEDIALOG001 503 "), "line shape: {l}");
        assert!(l.ends_with("ms"), "elapsed suffix: {l}");
        assert!(!l.contains("http") && !l.contains("Bearer") && !l.contains("token"), "allowlist: {l}");
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(st.data_dir.join("jetstream-media-access.log")).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "owner-only log file");
        }
    }
    #[tokio::test]
    async fn invalid_id_logs_dash_not_injection() {
        let (st, headers) = fix("media-log-inject");
        let _ = stream_handler(State((st.clone(), Default::default())), Method::HEAD, q_of("bad\nFORGED LINE"), headers).await;
        let log = std::fs::read_to_string(st.data_dir.join("jetstream-media-access.log")).unwrap();
        assert_eq!(log.lines().count(), 1, "no injected second line: {log:?}");
        assert!(log.contains("id=-"), "dash placeholder: {log}");
    }
    #[cfg(unix)]
    #[test]
    fn existing_loose_log_is_tightened_to_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let st = Arc::new(crate::auth_api::devices::tests::fixture("media-log-tighten"));
        let p = st.data_dir.join("jetstream-media-access.log");
        std::fs::write(&p, b"old\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        log_leg(&st, "/stream", &Method::GET, "TIGHTEN0001", StatusCode::OK, std::time::Instant::now());
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "pre-existing loose log tightened: {mode:o}");
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body.starts_with("old\n"), "content preserved: {body:?}");
    }
    #[test]
    fn log_file_stays_under_retention_cap() {
        let st = Arc::new(crate::auth_api::devices::tests::fixture("media-log-cap"));
        let p = st.data_dir.join("jetstream-media-access.log");
        std::fs::write(&p, vec![b'x'; (MEDIA_LOG_CAP + 10) as usize]).unwrap();
        log_leg(&st, "/stream", &Method::GET, "CAPCHECK001", StatusCode::OK, std::time::Instant::now());
        let after = std::fs::metadata(&p).unwrap().len();
        assert!(after < MEDIA_LOG_CAP, "bounded: {after} < {MEDIA_LOG_CAP}");
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body.ends_with("ms\n"), "new line intact after trim");
    }
}
