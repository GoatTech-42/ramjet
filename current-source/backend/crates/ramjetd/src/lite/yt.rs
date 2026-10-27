                                                                         
                                                                        
use serde::Deserialize;
use serde_json::json;
use std::time::{Duration, Instant};
use crate::AppState;

#[derive(Debug, Clone, Deserialize)]
pub struct YtVideo { pub id: String, pub title: String, pub channel: String, pub duration: String, pub views: String }

                                                                    
pub fn clip(s: &str, n: usize) -> String {
    let x = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = x.chars().collect();
    if chars.len() <= n { return x; }
    chars[..n - 1].iter().collect::<String>().trim_end().to_string() + "\u{2026}"
}

                                                                                    
pub fn fmt_views(x: &str) -> String {
    if x.is_empty() { return String::new(); }
    let stripped: String = x.chars().filter(|c| !matches!(c, ',' | ' ')).collect();
    let stripped = stripped.to_lowercase().replace("views", "").replace("view", "");
    if let Ok(n) = stripped.parse::<f64>() {
        if n >= 1e6 {
            let s = format!("{:.1}", n / 1e6);
            let s = s.trim_end_matches(".0").to_string();
            return format!("{s}M views");
        }
        if n >= 1e3 { return format!("{}K views", (n / 1e3).round() as u64); }
        return format!("{} views", n as u64);
    }
    clip(x, 18)
}

fn text(t: Option<&serde_json::Value>) -> String {
    match t {
        Some(v) => {
            if let Some(runs) = v.get("runs").and_then(|r| r.as_array()) {
                runs.iter().filter_map(|r| r.get("text").and_then(|x| x.as_str())).collect()
            } else {
                v.get("simpleText").and_then(|x| x.as_str()).unwrap_or("").to_string()
            }
        }
        None => String::new(),
    }
}

                                                                                
                                                                                     
async fn innertube(st: &AppState, body: serde_json::Value) -> Result<crate::apps::jetstream_up::Jv, String> {
    let eg = st.egress()?;
    let resp = eg.post("https://www.youtube.com/youtubei/v1/search?prettyPrint=false")
        .header("user-agent", "com.google.android.youtube/20.10.38 (Linux; U; Android 14; en_US; Pixel 8) gzip")
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .json(&body)
        .send().await.map_err(|e| if e.is_timeout() { "timed out".to_string() } else { "upstream error".to_string() })?;                                 
    if !resp.status().is_success() { return Err(format!("search upstream {}", resp.status())); }
                                                                                                     
                                                                                                            
    let bytes = resp.bytes().await.map_err(|_| "upstream error".to_string())?;
    crate::apps::jetstream_up::Jv::parse(&bytes)
}

pub async fn search_once(st: &AppState, q: &str) -> Result<(Vec<YtVideo>, Option<String>), String> {
    let body = json!({"context":{"client":{"clientName":"ANDROID","clientVersion":"20.10.38","hl":"en","gl":"US"}},"query":q});
    let data = innertube(st, body).await?;
    Ok((parse_search_jv(&data), crate::apps::jetstream_up::search_token(&data)))
}

                                                                                      
                                                                                 
                                                                                      
                                            
async fn cont_page(st: &AppState, tok: &str) -> Result<(Vec<YtVideo>, Option<String>), String> {
    #[cfg(test)]
    { let mut s = st.lite.cont_stub.lock().unwrap(); if !s.is_empty() { return s.remove(0); } }
    let body = json!({"context":{"client":{"clientName":"ANDROID","clientVersion":"20.10.38","hl":"en","gl":"US"}},"continuation":tok});
    let data = innertube(st, body).await?;
    Ok((parse_search_jv(&data), crate::apps::jetstream_up::search_token(&data)))
}

const MAX_CACHED_QUERIES: usize = 25;                                                            
const MAX_CACHED_ITEMS: usize = 240;                                                        
const MAX_WALK_CALLS: u32 = 4;                                                                

fn insert_first_page(cache: &mut std::collections::HashMap<String, (u32, Vec<YtVideo>, Option<String>, Instant)>, q: &str, items: Vec<YtVideo>, tok: Option<String>, at: Instant) {
    if !cache.contains_key(q) && cache.len() >= MAX_CACHED_QUERIES {
        if let Some(oldest) = cache.iter().min_by_key(|(_, e)| e.3).map(|(k, _)| k.clone()) { cache.remove(&oldest); }
    }
    cache.insert(q.to_string(), (1, items, tok, at));
}

                                                                       
async fn first_page_fresh(st: &AppState, q: &str) -> Result<(Vec<YtVideo>, Option<String>), String> {
    #[cfg(test)]
    { let mut s = st.lite.cont_stub.lock().unwrap(); if !s.is_empty() { let r = s.remove(0)?; let mut c = st.lite.search_cache.lock().unwrap(); insert_first_page(&mut c, q, r.0.clone(), r.1.clone(), Instant::now()); return Ok(r); } }
    let (data, tok) = search_once(st, q).await?;
    let mut cache = st.lite.search_cache.lock().unwrap();
    insert_first_page(&mut cache, q, data.clone(), tok.clone(), Instant::now());
    Ok((data, tok))
}

pub async fn yt_search_cached(st: &AppState, q: &str) -> Result<(Vec<YtVideo>, Option<String>), String> {
    {
        let cache = st.lite.search_cache.lock().unwrap();
        if let Some((1, data, tok, at)) = cache.get(q) {
            if at.elapsed() < Duration::from_secs(180) { return Ok((data.clone(), tok.clone())); }
        }
    }
    first_page_fresh(st, q).await
}

                                                                              
                                                                             
                                                                                
fn serve_window(st: &AppState, q: &str, pg: u32) -> Option<(Vec<YtVideo>, bool)> {
    let c = st.lite.search_cache.lock().unwrap();
    let (fp, v, t, _) = c.get(q)?;
    if pg < *fp { return None; }
    let start = (pg - fp) as usize * 8;
    if start >= v.len() { return None; }
    let end = (start + 8).min(v.len());
    if end - start < 8 && t.is_some() { return None; }                                                      
    let beyond = v.len() > end;
    Some((v[start..end].to_vec(), beyond || t.is_some()))
}

                                                                                    
pub async fn search_retry(st: &AppState, q: &str) -> Result<Vec<YtVideo>, String> {
    search_retry_full(st, q).await.map(|(v, _)| v)
}

pub async fn search_retry_full(st: &AppState, q: &str) -> Result<(Vec<YtVideo>, Option<String>), String> {
    match yt_search_cached(st, q).await {
        Ok(r) if !r.0.is_empty() => return Ok(r),
        Ok(r) => {
                                                                                   
            if st.lite.search_cache.lock().unwrap().contains_key(q) { return Ok(r); }
        }
        Err(_) => {}
    }
    tokio::time::sleep(Duration::from_millis(700)).await;
    yt_search_cached(st, q).await
}

                                                                                      
                                                                                       
                                                                                       
                                                                                     
                                                                                    
                                                                     
pub async fn search_pages(st: &AppState, q: &str, pg: u32) -> Result<(Vec<YtVideo>, bool), String> {
                                                                                     
                                                                                 
                                                                      
                                                                            
                                                                                 
                                                                 
    let anchored = { let c = st.lite.search_cache.lock().unwrap(); matches!(c.get(q), Some((fp, _, _, at)) if *fp <= pg && at.elapsed() < Duration::from_secs(180)) };
    if !anchored { first_page_fresh(st, q).await?; }                                                             
    if let Some(r) = serve_window(st, q, pg) { return Ok(r); }
    let _g = st.lite.search_walk.lock().await;
    if let Some(r) = serve_window(st, q, pg) { return Ok(r); }                                                        
    let mut calls = 0u32;
    loop {
        let tok = {
            let c = st.lite.search_cache.lock().unwrap();
            match c.get(q) {
                Some((fp, v, t, _)) if *fp <= pg && { let s = (pg - *fp) as usize * 8; s < v.len() && (s + 8 <= v.len() || t.is_none()) } => break,                                         
                Some((_, _, t, _)) => t.clone(),
                None => None,
            }
        };
        let tok = match tok { Some(t) => t, None => break };                             
        if calls >= MAX_WALK_CALLS { break; }
        let (more, next) = cont_page(st, &tok).await?;
        let mut c = st.lite.search_cache.lock().unwrap();
        let e = c.entry(q.to_string()).or_insert_with(|| (1, Vec::new(), None, Instant::now()));
        let mut seen: std::collections::HashSet<String> = e.1.iter().map(|v| v.id.clone()).collect();
        for v in more { if seen.insert(v.id.clone()) { e.1.push(v); } }
        if e.1.len() > MAX_CACHED_ITEMS {
            let pages_over = (e.1.len() - MAX_CACHED_ITEMS).div_ceil(8);
            let drop = (pages_over * 8).min(e.1.len());
            e.1.drain(..drop);                                                            
            e.0 += pages_over as u32;
        }
        e.2 = next;
        e.3 = Instant::now();
        calls += 1;
    }
                                                                                   
                                                                              
    Ok(serve_window(st, q, pg).unwrap_or_else(|| {
        let t = st.lite.search_cache.lock().unwrap().get(q).and_then(|e| e.2.clone());
        (Vec::new(), t.is_some())
    }))
}

                                                                                           
pub fn parse_search_jv(data: &crate::apps::jetstream_up::Jv) -> Vec<YtVideo> {
    crate::apps::jetstream_up::parse_search(data, 20).into_iter()
        .map(|v| YtVideo { id: v.id, title: v.title, channel: v.channel, duration: v.duration, views: v.views }).collect()
}

#[deprecated(note = "sorts object keys (serde_json has no preserve_order); use parse_search_jv")]
pub fn parse_search(data: &serde_json::Value) -> Vec<YtVideo> {
                                                                                
                                                                                        
    fn walk(node: &serde_json::Value, out: &mut Vec<YtVideo>) {
        if !node.is_object() && !node.is_array() { return; }
        if out.len() >= 40 { return; }
        let v = node.get("videoRenderer").or_else(|| node.get("compactVideoRenderer"));
        if let Some(v) = v {
            let id = v.get("videoId").and_then(|x| x.as_str()).unwrap_or("");
            let title = text(v.get("title"));
            let duration = text(v.get("lengthText"));
            if !id.is_empty() && !title.is_empty() && !duration.is_empty() {
                let byline = v.get("ownerText").or_else(|| v.get("longBylineText")).or_else(|| v.get("shortBylineText"));
                out.push(YtVideo { id: id.to_string(), title, channel: text(byline), duration, views: text(v.get("viewCountText")) });
            }
            return;
        }
        match node {
            serde_json::Value::Object(m) => { for val in m.values() { walk(val, out); } }
            serde_json::Value::Array(a) => { for val in a { walk(val, out); } }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(data, &mut out);
    let mut seen = std::collections::HashSet::new();
    out.into_iter().filter(|v| seen.insert(v.id.clone())).take(20).collect()
}

#[cfg(test)]
mod order_tests {
    use super::*;
                                                                                       
    #[test]
    fn walk_is_document_order() {
        let raw = br#"{"zeta":{"videoRenderer":{"videoId":"zzzzzzzzzzz","title":{"simpleText":"Z"},"lengthText":{"simpleText":"1:00"}}},"alpha":{"videoRenderer":{"videoId":"aaaaaaaaaaa","title":{"simpleText":"A"},"lengthText":{"simpleText":"2:00"}}}}"#;
        let v = crate::apps::jetstream_up::Jv::parse(raw).unwrap();
        let ids: Vec<String> = parse_search_jv(&v).into_iter().map(|x| x.id).collect();
        assert_eq!(ids, vec!["zzzzzzzzzzz", "aaaaaaaaaaa"]);
    }
}


#[cfg(test)]
mod paging_tests {
    use super::*;
    fn mk(i: u32) -> YtVideo { YtVideo { id: format!("VID{i:08}"), title: format!("T{i}"), channel: "C".into(), duration: "1:00".into(), views: "1 views".into() } }
    fn seed(st: &AppState, q: &str, n: u32, tok: Option<&str>) {
        st.lite.search_cache.lock().unwrap().insert(q.to_string(), (1, (1..=n).map(mk).collect(), tok.map(|s| s.to_string()), Instant::now()));
    }
    async fn call(st: &std::sync::Arc<AppState>, q: &str, page: &str) -> (axum::http::StatusCode, String) {
        let sh: crate::Shared = (st.clone(), st.data_dir.clone());
        let params: std::collections::HashMap<String, String> = [("q".to_string(), q.to_string()), ("page".to_string(), page.to_string())].into_iter().collect();
        let r = super::super::search(axum::extract::State(sh), axum::extract::Query(params)).await;
        let s = r.status();
        let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        (s, String::from_utf8(b.to_vec()).unwrap())
    }
    fn fx(name: &str) -> std::sync::Arc<AppState> { std::sync::Arc::new(crate::auth_api::devices::tests::fixture(name)) }

    #[test]
    fn token_extraction_both_shapes() {
        let first = crate::apps::jetstream_up::Jv::parse(br#"{"contents":{"twoColumnSearchResultsRenderer":{"primaryContents":{"sectionListRenderer":{"contents":[{"continuationItemRenderer":{"continuationEndpoint":{"continuationCommand":{"token":"TOK1"}}}}]}}}}}"#).unwrap();
        assert_eq!(crate::apps::jetstream_up::search_token(&first).as_deref(), Some("TOK1"));
        let cont = crate::apps::jetstream_up::Jv::parse(br#"{"onResponseReceivedCommands":[{"appendContinuationItemsAction":{"continuationItems":[{"continuationItemRenderer":{"continuationEndpoint":{"continuationCommand":{"token":"TOK2"}}}}]}}]}"#).unwrap();
        assert_eq!(crate::apps::jetstream_up::search_token(&cont).as_deref(), Some("TOK2"));
        let none = crate::apps::jetstream_up::Jv::parse(br#"{"contents":{}}"#).unwrap();
        assert_eq!(crate::apps::jetstream_up::search_token(&none), None);
    }

    #[tokio::test]
    async fn page1_and_2_served_from_cache_without_continuation_call() {
        let st = fx("pg-cached");
        seed(&st, "cats", 20, Some("CT1"));
        let (s, b) = call(&st, "cats", "1").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["results"].as_array().unwrap().len(), 8);
        assert_eq!(j["results"][0]["id"], "VID00000001");
        assert_eq!(j["has_more"], true);
        assert_eq!(j["next_page"], 2);
        let (s, b) = call(&st, "cats", "2").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["results"].as_array().unwrap().len(), 8);
        assert_eq!(j["results"][0]["id"], "VID00000009", "page 2 slices items 9-16");
        assert_eq!(j["has_more"], true, "continuation token keeps has_more true past the old 20-cap");
        assert_eq!(j["next_page"], 3);
        assert!(st.lite.cont_stub.lock().unwrap().is_empty(), "no continuation call while cache covers the page");
    }

    #[tokio::test]
    async fn old_hardstop_preserved_when_upstream_gives_no_token() {
        let st = fx("pg-notoken");
        seed(&st, "cats", 20, None);
        let (s, b) = call(&st, "cats", "3").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["results"].as_array().unwrap().len(), 4, "page 3 = items 17-20 (old shape)");
        assert_eq!(j["has_more"], false);
        assert_eq!(j["next_page"], serde_json::Value::Null);
        assert!(st.lite.cont_stub.lock().unwrap().is_empty(), "no token -> no continuation attempt");
    }

    #[tokio::test]
    async fn page3_extends_via_continuation_then_stops_cleanly() {
        let st = fx("pg-extend");
        seed(&st, "cats", 20, Some("CT1"));
        st.lite.cont_stub.lock().unwrap().push(Ok(((21..=40).map(mk).collect(), None)));
        let (s, b) = call(&st, "cats", "3").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["results"].as_array().unwrap().len(), 8);
        assert_eq!(j["results"][0]["id"], "VID00000017");
        assert_eq!(j["results"][j["results"].as_array().unwrap().len() - 1]["id"], "VID00000024");
        assert_eq!(j["has_more"], true, "page 3 has_more: extended cache holds items 25-40");
        assert_eq!(st.lite.search_cache.lock().unwrap()["cats"].1.len(), 40, "page appended");
        assert!(st.lite.cont_stub.lock().unwrap().is_empty(), "exactly one continuation call");
                                                                                  
        let (s, b) = call(&st, "cats", "5").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["results"].as_array().unwrap().len(), 8, "page 5 = items 33-40 from cache");
        assert_eq!(j["has_more"], false);
    }

    #[tokio::test]
    async fn has_more_true_while_token_remains() {
        let st = fx("pg-more");
        seed(&st, "cats", 20, Some("CT1"));
        st.lite.cont_stub.lock().unwrap().push(Ok(((21..=40).map(mk).collect(), Some("CT2".to_string()))));
        let (s, b) = call(&st, "cats", "3").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["has_more"], true);
        assert_eq!(j["next_page"], 4);
    }

    #[tokio::test]
    async fn continuation_failure_is_an_honest_502() {
        let st = fx("pg-fail");
        seed(&st, "cats", 20, Some("CT1"));
        st.lite.cont_stub.lock().unwrap().push(Err("upstream error".to_string()));
        let (s, b) = call(&st, "cats", "3").await;
        assert_eq!(s, axum::http::StatusCode::BAD_GATEWAY);
        assert!(b.contains("upstream error"), "fixed vocabulary, no token/URL leak: {b}");
        assert!(!b.contains("CT1"), "continuation token never in the response");
    }

    #[tokio::test]
    async fn continuation_pages_dedupe_by_id() {
        let st = fx("pg-dedupe");
        seed(&st, "cats", 20, Some("CT1"));
        st.lite.cont_stub.lock().unwrap().push(Ok(((11..=30).map(mk).collect(), None)));
        let (s, _b) = call(&st, "cats", "3").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        assert_eq!(st.lite.search_cache.lock().unwrap()["cats"].1.len(), 30, "overlap 11-20 deduped");
    }

    #[tokio::test]
    async fn deep_page_walk_is_capped_at_four_calls() {
        let st = fx("pg-cap");
        seed(&st, "cats", 20, Some("CT"));
        for k in 0..6u32 { st.lite.cont_stub.lock().unwrap().push(Ok(((21 + 20 * k..=40 + 20 * k).map(mk).collect(), Some("CT".to_string())))); }
        let (s, b) = call(&st, "cats", "20").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["results"].as_array().unwrap().len(), 0, "100 items cannot fill page 20");
        assert_eq!(j["has_more"], true, "token remains: client keeps paging forward");
        assert_eq!(st.lite.cont_stub.lock().unwrap().len(), 2, "exactly 4 upstream calls, then stop");
    }

    #[tokio::test]
    async fn envelope_key_order_unchanged() {
        let st = fx("pg-order");
        seed(&st, "cats", 20, Some("CT1"));
        let (s, b) = call(&st, "cats", "1").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        let keys = ["ok", "q", "results", "lines", "page", "per_page", "has_more", "next_page"];
        let pos: Vec<usize> = keys.iter().map(|k| b.find(k).unwrap_or(usize::MAX)).collect();
        assert!(pos.windows(2).all(|w| w[0] < w[1]), "r32 envelope order preserved: {b}");
        assert!(!b.contains("CT1"), "continuation token never in the envelope");
    }

    #[test]
    fn page_num_no_fixed_cap() {
        let p = |v: &str| std::collections::HashMap::from([("page".to_string(), v.to_string())]);
        assert_eq!(super::super::page_num(&p("21")).unwrap(), 21, "no fixed 20-page cap");
        assert_eq!(super::super::page_num(&p("200")).unwrap(), 200);
        assert_eq!(super::super::page_num(&p("0")).unwrap(), 1, "lower bound preserved");
        assert_eq!(super::super::page_num(&p("abc")).unwrap(), 1, "unparsable keeps established page-1 handling");
        assert_eq!(super::super::page_num(&p("99999999999999999999")).unwrap(), 1, "u64-overflow string is unparsable -> page 1, never a silent duplicate");
        assert_eq!(super::super::page_num(&p("10000")).unwrap(), 10000, "bound itself still serves");
    }

    #[test]
    fn page_above_sanity_bound_is_honest_400_not_duplicate() {
        let p = std::collections::HashMap::from([("page".to_string(), "10001".to_string())]);
        let r = super::super::page_num(&p).unwrap_err();
        assert_eq!(r.status(), axum::http::StatusCode::BAD_REQUEST, "r3: honest 400, never a duplicate page 10000");
    }

    #[tokio::test]
    async fn search_page_10001_is_400_not_duplicate() {
        let st = fx("pg-400");
        seed(&st, "cats", 20, None);
        let (s, b) = call(&st, "cats", "10001").await;
        assert_eq!(s, axum::http::StatusCode::BAD_REQUEST);
        assert!(b.contains("page too large"), "existing validation vocabulary: {b}");
    }

    #[tokio::test]
    async fn accurate_exhaustion_partial_last_page() {
        let st = fx("pg-exh");
        seed(&st, "cats", 20, None);                                 
        let (s, b) = call(&st, "cats", "3").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["results"].as_array().unwrap().len(), 4, "page 3 = items 17-20");
        assert_eq!(j["has_more"], false, "accurate at real exhaustion");
        assert_eq!(j["next_page"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn window_slides_bounded_and_stays_aligned() {
        let st = fx("pg-slide");
        seed(&st, "cats", 240, Some("CT1"));                                
        st.lite.cont_stub.lock().unwrap().push(Ok(((241..=480).map(mk).collect(), None)));
        let (s, b) = call(&st, "cats", "40").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["results"][0]["id"], "VID00000313", "whole-page slide keeps absolute alignment");
        let c = st.lite.search_cache.lock().unwrap();
        let e = &c["cats"];
        assert!(e.1.len() <= 240, "bounded window");
        assert_eq!(e.0, 31, "first_page advanced by dropped whole pages");
        drop(c);
        assert_eq!(j["has_more"], true, "more pages remain inside the window");
    }

    #[tokio::test]
    async fn backward_beyond_window_reanchors_at_page1() {
        let st = fx("pg-back");
        st.lite.search_cache.lock().unwrap().insert("cats".to_string(), (10, (1..=20).map(mk).collect(), None, Instant::now()));
        st.lite.cont_stub.lock().unwrap().push(Ok(((1..=30).map(mk).collect(), None)));                     
        let (s, b) = call(&st, "cats", "2").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["results"][0]["id"], "VID00000009", "re-anchored first page serves page 2");
        assert_eq!(j["has_more"], true, "items beyond page 2 in window");
    }

    #[tokio::test]
    async fn concurrent_deep_polls_single_flight() {
        let st = fx("pg-race");
        seed(&st, "cats", 20, Some("CT1"));
        st.lite.cont_stub.lock().unwrap().push(Ok(((21..=40).map(mk).collect(), None)));                                       
        let st2 = st.clone();
        let (a, b) = tokio::join!(super::search_pages(&st, "cats", 3), super::search_pages(&st2, "cats", 3));
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a.0[0].id, "VID00000017");
        assert_eq!(b.0[0].id, "VID00000017", "second request served from the extended cache, not a duplicate walk");
        assert!(st.lite.cont_stub.lock().unwrap().is_empty(), "exactly one upstream continuation call total");
    }

    #[test]
    fn query_set_is_bounded_oldest_evicted() {
        let mut c: std::collections::HashMap<String, (u32, Vec<YtVideo>, Option<String>, Instant)> = Default::default();
        let now = Instant::now();
        for i in 0..25u64 { super::insert_first_page(&mut c, &format!("q{i}"), vec![mk(1)], None, now - std::time::Duration::from_secs(25 - i)); }
        super::insert_first_page(&mut c, "q-new", vec![mk(2)], None, now);
        assert_eq!(c.len(), 25, "bounded query set");
        assert!(!c.contains_key("q0"), "oldest evicted");
        assert!(c.contains_key("q24") && c.contains_key("q-new"));
    }

    #[tokio::test]
    async fn sheet_empty_page_with_more_upstream_is_503_not_no_more() {
        let st = fx("pg-sheet");
        seed(&st, "cats", 8, Some("CT1"));                               
        for _ in 0..6 { st.lite.cont_stub.lock().unwrap().push(Ok((vec![], Some("CTx".to_string())))); }                              
        let sh: crate::Shared = (st.clone(), st.data_dir.clone());
        let params: std::collections::HashMap<String, String> = [("q".to_string(), "cats".to_string()), ("page".to_string(), "2".to_string())].into_iter().collect();
        let r = super::super::sheet_handler(axum::extract::State(sh), axum::extract::Query(params)).await;
        assert_eq!(r.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE, "bounded-walk empty page must not claim NoMore");
        assert_eq!(r.headers().get(axum::http::header::RETRY_AFTER).unwrap(), "1");
        assert_eq!(st.lite.cont_stub.lock().unwrap().len(), 2, "walk capped at 4 calls");
    }
}
