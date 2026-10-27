                                                                                    
                                                                                 
                                                                                  
                                                                                  
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use super::{json_err_x, json_ord, page_num, qparam, urlenc, OJ, Shared};

const CACHE_TTL_S: u64 = 1800;

#[derive(Clone)]
pub struct Img { pub src: String, pub title: String, pub site: String, pub full: String, pub thumb_src: String }

struct QueryState {
    at: Instant,
    seen: HashSet<String>,
    cse: Vec<Img>,
    rest: Vec<Img>,
    next: u32,
    done: bool,
}

type SharedFetch = futures::future::Shared<futures::future::BoxFuture<'static, Result<(), String>>>;

pub struct SearxState {
    cache: Mutex<HashMap<String, QueryState>>,
    busy: Mutex<HashMap<String, SharedFetch>>,                                          
}

impl SearxState {
    pub fn new() -> Self {
        Self { cache: Mutex::new(HashMap::new()), busy: Mutex::new(HashMap::new()) }
    }
}

fn src_tag(engine: &str) -> String {
    let e = engine.to_lowercase();
    if e.starts_with("brave") { "brave".into() }
    else if e.contains("cse") { "google cse".into() }
    else if e.starts_with("google") { "google".into() }
    else if e.starts_with("pinterest") { "pinterest".into() }
    else if e.starts_with("wikicommons") { "wikimedia".into() }
    else { e.strip_suffix(" images").unwrap_or(&e).to_string() }                                             
}

fn sx_item(x: &Value, seen: &mut HashSet<String>) -> Option<Img> {
    let full = x.get("img_src").and_then(|v| v.as_str())?.to_string();
    if !(full.starts_with("http://") || full.starts_with("https://")) || !seen.insert(full.clone()) { return None; }
    let host = x.get("url").and_then(|v| v.as_str()).unwrap_or(&full);
                                            
    let site = url::Url::parse(host).ok().and_then(|u| u.host_str().map(|h| h.strip_prefix("www.").unwrap_or(h).to_string())).unwrap_or_default();
                                                                                                                 
    let th_raw = x.get("thumbnail_src").or_else(|| x.get("thumbnail")).and_then(|v| v.as_str()).unwrap_or(&full);
    let th = if let Some(rest) = th_raw.strip_prefix("http:") { format!("https:{rest}") } else { th_raw.to_string() };
                                                                                            
                                                                                         
    let title_src = x.get("title").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(if site.is_empty() { "image" } else { &site });
    let re_tags = regex::Regex::new(r"<[^>]*>").unwrap();
    let re_pua = regex::Regex::new(r"[\u{e000}-\u{e00f}]").unwrap();
    let title = re_pua.replace_all(&re_tags.replace_all(title_src, ""), "").to_string();
    Some(Img { src: src_tag(x.get("engine").and_then(|v| v.as_str()).unwrap_or("")), title, site, full, thumb_src: th })
}

async fn searx_fetch_page(st: &crate::AppState, q: &str, pn: u32, lvl: u32) -> Result<Vec<Value>, String> {
    crate::searx_fetch::cse_gate().await;                                       
    let url = format!("{}/search?q={}&categories=images&format=json&pageno={pn}&safesearch={lvl}", st.searx_url, urlenc(q));
    let resp = st.local_http.get(&url).timeout(std::time::Duration::from_secs(12)).send().await
        .map_err(|e| if e.is_timeout() { "timed out".to_string() } else { "upstream error".to_string() })?;                                                           
    if !resp.status().is_success() { return Err(format!("searxng {}", resp.status().as_u16())); }
    let mut resp=resp;let mut bytes=Vec::new();
    if resp.content_length().is_some_and(|n|n>4*1024*1024){return Err("upstream error".into())}
    while let Some(chunk)=resp.chunk().await.map_err(|_|"upstream error".to_string())?{if bytes.len().saturating_add(chunk.len())>4*1024*1024{return Err("upstream error".into())}bytes.extend_from_slice(&chunk)}
    let data:Value=serde_json::from_slice(&bytes).map_err(|_|"upstream error".to_string())?;                      
    Ok(data.get("results").and_then(|r| r.as_array()).cloned().unwrap_or_default())
}

fn query_state(st: &crate::AppState, q: &str, lvl: u32) -> String {
    let key = format!("{}|{lvl}", q.to_lowercase());
    let mut cache = st.lite.searx.cache.lock().unwrap();
    let fresh = cache.get(&key).map(|s| s.at.elapsed() < Duration::from_secs(CACHE_TTL_S)).unwrap_or(false);
    if !fresh {
        cache.insert(key.clone(), QueryState { at: Instant::now(), seen: HashSet::new(), cse: vec![], rest: vec![], next: 1, done: false });
        if cache.len() > 60 { if let Some(k) = cache.iter().filter(|(k,_)|*k!=&key).min_by_key(|(_,v)|v.at).map(|(k,_)|k.clone()) { cache.remove(&k); } }
    }
    key
}

                                                                              
                                                                                      
                                                          
async fn searx_more(st: &std::sync::Arc<crate::AppState>, key: &str, q: &str, lvl: u32) -> Result<(), String> {
    let fut = {
        let mut m = st.lite.searx.busy.lock().unwrap();
        match m.get(key) {
            Some(f) => f.clone(),
            None => {
                let st2 = std::sync::Arc::clone(st);
                let k = key.to_string();
                let q2 = q.to_string();
                use futures::future::FutureExt;
                let f = async move { searx_more_inner(&st2, &k, &q2, lvl).await }.boxed().shared();
                if m.len() >= 60 { if let Some(k0) = m.keys().next().cloned() { m.remove(&k0); } }
                m.insert(key.to_string(), f.clone());
                f
            }
        }
    };
    let r = fut.await;
    st.lite.searx.busy.lock().unwrap().remove(key);
    r
}

async fn searx_more_inner(st: &crate::AppState, key: &str, q: &str, lvl: u32) -> Result<(), String> {
    let pn = { st.lite.searx.cache.lock().unwrap().get(key).map(|s| s.next).unwrap_or(1) };
    let res = searx_fetch_page(st, q, pn, lvl).await;
    {                                                           
        let mut cache = st.lite.searx.cache.lock().unwrap();
        let s = match cache.get_mut(key) { Some(s) => s, None => return Ok(()) };
        match res {
            Ok(rs) => {
                if pn == 1 {
                                                                                                     
                    for x in &rs { let t = src_tag(x.get("engine").and_then(|v| v.as_str()).unwrap_or(""));
                        if t != "google cse" && t != "bing" {
                            if let Some(it) = sx_item(x, &mut s.seen) { s.rest.push(it); }
                        }
                    }
                }
                let mut added = 0;
                for x in &rs { if src_tag(x.get("engine").and_then(|v| v.as_str()).unwrap_or("")) == "google cse" {
                    if let Some(it) = sx_item(x, &mut s.seen) { s.cse.push(it); added += 1; }
                } }
                s.next += 1;
                if added == 0 || s.next > 5 { s.done = true; }
            }
            Err(e) => {
                if pn == 1 { return Err(e); }
                s.done = true;
            }
        }
    }
                                                                                     
    if crate::searx_fetch::cse_budget_left().await < 4 {
        if let Some(s) = st.lite.searx.cache.lock().unwrap().get_mut(key) { s.done = true; }
    }
    Ok(())
}

async fn searx_images(st:&std::sync::Arc<crate::AppState>,q:&str,pg:u32,safe:&str,n:u32)->Result<Vec<Img>,String>{
    tokio::time::timeout(Duration::from_secs(15),searx_images_inner(st,q,pg,safe,n)).await.map_err(|_|"timed out".to_string())?
}
async fn searx_images_inner(st: &std::sync::Arc<crate::AppState>, q: &str, pg: u32, safe: &str, n: u32) -> Result<Vec<Img>, String> {
    let lvl = if safe == "off" { 0 } else if safe == "strict" { 2 } else { 1 };
    let key = query_state(st, q, lvl);
    let end = (pg * n) as usize;
    loop {
                                                                                      
                                                                         
        let (done, have) = { let c = st.lite.searx.cache.lock().unwrap(); let Some(s) = c.get(&key) else {return Err("search changed - try again".into())}; (s.done, s.cse.len()) };
        if done || have >= end { break; }
        searx_more(st, &key, q, lvl).await?;
    }
    let cache = st.lite.searx.cache.lock().unwrap();
    let Some(s) = cache.get(&key) else {return Err("search changed - try again".into())};
                                                                          
                                                                                  
    let done = s.done; let cse_empty = s.cse.is_empty();
    let arr: Vec<Img> = if done { s.cse.iter().chain(s.rest.iter()).cloned().collect() } else { s.cse.clone() };
                                                                                   
    let _ = cse_empty;
    Ok(arr.into_iter().skip((pg as usize - 1) * n as usize).take(n as usize).collect())
}

fn clip2(x: &str, n: usize) -> String {
    let x = x.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = x.chars().collect();
    if chars.len() <= n { return x; }
    chars[..n - 1].iter().collect::<String>().trim_end().to_string() + "\u{2026}"
}

pub async fn handler(State((st, _)): State<Shared>, Query(params): Query<HashMap<String, String>>) -> Response {
    let q = qparam(&params, "q").trim().to_string();
                                               
    if q.is_empty() || q.len() > 120 { return json_err_x(StatusCode::BAD_REQUEST, json!({"error": "q required, under 120 chars"})); }
    let pg = match page_num(&params) { Ok(p) => p, Err(r) => return r };
    let n_per: u32 = params.get("n").and_then(|p| p.parse().ok()).unwrap_or(20).clamp(1, 40);
    let safe = qparam(&params, "safe");
    let items = match searx_images(&st, &q, pg, &safe, n_per).await {
        Ok(i) => i,
                                                                    
        Err(e) => return json_err_x(StatusCode::BAD_GATEWAY, json!({"error": format!("image search failed: {}", e.chars().take(80).collect::<String>())})),
    };
                                                       
    if items.is_empty() { return json_err_x(StatusCode::NOT_FOUND, json!({"error": "no results on this page", "page": pg})); }
                                                                                                      
    let mut lines: Vec<OJ> = Vec::new();
    let results: Vec<OJ> = items.iter().enumerate().map(|(i, x)| {
        let label = format!("{}. {}{}{}", i + 1, clip2(&x.title, 48),
            if x.site.is_empty() { String::new() } else { format!(" - {}", clip2(&x.site, 22)) },
            if x.src.is_empty() { String::new() } else { format!(" [{}]", x.src) });
        let m = |u: &str, extra: &str| format!("/api/lite/media?kind=image&u={}{}", urlenc(u), extra);
        let line = format!("{label}||{}", i + 1);
        lines.push(OJ::Str(line.clone()));
        OJ::Obj(vec![
            ("n".into(), OJ::U64(i as u64 + 1)),
            ("title".into(), OJ::Str(x.title.clone())),
            ("site".into(), OJ::Str(x.site.clone())),
            ("source".into(), OJ::Str(x.src.clone())),
            ("label".into(), OJ::Str(label)),
            ("line".into(), OJ::Str(line)),
            ("image".into(), OJ::Str(m(&x.full, &format!("&orig=1&fb={}", urlenc(&x.thumb_src))))),
            ("image_small".into(), OJ::Str(m(&x.full, &format!("&fb={}", urlenc(&x.thumb_src))))),
            ("thumb".into(), OJ::Str(m(&x.thumb_src, ""))),
        ])
    }).collect();
                                                                                    
    let mut sources: Vec<(String, u32)> = Vec::new();
    for x in &items {
        let s = if x.src.is_empty() { "unknown" } else { x.src.as_str() };
        match sources.iter_mut().find(|(k, _)| k == s) { Some(e) => e.1 += 1, None => sources.push((s.to_string(), 1)) }
    }
                                                                                                              
    json_ord(StatusCode::OK, vec![
        ("ok", OJ::Bool(true)),
        ("q", OJ::Str(q)),
        ("page", OJ::U64(pg as u64)),
        ("per_page", OJ::U64(n_per as u64)),
        ("sources", OJ::Obj(sources.into_iter().map(|(k, n)| (k, OJ::U64(n as u64))).collect())),
        ("results", OJ::Arr(results)),
        ("lines", OJ::Arr(lines)),
        ("has_more", OJ::Bool(items.len() as u32 == n_per)),
        ("next_page", OJ::U64(pg as u64 + 1)),
    ])
}

pub async fn sheet_handler(State((st, _)): State<Shared>, Query(params): Query<HashMap<String, String>>) -> Response {
    let q = qparam(&params, "q").trim().to_string();
                                               
    if q.is_empty() || q.len() > 120 { return json_err_x(StatusCode::BAD_REQUEST, json!({"error": "q required, under 120 chars"})); }
    let pg = match page_num(&params) { Ok(p) => p, Err(r) => return r };
    let safe = qparam(&params, "safe");
    let items = match searx_images(&st, &q, pg, &safe, 8).await {
        Ok(i) => i,
                                                                    
        Err(e) => return json_err_x(StatusCode::BAD_GATEWAY, json!({"error": format!("image search failed: {}", e.chars().take(80).collect::<String>())})),
    };
                                                       
    if items.is_empty() { return json_err_x(StatusCode::NOT_FOUND, json!({"error": "no results on this page", "page": pg})); }
    match super::sheet::make_sheet_images(&st, &items).await {
        Ok(buf) => super::img_response(buf, "image/jpeg", "no-store"),
        Err(e) => json_err_x(StatusCode::BAD_GATEWAY, json!({"error": e.chars().take(160).collect::<String>()})),
    }
}


#[cfg(test)]mod eviction_regression{use super::*;
 #[tokio::test]async fn fresh_query_survives_eviction(){let st=crate::auth_api::devices::tests::fixture("image-cache-fixture");for i in 0..80{let key=query_state(&st,&format!("query{i}"),1);assert!(st.lite.searx.cache.lock().unwrap().contains_key(&key));}assert!(st.lite.searx.cache.lock().unwrap().len()<=60);}
}
