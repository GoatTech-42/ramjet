                                                                                          
                                                                                             
                                                                                               
                                                                                                       
                                                                                               
                                                                                                
                                                                
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;
use axum::http::StatusCode;
use axum::response::Response;
use base64::Engine;
use futures::StreamExt;
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use serde_json::Value;
use crate::lite::{json_err, json_ord, OJ};
use crate::AppState;
use super::amp::{art_validate, search_validate, stream_validate};

pub const DEFERRED_501: &str = "this part isn't ready yet.";
pub const ALL_FAILED: &str = "every catalog timed out - try again";
const BODY_CAP: usize = 1024 * 1024;                                  
const MAX_HOPS: usize = 3;
const TOTAL: Duration = Duration::from_secs(12);
const STREAM_TOTAL: Duration = Duration::from_secs(30);
                                                                                                 
                                                                                             
                                                                                              
                                                                                           
                                                                                            
const STREAM_IDLE: Duration = Duration::from_secs(30);
const STREAM_RANGELESS_TOTAL: Duration = Duration::from_secs(30 * 60);
const REQWEST_NO_TOTAL: Duration = Duration::from_secs(24 * 3600);
const WEB_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const YT_UA: &str = "com.google.android.youtube/20.10.38 (Linux; U; Android 14)";
const AU_HOST: &str = "https://discoveryprovider.audius.co";
const AU_APP: &str = "ramjet-amp";

                                                                                   
fn v4_special(a: Ipv4Addr) -> bool {
    let [a0, b, c, d] = a.octets();
    let n = u32::from(a);
    let in_ = |base: [u8; 4], len: u32| { let m = if len == 0 { 0 } else { u32::MAX << (32 - len) }; n & m == u32::from(Ipv4Addr::from(base)) & m };
    let _ = (b, c);
    a0 == 0 || a0 == 10 || a0 == 127 || a0 >= 240
        || in_([100, 64, 0, 0], 10) || in_([169, 254, 0, 0], 16) || in_([172, 16, 0, 0], 12)
        || in_([192, 0, 0, 0], 24) || in_([192, 0, 2, 0], 24) || in_([192, 31, 196, 0], 24)
        || in_([192, 52, 193, 0], 24) || in_([192, 88, 99, 0], 24) || in_([192, 168, 0, 0], 16)
        || in_([192, 175, 48, 0], 24) || in_([198, 18, 0, 0], 15) || in_([198, 51, 100, 0], 24)
        || in_([203, 0, 113, 0], 24) || in_([224, 0, 0, 0], 4) || (a0 == 255 && d == 255)
}
                                                              
pub fn is_public_global(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => !v4_special(a),
        IpAddr::V6(a) => {
            let s = a.segments();
                                                                                                   
            let unwrap4 = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
            if s[..5] == [0; 5] && s[5] == 0xffff { return !v4_special(unwrap4(s[6], s[7])); }
            if s[..6] == [0; 6] && (s[6] != 0 || s[7] > 1) { return !v4_special(unwrap4(s[6], s[7])); }
                                                 
            if s[0] & 0xe000 != 0x2000 { return false; }
                                                                                                      
                                                                                          
                                                                     
            if s[0] == 0x2001 && s[1] < 0x0200 { return false; }
            if s[0] == 0x2001 && s[1] == 0x0db8 { return false; }
            if s[0] == 0x2002 { return false; }
            if s[0] == 0x3fff && s[1] < 0x1000 { return false; }
            true
        }
    }
}
#[allow(dead_code)]
fn _t(_: Ipv6Addr) {}

                                                                                    
pub fn check_hop(u: &url::Url) -> Result<String, &'static str> {
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() { return Err("bad url"); }
    if u.port().is_some_and(|p| p != 443) { return Err("bad url"); }
    let h = u.host_str().ok_or("bad url")?;
    if h.len() > 253 { return Err("bad url"); }
    let bare = h.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() { if !is_public_global(ip) { return Err("bad url"); } }
    Ok(bare.to_string())
}
async fn validate_resolved(host: &str) -> Result<(), &'static str> {
    if host.parse::<IpAddr>().is_ok() { return Ok(()); }
    let v: Vec<IpAddr> = match tokio::time::timeout(Duration::from_secs(5), crate::lite::ssrf::resolve_host(host)).await { Ok(Ok(v)) => v, _ => return Err("upstream error") };                                                          
    if v.is_empty() || v.iter().any(|a| !is_public_global(*a)) { return Err("bad url"); }
    Ok(())
}

                                                                           
pub type Track = Arc<dyn Fn(i64) + Send + Sync>;

                                                   
                                                                                               
                                                        
pub async fn guarded_open(st: &AppState, method: reqwest::Method, url: &str, headers: &[(&str, String)], body: Option<String>, total: Duration) -> Result<reqwest::Response, &'static str> {
    let eg = st.egress().map_err(|_| "upstream error")?;
    let mut cur = url::Url::parse(url).map_err(|_| "bad url")?;
    let (mut method, mut body) = (method, body);
    for hop in 0..=MAX_HOPS {
        let host = check_hop(&cur)?;
        validate_resolved(&host).await?;
        let mut rq = eg.request(method.clone(), cur.as_str()).timeout(total).header("accept-encoding", "identity");
        for (k, v) in headers { rq = rq.header(*k, v.as_str()); }
        if let Some(b) = &body { rq = rq.header("content-type", "application/json").body(b.clone()); }
        let r = tokio::time::timeout(Duration::from_secs(12), rq.send()).await
            .map_err(|_| "upstream error")?.map_err(|_| "upstream error")?;
        if r.status().is_redirection() {
            if hop == MAX_HOPS { return Err("upstream error"); }
            let loc = r.headers().get("location").and_then(|v| v.to_str().ok()).ok_or("upstream error")?;
            cur = cur.join(loc).map_err(|_| "bad url")?;
            if matches!(r.status().as_u16(), 301 | 302 | 303) { method = reqwest::Method::GET; body = None; }
            continue;
        }
        return Ok(r);
    }
    Err("upstream error")
}
                                                                                
pub async fn read_capped(r: reqwest::Response, cap: usize) -> Result<Vec<u8>, &'static str> {
    let mut body = Vec::new();
    let mut s = r.bytes_stream();
    while let Some(c) = s.next().await {
        let c = c.map_err(|_| "upstream error")?;
        if body.len() + c.len() > cap { return Err("upstream error"); }
        body.extend_from_slice(&c);
    }
    Ok(body)
}
async fn get_json(st: &AppState, url: &str, headers: &[(&str, String)], post: Option<String>) -> Result<ONode, &'static str> {
    let m = if post.is_some() { reqwest::Method::POST } else { reqwest::Method::GET };
    let r = guarded_open(st, m, url, headers, post, TOTAL).await?;
    if !r.status().is_success() { return Err("upstream error"); }
    let b = tokio::time::timeout(TOTAL, read_capped(r, 4 * BODY_CAP)).await.map_err(|_| "upstream error")??;
    serde_json::from_slice::<ONode>(&b).map_err(|_| "upstream error")
}

                                                                                                               
#[derive(Debug, Clone)]
pub enum ONode { Obj(Vec<(String, ONode)>), Arr(Vec<ONode>), Str(String), Num(f64), Bool(bool), Null }
impl<'de> serde::Deserialize<'de> for ONode {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = ONode;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("json") }
            fn visit_bool<E>(self, b: bool) -> Result<ONode, E> { Ok(ONode::Bool(b)) }
            fn visit_i64<E>(self, n: i64) -> Result<ONode, E> { Ok(ONode::Num(n as f64)) }
            fn visit_u64<E>(self, n: u64) -> Result<ONode, E> { Ok(ONode::Num(n as f64)) }
            fn visit_f64<E>(self, n: f64) -> Result<ONode, E> { Ok(ONode::Num(n)) }
            fn visit_str<E>(self, s: &str) -> Result<ONode, E> { Ok(ONode::Str(s.to_string())) }
            fn visit_unit<E>(self) -> Result<ONode, E> { Ok(ONode::Null) }
            fn visit_none<E>(self) -> Result<ONode, E> { Ok(ONode::Null) }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut a: A) -> Result<ONode, A::Error> {
                let mut v = vec![]; while let Some(x) = a.next_element()? { v.push(x); } Ok(ONode::Arr(v))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<ONode, A::Error> {
                let mut v: Vec<(String, ONode)> = vec![];
                while let Some((k, x)) = m.next_entry::<String, ONode>()? {
                    if let Some(e) = v.iter_mut().find(|(kk, _)| *kk == k) { e.1 = x; } else { v.push((k, x)); }
                }
                Ok(ONode::Obj(v))
            }
        }
        d.deserialize_any(V)
    }
}
impl ONode {
    fn get(&self, k: &str) -> &ONode {
        static NULL: ONode = ONode::Null;
        if let ONode::Obj(v) = self { v.iter().find(|(kk, _)| kk == k).map(|(_, x)| x).unwrap_or(&NULL) } else { &NULL }
    }
    fn s(&self) -> Option<&str> { if let ONode::Str(s) = self { Some(s) } else { None } }
    fn arr(&self) -> &[ONode] { if let ONode::Arr(v) = self { v } else { &[] } }
    fn truthy(&self) -> bool { match self { ONode::Null => false, ONode::Bool(b) => *b, ONode::Num(n) => *n != 0.0 && !n.is_nan(), ONode::Str(s) => !s.is_empty(), _ => true } }
                                                          
    fn js_str(&self) -> String {
        match self {
            ONode::Str(s) => s.clone(), ONode::Num(n) => super::js_num_str(*n), ONode::Bool(b) => b.to_string(),
            ONode::Null => "null".into(), ONode::Arr(_) => String::new(), ONode::Obj(_) => "[object Object]".into(),
        }
    }
                                       
    fn or_empty(&self) -> String { if self.truthy() { self.js_str() } else { String::new() } }
                                   
    fn num_raw(&self) -> f64 {
        match self { ONode::Num(n) => *n, ONode::Str(s) => super::js_number(Some(&Value::String(s.clone()))), ONode::Bool(b) => if *b { 1.0 } else { 0.0 }, ONode::Null => 0.0, ONode::Arr(a) if a.is_empty() => 0.0, _ => f64::NAN }
    }
                      
    fn num0(&self) -> f64 {
        let n = match self { ONode::Num(n) => *n, ONode::Str(s) => super::js_number(Some(&Value::String(s.clone()))), ONode::Bool(b) => if *b { 1.0 } else { 0.0 }, ONode::Null => 0.0, _ => f64::NAN };
        if n.is_nan() { 0.0 } else { n }
    }
}

                                                                             
fn b64(s: &str) -> String { base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s) }
fn jround(x: f64) -> f64 { (x + 0.5).floor() }
                                                              
fn fmt_dur(sec: f64) -> String {
    let n = jround(if sec.is_nan() { 0.0 } else { sec }).max(0.0);
    let (m, r) = ((n / 60.0).floor(), n % 60.0);
    let rs = js_num(r);
    format!("{}:{}{}", js_num(m), if rs.len() < 2 { "0" } else { "" }, rs)
}
fn enc_id(s: &str) -> String { urlenc(s) }
fn urlenc(s: &str) -> String { crate::lite::urlenc(s) }                                                                             
fn s(x: &str) -> OJ { OJ::Str(x.to_string()) }
fn num(n: f64) -> OJ { if !n.is_finite() { OJ::Raw("null".into()) } else { OJ::Raw(js_num(if n == 0.0 { 0.0 } else { n })) } }
fn js_num(n: f64) -> String { super::js_num_str(n) }
                                                                                                    
fn to_json(n: &ONode) -> String {
    match n {
        ONode::Str(x) => serde_json::to_string(x).unwrap(), ONode::Num(x) => if x.is_finite() { super::js_num_str(*x) } else { "null".into() },
        ONode::Bool(b) => b.to_string(), ONode::Null => "null".into(),
        ONode::Arr(a) => format!("[{}]", a.iter().map(to_json).collect::<Vec<_>>().join(",")),
        ONode::Obj(o) => format!("{{{}}}", o.iter().map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap(), to_json(v))).collect::<Vec<_>>().join(",")),
    }
}
fn raw_or_empty(n: &ONode) -> OJ { OJ::Raw(if n.truthy() { to_json(n) } else { "\"\"".into() }) }

                                                                                                                                                   
fn array_or_throw(n: &ONode) -> Result<&[ONode], ()> {
    match n { ONode::Arr(a) => Ok(a), x if !x.truthy() => Ok(&[]), _ => Err(()) }
}
impl ONode {
    fn has(&self, k: &str) -> bool { if let ONode::Obj(v) = self { v.iter().any(|(kk, _)| kk == k) } else { false } }
}
                                                              
fn id_str(t: &ONode) -> String { if t.has("id") { t.get("id").js_str() } else { "undefined".into() } }

pub fn parse_audius(v: &ONode) -> Result<Vec<Value>, ()> {
    let rows = array_or_throw(v.get("data"))?;
    rows.iter().take(12).map(|t| {
        if matches!(t, ONode::Null) { return Err(()); }                              
        Ok({
        let art_url = if t.get("artwork").get("480x480").truthy() { t.get("artwork").get("480x480").js_str() }
                      else if t.get("artwork").get("150x150").truthy() { t.get("artwork").get("150x150").js_str() } else { String::new() };
        let id = id_str(t);
        let dur = t.get("duration").num0();
        ord(vec![
            ("key", s(&format!("au:{id}"))), ("src", s("au")), ("id", s(&id)),
            ("title", raw_or_empty(t.get("title"))), ("artist", raw_or_empty(t.get("user").get("name"))),
            ("dur", s(&fmt_dur(dur))), ("durSec", num(jround(dur))),
            ("art", s(&if art_url.is_empty() { String::new() } else { format!("/api/apps/amp/art?src=au&u={}", b64(&art_url)) })),
            ("stream", s(&format!("/api/apps/amp/stream?src=au&id={}", enc_id(&id)))),
        ])
        })
    }).collect()
}
pub fn parse_soundcloud(v: &ONode) -> Result<Vec<Value>, ()> {
    Ok(array_or_throw(v.get("collection"))?.iter().filter(|t| {
        if !t.get("id").truthy() { return false; }
        if matches!(t.get("streamable"), ONode::Bool(false)) { return false; }
        let tcs = t.get("media").get("transcodings").arr();
        tcs.is_empty() || tcs.iter().any(|x| x.get("format").get("protocol").s() == Some("progressive"))
    }).take(12).map(|t| {
        let id = t.get("id").js_str();
        let sec = (if t.get("duration").truthy() { t.get("duration").num_raw() } else { 0.0 }) / 1000.0;                                            
        let art = if t.get("artwork_url").truthy() {
            format!("/api/apps/amp/art?src=sc&u={}", b64(&t.get("artwork_url").js_str().replacen("-large", "-t500x500", 1)))
        } else { String::new() };
        ord(vec![
            ("key", s(&format!("sc:{id}"))), ("src", s("sc")), ("id", s(&id)),
            ("title", raw_or_empty(t.get("title"))), ("artist", raw_or_empty(t.get("user").get("username"))),
            ("dur", s(&fmt_dur(sec))), ("durSec", num(jround(sec))),
            ("art", s(&art)), ("stream", s(&format!("/api/apps/amp/stream?src=sc&id={id}"))),
        ])
    }).collect())
}
fn ord(pairs: Vec<(&str, OJ)>) -> Value {
                                                                                            
    let mut out = String::from("{");
    for (i, (k, v)) in pairs.iter().enumerate() {
        if i > 0 { out.push(','); }
        out.push_str(&serde_json::to_string(k).unwrap()); out.push(':');
        out.push_str(&oj_text(v));
    }
    out.push('}');
    Value::String(out)                                                               
}
fn oj_text(v: &OJ) -> String { match v { OJ::Str(x) => serde_json::to_string(x).unwrap(), OJ::Val(x) => serde_json::to_string(x).unwrap(), OJ::Raw(x) => x.clone(), _ => unreachable!() } }

fn is_bullet_only(t: &str) -> bool { !t.is_empty() && t.chars().all(|c| c == '\u{2022}' || is_js_space(c)) }
fn is_js_space(c: char) -> bool { c.is_whitespace() || c == '\u{feff}' }
fn is_clock(t: &str) -> bool {
    let p: Vec<&str> = t.split(':').collect();
    (p.len() == 2 || p.len() == 3) && p.iter().all(|x| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit()))
}
fn vid_ok(x: &str) -> bool { x.len() == 11 && x.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') }
fn walk_ym(n: &ONode, seen: &mut Vec<String>, out: &mut Vec<Value>) {
    match n {
        ONode::Obj(m) => {
            let it = n.get("musicResponsiveListItemRenderer");
            if !it.truthy() { for (_, x) in m { walk_ym(x, seen, out); } return; }
            let mut vid = it.get("playlistItemData").get("videoId").or_empty();
            if vid.is_empty() { vid = it.get("overlay").get("musicItemThumbnailOverlayRenderer").get("content").get("musicPlayButtonRenderer").get("playNavigationEndpoint").get("watchEndpoint").get("videoId").or_empty(); }
            if !vid_ok(&vid) || seen.contains(&vid) { return; }
            seen.push(vid.clone());
            let cols: Vec<&[ONode]> = it.get("flexColumns").arr().iter().map(|c| c.get("musicResponsiveListItemFlexColumnRenderer").get("text").get("runs").arr()).collect();
            let title_n = cols.first().and_then(|r| r.first()).map(|r| r.get("text")).unwrap_or(&ONode::Null);
            let mut segs: Vec<Vec<String>> = vec![vec![]];
            for r2 in cols.get(1).copied().unwrap_or(&[]) {
                let t = r2.get("text").or_empty();
                if is_bullet_only(&t) { segs.push(vec![]); } else { segs.last_mut().unwrap().push(t); }
            }
            let seg_text: Vec<String> = segs.iter().map(|x| x.join("").trim().to_string()).filter(|x| !x.is_empty()).collect();
            let dur_text = seg_text.iter().find(|t| is_clock(t)).cloned().unwrap_or_default();
            let meta: Vec<&String> = seg_text.iter().filter(|t| **t != dur_text).collect();
            let artist = meta.first().map(|x| x.as_str()).unwrap_or("");
            let album = meta.get(1).map(|x| x.as_str()).unwrap_or("");
            let dur_sec = if dur_text.is_empty() { 0.0 } else { dur_text.split(':').fold(0.0, |a, x| a * 60.0 + x.parse::<f64>().unwrap_or(0.0)) };
            let plays_n = cols.get(2).and_then(|r| r.first()).map(|r| r.get("text")).unwrap_or(&ONode::Null);
            if !title_n.truthy() { return; }
            out.push(ord(vec![
                ("key", s(&format!("yt:{vid}"))), ("src", s("yt")), ("id", s(&vid)), ("title", raw_or_empty(title_n)),
                ("artist", s(artist)), ("album", s(album)), ("plays", raw_or_empty(plays_n)),
                ("dur", s(&dur_text)), ("durSec", num(dur_sec)),
                ("art", s(&format!("/api/apps/amp/art?src=yt&id={vid}"))),
                ("stream", s(&format!("/api/apps/amp/stream?src=yt&id={vid}"))),
            ]));
        }
        ONode::Arr(a) => a.iter().for_each(|x| walk_ym(x, seen, out)),
        _ => {}
    }
}
pub fn parse_ytmusic(v: &ONode) -> Vec<Value> {
    let (mut seen, mut out) = (vec![], vec![]);
    walk_ym(v, &mut seen, &mut out);
    out.truncate(12);
    out
}

                                            
pub fn combine(q: &str, yt: Result<Vec<Value>, ()>, sc: Result<Vec<Value>, ()>, au: Result<Vec<Value>, ()>) -> Response {
    if yt.is_err() && sc.is_err() && au.is_err() { return json_err(StatusCode::BAD_GATEWAY, ALL_FAILED); }
    let arr = |r: Result<Vec<Value>, ()>| OJ::Arr(r.unwrap_or_default().into_iter().map(|v| OJ::Raw(v.as_str().unwrap_or("{}").to_string())).collect());
    json_ord(StatusCode::OK, vec![
        ("ok", OJ::Bool(true)), ("q", OJ::Str(q.to_string())),
        ("results", OJ::Obj(vec![("youtube".into(), arr(yt)), ("soundcloud".into(), arr(sc)), ("audius".into(), arr(au))])),
    ])
}

async fn src_audius(st: &AppState, q: &str) -> Result<Vec<Value>, ()> {
    let u = format!("{AU_HOST}/v1/tracks/search?query={}&app_name={AU_APP}", urlenc(q));
    get_json(st, &u, &[("user-agent", WEB_UA.into()), ("accept", "application/json".into())], None).await.map_err(|_| ()).and_then(|v| parse_audius(&v))
}

static SC_CID: Mutex<(String, Option<std::time::Instant>)> = Mutex::new((String::new(), None));
async fn sc_text(st: &AppState, url: &str) -> Result<String, &'static str> {
    let r = guarded_open(st, reqwest::Method::GET, url, &[("user-agent", WEB_UA.into())], None, TOTAL).await?;
    let b = tokio::time::timeout(TOTAL, read_capped(r, BODY_CAP)).await.map_err(|_| "upstream error")??;
    Ok(String::from_utf8_lossy(&b).into_owned())
}
static SC_LOCK: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);                                   
static SC_FAIL: Mutex<Option<std::time::Instant>> = Mutex::new(None);                                                   
async fn sc_client_id(st: &AppState, force: bool) -> Result<String, &'static str> {
    { let g = SC_CID.lock().unwrap();
      if !force && !g.0.is_empty() && g.1.is_some_and(|t| t.elapsed() < Duration::from_secs(6 * 3600)) { return Ok(g.0.clone()); } }
                                                                                        
                                                                                      
    if SC_FAIL.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_secs(60)) {
        let g = SC_CID.lock().unwrap();
        if !g.0.is_empty() { return Ok(g.0.clone()); }
        return Err("no soundcloud client_id");
    }
    let _one = SC_LOCK.acquire().await.map_err(|_| "no soundcloud client_id")?;
    { let g = SC_CID.lock().unwrap();                                                  
      if !force && !g.0.is_empty() && g.1.is_some_and(|t| t.elapsed() < Duration::from_secs(6 * 3600)) { return Ok(g.0.clone()); } }
    match tokio::time::timeout(Duration::from_secs(20), sc_scrape(st)).await {                                   
        Ok(Ok(id)) => { *SC_FAIL.lock().unwrap() = None; Ok(id) }
        _ => {
            *SC_FAIL.lock().unwrap() = Some(std::time::Instant::now());
            let g = SC_CID.lock().unwrap();
            if !g.0.is_empty() { Ok(g.0.clone()) } else { Err("no soundcloud client_id") }
        }
    }
}
async fn sc_scrape(st: &AppState) -> Result<String, &'static str> {
    let html = sc_text(st, "https://soundcloud.com/").await?;
    let re_s = regex::Regex::new(r#"<script[^>]+src="(https://a-v2\.sndcdn\.com/[^"]+\.js)""#).unwrap();
    let srcs: Vec<String> = re_s.captures_iter(&html).map(|c| c[1].to_string()).collect();
    let (r1, r2) = (regex::Regex::new(r#"client_id\s*[:=]\s*"([a-zA-Z0-9]{32})""#).unwrap(), regex::Regex::new(r#"client_id\s*[:=]\s*"([a-zA-Z0-9]{24,40})""#).unwrap());
    for src in srcs.iter().rev() {
        if let Ok(js) = sc_text(st, src).await {
            if let Some(m) = r1.captures(&js).or_else(|| r2.captures(&js)) {
                let id = m[1].to_string();
                *SC_CID.lock().unwrap() = (id.clone(), Some(std::time::Instant::now()));
                return Ok(id);
            }
        }
    }
    Err("no soundcloud client_id")
}
async fn sc_fetch_json(st: &AppState, up: &str) -> Result<ONode, &'static str> {
    let sep = if up.contains('?') { '&' } else { '?' };
    let mut cid = sc_client_id(st, false).await?;
    for attempt in 0..2 {
        let r = guarded_open(st, reqwest::Method::GET, &format!("{up}{sep}client_id={cid}"), &[("user-agent", WEB_UA.into())], None, Duration::from_secs(15)).await?;
        if r.status().as_u16() == 403 && attempt == 0 { cid = sc_client_id(st, true).await?; continue; }
        if !r.status().is_success() { return Err("upstream error"); }
        let b = tokio::time::timeout(Duration::from_secs(15), read_capped(r, 4 * BODY_CAP)).await.map_err(|_| "upstream error")??;
        return serde_json::from_slice(&b).map_err(|_| "upstream error");
    }
    Err("upstream error")
}
async fn src_soundcloud(st: &AppState, q: &str) -> Result<Vec<Value>, ()> {
    sc_fetch_json(st, &format!("https://api-v2.soundcloud.com/search/tracks?q={}&limit=24", urlenc(q))).await.map_err(|_| ()).and_then(|v| parse_soundcloud(&v))
}
const YM_SONGS_PARAMS: &str = "EgWKAQIIAWoKEAoQAxADEAQQAQ==";
async fn src_ytmusic(st: &AppState, q: &str) -> Result<Vec<Value>, ()> {
    let body = serde_json::json!({"context":{"client":{"clientName":"WEB_REMIX","clientVersion":"1.20240925.01.00","hl":"en"}},"query":q,"params":YM_SONGS_PARAMS}).to_string();
    get_json(st, "https://music.youtube.com/youtubei/v1/search?prettyPrint=false", &[("user-agent", WEB_UA.into())], Some(body)).await.map_err(|_| ()).map(|v| parse_ytmusic(&v))
}

pub async fn search(st: &AppState, track: &Track, q: &str) -> Response {
    if let Some(r) = search_validate(q) { return r; }
    let q = super::js_trim(q);
    let (y, c, a) = futures::join!(src_ytmusic(st, q), src_soundcloud(st, q), src_audius(st, q));
    track(8192);
    combine(q, y, c, a)
}

                                         
pub fn art_target(src: &str, id: &str, u: &str) -> Option<String> {
    match src {
        "yt" => Some(format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", super::js_trim(id))),
        _ => base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(u).or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(u))
            .ok().and_then(|b| String::from_utf8(b).ok()),
    }
}
fn bodiless(status: u16) -> Response { Response::builder().status(status).body(axum::body::Body::empty()).unwrap() }

                                                                                                                         
                                                                                                                 
                                                                                                                                                               
pub fn art_finish(ct: String, b: Vec<u8>, track: &Track) -> Response {
    let lc = ct.to_ascii_lowercase();
    let sub = lc.trim_start().strip_prefix("image/");
                                                                                                                              
    match sub { Some(sub) if !sub.trim_start().starts_with("svg") => {} _ => return bodiless(204) }
    track(b.len() as i64);
                                                                                                
    Response::builder().status(200).header("content-type", ct).header("cache-control", "private, max-age=86400").header("x-content-type-options", "nosniff").body(axum::body::Body::from(b)).unwrap()
}

pub async fn art(st: &AppState, track: &Track, src: &str, id: &str, u: &str) -> Response {
    if let Some(r) = art_validate(src, id, u) { return r; }
    let Some(target) = art_target(src, id, u) else { return bodiless(204) };
    let fut = async {
        let r = guarded_open(st, reqwest::Method::GET, &target, &[("user-agent", WEB_UA.into())], None, TOTAL).await?;
        if !r.status().is_success() { return Err("upstream error"); }
        let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("image/jpeg").to_string();
        let b = read_capped(r, BODY_CAP).await?;
        Ok::<_, &str>((ct, b))
    };
    match tokio::time::timeout(TOTAL, fut).await {
        Ok(Ok((ct, b))) => art_finish(ct, b, track),
        _ => bodiless(204),
    }
}

                                            
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum RangeReq { None, From(u64, Option<u64>), Suffix(u64) }
                                                                                           
pub fn parse_range(h: Option<&str>) -> RangeReq {
    let Some(r) = h.and_then(|h| h.trim().strip_prefix("bytes=")) else { return RangeReq::None };
    if r.contains(',') { return RangeReq::None; }
    let Some((a, b)) = r.split_once('-') else { return RangeReq::None };
    let (a, b) = (a.trim(), b.trim());
    let dig = |x: &str| !x.is_empty() && x.bytes().all(|c| c.is_ascii_digit());
    if a.is_empty() { return if dig(b) { b.parse().map(RangeReq::Suffix).unwrap_or(RangeReq::None) } else { RangeReq::None }; }
    if !dig(a) || !(b.is_empty() || dig(b)) { return RangeReq::None; }
    let (Ok(a), b) = (a.parse::<u64>(), if b.is_empty() { Ok(None) } else { b.parse::<u64>().map(Some) }) else { return RangeReq::None };
    match b { Ok(b) => RangeReq::From(a, b), Err(_) => RangeReq::None }
}
                                                                                                     
pub fn resolve_range(r: RangeReq, total: u64) -> Result<Option<(u64, u64)>, ()> {
    match r {
        RangeReq::None => Ok(None),
        RangeReq::Suffix(0) => Err(()),
        RangeReq::Suffix(n) => if total == 0 { Err(()) } else { Ok(Some((total.saturating_sub(n), total - 1))) },
        RangeReq::From(a, b) => {
            if a >= total { return Err(()); }
            if b.is_some_and(|b| b < a) { return Ok(None); }                                        
            Ok(Some((a, b.map(|b| b.min(total - 1)).unwrap_or(total - 1))))
        }
    }
}
                                                                               
pub fn media_range(h: Option<&str>) -> String {
    let cap = BODY_CAP as u64;
    match parse_range(h) {
        RangeReq::Suffix(n) => format!("bytes=-{}", n.clamp(1, cap)),
        RangeReq::From(a, Some(b)) if b >= a => format!("bytes={}-{}", a, b.min(a.saturating_add(cap.saturating_sub(1)))),
        RangeReq::From(a, _) => format!("bytes={}-{}", a, a.saturating_add(cap.saturating_sub(1))),
        RangeReq::None => format!("bytes=0-{}", cap - 1),
    }
}

fn base(status: u16, ctype: &str) -> axum::http::response::Builder {
    Response::builder().status(status).header("content-type", ctype).header("accept-ranges", "bytes").header("cache-control", "private, no-store")
}
                                                                                                       
fn empty_len0(status: u16, crange: Option<String>) -> Response {
    let mut b = Response::builder().status(status).header("content-length", "0").header("accept-ranges", "bytes");
    if let Some(c) = crange { b = b.header("content-range", c); }
    b.body(axum::body::Body::empty()).unwrap()
}
fn unsatisfiable(total: u64) -> Response { empty_len0(416, Some(format!("bytes */{total}"))) }

                                                                                                                              
fn zero_len(r: RangeReq, ctype: &str) -> Response {
    match resolve_range(r, 0) {
        Err(()) => unsatisfiable(0),
        Ok(_) => base(200, ctype).header("content-length", "0").body(axum::body::Body::empty()).unwrap(),
    }
}
                                                                                                         
                                                                              
pub fn effective_range<'a>(range: Option<&'a str>, if_range: Option<&str>) -> Option<&'a str> { if if_range.is_some() { None } else { range } }

                                                                                                             
                                                                                 
fn plan(r: RangeReq, total: u64, win_start: u64, win_len: u64, default_206: bool) -> Result<(u64, u64, bool), Response> {
    let res = resolve_range(r, total).map_err(|_| unsatisfiable(total))?;
    let explicit = res.is_some();
    let (st, en) = res.unwrap_or((0, total.saturating_sub(1)));
    if win_len == 0 || st < win_start || st >= win_start + win_len { return Err(empty_len0(503, None)); }
    let en = en.min(win_start + win_len - 1);
    Ok((st, en, explicit || default_206 || st != 0 || en + 1 != total))
}
fn window_head(st: u64, en: u64, total: u64, partial: bool, ctype: &str) -> axum::http::response::Builder {
    let b = base(if partial { 206 } else { 200 }, ctype).header("content-length", en - st + 1);
    if partial { b.header("content-range", format!("bytes {st}-{en}/{total}")) } else { b }
}
                                                                                                     
                                                                                     
                                            
pub fn serve_window(r: RangeReq, total: u64, win_start: u64, win: &[u8], ctype: &str, default_206: bool, head: bool) -> Response {
    if total == 0 { return zero_len(r, ctype); }
    let (st, en, partial) = match plan(r, total, win_start, win.len() as u64, default_206) { Ok(x) => x, Err(e) => return e };
    let body = &win[(st - win_start) as usize..=(en - win_start) as usize];
    window_head(st, en, total, partial, ctype).body(if head { axum::body::Body::empty() } else { axum::body::Body::from(body.to_vec()) }).unwrap()
}
                                                                                                                
pub fn head_only(r: RangeReq, total: u64, ctype: &str, default_206: bool) -> Response {
    if total == 0 { return zero_len(r, ctype); }
    match plan(r, total, 0, total, default_206) {
        Ok((st, en, partial)) => window_head(st, en, total, partial, ctype).body(axum::body::Body::empty()).unwrap(),
        Err(e) => e,
    }
}

                                                                                 
pub fn cr_window(c: &str) -> Option<(u64, u64)> {
    let ab = c.strip_prefix("bytes ")?.split('/').next()?;
    let (a, b) = ab.split_once('-')?;
    let (a, b) = (a.parse::<u64>().ok()?, b.parse::<u64>().ok()?);
    if b < a { None } else { Some((a, b)) }
}
                                                                                                            
pub fn cr_span(a: u64, b: u64) -> Option<u64> { b.checked_sub(a)?.checked_add(1) }
                                                                                        
pub fn cr_fits(want: RangeReq, a: u64, b: u64, cap: u64) -> bool {
    if b < a { return false; }
    match want {
        RangeReq::From(s, Some(e)) if e >= s => a == s && b <= e.min(s.saturating_add(cap - 1)),
        RangeReq::From(s, _) => a == s && b <= s.saturating_add(cap - 1),
        RangeReq::Suffix(n) => b - a < n.clamp(1, cap),                                      
        RangeReq::None => a == 0 && b < cap,
    }
}
                                                                                                
                                                                                            
                                                                           
fn full_body_stream(r: reqwest::Response, track: Track) -> axum::body::Body {
    let s = r.bytes_stream();
    let started = std::time::Instant::now();
    axum::body::Body::from_stream(futures::stream::try_unfold((s, track, started), |(mut s, track, started)| async move {
        if started.elapsed() > STREAM_RANGELESS_TOTAL { return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "body deadline")); }
        match tokio::time::timeout(STREAM_IDLE, s.next()).await {
            Err(_) => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "stalled")),
            Ok(None) => Ok(None),
            Ok(Some(Err(_))) => Err(std::io::Error::other("upstream")),
            Ok(Some(Ok(c))) => { track(c.len() as i64); Ok(Some((c, (s, track, started)))) }
        }
    }))
}
                                                                                               
                                                                                         
fn rangeless_full_body(r: reqwest::Response, ctype: &str, clen: Option<u64>, track: &Track, head: bool) -> Response {
    let b = base(200, ctype);
    let b = if let Some(c) = clen { b.header("content-length", c) } else { b };
    if head { return b.body(axum::body::Body::empty()).unwrap(); }
    b.body(full_body_stream(r, track.clone())).unwrap()
}
                                                                                                       
                                                                                                
async fn pipe_media(st: &AppState, track: &Track, url: &str, range: Option<&str>, head: bool) -> (Response, u16) {
    let want = parse_range(range);
                                                                                                
                                                                                               
                                             
    let mut hdrs = vec![("user-agent", WEB_UA.to_string())];
    if want != RangeReq::None { hdrs.push(("range", media_range(range))); }
                                                                                                
                                                                                            
                                                                                         
    let open_timeout = if want == RangeReq::None { REQWEST_NO_TOTAL } else { STREAM_TOTAL };
    let r = match guarded_open(st, reqwest::Method::GET, url, &hdrs, None, open_timeout).await { Ok(r) => r, Err(_) => return (empty_len0(502, None), 502) };
    let status = r.status().as_u16();
    let h = |k: &str| r.headers().get(k).and_then(|v| v.to_str().ok()).map(String::from);
    if status == 416 {                                              
        let total = h("content-range").and_then(|c| c.rsplit('/').next().and_then(|t| t.parse::<u64>().ok()));
        return (match total { Some(t) => unsatisfiable(t), None => empty_len0(416, h("content-range")) }, 416);
    }
    if status != 200 && status != 206 { return (empty_len0(status, None), status); }
    let ctype = h("content-type").unwrap_or_else(|| "audio/mpeg".into());
    let clen = h("content-length").and_then(|c| c.parse::<u64>().ok());
    let crange = h("content-range");
    if want == RangeReq::None && status == 200 {
                                                                                           
                                                                                           
                                                                                           
                               
        return (rangeless_full_body(r, &ctype, clen, track, head), 200);
    }
    if status == 206 {
                                                                                                    
                                                                                       
        let win = crange.as_deref().and_then(cr_window);
        let span = win.and_then(|(a, b)| cr_span(a, b));
        if let (Some(len), Some(cr), Some((a, b))) = (clen.or(span), crange.clone(), win) {
            if !cr_fits(want, a, b, BODY_CAP as u64) { return (empty_len0(502, None), 502); }
            if len > BODY_CAP as u64 { return (empty_len0(502, None), 502); }
                                                                                               
                                                                                                    
            let out = if want == RangeReq::None { 200 } else { 206 };
            let b = if out == 200 { base(200, &ctype).header("content-length", len) } else { base(206, &ctype).header("content-length", len).header("content-range", cr) };
            if head { return (b.body(axum::body::Body::empty()).unwrap(), out); }
                                                                                               
                                                                                            
                                                                                      
            let tr = track.clone();
            let started = std::time::Instant::now();
            let s = futures::stream::try_unfold((r.bytes_stream(), tr, started, 0usize), |(mut s, tr, started, mut seen)| async move {
                if started.elapsed() > STREAM_RANGELESS_TOTAL { return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "body deadline")); }
                match tokio::time::timeout(STREAM_IDLE, s.next()).await {
                    Err(_) => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "stalled")),
                    Ok(None) => Ok(None),
                    Ok(Some(Err(_))) => Err(std::io::Error::other("upstream")),
                    Ok(Some(Ok(c))) => {
                        seen += c.len();
                        if seen > BODY_CAP { return Err(std::io::Error::other("cap")); }
                        tr(c.len() as i64);
                        Ok(Some((c, (s, tr, started, seen))))
                    }
                }
            });
            return (b.body(axum::body::Body::from_stream(s)).unwrap(), out);
        }
    }
                                                                                                       
                                                                                   
    if clen.is_some_and(|c| c > BODY_CAP as u64) { return (empty_len0(502, None), 502); }
    if let (true, Some(c), 200) = (head, clen, status) { return (head_only(want, c, &ctype, false), 200); }                               
    let Ok(Ok(body)) = tokio::time::timeout(STREAM_TOTAL, read_capped(r, BODY_CAP)).await else { return (empty_len0(502, None), 502) };
    track(body.len() as i64);
    if status == 206 {                                                                                         
        return (empty_len0(502, None), 502);
    }
    (serve_window(want, body.len() as u64, 0, &body, &ctype, false, head), status)
}

                                              
                                                                                        
                                                                                           
                                                                                              
                                                                                            
                                                                                              
                                                                                           
                                                                                             
                                                                           
const REMUX_WIN: u64 = 4 << 20;                                                                  
const REMUX_OBJ_MAX: u64 = 96 << 20;                                                                              
const REMUX_DIR_MAX: u64 = 512 << 20;                                                                                                                                                                            
const REMUX_OUT_SLACK: u64 = 16 << 20;                                                                            
const REMUX_OUT_LIMIT: u64 = REMUX_OBJ_MAX + REMUX_OUT_SLACK;                                                        
const REMUX_JOB_RESERVE: u64 = REMUX_OBJ_MAX + REMUX_OUT_LIMIT;                                                                                           
const REMUX_FS_FREE_MIN: u64 = 2 << 30;                                                                
const REMUX_FS_USED_MAX: f64 = 0.75;                                                  
const REMUX_TTL_SECS: u64 = 6 * 3600;                                                                        
const REMUX_DL_TOTAL: Duration = Duration::from_secs(180);                                           
const REMUX_FF_TOTAL: Duration = Duration::from_secs(120);                                              
static REMUX_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
static REMUX_CELLS: Mutex<Vec<(String, Arc<tokio::sync::Mutex<()>>, std::time::Instant)>> = Mutex::new(Vec::new());
static REMUX_FAIL: Mutex<Option<HashMap<String, std::time::Instant>>> = Mutex::new(None);
static FFMPEG_MISSING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

                                                                                               
                                                                                              
                                                                                           
                                                                                       
fn remux_flag_on(v: Option<&str>) -> bool { v == Some("1") }
#[cfg(test)]
thread_local! { static TEST_REMUX_ON: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) }; }
fn remux_enabled() -> bool {
    #[cfg(test)]
    if let Some(v) = TEST_REMUX_ON.with(|o| o.get()) { return v; }
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| remux_flag_on(std::env::var("RJ_AMP_REMUX").ok().as_deref()))
}
fn remux_cell(id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut g = REMUX_CELLS.lock().unwrap();
    let now = std::time::Instant::now();
    if let Some(e) = g.iter_mut().find(|(k, _, _)| k == id) { e.2 = now; return e.1.clone(); }
    let c: Arc<tokio::sync::Mutex<()>> = Arc::new(tokio::sync::Mutex::new(()));
    g.push((id.to_string(), c.clone(), now));
                                                                                               
                                                                                            
                                                                                            
                                                                                              
                                                                                         
                                        
    if g.len() > 32 {
        let i = g.iter().enumerate().filter(|(_, e)| Arc::strong_count(&e.1) == 1).min_by_key(|(_, e)| e.2).map(|(i, _)| i);
        if let Some(i) = i { g.remove(i); }
    }
    c
}
fn remux_fresh(m: std::time::SystemTime, now: std::time::SystemTime) -> bool {
    now.duration_since(m).map(|d| d.as_secs() < REMUX_TTL_SECS).unwrap_or(false)
}
                                                                                          
                                                                                               
                                                                              
pub fn remux_boot_clean(data_dir: &std::path::Path) {
    if !remux_enabled() { return; }                                                                            
    let dir = data_dir.join("amp-remux");
    if std::fs::create_dir_all(&dir).is_err() { REMUX_DISK_FULL.store(true, std::sync::atomic::Ordering::Relaxed); return; }
    let Some(f) = remux_dir_claim(&dir) else {
                                                                                               
                                                                                         
                                                             
        REMUX_DISK_FULL.store(true, std::sync::atomic::Ordering::Relaxed);
        return;
    };
    REMUX_DIR_LOCK.lock().unwrap().insert(dir.clone(), f);                                   
    let Ok(rd) = std::fs::read_dir(&dir) else { return };                      
    let now = std::time::SystemTime::now();
    for e in rd.flatten() {
        let p = e.path();
        let name = p.file_name().and_then(|x| x.to_str()).unwrap_or("");
        let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
        if !remux_id_ok(name.split('.').next().unwrap_or("")) { continue; }
        if ext == "part" { let _ = std::fs::remove_file(&p); continue; }
        if ext == "m4a" {
            let expired = e.metadata().ok().and_then(|m| m.modified().ok()).is_some_and(|mt| !remux_fresh(mt, now));
            if expired { let _ = std::fs::remove_file(&p); }
        }
    }
    remux_cache_evict(&dir);
}
fn remux_cached(dir: &std::path::Path, id: &str) -> Option<(std::path::PathBuf, u64)> {
    if !remux_id_ok(id) { return None; }                                                    
    let p = dir.join(format!("{id}.m4a"));
    let m = std::fs::metadata(&p).ok()?;
    if !remux_fresh(m.modified().ok()?, std::time::SystemTime::now()) { return None; }
    Some((p, m.len()))
}
                                                                                          
                                                                                                
fn remux_window(want: RangeReq, size: u64) -> Option<(u64, u64)> {
    match want {
        RangeReq::None => None,
        RangeReq::From(a, b) => {
            if let Some(b) = b { if b < a { return None; } }                                      
            if a >= size { return Some((0, 0)); }                                           
            let ask = b.map(|b| b - a + 1).unwrap_or(REMUX_WIN);
            Some((a, ask.min(REMUX_WIN).min(size - a)))
        }
        RangeReq::Suffix(n) => {
            if n == 0 || size == 0 { return Some((0, 0)); }                          
            let n = n.min(REMUX_WIN).min(size);
            Some((size - n, n))
        }
    }
}
                                                                                     
fn pick_evictions(mut files: Vec<(std::path::PathBuf, u64, std::time::SystemTime)>, cap: u64) -> Vec<std::path::PathBuf> {
    files.sort_by_key(|f| f.2);
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    let mut out = Vec::new();
    for (p, len, _) in files {
        if total <= cap { break; }
        total -= len;
        out.push(p);
    }
    out
}
fn remux_cache_evict(dir: &std::path::Path) { remux_cache_evict_at(dir, std::time::SystemTime::now()); }
                                                                                              
                                                                                                
                                                          
fn remux_cache_evict_at(dir: &std::path::Path, now: std::time::SystemTime) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
                                                                                               
                                                                                              
                                                                                          
    let stale = now - std::time::Duration::from_secs(3600);
    let mut files = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        let name = p.file_name().and_then(|x| x.to_str()).unwrap_or("");
        let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
        if !remux_id_ok(name.split('.').next().unwrap_or("")) { continue; }
        let Ok(m) = e.metadata() else { continue };
        let Ok(mt) = m.modified() else { continue };
        if ext == "part" && mt < stale { let _ = std::fs::remove_file(&p); continue; }
        if ext == "m4a" {
            if !remux_fresh(mt, now) { let _ = std::fs::remove_file(&p); continue; }
            files.push((p, m.len(), mt));
        }
    }
    for p in pick_evictions(files, REMUX_DIR_MAX) { let _ = std::fs::remove_file(p); }
}
                                                                                          
                                                                                              
                                                                                                
                                                                                                
                                               
async fn serve_remux_file(track: &Track, path: &std::path::Path, size: u64, range: Option<&str>, head: bool) -> Response {
    let want = parse_range(range);
    if size == 0 { return zero_len(want, "audio/mp4"); }
    let Some((start, len)) = remux_window(want, size) else {
        if head { return head_only(RangeReq::None, size, "audio/mp4", false); }
        let Ok(f) = tokio::fs::File::open(path).await else { return empty_len0(502, None) };
        use tokio::io::AsyncReadExt;
        let started = std::time::Instant::now();
        let tr = track.clone();
        let s = futures::stream::try_unfold((f, tr, started), |(mut f, tr, started)| async move {
            if started.elapsed() > STREAM_RANGELESS_TOTAL { return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "body deadline")); }
            let mut buf = vec![0u8; 256 * 1024];
            match tokio::time::timeout(STREAM_IDLE, f.read(&mut buf)).await {
                Err(_) => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "stalled")),
                Ok(Err(_)) => Err(std::io::Error::other("read")),
                Ok(Ok(0)) => Ok(None),
                Ok(Ok(n)) => { tr(n as i64); buf.truncate(n); Ok(Some((axum::body::Bytes::from(buf), (f, tr, started)))) }
            }
        });
        return base(200, "audio/mp4").header("content-length", size).body(axum::body::Body::from_stream(s)).unwrap();
    };
    if len == 0 { return serve_window(want, size, 0, &[], "audio/mp4", false, head); }                
    let mut f = match std::fs::File::open(path) { Ok(f) => f, Err(_) => return empty_len0(502, None) };
    use std::io::{Read, Seek, SeekFrom};
    let mut buf = vec![0u8; len as usize];
    if f.seek(SeekFrom::Start(start)).and_then(|_| f.read_exact(&mut buf)).is_err() { return empty_len0(502, None); }
    if !head { track(buf.len() as i64); }
    serve_window(want, size, start, &buf, "audio/mp4", false, head)
}
                                                                                            
                                                                                             
                                                                                                 
                                                                                 
                                                                                            
                           
fn remux_id_ok(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
                                                                                           
                                                                                          
static REMUX_DIR_LOCK: std::sync::LazyLock<Mutex<HashMap<std::path::PathBuf, std::fs::File>>> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
                                                                                          
                                                                                             
                                                                                
                                                                                      
fn remux_dir_claim(dir: &std::path::Path) -> Option<std::fs::File> {
    let f = std::fs::OpenOptions::new().read(true).write(true).create(true).open(dir.join("amp-remux.lock")).ok()?;
    use std::os::unix::io::AsRawFd;
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 { return None; }                                             
    Some(f)
}
                                                                                             
                                                                                          
static REMUX_DISK: Mutex<u64> = Mutex::new(0);
static REMUX_DISK_FULL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
struct DiskReserve;
impl Drop for DiskReserve { fn drop(&mut self) { let mut g = REMUX_DISK.lock().unwrap(); *g = g.saturating_sub(REMUX_JOB_RESERVE); } }
                                                                                              
                                                                                            
                                           
#[cfg(test)]
thread_local! { static TEST_FS_STATS: std::cell::Cell<Option<(u64, u64)>> = const { std::cell::Cell::new(None) }; }
fn remux_fs_stats(dir: &std::path::Path) -> Option<(u64, u64)> {
    #[cfg(test)]
    if let Some(x) = TEST_FS_STATS.with(|o| o.get()) { return Some(x); }
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 { return None; }                 
    let fr = (st.f_frsize as u64).max(1);
    Some((st.f_bavail as u64 * fr, st.f_blocks as u64 * fr))
}
fn remux_dir_bytes(dir: &std::path::Path) -> Option<u64> {
    match std::fs::read_dir(dir) {
        Ok(rd) => {
            let mut n: u64 = 0;
            for e in rd.flatten() { if let Ok(m) = e.metadata() { if m.is_file() { n = n.saturating_add(m.len()); } } }
            Some(n)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(0),                          
        Err(_) => None,                 
    }
}
                                                                                      
                                                                                              
                                                                                          
                                                                                      
                                                                                              
                                                                                            
                                                
fn remux_admit(dir_bytes: u64, reserved: u64, free: u64, total: u64) -> Result<(), &'static str> {
    if total == 0 { return Err("disk accounting"); }
    let want = reserved.saturating_add(REMUX_JOB_RESERVE);
    if dir_bytes.saturating_add(want) > REMUX_DIR_MAX { return Err("cache full"); }
    let free_after = free.saturating_sub(want);
    let used_after = total.saturating_sub(free_after);
    if free_after < REMUX_FS_FREE_MIN || used_after as f64 > total as f64 * REMUX_FS_USED_MAX { return Err("disk"); }
    Ok(())
}
fn remux_disk_refuse(e: &'static str) -> Result<(std::path::PathBuf, u64), &'static str> {
    REMUX_DISK_FULL.store(true, std::sync::atomic::Ordering::Relaxed);
    Err(e)
}
                                                                                          
                                                                                           
                                                                                    
                                                                                              
async fn remux_job(st: &Arc<AppState>, id: &str) -> Result<(std::path::PathBuf, u64), &'static str> {
    let dir = st.data_dir.join("amp-remux");
    std::fs::create_dir_all(&dir).map_err(|_| "cache dir")?;
    if let Some(hit) = remux_cached(&dir, id) { return Ok(hit); }                                  
    if REMUX_FAIL.lock().unwrap().as_ref().is_some_and(|m| m.get(id).is_some_and(|t| t.elapsed() < Duration::from_secs(60))) { return Err("recent failure"); }
                                                                                            
                                           
    {
                                                                                               
                                                                                  
        let mut g = REMUX_DIR_LOCK.lock().unwrap();
        if !g.contains_key(&dir) {
            match remux_dir_claim(&dir) {
                Some(f) => { g.insert(dir.clone(), f); }
                None => return remux_disk_refuse("cache dir owned elsewhere"),
            }
        }
    }
    remux_cache_evict(&dir);                                                      
                                                                                         
                                                                                         
    let (free, total) = match remux_fs_stats(&dir) { Some(x) => x, None => return remux_disk_refuse("disk") };
    let dir_bytes = match remux_dir_bytes(&dir) { Some(x) => x, None => return remux_disk_refuse("disk") };
    let _reserve = {
        let mut g = REMUX_DISK.lock().unwrap();
        match remux_admit(dir_bytes, *g, free, total) {
            Ok(()) => { *g += REMUX_JOB_RESERVE; DiskReserve }
            Err(e) => return remux_disk_refuse(e),
        }
    };
                                                                                              
                                                                                           
    let Ok(_p) = REMUX_PERMITS.try_acquire() else { return Err("busy") };
    let r = remux_track_inner(st, &dir, id).await;
    if r.is_ok() { REMUX_DISK_FULL.store(false, std::sync::atomic::Ordering::Relaxed); }                            
    if r.is_err() {
        let mut g = REMUX_FAIL.lock().unwrap();
        let m = g.get_or_insert_with(HashMap::new);
        if m.len() >= 256 { m.clear(); }
        m.insert(id.to_string(), std::time::Instant::now());
    }
    r
}
                                                                                            
                                                                                       
#[derive(Debug, PartialEq, Eq)]
enum DlNext { Stream, RetryPlain, Fail }
fn dl_next(code: u16, ranged: bool) -> DlNext {
    if code == 200 || code == 206 { DlNext::Stream }
    else if code == 416 && ranged { DlNext::RetryPlain }
    else { DlNext::Fail }
}
                                                                         
fn content_range_total(v: Option<&reqwest::header::HeaderValue>) -> Option<u64> {
    let s = v?.to_str().ok()?;
    s.rsplit('/').next()?.parse().ok()
}
                                                                                             
                                                                                              
                                                                                          
                                                    
fn ffmpeg_missing(code: Option<i32>, stderr: &[u8]) -> bool {
    if code == Some(127) { return true; }
    let s = String::from_utf8_lossy(stderr);
    s.contains("ffmpeg") && s.contains("No such file")
}
                                                                                            
                                                                                             
                                                                                               
                                                                                            
                                                                                              
pub(crate) fn remux_prefetch(st: &Arc<AppState>, id: &str) {
    if !remux_enabled() || !remux_id_ok(id) || FFMPEG_MISSING.load(std::sync::atomic::Ordering::Relaxed) { return; }                                
    let dir = st.data_dir.join("amp-remux");
    if remux_cached(&dir, id).is_some() { return; }
    if REMUX_FAIL.lock().unwrap().as_ref().is_some_and(|m| m.get(id).is_some_and(|t| t.elapsed() < Duration::from_secs(60))) { return; }
    let cell = remux_cell(id);
                                                                                            
                                                                                               
    let Ok(g) = cell.try_lock_owned() else { return };                                                     
    let st = st.clone();
    let id = id.to_string();
    tokio::spawn(async move {
        let _cell_held = g;                                                         
        let _ = remux_job(&st, &id).await;
    });
}
                                                                                           
                                                                                               
struct PartGuard { src: std::path::PathBuf, out: std::path::PathBuf }
impl Drop for PartGuard {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.src); let _ = std::fs::remove_file(&self.out); }
}
async fn remux_track_inner(st: &Arc<AppState>, dir: &std::path::Path, id: &str) -> Result<(std::path::PathBuf, u64), &'static str> {
    let guard = PartGuard { src: dir.join(format!("{id}.src.part")), out: dir.join(format!("{id}.out.part")) };
    let (src, out) = (guard.src.clone(), guard.out.clone());
    let fin = dir.join(format!("{id}.m4a"));
    let u = yt_audio_url(st, id, false).await.map_err(|()| "resolve")?;
    let dl = async {
                                                                                                
                                                                                                
                                                                                               
                                                                                             
        let ua = ("user-agent", YT_UA.to_string());
        let mut ranged = true;
        let mut r = match guarded_open(st, reqwest::Method::GET, &u, &[ua.clone(), ("range", "bytes=0-".to_string())], None, REQWEST_NO_TOTAL).await { Ok(r) => r, Err(e) => return Err(e) };
        loop {
            match dl_next(r.status().as_u16(), ranged) {
                DlNext::Stream => {
                                                                                    
                    let total = if r.status().as_u16() == 206 { content_range_total(r.headers().get("content-range")) } else { r.content_length() };
                    if total.is_some_and(|t| t > REMUX_OBJ_MAX) { return Err("too big"); }
                    break;
                }
                DlNext::RetryPlain => {
                    ranged = false;
                    r = match guarded_open(st, reqwest::Method::GET, &u, std::slice::from_ref(&ua), None, REQWEST_NO_TOTAL).await { Ok(r) => r, Err(e) => return Err(e) };
                }
                DlNext::Fail => return Err("upstream status"),
            }
        }
        let mut f = std::fs::File::create(&src).map_err(|_| "cache write")?;
        let mut s = r.bytes_stream();
        let mut n: u64 = 0;
        use std::io::Write;
        while let Some(c) = s.next().await {
            let c = c.map_err(|_| "upstream read")?;
            n += c.len() as u64;
            if n > REMUX_OBJ_MAX { return Err("too big"); }                                     
            f.write_all(&c).map_err(|_| "cache write")?;
        }
        Ok(n)
    };
    let n = match tokio::time::timeout(REMUX_DL_TOTAL, dl).await { Ok(Ok(n)) => n, _ => return Err("download") };
    if n == 0 { return Err("empty"); }
    let mut cmd = tokio::process::Command::new("nice");
    cmd.args(["-n", "10", "ffmpeg", "-v", "error", "-y", "-i"]).arg(&src)
        .args(["-c", "copy", "-movflags", "+faststart", "-f", "mp4"]).arg(&out).kill_on_drop(true);
                                                                                                
                                                                                       
                                                           
    unsafe { cmd.pre_exec(|| {
        let lim = libc::rlimit { rlim_cur: REMUX_OUT_LIMIT, rlim_max: REMUX_OUT_LIMIT };
        if libc::setrlimit(libc::RLIMIT_FSIZE, &lim) != 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
    }); }
    match tokio::time::timeout(REMUX_FF_TOTAL, cmd.output()).await {
        Ok(Ok(o)) if o.status.success() => {}
                                                                                            
                                                                                
        Ok(Ok(o)) if ffmpeg_missing(o.status.code(), &o.stderr) => {
            FFMPEG_MISSING.store(true, std::sync::atomic::Ordering::Relaxed);
            return Err("ffmpeg missing");
        }
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                                                                                               
                                                                                            
            FFMPEG_MISSING.store(true, std::sync::atomic::Ordering::Relaxed);
            return Err("ffmpeg missing");
        }
        _ => return Err("ffmpeg"),
    }
    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    if size == 0 || size > REMUX_OBJ_MAX { return Err("too big"); }
    std::fs::rename(&out, &fin).map_err(|_| "rename")?;
    let _ = std::fs::remove_file(&src);
    remux_cache_evict(dir);
    Ok((fin, size))
}
async fn stream_yt(st: &Arc<AppState>, track: &Track, id: &str, range: Option<&str>, head: bool) -> Response {
                                                                                             
                                                                                             
                                                                                           
    if !remux_id_ok(id) { return json_err(StatusCode::BAD_REQUEST, "bad id"); }
                                                                                                          
    if !remux_enabled() || FFMPEG_MISSING.load(std::sync::atomic::Ordering::Relaxed) { return stream_yt_blocks(st, track, id, range, head).await; }
    let dir = st.data_dir.join("amp-remux");
    if let Some((path, size)) = remux_cached(&dir, id) { return serve_remux_file(track, &path, size, range, head).await; }
    if head {
                                                                                              
                                                                                           
                                                                                            
                                                                                       
        remux_prefetch(st, id);
        return Response::builder().status(503).header("retry-after", "1").header("content-length", "0").header("accept-ranges", "bytes").body(axum::body::Body::empty()).unwrap();
    }
                                                                                            
                                                                                              
                                                                                            
                                                                                        
    remux_prefetch(st, id);
    let cell = remux_cell(id);
    {
        let _g = cell.lock().await;                                                          
    }
    if let Some((path, size)) = remux_cached(&dir, id) { return serve_remux_file(track, &path, size, range, head).await; }
                                                                                         
                                                                                   
    if FFMPEG_MISSING.load(std::sync::atomic::Ordering::Relaxed) || REMUX_DISK_FULL.load(std::sync::atomic::Ordering::Relaxed) { return stream_yt_blocks(st, track, id, range, head).await; }
    if REMUX_FAIL.lock().unwrap().as_ref().is_some_and(|m| m.get(id).is_some_and(|t| t.elapsed() < Duration::from_secs(60))) { return empty_len0(502, None); }
                                                                                               
    Response::builder().status(503).header("retry-after", "1").header("content-length", "0").header("accept-ranges", "bytes").body(axum::body::Body::empty()).unwrap()
}

                                                 
const YT_BLOCK: u64 = 1 << 20;
static YT_AUDIO: Mutex<Vec<(String, String, std::time::Instant)>> = Mutex::new(Vec::new());
static SC_MEDIA: Mutex<Vec<(String, String, std::time::Instant)>> = Mutex::new(Vec::new());
fn cache_get(c: &Mutex<Vec<(String, String, std::time::Instant)>>, k: &str) -> Option<String> {
    c.lock().unwrap().iter().find(|(kk, _, t)| kk == k && *t > std::time::Instant::now()).map(|(_, v, _)| v.clone())
}
fn cache_put(c: &Mutex<Vec<(String, String, std::time::Instant)>>, k: &str, v: String, ttl: Duration, cap: usize) {
    let mut g = c.lock().unwrap();
    g.retain(|(kk, _, _)| kk != k);
    g.push((k.to_string(), v, std::time::Instant::now() + ttl));
    if g.len() > cap { g.remove(0); }
}
                                                                                              
                                                                                               
                                             
const YTDLP_MAX_OUT: usize = 32 * 1024 * 1024;
                                                                                                                   
                                                                                                                      
pub async fn run_capped(mut cmd: tokio::process::Command, cap: usize, total: Duration) -> Result<Vec<u8>, ()> {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|_| ())?;
    let Some(mut out) = child.stdout.take() else { let _ = child.start_kill(); return Err(()) };
    let read = tokio::time::timeout(total, async {
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let n = out.read(&mut chunk).await.map_err(|_| ())?;
            if n == 0 { return Ok(buf); }
            if buf.len() + n > cap { return Err(()); }
            buf.extend_from_slice(&chunk[..n]);
        }
    }).await;
    match read {
        Ok(Ok(buf)) => match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(Ok(s)) if s.success() => Ok(buf),
            _ => { let _ = child.start_kill(); let _ = child.wait().await; Err(()) }
        },
        _ => { let _ = child.start_kill(); let _ = child.wait().await; Err(()) }
    }
}
async fn yt_audio_resolve(st: &Arc<AppState>, id: &str) -> Result<String, ()> {
    if st.proxy_url.is_empty() { return Err(()); }                                             
    let _slots = crate::apps::jetstream_up::ytdlp_take(&crate::apps::jetstream_up::YTDLP_LANE_AMP).await?;                                     
    let mut cmd = tokio::process::Command::new(&st.ytdlp);
    cmd.args(["--no-playlist", "--no-warnings", "--skip-download", "-j", &format!("https://www.youtube.com/watch?v={id}")]);
    cmd.args(["--proxy", &st.proxy_url]);
    let out = run_capped(cmd, YTDLP_MAX_OUT, Duration::from_secs(30)).await?;
    let d: Value = serde_json::from_slice(&out).map_err(|_| ())?;
    let mut a: Vec<&Value> = d["formats"].as_array().map(|f| f.iter().filter(|f| {
        f["url"].as_str().is_some_and(|u| !u.is_empty()) && f["protocol"] == "https"
        && (f["vcodec"].is_null() || f["vcodec"] == "none" || f["vcodec"] == "")
        && (f["ext"] == "m4a" || f["acodec"].as_str().unwrap_or("").starts_with("mp4a"))
    }).collect()).unwrap_or_default();
    a.sort_by(|x, y| y["abr"].as_f64().unwrap_or(0.0).partial_cmp(&x["abr"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
    a.first().and_then(|f| f["url"].as_str()).map(String::from).ok_or(())
}
type YtJob = futures::future::Shared<futures::future::BoxFuture<'static, Result<String, ()>>>;
static YT_INFLIGHT: Mutex<Option<HashMap<String, YtJob>>> = Mutex::new(None);
static YT_FAIL: Mutex<Option<HashMap<String, std::time::Instant>>> = Mutex::new(None);                                                  
                                                                                         
                                                                                          
                                                                     
async fn yt_audio_url(st: &Arc<AppState>, id: &str, force: bool) -> Result<String, ()> {
    if !force { if let Some(u) = cache_get(&YT_AUDIO, id) { return Ok(u); } }
                                                                                          
                                                                                                 
    if YT_FAIL.lock().unwrap().as_ref().is_some_and(|m| m.get(id).is_some_and(|t| t.elapsed() < Duration::from_secs(45))) { return Err(()); }
    use futures::FutureExt;
    let job = {
        let mut g = YT_INFLIGHT.lock().unwrap();
        let m = g.get_or_insert_with(HashMap::new);
        if let Some(j) = m.get(id) { j.clone() } else {
            let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, ()>>();
            let (st2, id2) = (st.clone(), id.to_string());
            tokio::spawn(async move {
                let r = yt_audio_resolve(&st2, &id2).await;
                if let Ok(u) = &r { cache_put(&YT_AUDIO, &id2, u.clone(), Duration::from_secs(600), 200); }
                {
                    let mut g = YT_FAIL.lock().unwrap();
                    let m = g.get_or_insert_with(HashMap::new);
                    if r.is_err() { if m.len() >= 512 { m.clear(); } m.insert(id2.clone(), std::time::Instant::now()); } else { m.remove(&id2); }
                }
                if let Some(m) = YT_INFLIGHT.lock().unwrap().as_mut() { m.remove(&id2); }
                let _ = tx.send(r);
            });
            let j = rx.map(|r| r.unwrap_or(Err(()))).boxed().shared();
            m.insert(id.to_string(), j.clone());
            j
        }
    };
    job.await
}
                                                                        
pub const YT_CACHE_MAX: usize = 64 * 1024 * 1024;
#[derive(Default)]
struct BlockCache { map: HashMap<(String, u64, u64), (Arc<Vec<u8>>, u64)>, bytes: usize, tick: u64 }
static YT_BLOCKS: Mutex<Option<BlockCache>> = Mutex::new(None);
fn bc<R>(f: impl FnOnce(&mut BlockCache) -> R) -> R {
    let mut g = YT_BLOCKS.lock().unwrap();
    f(g.get_or_insert_with(BlockCache::default))
}
                                                                                                              
                                                                                                      
pub fn cache_block_get(id: &str, gen: u64, idx: u64) -> Option<Arc<Vec<u8>>> {
    bc(|c| { c.tick += 1; let t = c.tick; c.map.get_mut(&(id.to_string(), gen, idx)).map(|e| { e.1 = t; e.0.clone() }) })
}
pub fn cache_block_put(id: &str, gen: u64, idx: u64, b: Arc<Vec<u8>>, max: usize) {
    bc(|c| {
        c.tick += 1; let t = c.tick;
        if let Some(old) = c.map.insert((id.to_string(), gen, idx), (b.clone(), t)) { c.bytes -= old.0.len(); }
        c.bytes += b.len();
        while c.bytes > max {
            let Some(k) = c.map.iter().filter(|(k, _)| !(k.0 == id && k.1 == gen && k.2 == idx)).min_by_key(|(_, v)| v.1).map(|(k, _)| k.clone()) else { break };
            if let Some(v) = c.map.remove(&k) { c.bytes -= v.0.len(); }
        }
    })
}
pub fn cache_bytes() -> usize { bc(|c| c.bytes) }
fn cache_drop_track(id: &str, gen: u64) { bc(|c| { let ks: Vec<_> = c.map.keys().filter(|k| k.0 == id && k.1 == gen).cloned().collect(); for k in ks { if let Some(v) = c.map.remove(&k) { c.bytes -= v.0.len(); } } }) }

#[derive(Default)]
pub struct YtTrack { gen: u64, total: u64, failed_at: Option<std::time::Instant> }
                                                                                                                 
                                                                                                               
pub const YT_FAIL_TTL: Option<Duration> = Some(Duration::from_secs(60));
pub fn fail_active(at: Option<std::time::Instant>, ttl: Option<Duration>, now: std::time::Instant) -> bool {
    at.is_some_and(|a| ttl.map_or(true, |t| now.saturating_duration_since(a) < t))
}
static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static LOOKAHEAD: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);                                     
static AMP_STREAMS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);                                                                       
type TrackCell = Arc<tokio::sync::Mutex<YtTrack>>;
static YT_TRACKS: Mutex<Vec<(String, TrackCell, std::time::Instant)>> = Mutex::new(Vec::new());
fn yt_track(id: &str) -> TrackCell {
    let mut g = YT_TRACKS.lock().unwrap();
    let now = std::time::Instant::now();
    if let Some(e) = g.iter_mut().find(|(k, _, _)| k == id) { e.2 = now; return e.1.clone(); }
    let c: TrackCell = Arc::new(tokio::sync::Mutex::new(YtTrack { gen: GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed), ..Default::default() }));
    g.push((id.to_string(), c.clone(), now));
    if g.len() > 12 { let i = g.iter().enumerate().min_by_key(|(_, e)| e.2).map(|(i, _)| i).unwrap(); let (old, cell, _) = g.remove(i); drop(g); let gen = cell.try_lock().map(|t| t.gen).ok(); if let Some(gen) = gen { cache_drop_track(&old, gen); } }
    c
}
                                                                                                          
                                                                                       
async fn yt_block(st: &Arc<AppState>, id: &str, idx: u64) -> Result<(Arc<Vec<u8>>, u64), ()> {
    let cell = yt_track(id);
    let mut t = cell.lock().await;
    if let Some(b) = cache_block_get(id, t.gen, idx) { if t.total > 0 || idx > 0 { return Ok((b, t.total)); } }
    if fail_active(t.failed_at, YT_FAIL_TTL, std::time::Instant::now()) { return Err(()); }
    t.failed_at = None;                                             
    let start = idx * YT_BLOCK;
    let mut buf = None;
    for attempt in 0..2 {
        let Ok(u) = yt_audio_url(st, id, attempt > 0).await else { break };
        let end = if t.total > 0 { (start + YT_BLOCK).min(t.total) - 1 } else { start + YT_BLOCK - 1 };
        let hdrs = [("user-agent", YT_UA.to_string()), ("range", format!("bytes={start}-{end}"))];
        let Ok(r) = guarded_open(st, reqwest::Method::GET, &u, &hdrs, None, STREAM_TOTAL).await else { continue };
        if r.status().as_u16() != 200 && r.status().as_u16() != 206 { continue; }
        let cr = r.headers().get("content-range").and_then(|v| v.to_str().ok()).and_then(|v| v.rsplit('/').next()).and_then(|v| v.parse::<u64>().ok());
        let Ok(b) = tokio::time::timeout(STREAM_TOTAL, read_capped(r, YT_BLOCK as usize)).await.unwrap_or(Err("t")) else { continue };
        if let Some(c) = cr { t.total = c; }
        buf = Some(b); break;
    }
    match buf {
        None => { t.failed_at = Some(std::time::Instant::now()); Err(()) }
        Some(b) => { let a = Arc::new(b); cache_block_put(id, t.gen, idx, a.clone(), YT_CACHE_MAX); Ok((a, t.total)) }
    }
}
                                                                                              
                                                                                                
                                                                                              
                                                                                          
                                                                                                
                                                                                           
                                                                             
pub fn block_walk<F, Fut>(total: u64, first: Arc<Vec<u8>>, fetch: F, track: Track) -> axum::body::Body
where
    F: Fn(u64) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<Arc<Vec<u8>>, ()>> + Send + 'static,
{
    let last = (total - 1) / YT_BLOCK;                                 
    let fetch = Arc::new(fetch);
    let started = std::time::Instant::now();
    let s = futures::stream::try_unfold((0u64, Some(first)), move |(idx, pending)| {
        let (fetch, track) = (fetch.clone(), track.clone());
        async move {
            if idx > last { return Ok(None); }
            if started.elapsed() > STREAM_RANGELESS_TOTAL { return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "body deadline")); }                      
            let blk = match pending {
                Some(b) => b,
                None => fetch(idx).await.map_err(|()| std::io::Error::other("block fetch"))?,
            };
                                                                                                
                                                                                            
                                                                                                   
            let n = ((total - idx * YT_BLOCK).min(blk.len() as u64)) as usize;
            track(n as i64);
            Ok(Some((axum::body::Bytes::copy_from_slice(&blk[..n]), (idx + 1, None))))
        }
    });
    axum::body::Body::from_stream(s)
}
                                                                                               
                                                                                           
                                                                                             
                                                                                                
pub fn block_window<F, Fut>(start: u64, len: u64, fetch: F, track: Track) -> axum::body::Body
where
    F: Fn(u64) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<Arc<Vec<u8>>, ()>> + Send + 'static,
{
    let fetch = Arc::new(fetch);
    let started = std::time::Instant::now();
    let s = futures::stream::try_unfold(0u64, move |sent| {
        let (fetch, track) = (fetch.clone(), track.clone());
        async move {
            if sent >= len { return Ok(None); }
            if started.elapsed() > STREAM_RANGELESS_TOTAL { return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "body deadline")); }
            let pos = start + sent;
            let blk = fetch(pos / YT_BLOCK).await.map_err(|()| std::io::Error::other("block fetch"))?;
            let off = (pos % YT_BLOCK) as usize;
            if off >= blk.len() { return Err(std::io::Error::other("short block")); }                                        
            let n = ((len - sent) as usize).min(blk.len() - off);
            track(n as i64);
            Ok(Some((axum::body::Bytes::copy_from_slice(&blk[off..off + n]), sent + n as u64)))
        }
    });
    axum::body::Body::from_stream(s)
}
                                                                                              
                                                           
async fn stream_yt_blocks(st: &Arc<AppState>, track: &Track, id: &str, range: Option<&str>, head: bool) -> Response {
    let want = parse_range(range);
                                                                                                          
    let first = match want { RangeReq::From(a, _) => a / YT_BLOCK, _ => 0 };
    let Ok((b0, total0)) = yt_block(st, id, first).await else { return empty_len0(503, None) };
    let total = if total0 > 0 { total0 } else { first * YT_BLOCK + b0.len() as u64 };
                                                                                           
                                                                                             
                                                                                            
                                                                           
    if want == RangeReq::None && total > 0 {
        if head { return head_only(RangeReq::None, total, "audio/mp4", false); }
        let (st2, id2) = (st.clone(), id.to_string());
        let fetch = move |idx: u64| { let (st, id) = (st2.clone(), id2.clone()); async move { yt_block(&st, &id, idx).await.map(|(b, _)| b) } };
        return base(200, "audio/mp4").header("content-length", total).body(block_walk(total, b0, fetch, track.clone())).unwrap();
    }
                                                                                               
                                                                                            
                                                                                                
                                                                                
    if let RangeReq::From(a, None) = want {
        if a >= total { return unsatisfiable(total); }
        let en = a.saturating_add(YT_BLOCK).min(total) - 1;
        let len = en - a + 1;
        if head { return window_head(a, en, total, true, "audio/mp4").body(axum::body::Body::empty()).unwrap(); }
        let (st2, id2) = (st.clone(), id.to_string());
        let fetch = move |idx: u64| { let (st, id) = (st2.clone(), id2.clone()); async move { yt_block(&st, &id, idx).await.map(|(b, _)| b) } };
        return window_head(a, en, total, true, "audio/mp4").body(block_window(a, len, fetch, track.clone())).unwrap();
    }
    let (st_byte, _) = match resolve_range(want, total) {
        Err(()) => return unsatisfiable(total),
        Ok(Some(x)) => x,
        Ok(None) => (0, 0),
    };
    let idx = st_byte / YT_BLOCK;
    let (block, _) = if idx == first { (b0, total0) } else { match yt_block(st, id, idx).await { Ok(x) => x, Err(()) => return empty_len0(503, None) } };
    let resp = serve_window(want, total, idx * YT_BLOCK, &block, "audio/mp4", true, head);
    if resp.status() == 206 && !head {
        let n = resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
        track(n);
        if block.len() as u64 == YT_BLOCK {                            
            let (st2, id2) = (st.clone(), id.to_string());
            tokio::spawn(async move {
                let Ok(_p) = LOOKAHEAD.try_acquire() else { return };                                                     
                let _ = yt_block(&st2, &id2, idx + 1).await;
            });
        }
    }
    resp
}

async fn sc_stream_url(st: &AppState, id: &str, force: bool) -> Result<String, ()> {
    if !force { if let Some(u) = cache_get(&SC_MEDIA, id) { return Ok(u); } }
    let t = sc_fetch_json(st, &format!("https://api-v2.soundcloud.com/tracks/{id}")).await.map_err(|_| ())?;
    let tcs = t.get("media").get("transcodings").arr();
    let tc = tcs.iter().find(|x| x.get("format").get("protocol").s() == Some("progressive") && x.get("format").get("mime_type").or_empty().contains("mp3"))
        .or_else(|| tcs.iter().find(|x| x.get("format").get("protocol").s() == Some("progressive"))).ok_or(())?;
    let j = sc_fetch_json(st, &tc.get("url").or_empty()).await.map_err(|_| ())?;
    let u = j.get("url").or_empty();
    if u.is_empty() { return Err(()); }
    cache_put(&SC_MEDIA, id, u.clone(), Duration::from_secs(45), 300);
    Ok(u)
}

pub async fn stream(st: &Arc<AppState>, track: &Track, bytes_left: i64, src: &str, id: &str, range: Option<&str>, head: bool) -> Response {
    if let Some(r) = stream_validate(bytes_left, src, id) { return r; }
                                                                                            
    let permit = if head { None } else { match AMP_STREAMS.try_acquire() { Ok(p) => Some(p), Err(_) => return empty_len0(429, None) } };
    let id = super::js_trim(id);
    let r = match src {
        "yt" => stream_yt(st, track, id, range, head).await,
        "sc" => match sc_stream_url(st, id, false).await {
            Err(()) => empty_len0(502, None),
            Ok(u) => {
                let (r, status) = pipe_media(st, track, &u, range, head).await;
                if status == 403 || status == 410 {
                    match sc_stream_url(st, id, true).await {
                        Ok(u2) => pipe_media(st, track, &u2, range, head).await.0,
                        Err(()) => empty_len0(502, None),
                    }
                } else { r }
            }
        },
        _ => pipe_media(st, track, &format!("{AU_HOST}/v1/tracks/{id}/stream?app_name={AU_APP}"), range, head).await.0,
    };
                                                                                                  
                                                                                              
                                                                                                  
                                                                                          
                                     
    match permit { Some(p) => hold_in_body(r, p), None => r }
}
                                                                                           
                                                                                            
fn hold_in_body(r: Response, p: tokio::sync::SemaphorePermit<'static>) -> Response {
    let (parts, body) = r.into_parts();
    let s = futures::stream::try_unfold((body.into_data_stream(), p), |(mut s, p)| async move {
        match s.next().await {
            Some(Ok(b)) => Ok(Some((b, (s, p)))),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    });
    Response::from_parts(parts, axum::body::Body::from_stream(s))
}

#[cfg(test)]
mod r13_tests {
    use super::*;

    #[test]
    fn cr_window_parses_and_rejects() {
        assert_eq!(cr_window("bytes 0-99/1000"), Some((0, 99)));
        assert_eq!(cr_window("bytes 100-611/10000"), Some((100, 611)));
        assert_eq!(cr_window("bytes 9-9/*"), Some((9, 9)));
        assert_eq!(cr_window("bytes 10-9/100"), None, "inverted");
        assert_eq!(cr_window("bytes 0-/100"), None);
        assert_eq!(cr_window("0-99/100"), None, "missing prefix");
        assert_eq!(cr_window("bytes a-b/c"), None);
    }

    #[test]
    fn cr_span_is_checked() {
        assert_eq!(cr_span(0, 0), Some(1));
        assert_eq!(cr_span(5, 9), Some(5));
        assert_eq!(cr_span(u64::MAX, u64::MAX), Some(1));
        assert_eq!(cr_span(0, u64::MAX), None, "b-a+1 overflows - must not wrap to 0");
        assert_eq!(cr_span(9, 5), None, "inverted");
    }

    #[test]
    fn cr_fits_tables() {
        let cap = 1024u64;
                                                                                                      
        assert!(cr_fits(RangeReq::From(100, Some(500)), 100, 500, cap));
        assert!(!cr_fits(RangeReq::From(100, Some(500)), 100, 501, cap));
        assert!(!cr_fits(RangeReq::From(100, Some(500)), 101, 500, cap));
        assert!(!cr_fits(RangeReq::From(100, Some(500)), 100, 2000, cap));
                                                                  
        assert!(cr_fits(RangeReq::From(100, None), 100, 1123, cap));
        assert!(!cr_fits(RangeReq::From(100, None), 100, 1124, cap));
                                                                       
        assert!(cr_fits(RangeReq::Suffix(100), 900, 999, cap));
        assert!(!cr_fits(RangeReq::Suffix(100), 899, 999, cap));
        assert!(cr_fits(RangeReq::Suffix(0), 5, 5, cap));
        assert!(cr_fits(RangeReq::Suffix(99999), 0, 1023, cap));
        assert!(!cr_fits(RangeReq::Suffix(99999), 0, 1024, cap));
                                                          
        assert!(cr_fits(RangeReq::None, 0, 1023, cap));
        assert!(!cr_fits(RangeReq::None, 1, 100, cap));
        assert!(!cr_fits(RangeReq::None, 0, 1024, cap));
                                              
        assert!(!cr_fits(RangeReq::None, 9, 5, cap));
    }

    fn blk(n: usize, fill: u8) -> Arc<Vec<u8>> { Arc::new(vec![fill; n]) }

                                                                                              
                                                                                    
    #[tokio::test]
    async fn block_walk_streams_the_whole_object_lazily() {
        let total = 2 * YT_BLOCK + 17;
        let calls = Arc::new(Mutex::new(Vec::new()));
        let billed = Arc::new(Mutex::new(0i64));
        let (c2, b2) = (calls.clone(), billed.clone());
        let fetch = move |idx: u64| {
            let c2 = c2.clone();
            async move { c2.lock().unwrap().push(idx); Ok(blk(YT_BLOCK as usize, idx as u8 + 1)) }
        };
        let track: Track = Arc::new(move |n| *b2.lock().unwrap() += n);
        let body = block_walk(total, blk(YT_BLOCK as usize, 0), fetch, track);
        let got = axum::body::to_bytes(body, (4 * YT_BLOCK) as usize).await.unwrap();
        assert_eq!(got.len() as u64, total, "body length == Content-Length total");
        assert_eq!(&got[..4], &[0u8; 4]);
        assert_eq!(&got[YT_BLOCK as usize..YT_BLOCK as usize + 4], &[2u8; 4], "fetch fills block idx with idx+1");
        assert_eq!(&got[2 * YT_BLOCK as usize..], &[3u8; 17], "last block clamped to the total remainder");
        assert_eq!(*calls.lock().unwrap(), vec![1, 2], "block 0 comes from the caller; the rest lazy, in order");
        assert_eq!(*billed.lock().unwrap(), total as i64, "billed exactly the delivered bytes");
    }

                                                                                                 
                                                                                       
    #[tokio::test]
    async fn rangeless_full_body_bills_per_chunk_and_head_is_empty() {
        let chunks: Vec<Vec<u8>> = vec![vec![1u8; 100], vec![2u8; 50], vec![3u8; 7]];
        let total = chunks.iter().map(|c| c.len() as u64).sum::<u64>();
        let mut want = Vec::new();
        for c in &chunks { want.extend_from_slice(c); }
                                                                                                      
        let mk = move || {
            let s = futures::stream::iter(chunks.clone().into_iter().map(|c| Ok::<_, std::io::Error>(axum::body::Bytes::from(c))));
            let r: reqwest::Response = Response::builder().status(200).body(reqwest::Body::wrap_stream(s)).unwrap().into();
            r
        };
        let billed = Arc::new(Mutex::new(Vec::new()));
        let b2 = billed.clone();
        let track: Track = Arc::new(move |n| b2.lock().unwrap().push(n));
        let r = rangeless_full_body(mk(), "audio/mpeg", Some(total), &track, false);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()["content-length"].to_str().unwrap(), total.to_string());
        assert_eq!(r.headers()["accept-ranges"].to_str().unwrap(), "bytes");
        assert!(r.headers().get("content-range").is_none());
        let got = axum::body::to_bytes(r.into_body(), 1024).await.unwrap();
        assert_eq!(got.as_ref(), want.as_slice());
        assert_eq!(*billed.lock().unwrap(), vec![100, 50, 7], "billed per chunk as pulled");
        let r = rangeless_full_body(mk(), "audio/mpeg", Some(total), &track, true);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()["content-length"].to_str().unwrap(), total.to_string());
        assert!(axum::body::to_bytes(r.into_body(), 1024).await.unwrap().is_empty(), "HEAD pulls nothing");
    }

                                                                                         
                                                                                                  
    #[tokio::test]
    async fn block_window_serves_from_the_offset_for_the_cap() {
        let (start, len) = (972670u64, YT_BLOCK);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let c2 = calls.clone();
        let fetch = move |idx: u64| { let c2 = c2.clone(); async move { c2.lock().unwrap().push(idx); Ok(blk(YT_BLOCK as usize, idx as u8 + 1)) } };
        let billed = Arc::new(Mutex::new(0i64));
        let b2 = billed.clone();
        let track: Track = Arc::new(move |n| *b2.lock().unwrap() += n);
        let body = block_window(start, len, fetch, track);
        let got = axum::body::to_bytes(body, (4 * YT_BLOCK) as usize).await.unwrap();
        assert_eq!(got.len() as u64, len, "cap length from the offset, not the block remainder");
        let tail = (YT_BLOCK - start) as usize;                                                            
        assert_eq!(&got[..4], &[1u8; 4]);
        assert_eq!(&got[tail..tail + 4], &[2u8; 4]);
        assert_eq!(*calls.lock().unwrap(), vec![0, 1]);
        assert_eq!(*billed.lock().unwrap(), len as i64);
    }

    #[tokio::test]
    async fn block_window_stops_at_len_inside_one_block() {
        let fetch = |_idx: u64| async move { Ok(blk(YT_BLOCK as usize, 9)) };
        let track: Track = Arc::new(|_| ());
        let body = block_window(100, 50, fetch, track);
        let got = axum::body::to_bytes(body, (4 * YT_BLOCK) as usize).await.unwrap();
        assert_eq!(got.as_ref(), &[9u8; 50]);
    }

    #[test]
    fn remux_window_contract() {
        let size = 10 * REMUX_WIN;
        assert_eq!(remux_window(RangeReq::None, size), None);
        assert_eq!(remux_window(RangeReq::From(5, None), size), Some((5, REMUX_WIN)));
        assert_eq!(remux_window(RangeReq::From(size - 10, None), size), Some((size - 10, 10)), "clipped at EOF");
        assert_eq!(remux_window(RangeReq::From(5, Some(19)), size), Some((5, 15)), "bounded: exact ask (b-a+1)");
        assert_eq!(remux_window(RangeReq::From(5, Some(9 * REMUX_WIN)), size), Some((5, REMUX_WIN)), "bounded: clipped to cap");
        assert_eq!(remux_window(RangeReq::From(5, Some(4)), size), None, "inverted: plain 200 (qa_9)");
        assert_eq!(remux_window(RangeReq::From(size, None), size), Some((0, 0)), "OOB: serve_window shapes the 416");
        assert_eq!(remux_window(RangeReq::Suffix(100), size), Some((size - 100, 100)));
        assert_eq!(remux_window(RangeReq::Suffix(99 * REMUX_WIN), size), Some((size - REMUX_WIN, REMUX_WIN)), "suffix clamped to cap");
        assert_eq!(remux_window(RangeReq::Suffix(0), size), Some((0, 0)));
    }

    #[test]
    fn ffmpeg_missing_detects_absent_binary_not_bad_input() {
        assert!(ffmpeg_missing(Some(127), b"nice: ffmpeg: No such file or directory"));
        assert!(ffmpeg_missing(Some(1), b"nice: ffmpeg: No such file or directory"));                        
        assert!(!ffmpeg_missing(Some(1), b"pipe:: moov atom not found"));                                  
        assert!(!ffmpeg_missing(Some(1), b"/x/y.src.part: No such file or directory"));                               
        assert!(!ffmpeg_missing(Some(0), b""));
        assert!(!ffmpeg_missing(None, b""));
    }

                                                                                          
                                                                                             
                                                                                         
    #[tokio::test]
    async fn remux_detach_attach_and_busy_contract() {
        TEST_REMUX_ON.with(|o| o.set(Some(true)));                                                       
        let st = Arc::new(crate::auth_api::devices::tests::fixture("remux-r15e"));
        let id = "detachtest1";
                                                                                                 
                                                                                              
                                  
        TEST_FS_STATS.with(|o| o.set(Some((30 << 30, 100 << 30))));
        remux_prefetch(&st, id);
        remux_prefetch(&st, id);                                                  
        let cell = remux_cell(id);
                                                                                      
        let cancelled = { let c = cell.clone(); tokio::spawn(async move { let _g = c.lock().await; }) };
        cancelled.abort();
                                                                                             
                                                                                           
                                                                                        
        let waiter = { let c = cell.clone(); tokio::spawn(async move { let _g = c.lock().await; }) };
        waiter.await.unwrap();
        assert!(REMUX_FAIL.lock().unwrap().as_ref().is_some_and(|m| m.contains_key(id)), "admitted: detached job completed and cached its controlled inner failure");

                                                                                              
                                                                                      
        let id2 = "detachtest2";
        TEST_FS_STATS.with(|o| o.set(Some((REMUX_FS_FREE_MIN + REMUX_JOB_RESERVE - 1, 100 << 30))));
        remux_prefetch(&st, id2);
        let w2 = { let c = remux_cell(id2); tokio::spawn(async move { let _g = c.lock().await; }) };
        w2.await.unwrap();
        assert!(!REMUX_FAIL.lock().unwrap().as_ref().is_some_and(|m| m.contains_key(id2)), "refusal stays retryable: never negative-cached");
        assert!(REMUX_DISK_FULL.load(std::sync::atomic::Ordering::Relaxed), "refusal reported on the lane flag");
        REMUX_DISK_FULL.store(false, std::sync::atomic::Ordering::Relaxed);                                    
        TEST_FS_STATS.with(|o| o.set(None));

                                                                                               
                                                                                               
                                                                                           
                                                                 
        TEST_FS_STATS.with(|o| o.set(Some((30 << 30, 100 << 30))));
        let _p1 = REMUX_PERMITS.try_acquire().unwrap();
        let _p2 = REMUX_PERMITS.try_acquire().unwrap();
        assert_eq!(remux_job(&st, "busytestzz1").await, Err("busy"));
        TEST_FS_STATS.with(|o| o.set(None));
        assert!(REMUX_FAIL.lock().unwrap().as_ref().map_or(true, |m| !m.contains_key("busytestzz1")), "busy ids must stay retryable");
    }

    #[test]
    fn remux_dl_status_contract() {
        use DlNext::*;
        assert_eq!(dl_next(206, true), Stream);                                  
        assert_eq!(dl_next(200, true), Stream);                                            
        assert_eq!(dl_next(200, false), Stream);
        assert_eq!(dl_next(416, true), RetryPlain);                      
        assert_eq!(dl_next(416, false), Fail);                                          
        assert_eq!(dl_next(403, true), Fail);
        assert_eq!(dl_next(302, true), Fail);                                         
    }

    #[test]
    fn content_range_total_parses_real_headers() {
        let h = reqwest::header::HeaderValue::from_static("bytes 0-3359659/44201597");
        assert_eq!(content_range_total(Some(&h)), Some(44201597));
        assert_eq!(content_range_total(None), None);
        for bad in ["nonsense", "bytes 0-1/", "bytes */*"] {
            assert_eq!(content_range_total(Some(&reqwest::header::HeaderValue::from_static(bad))), None, "{bad}");
        }
    }

                                                                                       
                                                                                     
                                                                                     
                                                                                  
    #[test]
    fn remux_admission_pure_cases() {
        let g = 1u64 << 30;
        let t = 100 * g;
        let free70 = 30 * g;                                                                          
        assert!(remux_admit(0, 0, free70, t).is_ok());
        assert!(remux_admit(0, REMUX_JOB_RESERVE, free70, t).is_ok());                                                             
        assert_eq!(remux_admit(0, 2 * REMUX_JOB_RESERVE, free70, t), Err("cache full"));                                          
                                                                                                        
        let edge = REMUX_DIR_MAX - 2 * REMUX_JOB_RESERVE;                                                        
        assert!(remux_admit(edge, REMUX_JOB_RESERVE, free70, t).is_ok());
        assert_eq!(remux_admit(edge + 1, REMUX_JOB_RESERVE, free70, t), Err("cache full"));
                                                                                      
        assert_eq!(remux_admit(0, 0, REMUX_FS_FREE_MIN + REMUX_JOB_RESERVE - 1, t), Err("disk"));
                                                                                                               
        assert!(remux_admit(0, 0, REMUX_FS_FREE_MIN + REMUX_JOB_RESERVE, 8 * g).is_ok());
                                                                                
        assert_eq!(remux_admit(0, 0, REMUX_FS_FREE_MIN + REMUX_JOB_RESERVE, 10 * g), Err("disk"));
                                                   
        assert_eq!(remux_admit(0, 0, free70, 0), Err("disk accounting"));
    }

                                                                                              
                                                     
    #[test]
    fn remux_boot_clean_sweeps_orphans_and_expired_keeps_the_rest() {
        let d = std::env::temp_dir().join(format!("remux-boot-{}", crate::apps::hex_id(8).unwrap()));
        std::fs::create_dir_all(d.join("amp-remux")).unwrap();                                                         
        for f in ["aa000000000.src.part", "bb111111111.out.part"] { std::fs::write(d.join("amp-remux").join(f), b"x").unwrap(); }
        std::fs::write(d.join("amp-remux").join("cc222222222.m4a"), b"x").unwrap();                       
        std::fs::write(d.join("unrelated.txt"), b"x").unwrap();                                  
        std::fs::write(d.join("amp-remux").join("bad id.m4a"), b"x").unwrap();                                
        TEST_REMUX_ON.with(|o| o.set(Some(true)));                                         
        remux_boot_clean(&d);
        assert!(!d.join("amp-remux").join("aa000000000.src.part").exists() && !d.join("amp-remux").join("bb111111111.out.part").exists());
        assert!(d.join("amp-remux").join("cc222222222.m4a").exists());
        assert!(d.join("unrelated.txt").exists() && d.join("amp-remux").join("bad id.m4a").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

                                                                                                
                                                                      
    #[test]
    fn remux_evict_sweeps_stale_part_and_expired_m4a() {
        let d = std::env::temp_dir().join(format!("remux-evict-{}", crate::apps::hex_id(8).unwrap()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("dd333333333.src.part"), b"x").unwrap();
        std::fs::write(d.join("ee444444444.m4a"), b"x").unwrap();
        std::fs::write(d.join("notes.md"), b"x").unwrap();
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(7 * 3600);                                                
        remux_cache_evict_at(&d, future);
        assert!(!d.join("dd333333333.src.part").exists(), "stale-looking orphan swept");
        assert!(!d.join("ee444444444.m4a").exists(), "expired-looking m4a swept");
        assert!(d.join("notes.md").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

                                                                                               
                                                                                               
    #[tokio::test]
    async fn remux_cell_eviction_never_drops_a_live_cell() {
        let mut guards = Vec::new();
        let mut first = None;
        for i in 0..40 {
            let c = remux_cell(&format!("celltest{i:04}"));
            if i == 0 { first = Some(c.clone()); }
            guards.push(c.try_lock_owned().unwrap());
        }
        assert!(Arc::ptr_eq(&remux_cell("celltest0000"), first.as_ref().unwrap()), "live cell survived past the 32-entry LRU");
        drop(guards);
    }

                                                                                            
                                                                         
                                                                            
                                                                                 
    #[tokio::test]
    async fn remux_cell_eviction_never_drops_an_externally_held_cell() {
        let held = remux_cell("cellhold0000");                                  
        for i in 0..40 { let _ = remux_cell(&format!("cellhold{i:04}x")); }
        assert!(Arc::ptr_eq(&remux_cell("cellhold0000"), &held), "externally-held unlocked cell survived");
        drop(held);
    }

    #[test]
    fn remux_dir_claim_is_single_owner() {
        let d = std::env::temp_dir().join(format!("remux-claim-{}", crate::apps::hex_id(8).unwrap()));
        std::fs::create_dir_all(&d).unwrap();
        let f = remux_dir_claim(&d).expect("first claim");
        assert!(remux_dir_claim(&d).is_none(), "second owner refused");
        drop(f);
        assert!(remux_dir_claim(&d).is_some(), "claim again after release");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn remux_id_ok_matches_the_upstream_charset() {
        assert!(remux_id_ok("w3Xzgj_-ABC"));                                           
        assert!(!remux_id_ok("")); assert!(!remux_id_ok(&"a".repeat(65)));
        for bad in ["a/b", "..", "a b", "a.b", "a\0b"] { assert!(!remux_id_ok(bad), "{bad:?}"); }
    }

    #[test]
    fn remux_fresh_ttl_and_eviction_order() {
        let now = std::time::SystemTime::now();
        assert!(remux_fresh(now, now));
        assert!(!remux_fresh(now - std::time::Duration::from_secs(REMUX_TTL_SECS + 1), now));
        let t = |s: u64| now - std::time::Duration::from_secs(s);
        let f = |n: &str, l: u64, s: u64| (std::path::PathBuf::from(n), l, t(s));
        let files = vec![f("new", 300, 1), f("old", 300, 999), f("mid", 300, 500)];
        assert_eq!(pick_evictions(files, 600), vec![std::path::PathBuf::from("old")], "oldest first, stop once under cap");
        let files = vec![f("a", 300, 1), f("b", 300, 2), f("c", 300, 3)];
        assert_eq!(pick_evictions(files, 0).len(), 3);
        assert!(pick_evictions(vec![f("a", 300, 1)], 600).is_empty());
    }

                                                               
    #[test]
    fn remux_flag_fail_closed_parse() {
        assert!(remux_flag_on(Some("1")));
        for v in [None, Some(""), Some("0"), Some("true"), Some("TRUE"), Some("yes"), Some("on"), Some(" 1"), Some("1 "), Some("11")] { assert!(!remux_flag_on(v), "{v:?}"); }
    }

                                                                                               
                                                                          
    #[test]
    fn remux_off_boot_clean_touches_nothing() {
        TEST_REMUX_ON.with(|o| o.set(Some(false)));
        let d = std::env::temp_dir().join(format!("remux-off-boot-{}", crate::apps::hex_id(8).unwrap()));
        std::fs::create_dir_all(&d).unwrap();
        remux_boot_clean(&d);
        assert!(!d.join("amp-remux").exists(), "off: no dir created, no lock file claimed");
        std::fs::create_dir_all(d.join("amp-remux")).unwrap();
        for f in ["aa000000000.src.part", "bb111111111.out.part", "cc222222222.m4a"] { std::fs::write(d.join("amp-remux").join(f), b"x").unwrap(); }
        remux_boot_clean(&d);
        let mut names: Vec<String> = std::fs::read_dir(d.join("amp-remux")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["aa000000000.src.part", "bb111111111.out.part", "cc222222222.m4a"], "off: planted files survive boot, no lock file added");
        TEST_REMUX_ON.with(|o| o.set(None));
        let _ = std::fs::remove_dir_all(&d);
    }

                                                                                           
                                                                                           
                                                                                                        
    #[tokio::test]
    async fn remux_off_stream_yt_is_legacy_and_inert() {
        TEST_REMUX_ON.with(|o| o.set(Some(false)));
        let st = Arc::new(crate::auth_api::devices::tests::fixture("remux-r18off"));
        let id = "offtest0001";
        let dir = st.data_dir.join("amp-remux");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.m4a")), vec![7u8; 4096]).unwrap();                                          
        let track: Track = Arc::new(|_| {});
        let before = std::fs::read_dir(&dir).unwrap().count();
        for head in [true, false] {
            let r = stream_yt(&st, &track, id, None, head).await;
            assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE, "legacy blocks route (no upstream in fixture), head={head}; never the cached remux 200");
        }
        let r = stream_yt(&st, &track, id, Some("bytes=0-99"), false).await;
        assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE, "ranged GET also legacy, not the cached file");
        tokio::task::yield_now().await;
        assert!(!REMUX_CELLS.lock().unwrap().iter().any(|(k, _, _)| k == id), "no detached job claimed a cell");
        assert!(!REMUX_FAIL.lock().unwrap().as_ref().is_some_and(|m| m.contains_key(id)), "no job ran to a negative-cache entry");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), before, "no .part/.m4a/lock written");
        assert_eq!(std::fs::read(dir.join(format!("{id}.m4a"))).unwrap(), vec![7u8; 4096], "planted file untouched");
        assert!(!FFMPEG_MISSING.load(std::sync::atomic::Ordering::Relaxed), "ffmpeg never probed by the lane");
        TEST_REMUX_ON.with(|o| o.set(None));
    }

                                                                                               
    #[tokio::test]
    async fn serve_remux_file_ranges_and_full_body() {
        let size: u64 = 6 * YT_BLOCK + 123;
        let dir = std::env::temp_dir().join(format!("remux-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.m4a");
        let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &data).unwrap();
        let billed = Arc::new(Mutex::new(0i64));
        let b2 = billed.clone();
        let track: Track = Arc::new(move |n| *b2.lock().unwrap() += n);
        let r = serve_remux_file(&track, &path, size, None, false).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()["content-length"].to_str().unwrap(), size.to_string());
        let got = axum::body::to_bytes(r.into_body(), (size + 1) as usize).await.unwrap();
        assert_eq!(got.as_ref(), data.as_slice());
        assert_eq!(*billed.lock().unwrap(), size as i64);
        let h = serve_remux_file(&track, &path, size, None, true).await;
        assert_eq!(h.status(), StatusCode::OK);
        assert_eq!(h.headers()["content-length"].to_str().unwrap(), size.to_string());
        assert!(axum::body::to_bytes(h.into_body(), 100).await.unwrap().is_empty());
        assert_eq!(*billed.lock().unwrap(), size as i64, "HEAD bills nothing");
        *billed.lock().unwrap() = 0;
        let r = serve_remux_file(&track, &path, size, Some("bytes=972670-"), false).await;
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.headers()["content-range"].to_str().unwrap(), format!("bytes 972670-{}/{size}", 972670 + REMUX_WIN - 1));
        let got = axum::body::to_bytes(r.into_body(), (REMUX_WIN + 1) as usize).await.unwrap();
        assert_eq!(got.as_ref(), &data[972670usize..(972670 + REMUX_WIN) as usize]);
        assert_eq!(*billed.lock().unwrap(), REMUX_WIN as i64);
        let r = serve_remux_file(&track, &path, size, Some("bytes=10-19"), false).await;
        assert_eq!(r.headers()["content-range"].to_str().unwrap(), format!("bytes 10-19/{size}"));
        let r = serve_remux_file(&track, &path, size, Some("bytes=99999999-"), false).await;
        assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(r.headers()["content-range"].to_str().unwrap(), format!("bytes */{size}"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn block_walk_ends_the_body_when_a_block_fails() {
        let total = 2 * YT_BLOCK;
        let fetch = |_idx: u64| async move { Err(()) };
        let track: Track = Arc::new(|_| ());
        let body = block_walk(total, blk(YT_BLOCK as usize, 9), fetch, track);
        assert!(axum::body::to_bytes(body, (4 * YT_BLOCK) as usize).await.is_err(),
            "a failed mid-stream block must error the body, never pad it");
    }
}
