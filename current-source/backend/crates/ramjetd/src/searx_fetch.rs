                                                                                
                                                                                  
                                               
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Instant,Duration};


const SX_TTL_MS: i64 = 5 * 60 * 1000;
const IMG_TTL_MS: i64 = 30 * 60 * 1000;

                                                                      
pub fn enc_component(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => o.push(b as char),
            _ => o.push_str(&format!("%{:02X}", b)),
        }
    }
    o
}

#[derive(Clone)]
pub struct SxResult { pub down: bool, pub data: Option<Value>, pub failure: Option<crate::searx_page::Failure> }

struct Cache { map: HashMap<String, (i64, bool, Option<Value>,Option<crate::searx_page::Failure>)>, order: VecDeque<String> }
                                                                                     
fn value_weight(v:&Value)->usize{match v{Value::String(s)=>64+s.capacity(),Value::Array(a)=>64+a.iter().map(value_weight).sum::<usize>(),Value::Object(o)=>64+o.iter().map(|(k,v)|96+k.capacity()+value_weight(v)).sum::<usize>(),_=>64}}
fn cache_order(c:&mut Cache,key:String){c.order.retain(|k|k!=&key);c.order.push_back(key);}
fn cache() -> &'static Mutex<Cache> {
    static C: OnceLock<Mutex<Cache>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Cache { map: HashMap::new(), order: VecDeque::new() }))
}

                                                                      
struct Cse { last:Option<Instant>, stamps:VecDeque<Instant> }
fn cse()->&'static Mutex<Cse>{static C:OnceLock<Mutex<Cse>>=OnceLock::new();C.get_or_init(||Mutex::new(Cse{last:None,stamps:VecDeque::new()}))}
fn now_ms()->i64{std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64}
fn trim_stamps(g:&mut Cse,n:Instant){while g.stamps.front().is_some_and(|t|n.saturating_duration_since(*t)>Duration::from_secs(600)){g.stamps.pop_front();}}
pub async fn cse_budget_left()->i64{let mut g=cse().lock().unwrap_or_else(|e|e.into_inner());trim_stamps(&mut g,Instant::now());24-g.stamps.len() as i64}
pub async fn cse_gate(){
                                                                                   
                                                                                          
    static DISPATCH:OnceLock<tokio::sync::Semaphore>=OnceLock::new();
    let Ok(_permit)=DISPATCH.get_or_init(||tokio::sync::Semaphore::new(1)).acquire().await else{return};
    let at={let g=cse().lock().unwrap_or_else(|e|e.into_inner());g.last.map(|at|at+Duration::from_secs(3))};
    if let Some(at)=at{tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await}
    let mut g=cse().lock().unwrap_or_else(|e|e.into_inner());let now=Instant::now();trim_stamps(&mut g,now);g.last=Some(now);g.stamps.push_back(now);
}
fn flight(key:&str)->Arc<tokio::sync::Mutex<()>>{
    static F:OnceLock<Mutex<HashMap<String,Weak<tokio::sync::Mutex<()>>>>>=OnceLock::new();
    let mut m=F.get_or_init(||Mutex::new(HashMap::new())).lock().unwrap_or_else(|e|e.into_inner());m.retain(|_,v|v.strong_count()>0);
    if let Some(v)=m.get(key).and_then(Weak::upgrade){return v}
    let v=Arc::new(tokio::sync::Mutex::new(()));m.insert(key.into(),Arc::downgrade(&v));v
}

fn is_cse(r: &Value) -> bool {
    r.get("engine").and_then(|e| e.as_str()).unwrap_or("").contains("cse")
}

                                                                                    
pub async fn sx_fetch_raw(st: &crate::AppState, query: &str, page: i64, cat: &str, safe: i64, pin: bool) -> SxResult {
    if cat == "images" { cse_gate().await; }
    let mut qs = String::new();
    qs.push_str(if pin { "?engines=bing,google+cse&q=" } else { "?q=" });
    qs.push_str(&enc_component(query));
    qs.push_str("&format=json");
    if page > 1 { qs.push_str(&format!("&pageno={}", page)); }
    if !cat.is_empty() && cat != "general" { qs.push_str(&format!("&categories={}", enc_component(cat))); }
    qs.push_str(&format!("&safesearch={}", safe));                
    let url = format!("{}/search{}", st.searx_url.trim_end_matches('/'), qs);                                                     
    let resp = match st.local_http.get(&url)
        .header("accept", "application/json").header("accept-encoding", "identity")
        .timeout(std::time::Duration::from_secs(15)).send().await {
        Ok(r) => r,
        Err(e) => { let kind = if e.is_timeout() { "timeout" } else if e.is_connect() { "connect" } else { "request" };
        tracing::warn!(target: "searx", "upstream request failed cat={cat} p={page} kind={kind}"); return SxResult { down: true, data: None, failure: Some(if e.is_timeout() || e.is_connect() { crate::searx_page::Failure::Retryable } else { crate::searx_page::Failure::Unknown }) } },                                                                             
    };
    if !resp.status().is_success() {
        use crate::searx_page::Failure;
        let failure = match resp.status().as_u16() {
            429 => Failure::RateLimited, 403 => Failure::Forbidden,
            408 | 500 | 502 | 504 => Failure::Retryable, _ => Failure::Unavailable,
        };
        return SxResult { down: true, data: None, failure: Some(failure) };
    }
    if resp.content_length().is_some_and(|n|n>4*1024*1024){return SxResult{down:true,data:None,failure:Some(crate::searx_page::Failure::Unavailable)}}
    let mut body = Vec::new();
    let mut resp = resp;
    loop {                                 
        match resp.chunk().await {
            Ok(Some(c)) => { if body.len().saturating_add(c.len())>4*1024*1024{return SxResult{down:true,data:None,failure:Some(crate::searx_page::Failure::Unavailable)}}body.extend_from_slice(&c); }
            Ok(None) => break,
            Err(_e) => { tracing::warn!(target: "searx", "upstream read failed cat={cat} p={page} kind=read"); return SxResult { down: true, data: None, failure: Some(crate::searx_page::Failure::Retryable) } },                                           
        }
    }
    let mut dd: Value = match serde_json::from_slice(&body) { Ok(v) => v, Err(_) => { tracing::warn!(target: "searx", "upstream bad JSON cat={cat} p={page} kind=parse"); return SxResult { down: true, data: None, failure: Some(crate::searx_page::Failure::Unknown) } } };                            
    if cat == "images" {
        if let Some(arr) = dd.get_mut("results").and_then(|r| r.as_array_mut()) {
                                                                           
            let mut idx: Vec<(usize, Value)> = arr.drain(..).enumerate().collect();
            idx.sort_by(|(ia, a), (ib, b)| is_cse(b).cmp(&is_cse(a)).then(ia.cmp(ib)));
            *arr = idx.into_iter().map(|(_, v)| v).collect();
        }
    }
    SxResult { down: false, data: Some(dd), failure: None }
}

pub async fn sx_fetch_rail(st:&crate::AppState,query:&str,safe:i64)->SxResult{
 let key=format!("rail|{}|{safe}",query.to_lowercase());let f=flight(&key);let _guard=f.lock().await;
 {let c=cache().lock().unwrap();if let Some((at,down,data,failure))=c.map.get(&key){if now_ms()-at<(if *down{10000}else{SX_TTL_MS}){return SxResult{down:*down,data:data.clone(),failure:*failure}}}}
 let v=sx_fetch_raw(st,query,1,"images",safe,false).await;
 {let mut c=cache().lock().unwrap();c.map.insert(key.clone(),(now_ms(),v.down,v.data.clone(),v.failure));cache_order(&mut c,key);while c.map.len()>200||c.map.values().map(|(_,_,v,_)|v.as_ref().map(value_weight).unwrap_or(0)).sum::<usize>()>32*1024*1024{if let Some(k)=c.order.pop_front(){c.map.remove(&k);}else{break}}}
 v
}
                                                                          
pub async fn sx_fetch(st: &crate::AppState, query: &str, page: i64, cat: &str, safe: i64) -> SxResult {
    let key = format!("{}|{}|{}|{}",query.to_lowercase(),page,cat,safe);
    match tokio::time::timeout(Duration::from_secs(15),async {
        let f=flight(&key);let _guard=f.lock().await;
        sx_fetch_inner(st,query,page,cat,safe).await
    }).await{Ok(v)=>v,Err(_)=>SxResult{down:true,data:None,failure:Some(crate::searx_page::Failure::Retryable)}}
}
async fn sx_fetch_inner(st:&crate::AppState,query:&str,page:i64,cat:&str,safe:i64)->SxResult{
    let key = format!("{}|{}|{}|{}", query.to_lowercase(), page, cat, safe);
    let ttl = if cat == "images" { IMG_TTL_MS } else { SX_TTL_MS };
    { let c = cache().lock().unwrap();
      if let Some((at, down, v, failure)) = c.map.get(&key) { if now_ms() - at < (if *down || v.as_ref().and_then(|d|d.get("results")).and_then(|r|r.as_array()).is_some_and(|r|r.is_empty()) {10000}else{ttl}) { return SxResult { down: *down, data: v.clone(), failure: *failure }; } } }
    let general = cat.is_empty() || cat == "general";
    let mut v = sx_fetch_raw(st, query, page, cat, safe, general).await;
    if cat == "images" && page == 1 {
                                                                                            
        let has_arr = v.data.as_ref().and_then(|d| d.get("results")).map_or(false, |r| r.is_array());
        if has_arr {
            let mut extra = Vec::new();
            for p in [2i64, 3, 4, 5] {
                if cse_budget_left().await < 4 { break; }
                let ex = sx_fetch_raw(st, query, p, cat, safe, false).await;
                let empty = ex.data.as_ref().and_then(|d| d.get("results")).and_then(|r| r.as_array()).map_or(true, |a| a.is_empty());
                extra.push(ex);
                if empty { break; }
            }
                                                                                            
            let mut seen = std::collections::HashSet::new();
            let mut all: Vec<Value> = Vec::new();
            let add = |r: &Value, seen: &mut std::collections::HashSet<String>, all: &mut Vec<Value>| {
                let k = r.get("img_src").or_else(|| r.get("url")).and_then(|x| x.as_str()).unwrap_or("");
                if k.is_empty() || seen.contains(k) { return; }
                seen.insert(k.to_string()); all.push(r.clone());
            };
            let base = v.data.as_ref().and_then(|d| d.get("results")).and_then(|r| r.as_array()).cloned().unwrap_or_default();
            for r in base.iter().filter(|r| is_cse(r)) { add(r, &mut seen, &mut all); }
            for ex in &extra {
                if let Some(arr) = ex.data.as_ref().and_then(|d| d.get("results")).and_then(|r| r.as_array()) {
                    for r in arr.iter().filter(|r| is_cse(r)) { add(r, &mut seen, &mut all); }
                }
            }
            for r in base.iter().filter(|r| !is_cse(r)) { add(r, &mut seen, &mut all); }
            if let Some(d) = v.data.as_mut() { d["results"] = Value::Array(all); }
        }
    }
    if general && !v.down {
        let empty = v.data.as_ref().and_then(|d| d.get("results")).and_then(|r| r.as_array()).map_or(true, |a| a.is_empty());
        if empty { v = sx_fetch_raw(st, query, page, cat, safe, false).await; }
    }
    let _has_results = v.data.as_ref().and_then(|d| d.get("results")).and_then(|r| r.as_array()).map_or(false, |a| !a.is_empty());
    let _any_cse = v.data.as_ref().and_then(|d| d.get("results")).and_then(|r| r.as_array()).map_or(false, |a| a.iter().any(is_cse));
    {
        let mut c = cache().lock().unwrap();
        c.map.insert(key.clone(), (now_ms(), v.down, v.data.clone(),v.failure));
        cache_order(&mut c,key);
        while c.map.len() > 200 || c.map.values().map(|(_,_,v,_)|v.as_ref().map(value_weight).unwrap_or(0)).sum::<usize>()>32*1024*1024 { if let Some(k) = c.order.pop_front() { c.map.remove(&k); } }
    }
    v
}

#[cfg(test)]mod hardening_tests{use super::*;
 #[test]fn cache_order_dedupes(){let mut c=Cache{map:HashMap::new(),order:VecDeque::new()};for _ in 0..1000{cache_order(&mut c,"same".into())}assert_eq!(c.order.len(),1);}
 #[test]fn singleflight_is_per_key(){let a=flight("fixture-key");let b=flight("fixture-key");let c=flight("other-fixture-key");assert!(Arc::ptr_eq(&a,&b));assert!(!Arc::ptr_eq(&a,&c));}
 #[tokio::test]async fn gate_cancelled_backlog_does_not_poison_dispatch(){
    cse_gate().await;let before=cse().lock().unwrap().stamps.len();let mut jobs=Vec::new();for _ in 0..12{jobs.push(tokio::spawn(cse_gate()))}tokio::time::sleep(Duration::from_millis(25)).await;for j in jobs{j.abort();let _=j.await;}assert_eq!(cse().lock().unwrap().stamps.len(),before);assert!(cse().try_lock().is_ok());assert!(tokio::time::timeout(Duration::from_millis(3300),cse_gate()).await.is_ok());
 }
}
