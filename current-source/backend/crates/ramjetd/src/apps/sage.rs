                                                                                  
                                                                            
                                                                                    
                                                
                                                                                     
                                                                                  
                                                                                 
                                                                                   
                                                                                   
                                                              
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::lite::{json_ord, json_err, OJ};
use super::{fresh_id, io_fail, js_len16, js_slice16, js_string, js_trim, js_ws_collapse, millis,
            parse_body2, read_store, store_mutex, too_large, write_json, BodyErr, StoreRead};

                                                                                                
                                                                                               
                                                                                                         
#[cfg(test)] static TEST_NOW: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
#[cfg(test)] static TEST_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn now_ms() -> i64 {
    #[cfg(test)] { if TEST_NOW.load(std::sync::atomic::Ordering::Relaxed) != 0 { return TEST_NOW.fetch_add(1, std::sync::atomic::Ordering::Relaxed); } }
    millis()
}
fn mint_id(taken: impl Fn(&str) -> bool) -> Option<String> {
    #[cfg(test)] { if TEST_NOW.load(std::sync::atomic::Ordering::Relaxed) != 0 {
        for _ in 0..64 { let c = TEST_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1; let id = format!("{c:08}"); if !taken(&id) { return Some(id); } }
        return None;
    } }
    fresh_id(4, taken)
}

const MAX_CONVS: usize = 20;
const MAX_CONV_MSGS: usize = 100;
const MAX_CHARS: usize = 4000;

#[derive(Serialize, Deserialize, Clone)]
pub struct Msg {
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Conv {
    pub id: String,
    pub title: String,
    pub messages: Vec<Msg>,
    pub at: i64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub custom: Option<bool>,
}

fn file(data_dir: &std::path::Path) -> std::path::PathBuf { data_dir.join("sage-conversations.json") }

fn load(f: &std::path::Path, user: &str) -> Result<(Value, Vec<Conv>), Response> {
    let all = match read_store(f) {
        StoreRead::Missing => serde_json::json!({}),
        StoreRead::Corrupt => return Err(io_fail()),        
        StoreRead::Ok(v) => v,
    };
    let list: Vec<Conv> = match all.get(user) {
        None => vec![],
        Some(v) if !v.is_array() => return Err(io_fail()),                                       
        Some(v) => serde_json::from_value(v.clone()).map_err(|_| io_fail())?,                             
    };
    Ok((all, list))
}

fn commit(f: &std::path::Path, mut all: Value, user: &str, list: &[Conv]) -> Result<(), Response> {
    all[user] = serde_json::to_value(list).unwrap();
    write_json(f, &all).map_err(|_| io_fail())
}

                                                                                         
                                                                                         
                                                                                            
fn clean_messages(v: &Value) -> Option<Vec<Msg>> {
    let arr = v.as_array()?;
    let mut out = Vec::new();
    for m in arr.iter().take(MAX_CONV_MSGS) {
        let role = m["role"].as_str().unwrap_or("");
        if role != "user" && role != "assistant" { continue; }
        let content = js_string(&m["content"]);
        if js_len16(&content) > MAX_CHARS || js_trim(&content).is_empty() { continue; }                
        out.push(Msg { role: role.to_string(), content });
    }
    Some(out)
}

fn gone404() -> Response { json_err(StatusCode::NOT_FOUND, "that conversation is gone") }

pub async fn handle(st: &crate::AppState, user: &str, method: &str, sub: &str, query_id: Option<&str>, body: &[u8]) -> Response {
                                                                            
                                                                      
    if method == "POST" && sub == "/chat" { return chat(st, user, body).await; }
    store_handle(&st.data_dir, user, method, sub, query_id, body)
}

                                                                                                                         
pub fn store_handle(data_dir: &std::path::Path, user: &str, method: &str, sub: &str, query_id: Option<&str>, body: &[u8]) -> Response {
    let f = file(data_dir);
    let _m = store_mutex(&f);
    let _g = match _m.lock() { Ok(g) => g, Err(_) => return io_fail() };                         
    match (method, sub) {
        ("GET", "/conversations") => {
            let (_, list) = match load(&f, user) { Ok(x) => x, Err(r) => return r };
                                                                                           
                                                                             
            let arr: Vec<OJ> = list.iter().map(|c| OJ::Raw(format!(
                "{{\"id\":{},\"title\":{},\"count\":{},\"at\":{}}}",
                serde_json::to_string(&c.id).unwrap(), serde_json::to_string(&c.title).unwrap(),
                c.messages.len(), c.at))).collect();
            json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("conversations", OJ::Arr(arr))])
        }
        ("GET", "/conversations/messages") => {
            let id = js_trim(query_id.unwrap_or(""));                
            let (_, list) = match load(&f, user) { Ok(x) => x, Err(r) => return r };
            let Some(c) = list.iter().find(|c| c.id == id) else { return gone404() };
                                                                      
            json_ord(StatusCode::OK, vec![
                ("ok", OJ::Bool(true)),
                ("conversation", OJ::Raw(format!("{{\"id\":{},\"title\":{},\"messages\":{}}}",
                    serde_json::to_string(&c.id).unwrap(), serde_json::to_string(&c.title).unwrap(),
                    serde_json::to_string(&c.messages).unwrap()))),
            ])
        }
        ("POST", "/conversations") => {
                                                                                              
            let b = match parse_body2(body, 65536) { Ok(v) => v.unwrap_or_else(|| serde_json::json!({})), Err(BodyErr::TooLarge) => return too_large() };
            let Some(messages) = clean_messages(&b["messages"]) else { return json_err(StatusCode::BAD_REQUEST, "nothing to save yet") };
            if messages.is_empty() { return json_err(StatusCode::BAD_REQUEST, "nothing to save yet"); }
            let (all, mut list) = match load(&f, user) { Ok(x) => x, Err(r) => return r };
                                                                                      
            let first_user = messages.iter().find(|m| m.role == "user");
            let title = js_slice16(js_trim(&js_ws_collapse(first_user.map(|m| m.content.as_str()).unwrap_or("conversation"))), 60).to_string();                
                                                                                                    
            let cid = js_string(&b["id"]);
            let id = if cid.len() == 8 && cid.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
                cid
            } else {
                let Some(x) = mint_id(|x| list.iter().any(|c| c.id == x)) else { return io_fail() };       
                x
            };
            let now = now_ms();
            if let Some(c) = list.iter_mut().find(|c| c.id == id) {
                c.messages = messages;
                if c.custom != Some(true) { c.title = title; }
                c.at = now;
            } else {
                list.insert(0, Conv { id: id.clone(), title, messages, at: now, custom: None });
            }
            list.sort_by(|a, b| b.at.cmp(&a.at));
            list.truncate(MAX_CONVS);                                          
            if commit(&f, all, user, &list).is_err() { return io_fail(); }
                                         
            json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("id", OJ::Str(id))])
        }
        ("POST", "/conversations/delete") => {
            let b = match parse_body2(body, 65536) { Ok(v) => v.unwrap_or_else(|| serde_json::json!({})), Err(BodyErr::TooLarge) => return too_large() };
            let (all, list) = match load(&f, user) { Ok(x) => x, Err(r) => return r };
            let before = all[user].as_array().map(|a| a.len()).unwrap_or(0);
            let id = js_string(&b["id"]);
            let kept: Vec<Conv> = list.into_iter().filter(|c| c.id != id).collect();
            if kept.len() == before { return gone404() }
            if commit(&f, all, user, &kept).is_err() { return io_fail(); }
            super::ok_true()
        }
        ("POST", "/conversations/rename") => {
            let b = match parse_body2(body, 65536) { Ok(v) => v.unwrap_or_else(|| serde_json::json!({})), Err(BodyErr::TooLarge) => return too_large() };
            let title = js_slice16(js_trim(&js_ws_collapse(&js_string(&b["title"]))), 60).to_string();                
            if title.is_empty() { return json_err(StatusCode::BAD_REQUEST, "give it a name"); }
            let (all, mut list) = match load(&f, user) { Ok(x) => x, Err(r) => return r };
            let id = js_string(&b["id"]);
            let Some(c) = list.iter_mut().find(|c| c.id == id) else { return gone404() };
            c.title = title;
            c.custom = Some(true);                                                                        
            if commit(&f, all, user, &list).is_err() { return io_fail(); }
            super::ok_true()
        }
        ("POST", "/conversations/clear") => {
                                                                                                 
            if body.len() > 65536 { return too_large(); }
            let (all, _) = match load(&f, user) { Ok(x) => x, Err(r) => return r };
            if commit(&f, all, user, &[]).is_err() { return io_fail(); }
            super::ok_true()
        }
        _ => json_err(StatusCode::NOT_FOUND, "unknown sage call"),
    }
}

                                                                   
                                                                             
                                                                        
                                                                            
                                                                          
                                                                     
                                                                                 
                                                                                   
                                                    
                                                                                              
                                                            
                                                                             
                                                                                
                                                                    
                                                                                      
                                                                                         
                                                                                            
const MAX_TURNS: usize = 40;

                                                                                     
                                                                                  
                                                                                 
                                      
pub fn chat_validate(body: &[u8]) -> Result<Vec<Msg>, Response> {
                                                                              
                                                                              
                                                                              
                                                                              
    if body.len() > 65536 { return Err(too_large()); }
    let s = String::from_utf8_lossy(body);
                                                                             
                                                                                  
                                                                                       
    let b: Value = if s.is_empty() { serde_json::json!({}) } else {
        match serde_json::from_str(&s) { Ok(v) => v, Err(_) => return Err(crate::lite::json_err(StatusCode::BAD_REQUEST, "bad request")) }
    };
                                                                                        
    let messages: Vec<Value> = match &b["messages"] { Value::Array(a) => a.clone(), _ => vec![] };
    if messages.is_empty() || messages.len() > MAX_TURNS {
        return Err(crate::lite::json_err(StatusCode::BAD_REQUEST, "bad conversation"));
    }
                                                                               
                                                                                   
                                                                             
                                  
    let mut clean: Vec<Msg> = Vec::new();
    for m in &messages {
        let role = m["role"].as_str().unwrap_or("");
        if role != "user" && role != "assistant" { continue; }
        let content = js_string(&m["content"]);
        if js_len16(&content) > MAX_CHARS {
            return Err(crate::lite::json_err(StatusCode::BAD_REQUEST, "keep messages under 4,000 characters"));
        }
        if !js_trim(&content).is_empty() { clean.push(Msg { role: role.to_string(), content }); }                
    }
                                                                        
    if clean.is_empty() || clean.last().map(|m| m.role.as_str()) != Some("user") {
        return Err(crate::lite::json_err(StatusCode::BAD_REQUEST, "bad conversation"));
    }
    Ok(clean)                                              
}

                                                                
                                                                              
                                                                              
                                                                               
                                                                       
                                                                               
                                                                             
                                                                          
const SYSTEM: &str = "You are sage, the assistant inside ramjet. Answer directly and plainly, like a smart friend - no corporate filler, no \"as an AI\". Short answers for short questions; longer only when the question needs it. Plain text, minimal markdown.";
const POLLINATIONS_URL: &str = "https://text.pollinations.ai/";
const STREAM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);                     
const PLAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);                        
const MAX_REPLY_BYTES: usize = 4 * 1024 * 1024;                                                         

fn sys_for(style: &str) -> String {
    match style {
        "brief" => format!("{SYSTEM} Keep every answer to a few sentences at most unless asked for more."),
        "deep" => format!("{SYSTEM} Go thorough: explain the reasoning, give examples, and cover edge cases."),
        _ => SYSTEM.to_string(),
    }
}

                                                                                                                                   
fn provider_error_code(body: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(body).ok()?;
    v.pointer("/error/code").and_then(|c| c.as_str()).map(|s| s.to_string())
}
const RESTRICTED_MSG: &str = "sage's model provider has restricted this account - a retry won't fix it, it needs the owner";

struct Provider { base: String, key: String, model: Option<String> }
fn provider(data_dir: &std::path::Path) -> Option<Provider> {
    let bytes = std::fs::read(data_dir.join("sage-provider.json")).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    let base = v["base"].as_str()?.trim_end_matches('/').to_string();
    let key = v["key"].as_str()?.to_string();
    if base.is_empty() || key.is_empty() { return None; }
    Some(Provider { base, key, model: v["model"].as_str().map(|s| s.to_string()) })
}

async fn chat(st: &crate::AppState, user: &str, body: &[u8]) -> Response {
    let clean = match chat_validate(body) { Err(r) => return r, Ok(c) => c };
    let parsed: Value = serde_json::from_slice(body).unwrap_or_else(|_| serde_json::json!({}));
    let want_stream = parsed["stream"].as_bool().unwrap_or(false);
    let sys = sys_for(parsed["style"].as_str().unwrap_or(""));
    let mut messages = Vec::with_capacity(clean.len() + 1);
    messages.push(serde_json::json!({"role": "system", "content": sys}));
    for m in &clean { messages.push(serde_json::json!({"role": m.role, "content": m.content})); }
    let (url, key, model) = match provider(&st.data_dir) {
        Some(p) => (format!("{}/chat/completions", p.base), Some(p.key), p.model.unwrap_or_else(|| "openai/gpt-oss-120b".to_string())),
        None => (POLLINATIONS_URL.to_string(), None, "openai".to_string()),
    };
    let use_sse = want_stream && key.is_some();
    let payload = if key.is_some() {
        if use_sse { serde_json::json!({"model": model, "messages": messages, "max_tokens": 2048, "temperature": 0.7, "stream": true}) }
        else { serde_json::json!({"model": model, "messages": messages, "max_tokens": 2048, "temperature": 0.7}) }                                            
    } else {
        serde_json::json!({"model": model, "messages": messages, "private": true})                                         
    };

    let mut mapped: Option<(u16, Option<String>)> = None;
    let mut resp = None;
    let mut restricted = false;
    let attempts = if use_sse { 1 } else { 2 };                                                                              
    for attempt in 0..attempts {
        if attempt == 1 { tokio::time::sleep(std::time::Duration::from_millis(1200)).await; }
        let eg = match st.egress() { Ok(c) => c, Err(_) => continue };
        let mut req = eg.post(&url).timeout(if use_sse { STREAM_TIMEOUT } else { PLAIN_TIMEOUT }).json(&payload);
        if let Some(k) = &key { req = req.header("authorization", format!("Bearer {k}")); }
        match req.send().await {
            Ok(r) if r.status().is_success() => { resp = Some(r); break; }
            Ok(r) => {
                let code = r.status().as_u16();
                if code == 402 || code == 429 {
                    let ra = r.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
                    mapped = Some((code, ra));
                    break;
                }
                                                                                                                                          
                if code == 400 || code == 403 {
                    if let Ok(b) = super::amp_media::read_capped(r, 8 * 1024).await {
                        if provider_error_code(&b).as_deref() == Some("organization_restricted") { restricted = true; break; }
                    }
                }
            }
            Err(_) => {}
        }
    }
    if restricted { return json_err(StatusCode::BAD_GATEWAY, RESTRICTED_MSG); }
    if let Some((code, ra)) = mapped {
        if code == 402 { return json_err(StatusCode::BAD_GATEWAY, "sage is resting - the free model hit its daily limit, back soon"); }
        let n = ra.as_deref().and_then(|v| v.parse::<f64>().ok()).map(|f| f.ceil() as i64).unwrap_or(10).clamp(1, 120);
        return json_err(StatusCode::TOO_MANY_REQUESTS, &format!("sage is busy right now - give it about {n} seconds"));
    }
    let Some(resp) = resp else { return json_err(StatusCode::BAD_GATEWAY, "couldn't reach the model - try again"); };

    if use_sse { return sse_relay(st, user, resp); }
    let bytes = match resp.bytes().await { Ok(b) => b, Err(_) => return json_err(StatusCode::BAD_GATEWAY, "couldn't reach the model - try again") };
    if bytes.len() > MAX_REPLY_BYTES { return json_err(StatusCode::BAD_GATEWAY, "couldn't reach the model - try again") };
    let reply = if key.is_some() {
        let v: Value = match serde_json::from_slice(&bytes) { Ok(v) => v, Err(_) => return json_err(StatusCode::BAD_GATEWAY, "couldn't reach the model - try again") };
        v["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string()                 
    } else {
        String::from_utf8_lossy(&bytes).trim().to_string()                                       
    };
    if reply.trim().is_empty() { return json_err(StatusCode::BAD_GATEWAY, "the model said nothing - try again"); }
    st.guard.track_bytes(&st.data_dir.to_string_lossy(), user, super::js_len16(&reply) as i64);                              
    json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("reply", OJ::Str(reply))])
}

                                                                              
                                                                           
                                                                             
fn sse_relay(st: &crate::AppState, user: &str, resp: reqwest::Response) -> Response {
    use futures::{SinkExt, StreamExt};
    let (mut tx, rx) = futures::channel::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(16);
    let guard = st.guard.clone();
    let dd = st.data_dir.to_string_lossy().into_owned();
    let u = user.to_string();
    tokio::spawn(async move {
        let mut upstream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        let mut total = String::new();
        let mut capped = false;
        'outer: while let Some(chunk) = upstream.next().await {
            let Ok(c) = chunk else { break };
            buf.extend_from_slice(&c);
            while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buf.drain(..=nl).collect();
                let line = String::from_utf8_lossy(&line);
                let line = line.trim_end_matches(['\r', '\n']);
                let Some(data) = line.strip_prefix("data:") else { continue };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" { continue; }
                let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                let delta = v["choices"][0]["delta"]["content"].as_str().unwrap_or("");
                if delta.is_empty() { continue; }
                total.push_str(delta);
                let frame = format!("data: {}\n\n", serde_json::to_string(&serde_json::json!({"t": delta})).unwrap());
                if tx.send(Ok(axum::body::Bytes::from(frame))).await.is_err() { break 'outer; }
                if total.len() > MAX_REPLY_BYTES { capped = true; break 'outer; }                                                                             
            }
            if buf.len() > (256 << 10) { break; }                                                                                                            
        }
                                                                                       
                                                                                     
                                                                                          
        let frame = if capped {
            format!("data: {}\n\n", serde_json::to_string(&serde_json::json!({"error": "that reply hit the size cap - try a narrower question"})).unwrap())
        } else if total.is_empty() {
            format!("data: {}\n\n", serde_json::to_string(&serde_json::json!({"error": "the model said nothing - try again"})).unwrap())
        } else { "data: {\"done\":true}\n\n".to_string() };
        let _ = tx.send(Ok(axum::body::Bytes::from(frame))).await;
        guard.track_bytes(&dd, &u, super::js_len16(&total) as i64);                          
    });
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "text/event-stream; charset=utf-8"), (axum::http::header::CACHE_CONTROL, "no-store"), (axum::http::header::HeaderName::from_static("x-accel-buffering"), "no")],
        axum::body::Body::from_stream(rx),
    ).into_response()
}

#[cfg(test)]
mod relay_tests {
    use super::*;
    #[test]
    fn styles_suffix_only_brief_deep() {
        assert_eq!(sys_for("normal"), SYSTEM);
        assert_eq!(sys_for(""), SYSTEM);
        assert_eq!(sys_for("weird"), SYSTEM);
        assert_eq!(sys_for("brief"), format!("{SYSTEM} Keep every answer to a few sentences at most unless asked for more."));
        assert_eq!(sys_for("deep"), format!("{SYSTEM} Go thorough: explain the reasoning, give examples, and cover edge cases."));
    }
    #[test]
    fn provider_error_code_recognises_org_restriction_only_by_code() {
        let b = br#"{"error":{"message":"Your organization has been restricted.","type":"invalid_request_error","code":"organization_restricted"}}"#;
        assert_eq!(provider_error_code(b).as_deref(), Some("organization_restricted"));
        assert_eq!(provider_error_code(br#"{"error":{"code":"invalid_api_key"}}"#).as_deref(), Some("invalid_api_key"));
        assert_eq!(provider_error_code(br#"{"error":{"message":"organization_restricted"}}"#), None);                            
        assert_eq!(provider_error_code(b"not json"), None);
        assert_eq!(provider_error_code(br#"{"error":"organization_restricted"}"#), None);
        assert!(!RESTRICTED_MSG.contains("key") && RESTRICTED_MSG.contains("retry"));
    }
    #[test]
    fn provider_requires_base_and_key() {
        let d = std::env::temp_dir().join(format!("sage-prov-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        assert!(provider(&d).is_none());                           
        std::fs::write(d.join("sage-provider.json"), r#"{"base":"https://x.example/v1"}"#).unwrap();
        assert!(provider(&d).is_none());                     
        std::fs::write(d.join("sage-provider.json"), r#"{"base":"https://x.example/v1/","key":"k","model":"m"}"#).unwrap();
        let p = provider(&d).unwrap();
        assert_eq!(p.base, "https://x.example/v1");                          
        assert_eq!(p.model.as_deref(), Some("m"));
        let _ = std::fs::remove_dir_all(&d);
    }


                                                                                                                                    
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering::SeqCst}};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn http_resp(status: &str, body: &[u8]) -> Vec<u8> {
        let mut v = format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len()).into_bytes();
        v.extend_from_slice(body); v
    }
                                                                                               
    async fn stub(responses: Vec<Vec<u8>>) -> (u16, Arc<AtomicUsize>) {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = l.accept().await else { return };
                let i = n2.fetch_add(1, SeqCst);
                let resp = responses[i.min(responses.len() - 1)].clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new(); let mut tmp = [0u8; 4096];
                    let (mut hdr_end, mut clen) = (None, 0usize);
                    loop {
                        let Ok(k) = sock.read(&mut tmp).await else { return };
                        if k == 0 { break; }
                        buf.extend_from_slice(&tmp[..k]);
                        if hdr_end.is_none() {
                            if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                hdr_end = Some(p + 4);
                                let h = String::from_utf8_lossy(&buf[..p]).to_ascii_lowercase();
                                clen = h.lines().find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse().ok())).unwrap_or(0);
                            }
                        }
                        if let Some(e) = hdr_end { if buf.len() >= e + clen { break; } }
                    }
                    let _ = sock.write_all(&resp).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (port, n)
    }
    fn sage_state(port: u16) -> crate::AppState {
        let mut st = crate::auth_api::devices::tests::fixture("sage-restricted-fixture");
        st.egress_client = Some(reqwest::Client::builder().no_proxy().build().unwrap());                                                          
        std::fs::write(st.data_dir.join("sage-provider.json"), format!(r#"{{"base":"http://127.0.0.1:{port}/v1","key":"test-key","model":"m"}}"#)).unwrap();
        st
    }
    async fn run_chat(port: u16, stream: bool) -> (StatusCode, String) {
        let st = sage_state(port);
        let body = format!(r#"{{"messages":[{{"role":"user","content":"hi"}}],"stream":{stream}}}"#);
        let r = chat(&st, "sage-restricted-fixture", body.as_bytes()).await;
        let status = r.status();
        let b = axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8_lossy(&b).to_string())
    }
    const RESTRICTED_BODY: &str = r#"{"error":{"message":"Your organization has been restricted.","type":"invalid_request_error","code":"organization_restricted"}}"#;
    const GENERIC: &str = "couldn't reach the model - try again";

    #[tokio::test]
    async fn restricted_400_and_403_zero_retries_honest_error() {
        for code in ["400 Bad Request", "403 Forbidden"] {
            let (port, n) = stub(vec![http_resp(code, RESTRICTED_BODY.as_bytes())]).await;
            let (st, body) = run_chat(port, false).await;
            assert_eq!(st, StatusCode::BAD_GATEWAY, "{code}");
            assert!(body.contains(RESTRICTED_MSG), "{code}: {body}");
            assert!(!body.contains(GENERIC) && !body.contains("test-key") && !body.contains("organization has been"), "{code}: {body}");
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;                                               
            assert_eq!(n.load(SeqCst), 1, "{code}: exactly one upstream request");
        }
    }
    #[tokio::test]
    async fn other_400_keeps_generic_error_and_one_retry() {
        let (port, n) = stub(vec![http_resp("400 Bad Request", br#"{"error":{"code":"invalid_api_key","message":"bad"}}"#)]).await;
        let (st, body) = run_chat(port, false).await;
        assert_eq!(st, StatusCode::BAD_GATEWAY);
        assert!(body.contains(GENERIC), "{body}");
        assert_eq!(n.load(SeqCst), 2, "plain leg still retries once (real 1200ms)");
    }
    #[tokio::test]
    async fn sse_restricted_one_request_no_retry() {
        let (port, n) = stub(vec![http_resp("400 Bad Request", RESTRICTED_BODY.as_bytes())]).await;
        let (st, body) = run_chat(port, true).await;
        assert_eq!(st, StatusCode::BAD_GATEWAY);
        assert!(body.contains(RESTRICTED_MSG), "{body}");
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        assert_eq!(n.load(SeqCst), 1);
    }
    #[tokio::test]
    async fn oversize_body_over_8kb_is_not_restriction_prior_generic_behavior() {
                                                                                                     
        let big = format!(r#"{{"error":{{"code":"organization_restricted","message":"{}"}}}}"#, "x".repeat(9000));
        assert!(big.len() > 8 * 1024);
        let (port, n) = stub(vec![http_resp("400 Bad Request", big.as_bytes())]).await;
        let (st, body) = run_chat(port, false).await;
        assert_eq!(st, StatusCode::BAD_GATEWAY);
        assert!(body.contains(GENERIC) && !body.contains(RESTRICTED_MSG), "{body}");
        assert_eq!(n.load(SeqCst), 2);
    }
    #[tokio::test]
    async fn body_read_error_keeps_prior_generic_behavior() {
                                                                                                            
        let mut short = b"HTTP/1.1 400 Bad Request\r\ncontent-length: 500\r\nconnection: close\r\n\r\n".to_vec();
        short.extend_from_slice(b"{\"error\":{\"code\":\"or");
        let (port, n) = stub(vec![short]).await;
        let (st, body) = run_chat(port, false).await;
        assert_eq!(st, StatusCode::BAD_GATEWAY);
        assert!(body.contains(GENERIC) && !body.contains(RESTRICTED_MSG), "{body}");
        assert_eq!(n.load(SeqCst), 2);
    }
    #[tokio::test]
    async fn read_capped_actual_behavior_at_the_cap() {
                                                                                     
        for (len, expect_ok) in [(8 * 1024usize, true), (8 * 1024 + 1, false)] {
            let (port, _n) = stub(vec![http_resp("200 OK", &vec![b'a'; len])]).await;
            let r = reqwest::Client::builder().no_proxy().build().unwrap().get(format!("http://127.0.0.1:{port}/")).send().await.unwrap();
            let got = super::super::amp_media::read_capped(r, 8 * 1024).await;
            assert_eq!(got.is_ok(), expect_ok, "len {len}");
            if let Ok(b) = got { assert_eq!(b.len(), len); }
        }
    }

    fn form_decode(s: &str) -> String {
        let b = s.as_bytes(); let mut out = Vec::with_capacity(b.len()); let mut i = 0;
        while i < b.len() {
            match b[i] {
                b'%' if i + 3 <= b.len() => { out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap_or(b'%')); i += 3; }
                b'+' => { out.push(b' '); i += 1; }
                c => { out.push(c); i += 1; }
            }
        }
        String::from_utf8(out).unwrap_or_default()
    }

                                                                                                      
                                                                                                     
                                                              
    #[tokio::test]
    async fn golden_sage_conversations_battery() {
        use std::sync::atomic::Ordering::Relaxed;
        TEST_NOW.store(1760000000000, Relaxed);
        TEST_SEQ.store(0, Relaxed);
        static CTR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!("sagebat-{}-{}", std::process::id(), CTR.fetch_add(1, Relaxed)));
        std::fs::remove_dir_all(&d).ok(); std::fs::create_dir_all(&d).unwrap();
        let cases: Value = serde_json::from_str(include_str!("sage_conv_golden.json")).unwrap();
        for (i, c) in cases.as_array().unwrap().iter().enumerate() {
            let name = c["name"].as_str().unwrap();
                                                                                                                 
            if name == "cap 20 convs, newest first (list)" {
                for j in 0..25 {
                    let r = store_handle(&d, "cap", "POST", "/conversations", None, format!("{{\"messages\":[{{\"role\":\"user\",\"content\":\"m{j}\"}}]}}").as_bytes());
                    assert_eq!(r.status(), StatusCode::OK, "cap setup save {j}");
                }
            }
            let raw_path = c["path"].as_str().unwrap();
            let (sub, q) = match raw_path.split_once('?') { Some((p, q)) => (p, Some(q)), None => (raw_path, None) };
            let qid = q.and_then(|q| q.split('&').find_map(|p| p.split_once('=').filter(|(k, _)| *k == "id").map(|(_, v)| form_decode(v))));
            let body = c["body"].as_str().unwrap_or("").as_bytes().to_vec();
            let r = store_handle(&d, c["user"].as_str().unwrap(), c["method"].as_str().unwrap(), sub, qid.as_deref(), &body);
            let e = &c["expect"];
            assert_eq!(r.status().as_u16(), e["status"].as_u64().unwrap() as u16, "case {} ({name}) status", i + 1);
            let bytes = axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap();
            let got = String::from_utf8(bytes.to_vec()).unwrap();
            if let Some(exp) = e["body"].as_str() {
                assert_eq!(got, exp, "case {} ({name}) body", i + 1);
            } else {
                assert_eq!(got.len(), e["bodyLen"].as_u64().unwrap() as usize, "case {} ({name}) bodyLen", i + 1);
                use sha2::Digest;
                let h = sha2::Sha256::digest(got.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>();
                assert_eq!(h, e["bodySha256"].as_str().unwrap(), "case {} ({name}) bodySha256", i + 1);
                assert!(got.starts_with(e["head"].as_str().unwrap()), "case {} ({name}) head", i + 1);
            }
        }
        TEST_NOW.store(0, Relaxed);
        std::fs::remove_dir_all(&d).ok();
    }
}
