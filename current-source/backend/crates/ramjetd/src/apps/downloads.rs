                                                                             
                                                                                 
                                                          
   
                                                                                
                                                                          
                                                                                 
                                                                              
                                                                                
                                                                                
                                                                          
                                                                                
                                                                             
                                                                            
                                                                              
   
                                                                          
                                                                                               
                                                                            
                                                                          
                                                         

use axum::http::StatusCode;
use axum::response::Response;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use crate::lite::{json_ord, json_err, OJ};

pub const TTL_MS: i64 = 5 * 60 * 1000;                                                     
pub const MAX_FILE: u64 = 150 * 1024 * 1024;                                       
pub const MAX_USER: u64 = 500 * 1024 * 1024;                                       
pub const MAX_GLOBAL: u64 = 1024 * 1024 * 1024;                                    
pub const MIN_FREE: u64 = 2 * 1024 * 1024 * 1024;                                                              

#[derive(Clone, PartialEq, Debug)]
enum St { Fetching, Ready, Failed }
struct Item {
    name: String,
    st: St,
    size: u64,
    expires_at: i64,                                                                                   
    abort: Arc<AtomicBool>,
    sess: String,                                                                                     
    decl: Option<u64>,                                                                         
}
static REG: OnceLock<Mutex<HashMap<String, Vec<(String, Item)>>>> = OnceLock::new();
fn reg() -> &'static Mutex<HashMap<String, Vec<(String, Item)>>> { REG.get_or_init(|| Mutex::new(HashMap::new())) }
fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Vec<(String, Item)>>> { reg().lock().unwrap_or_else(|e| e.into_inner()) }

fn dir(data_dir: &Path, user: &str) -> PathBuf { data_dir.join("downloads").join(user) }

                                                                                 
fn fs_free(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 { return None; }
    Some(st.f_bavail as u64 * (st.f_frsize as u64).max(1))
}

fn clean_name(raw: &str) -> String {
    let mut n: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '-' }).take(80).collect();
    while n.starts_with('.') { n.remove(0); }
    if n.is_empty() { n = "file".into(); }
    n
}
fn name_from_url(u: &url::Url) -> String {
    let seg = u.path_segments().and_then(|mut s| s.next_back()).unwrap_or("");
    let dec = url::form_urlencoded::parse(seg.as_bytes()).next().map(|(k, _)| k.into_owned()).unwrap_or_else(|| seg.to_string());
    clean_name(&dec)
}

pub enum Fetcher { Lane(Arc<crate::AppState>), #[cfg(test)] Direct }

                                                                 

pub async fn enqueue(st: Arc<crate::AppState>, user: &str, body: &[u8]) -> Response {
    let v: Value = match serde_json::from_slice(body) { Ok(v) => v, Err(_) => return json_err(StatusCode::BAD_REQUEST, "bad json") };
    let url = super::js_trim(&super::js_string(&v["url"])).to_string();
    if url.is_empty() || url.len() > 2048 || crate::lite::ssrf::check_url(&url).is_err() { return json_err(StatusCode::BAD_REQUEST, "bad url"); }
    match enqueue_core(Fetcher::Lane(st.clone()), &st.data_dir, user, &url, TTL_MS, MAX_USER, MAX_GLOBAL, MIN_FREE).await {
        Ok(id) => json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("id", OJ::Str(id))]),
        Err(r) => r,
    }
}

                                                                                       
                                                                                 
fn purge_expired(data_dir: &Path) {
    let now = super::millis();
    let dead: Vec<(String, String)> = {
        let g = lock();
        g.iter().flat_map(|(u, v)| v.iter().filter(|(_, it)| it.expires_at > 0 && it.expires_at <= now).map(|(i, _)| (u.clone(), i.clone()))).collect()
    };
    for (u, i) in dead { remove_item(data_dir, &u, &i, false); }
}

pub fn list(data_dir: &Path, user: &str) -> Response {
    purge_expired(data_dir);
    let g = lock();
    let items = g.get(user).map(|v| v.iter().map(|(id, it)| {
        let (s, left) = match it.st {
            St::Fetching => ("fetching", OJ::Null),
            St::Ready => ("ready", OJ::Num((it.expires_at - super::millis()).max(0))),
            St::Failed => ("failed", OJ::Null),
        };
        OJ::Obj(vec![("id".into(), OJ::Str(id.clone())), ("name".into(), OJ::Str(it.name.clone())), ("state".into(), OJ::Str(s.into())), ("size".into(), OJ::U64(it.size)), ("expires_in_ms".into(), left)])
    }).collect()).unwrap_or_default();
    json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("items", OJ::Arr(items))])
}

pub async fn file(data_dir: &Path, user: &str, query: &HashMap<String, String>) -> Response {
    purge_expired(data_dir);
    let id = query.get("id").map(|s| s.as_str()).unwrap_or("");
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return json_err(StatusCode::NOT_FOUND, "not found"); }
    let (name, path) = {
        let g = lock();
        match g.get(user).and_then(|v| v.iter().find(|(i, _)| i.as_str() == id)) {
            Some((_, it)) if it.st == St::Ready => (it.name.clone(), dir(data_dir, user).join(id)),
            _ => return json_err(StatusCode::NOT_FOUND, "not found"),                                                                
        }
    };                                           
    let f = match tokio::fs::File::open(&path).await { Ok(f) => f, Err(_) => return json_err(StatusCode::NOT_FOUND, "not found") };
                                                                             
    let size = f.metadata().await.map(|m| m.len()).unwrap_or(0);
                                                                                         
                                                                                       
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
    let stream = futures::stream::try_unfold((f, vec![0u8; 65536]), move |(mut f, mut buf)| async move {
        use tokio::io::AsyncReadExt;
        if std::time::Instant::now() >= deadline { return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "save window ended")); }
        match f.read(&mut buf).await {
            Ok(0) => Ok(None),
            Ok(n) => Ok(Some((buf[..n].to_vec(), (f, buf)))),
            Err(e) => Err(e),
        }
    });
    let mut r = Response::new(axum::body::Body::from_stream(stream));
    let h = r.headers_mut();
    h.insert("content-type", "application/octet-stream".parse().unwrap());
    h.insert("content-length", size.to_string().parse().unwrap());
    h.insert("content-disposition", format!("attachment; filename=\"{name}\"").parse().unwrap());
    h.insert("cache-control", "no-store".parse().unwrap());
    h.insert("x-content-type-options", "nosniff".parse().unwrap());
    r
}

pub fn cancel(user: &str, body: &[u8], data_dir: &Path) -> Response {
    let v: Value = match serde_json::from_slice(body) { Ok(v) => v, Err(_) => return json_err(StatusCode::BAD_REQUEST, "bad json") };
    let id = super::js_trim(&super::js_string(&v["id"])).to_string();
    remove_item(data_dir, user, &id, true);
    super::ok_true()
}

                                                                               

async fn enqueue_core(f: Fetcher, data_dir: &Path, user: &str, url: &str, ttl_ms: i64, max_user: u64, max_global: u64, min_free: u64) -> Result<String, Response> {
                                                                                    
                                                                                 
                                                                                  
    let parsed = match &f {
        Fetcher::Lane(_) => crate::lite::ssrf::check_url(url).map_err(|_| json_err(StatusCode::BAD_REQUEST, "bad url"))?,
        #[cfg(test)]
        Fetcher::Direct => url::Url::parse(url).map_err(|_| json_err(StatusCode::BAD_REQUEST, "bad url"))?,
    };
    let name = name_from_url(&parsed);
    let d = dir(data_dir, user);
    {
                                                                                                       
        let mut g = lock();
        let mine = g.get(user).map(|v| v.as_slice()).unwrap_or(&[]);
        if mine.iter().any(|(_, it)| it.st == St::Fetching) { return Err(json_err(StatusCode::TOO_MANY_REQUESTS, "finish the one that's already going")); }
        let used: u64 = mine.iter().filter(|(_, it)| it.st == St::Ready).map(|(_, it)| it.size).sum();
        if used >= max_user { return Err(json_err(StatusCode::PAYLOAD_TOO_LARGE, "no room left in your download inbox")); }
        let total: u64 = g.values().flatten().filter(|(_, it)| it.st == St::Ready).map(|(_, it)| it.size).sum();
        if total >= max_global { return Err(json_err(StatusCode::SERVICE_UNAVAILABLE, "the download inbox is full - try again in a few minutes")); }
        let taken: std::collections::HashSet<String> = g.values().flatten().map(|(i, _)| i.clone()).collect();
        let id = super::fresh_id(16, |cand| taken.contains(cand)).ok_or_else(super::io_fail)?;
                                                                                                      
        let in_flight: u64 = g.values().flatten().filter(|(_, it)| it.st == St::Fetching).count() as u64;
        let need = min_free.saturating_add(in_flight.saturating_add(1).saturating_mul(MAX_FILE));
        if fs_free(data_dir).map(|a| a < need).unwrap_or(true) { return Err(json_err(StatusCode::SERVICE_UNAVAILABLE, "no room on the server right now")); }
        if std::fs::create_dir_all(&d).is_err() { return Err(super::io_fail()); }
        g.entry(user.to_string()).or_default().push((id.clone(), Item { name, st: St::Fetching, size: 0, expires_at: 0, abort: Arc::new(AtomicBool::new(false)), sess: String::new(), decl: None }));
        let dd = data_dir.to_path_buf();
        let u = user.to_string();
        let i = id.clone();
        let url = url.to_string();
        tokio::spawn(async move { run_fetch(f, dd, u, i, url, ttl_ms, MAX_FILE).await; });
        return Ok(id);
    }
}

async fn run_fetch(f: Fetcher, data_dir: PathBuf, user: String, id: String, url: String, ttl_ms: i64, max_file: u64) {
                                                                                              
    if tokio::time::timeout(std::time::Duration::from_secs(600), run_fetch_inner(f, data_dir.clone(), user.clone(), id.clone(), url, ttl_ms, max_file)).await.is_err() {
        let part = dir(&data_dir, &user).join(format!("{id}.part"));
        let _ = std::fs::remove_file(&part);
        let mut g = lock();
        if let Some(v) = g.get_mut(&user) { if let Some((_, it)) = v.iter_mut().find(|(i, _)| i == &id) { if it.st == St::Fetching { it.st = St::Failed; it.expires_at = super::millis() + ttl_ms; } } }
    }
}
async fn run_fetch_inner(f: Fetcher, data_dir: PathBuf, user: String, id: String, url: String, ttl_ms: i64, max_file: u64) {
    let d = dir(&data_dir, &user);
    let part = d.join(format!("{id}.part"));
    let done = d.join(&id);
    let fail = |user: &str, id: &str| {
        let _ = std::fs::remove_file(&part);
        let mut g = lock();
        if let Some(v) = g.get_mut(user) { if let Some((_, it)) = v.iter_mut().find(|(i, _)| i == id) { it.st = St::Failed; it.expires_at = super::millis() + ttl_ms; } }
    };
    let abort = { let g = lock(); g.get(&user).and_then(|v| v.iter().find(|(i, _)| i == &id)).map(|(_, it)| it.abort.clone()).unwrap_or_else(|| Arc::new(AtomicBool::new(true))) };
    let fetched: Result<reqwest::Response, String> = match &f {
        Fetcher::Lane(st) => crate::lite::ssrf::safe_get_stall(st, &url, "*/*", std::time::Duration::from_secs(15)).await.map(|(r, _)| r),
        #[cfg(test)]
        Fetcher::Direct => reqwest::Client::new().get(&url).send().await.map_err(|_| "upstream error".to_string()),
    };
    let resp = match fetched { Ok(r) if r.status().is_success() => r, Ok(_) => { fail(&user, &id); return; }, Err(_) => { fail(&user, &id); return; } };
    let mut out = match std::fs::OpenOptions::new().write(true).create_new(true).open(&part) {
        Ok(f) => f, Err(_) => { fail(&user, &id); return; }
    };
    let mut n: u64 = 0;
    use futures::StreamExt;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if abort.load(Ordering::SeqCst) { drop(out); let _ = std::fs::remove_file(&part); remove_item(&data_dir, &user, &id, false); return; }
        let b = match chunk { Ok(b) => b, Err(_) => { drop(out); fail(&user, &id); return; } };
        if n + b.len() as u64 > max_file { drop(out); fail(&user, &id); return; }
        n += b.len() as u64;
        if std::io::Write::write_all(&mut out, &b).is_err() { drop(out); fail(&user, &id); return; }
    }
    drop(out);
    if std::fs::rename(&part, &done).is_err() { let _ = std::fs::remove_file(&part); fail(&user, &id); return; }
                                                                                           
                                                                                    
    let name = { let g = lock(); match g.get(&user).and_then(|v| v.iter().find(|(i, _)| i == &id)) { Some((_, it)) => it.name.clone(), None => { drop(g); let _ = std::fs::remove_file(&done); return; } } };
    let expires = super::millis() + ttl_ms;
                                                                                           
                                                                                             
    let meta = serde_json::json!({"expires_at": expires, "size": n, "name": name});
    if super::write_json(&d.join(format!("{id}.json")), &meta).is_err() { tracing::error!("download inbox: meta write failed for a completed item"); }
    { let mut g = lock(); if let Some(v) = g.get_mut(&user) { if let Some((_, it)) = v.iter_mut().find(|(i, _)| i == &id) { it.st = St::Ready; it.size = n; it.expires_at = expires; } else { return; } } else { return; } }
    let dd = data_dir.clone(); let u = user.clone(); let i = id.clone();
    tokio::spawn(async move { tokio::time::sleep(std::time::Duration::from_millis(ttl_ms as u64)).await; remove_item(&dd, &u, &i, false); });
}

fn remove_item(data_dir: &Path, user: &str, id: &str, signal_abort: bool) {
    let found = {
        let mut g = lock();
        match g.get_mut(user).and_then(|v| v.iter().position(|(i, _)| i.as_str() == id).map(|p| v.remove(p))) {
            Some((_, it)) => { if signal_abort { it.abort.store(true, Ordering::SeqCst); } true }
            None => false,
        }
    };
    if found {
        let d = dir(data_dir, user);
        let _ = std::fs::remove_file(d.join(id));
        let _ = std::fs::remove_file(d.join(format!("{id}.part")));
        let _ = std::fs::remove_file(d.join(format!("{id}.json")));
    }
}

                                                                                
                                                                              
pub fn boot_sweep(data_dir: &Path) {
    let d = data_dir.join("downloads");
    match std::fs::remove_dir_all(&d) {
        Ok(()) => tracing::info!("download inbox: boot sweep removed leftover payloads"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::error!("download inbox: boot sweep FAILED: {e}"),
    }
}


                                                                                    
                                                                          
                                                                              
                                                                      
                                                                              
                                                                           
                                                                             
                                                                            
                                                                           
pub const CHUNK: u64 = 1 << 20;                                                                 
pub const STAGE_DEADLINE_S: u64 = 600;                                                 

pub fn sess_hash(tok: &str) -> String { use sha2::Digest; format!("{:x}", sha2::Sha256::digest(tok.as_bytes())) }

pub fn stage_init(data_dir: &Path, user: &str, sess: &str, body: &[u8]) -> Response {
    let v: Value = match serde_json::from_slice(body) { Ok(v) => v, Err(_) => return json_err(StatusCode::BAD_REQUEST, "bad json") };
    let name = clean_name(&super::js_trim(&super::js_string(&v["name"])));
    let decl = if v["size"].is_null() { None } else { match v["size"].as_u64() {
        Some(n) if n <= MAX_FILE => Some(n),                                                            
        _ => return json_err(StatusCode::PAYLOAD_TOO_LARGE, "file too large"),
    } };
    match stage_init_core(data_dir, user, sess, name, decl, MAX_USER, MAX_GLOBAL, MIN_FREE, TTL_MS, STAGE_DEADLINE_S) {
        Ok(id) => json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("id", OJ::Str(id)), ("chunk", OJ::U64(CHUNK))]),
        Err(r) => r,
    }
}

#[allow(clippy::too_many_arguments)]
fn stage_init_core(data_dir: &Path, user: &str, sess: &str, name: String, decl: Option<u64>, max_user: u64, max_global: u64, min_free: u64, ttl_ms: i64, deadline_s: u64) -> Result<String, Response> {
    let d = dir(data_dir, user);
    let id;
    {
                                                                           
                                                                                    
        let mut g = lock();
        let mine = g.get(user).map(|v| v.as_slice()).unwrap_or(&[]);
        if mine.iter().any(|(_, it)| it.st == St::Fetching) { return Err(json_err(StatusCode::TOO_MANY_REQUESTS, "finish the one that's already going")); }
        let used: u64 = mine.iter().filter(|(_, it)| it.st == St::Ready).map(|(_, it)| it.size).sum();
        if used >= max_user { return Err(json_err(StatusCode::PAYLOAD_TOO_LARGE, "no room left in your download inbox")); }
        let total: u64 = g.values().flatten().filter(|(_, it)| it.st == St::Ready).map(|(_, it)| it.size).sum();
        if total >= max_global { return Err(json_err(StatusCode::SERVICE_UNAVAILABLE, "the download inbox is full - try again in a few minutes")); }
        let taken: std::collections::HashSet<String> = g.values().flatten().map(|(i, _)| i.clone()).collect();
        id = super::fresh_id(16, |cand| taken.contains(cand)).ok_or_else(super::io_fail)?;
        let in_flight: u64 = g.values().flatten().filter(|(_, it)| it.st == St::Fetching).count() as u64;
        let need = min_free.saturating_add(in_flight.saturating_add(1).saturating_mul(MAX_FILE));
        if fs_free(data_dir).map(|a| a < need).unwrap_or(true) { return Err(json_err(StatusCode::SERVICE_UNAVAILABLE, "no room on the server right now")); }
        if std::fs::create_dir_all(&d).is_err() { return Err(super::io_fail()); }
        g.entry(user.to_string()).or_default().push((id.clone(), Item { name, st: St::Fetching, size: 0, expires_at: 0, abort: Arc::new(AtomicBool::new(false)), sess: sess.to_string(), decl }));
    }
                                                                                 
                                                                       
    let dd = data_dir.to_path_buf(); let u = user.to_string(); let i = id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(deadline_s)).await;
        let part = dir(&dd, &u).join(format!("{i}.part"));
        let mut g = lock();
        if let Some(v) = g.get_mut(&u) { if let Some((_, it)) = v.iter_mut().find(|(x, _)| x == &i) { if it.st == St::Fetching { it.st = St::Failed; it.expires_at = super::millis() + ttl_ms; drop(g); let _ = std::fs::remove_file(&part); } } }
    });
    Ok(id)
}

                                                                                 
                                                                          
#[allow(clippy::too_many_arguments)]
fn stage_part_core(data_dir: &Path, user: &str, sess: &str, id: &str, offset: u64, len: u64, sha_hex: &str, bytes: &[u8], max_file: u64, ttl_ms: i64) -> Result<u64, Response> {
    use sha2::Digest;
    if len == 0 || len > CHUNK || bytes.len() as u64 != len { return Err(json_err(StatusCode::BAD_REQUEST, "bad chunk")); }
    let d = dir(data_dir, user);
    let part = d.join(format!("{id}.part"));
                                                                                        
    let mut g = lock();
    match g.get(user).and_then(|v| v.iter().find(|(i, _)| i == id)) {
        None => return Err(json_err(StatusCode::NOT_FOUND, "not found")),                                   
        Some((_, it)) => {
            if it.st != St::Fetching { return Err(json_err(StatusCode::CONFLICT, "not uploading")); }
            if it.sess != sess { return Err(json_err(StatusCode::UNAUTHORIZED, "session changed")); }
        }
    }
    let cur = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if offset > cur { return Err(json_err(StatusCode::CONFLICT, "gap")); }
    if offset < cur {
        let end = offset + len;
        if end > cur { return Err(json_err(StatusCode::CONFLICT, "overlap")); }
        let mut f = std::fs::File::open(&part).map_err(|_| super::io_fail())?;
        use std::io::{Read, Seek, SeekFrom};
        if f.seek(SeekFrom::Start(offset)).is_err() { return Err(super::io_fail()); }
        let mut buf = vec![0u8; len as usize];
        if f.read_exact(&mut buf).is_err() { return Err(super::io_fail()); }
        if format!("{:x}", sha2::Sha256::digest(&buf)) != sha_hex { return Err(json_err(StatusCode::CONFLICT, "conflict")); }
        return Ok(cur);                                                                           
    }
    if format!("{:x}", sha2::Sha256::digest(bytes)) != sha_hex { return Err(json_err(StatusCode::BAD_REQUEST, "chunk hash mismatch")); }
    if cur + len > max_file {
                                                                                                   
        if let Some(v) = g.get_mut(user) { if let Some((_, it)) = v.iter_mut().find(|(i, _)| i == id) { it.st = St::Failed; it.expires_at = super::millis() + ttl_ms; } }
        drop(g);
        let _ = std::fs::remove_file(&part);
        return Err(json_err(StatusCode::PAYLOAD_TOO_LARGE, "file too large"));
    }
    let mut f = std::fs::OpenOptions::new().append(true).create(true).open(&part).map_err(|_| super::io_fail())?;
    use std::io::Write;
    if f.write_all(bytes).is_err() { return Err(super::io_fail()); }
    Ok(cur + len)
}

pub fn stage_part(data_dir: &Path, user: &str, sess: &str, query: &HashMap<String, String>, offset: Option<&str>, len: Option<&str>, sha: Option<&str>, body: &[u8]) -> Response {
    let id = query.get("id").map(String::as_str).unwrap_or("");
    let (Some(o), Some(l), Some(sha)) = (offset, len, sha) else { return json_err(StatusCode::BAD_REQUEST, "bad chunk headers") };
    let (Ok(o), Ok(l)) = (o.parse::<u64>(), l.parse::<u64>()) else { return json_err(StatusCode::BAD_REQUEST, "bad chunk headers") };
    if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return json_err(StatusCode::BAD_REQUEST, "bad chunk headers"); }
    match stage_part_core(data_dir, user, sess, id, o, l, sha, body, MAX_FILE, TTL_MS) {
        Ok(size) => json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("size", OJ::U64(size))]),
        Err(r) => r,
    }
}

fn stage_complete_core(data_dir: &Path, user: &str, sess: &str, id: &str, ttl_ms: i64) -> Result<(), Response> {
    let d = dir(data_dir, user);
    let part = d.join(format!("{id}.part"));
    let done = d.join(id);
                                                                                  
                                                                                  
                                                                               
    let mut g = lock();
    let (decl, name) = match g.get(user).and_then(|v| v.iter().find(|(i, _)| i == id)) {
        None => return Err(json_err(StatusCode::NOT_FOUND, "not found")),
        Some((_, it)) => {
            if it.st != St::Fetching { return Err(json_err(StatusCode::CONFLICT, "not uploading")); }
            if it.sess != sess { return Err(json_err(StatusCode::UNAUTHORIZED, "session changed")); }
            (it.decl, it.name.clone())
        }
    };
                                                                                     
                                                                                     
    let n = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if let Some(d0) = decl { if d0 != n {
                                                                                     
        if let Some(v) = g.get_mut(user) { if let Some((_, it)) = v.iter_mut().find(|(i, _)| i == id) { it.st = St::Failed; it.expires_at = super::millis() + ttl_ms; } }
        drop(g);
        let _ = std::fs::remove_file(&part);
        return Err(json_err(StatusCode::CONFLICT, "size mismatch"));
    } }
    let placed = if n > 0 { std::fs::rename(&part, &done).is_ok() } else { std::fs::OpenOptions::new().write(true).create_new(true).open(&done).is_ok() };
    if !placed { drop(g); let _ = std::fs::remove_file(&part); return Err(super::io_fail()); }
                                                                                        
    let expires = super::millis() + ttl_ms;
    let meta = serde_json::json!({"expires_at": expires, "size": n, "name": name});
    if super::write_json(&d.join(format!("{id}.json")), &meta).is_err() { tracing::error!("download inbox: meta write failed for a completed item"); }
    if let Some(v) = g.get_mut(user) { if let Some((_, it)) = v.iter_mut().find(|(i, _)| i == id) { it.st = St::Ready; it.size = n; it.expires_at = expires; } }
    drop(g);
    let dd = data_dir.to_path_buf(); let u = user.to_string(); let i = id.to_string();
    tokio::spawn(async move { tokio::time::sleep(std::time::Duration::from_millis(ttl_ms as u64)).await; remove_item(&dd, &u, &i, false); });
    Ok(())
}

pub fn stage_complete(data_dir: &Path, user: &str, sess: &str, body: &[u8]) -> Response {
    let v: Value = match serde_json::from_slice(body) { Ok(v) => v, Err(_) => return json_err(StatusCode::BAD_REQUEST, "bad json") };
    let id = super::js_trim(&super::js_string(&v["id"])).to_string();
    match stage_complete_core(data_dir, user, sess, &id, TTL_MS) {
        Ok(()) => json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("id", OJ::Str(id))]),
        Err(r) => r,
    }
}

                                                                                  
                                                                                       
pub fn stage_cancel(user: &str, sess: &str, body: &[u8], data_dir: &Path) -> Response {
    let v: Value = match serde_json::from_slice(body) { Ok(v) => v, Err(_) => return json_err(StatusCode::BAD_REQUEST, "bad json") };
    let id = super::js_trim(&super::js_string(&v["id"])).to_string();
    let ok = { let g = lock(); g.get(user).and_then(|v| v.iter().find(|(i, _)| i.as_str() == id.as_str())).map(|(_, it)| it.sess == sess).unwrap_or(true) };
    if !ok { return json_err(StatusCode::UNAUTHORIZED, "session changed"); }
    remove_item(data_dir, user, &id, true);
    super::ok_true()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rjdl-test-{}-{}", tag, super::super::hex_id(4).unwrap()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
                                                                                                
                                                                                          
    enum Serve { Body(Vec<u8>, usize, u64), Drop }
    async fn test_server(s: Serve) -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut c, _)) = l.accept().await {
                match s {
                    Serve::Body(body, chunks, gap) => {
                        let mut req = vec![0u8; 1024];
                        let _ = tokio::io::AsyncReadExt::read(&mut c, &mut req).await;
                        let head = format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                        let _ = tokio::io::AsyncWriteExt::write_all(&mut c, head.as_bytes()).await;
                        let step = (body.len() / chunks.max(1)).max(1);
                        for i in (0..body.len()).step_by(step) {
                            let end = (i + step).min(body.len());
                            let _ = tokio::io::AsyncWriteExt::write_all(&mut c, &body[i..end]).await;
                            let _ = tokio::io::AsyncWriteExt::flush(&mut c).await;
                            if gap > 0 { tokio::time::sleep(std::time::Duration::from_millis(gap)).await; }
                        }
                    }
                    Serve::Drop => { let mut req = vec![0u8; 1024]; let _ = tokio::io::AsyncReadExt::read(&mut c, &mut req).await; }               
                }
            }
        });
        format!("http://127.0.0.1:{port}/some/Report Final.PDF")
    }
    async fn wait_state(user: &str, id: &str, want: St, ms: u64) -> bool {
        for _ in 0..ms / 10 {
            { let g = lock(); if let Some(v) = g.get(user) { if let Some((_, it)) = v.iter().find(|(i, _)| i == id) { if it.st == want { return true; } } } }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        false
    }
    fn states(user: &str) -> Vec<(String, St, u64)> {
        let g = lock();
        g.get(user).map(|v| v.iter().map(|(i, it)| (i.clone(), it.st.clone(), it.size)).collect()).unwrap_or_default()
    }

    #[test]
    fn name_sanitize() {
        assert_eq!(clean_name("Report Final.PDF"), "Report-Final.PDF");
        assert_eq!(clean_name("..\\../etc"), "-..-etc");
        assert_eq!(clean_name(""), "file");
        let long = "a".repeat(200);
        assert_eq!(clean_name(&long).len(), 80);
                                                            
        assert_eq!(clean_name("a\u{0}\u{1f}\u{7f}\r\n\"b.bin"), "a------b.bin");
    }

    #[tokio::test]
    async fn enqueue_rejects_bad_url_and_cap() {
        let d = tmpdir("bad");
                                                                                      
        assert!(crate::lite::ssrf::check_url("ftp://example.com/x").is_err());
        assert!(crate::lite::ssrf::check_url("http://user:pw@example.com/x").is_err());
                                                     
        let u = "u-cap";
        { lock().insert(u.into(), vec![("a".repeat(32), Item { name: "x".into(), st: St::Ready, size: 100, sess: String::new(), decl: None, expires_at: super::super::millis() + 60000, abort: Arc::new(AtomicBool::new(false)) })]); }
        let r = enqueue_core(Fetcher::Direct, &d, u, "http://127.0.0.1:1/x", 60000, 100, u64::MAX, 0).await;
        assert!(r.is_err());
        let g = lock(); assert_eq!(g.get(u).unwrap().len(), 1);                
        drop(g);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn one_concurrent_per_user() {
        let d = tmpdir("conc");
        let u = "u-conc";
        let url = test_server(Serve::Body(vec![b'x'; 4096], 8, 120)).await;              
        let id = enqueue_core(Fetcher::Direct, &d, u, &url, 60000, u64::MAX, u64::MAX, 0).await.unwrap();
        let second = enqueue_core(Fetcher::Direct, &d, u, &url, 60000, u64::MAX, u64::MAX, 0).await;
        assert!(second.is_err());                      
        remove_item(&d, u, &id, true);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(states(u).is_empty());
        assert!(std::fs::read_dir(dir(&d, u)).map(|mut r| r.next().is_none()).unwrap_or(true));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn concurrent_same_user_enqueue_exactly_one_wins() {
                                                                                   
        let d = tmpdir("race");
        let u = "u-race";
        let url1 = test_server(Serve::Body(vec![b'r'; 8192], 8, 120)).await;
        let url2 = test_server(Serve::Body(vec![b's'; 8192], 8, 120)).await;
        let (r1, r2) = tokio::join!(
            enqueue_core(Fetcher::Direct, &d, u, &url1, 60000, u64::MAX, u64::MAX, 0),
            enqueue_core(Fetcher::Direct, &d, u, &url2, 60000, u64::MAX, u64::MAX, 0));
        let wins = r1.is_ok() as u32 + r2.is_ok() as u32;
        assert_eq!(wins, 1, "exactly one enqueue may win; r1={} r2={}", r1.is_ok(), r2.is_ok());
        if let Ok(id) = r1.or(r2) { remove_item(&d, u, &id, true); }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn ready_then_expires_and_file_get() {
        let d = tmpdir("life");
        let u = "u-life";
        let body = b"hello payload".to_vec();
        let url = test_server(Serve::Body(body.clone(), 1, 0)).await;
        let id = enqueue_core(Fetcher::Direct, &d, u, &url, 1000, u64::MAX, u64::MAX, 0).await.unwrap();
        assert!(wait_state(u, &id, St::Ready, 5000).await);
        let st = states(u);
        assert_eq!(st[0].1, St::Ready);
        assert_eq!(st[0].2, body.len() as u64);
                                                               
        { let g = lock(); assert_eq!(g.get(u).unwrap()[0].1.name, "Report-Final.PDF"); }
                                       
        let mut q = HashMap::new();
        q.insert("id".to_string(), id.clone());
        let r = file(&d, u, &q).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers().get("x-content-type-options").unwrap(), "nosniff");
        assert_eq!(r.headers().get("content-disposition").unwrap(), "attachment; filename=\"Report-Final.PDF\"");
        let got = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        assert_eq!(&got[..], &body[..]);
                                                                      
        let meta: Value = serde_json::from_str(&std::fs::read_to_string(dir(&d, u).join(format!("{id}.json"))).unwrap()).unwrap();
        assert!(meta["expires_at"].as_i64().unwrap() > super::super::millis());
        assert_eq!(meta["size"].as_u64().unwrap(), body.len() as u64);
        assert_eq!(meta["name"].as_str().unwrap(), "Report-Final.PDF");
                                                            
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        assert!(states(u).is_empty());
        assert!(!dir(&d, u).join(&id).exists());
        assert!(!dir(&d, u).join(format!("{id}.json")).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn failure_cleans_part() {
        let d = tmpdir("fail");
        let u = "u-fail";
        let url = test_server(Serve::Drop).await;
        let id = enqueue_core(Fetcher::Direct, &d, u, &url, 60000, u64::MAX, u64::MAX, 0).await.unwrap();
        assert!(wait_state(u, &id, St::Failed, 5000).await);
        assert!(!dir(&d, u).join(format!("{id}.part")).exists());
        assert!(!dir(&d, u).join(&id).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn failed_then_expires_and_purged() {
                                                                                                         
                                                                                                          
        let d = tmpdir("fpurge");
        let u = "u-fpurge";
        let url = test_server(Serve::Drop).await;
        let id = enqueue_core(Fetcher::Direct, &d, u, &url, 600, u64::MAX, u64::MAX, 0).await.unwrap();
        assert!(wait_state(u, &id, St::Failed, 5000).await);
        assert!(!states(u).is_empty());                                                        
        { let g = lock(); assert!(g.get(u).unwrap()[0].1.expires_at > 0); }                             
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;                                   
        let _ = list(&d, u);                                                  
        assert!(states(u).is_empty());
        assert!(!dir(&d, u).join(format!("{id}.part")).exists());
        assert!(!dir(&d, u).join(&id).exists());
        assert!(!dir(&d, u).join(format!("{id}.json")).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn cancel_zero_byte_leaves_nothing() {
                                                                        
        let d = tmpdir("cxl0");
        let u = "u-cxl0";
        let url = test_server(Serve::Body(vec![b'q'; 65536], 16, 200)).await;                             
        let id = enqueue_core(Fetcher::Direct, &d, u, &url, 60000, u64::MAX, u64::MAX, 0).await.unwrap();
        remove_item(&d, u, &id, true);                                                  
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;                               
        assert!(states(u).is_empty());
        assert!(!dir(&d, u).join(format!("{id}.part")).exists());
        assert!(std::fs::read_dir(dir(&d, u)).map(|mut r| r.next().is_none()).unwrap_or(true));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn cancel_large_partial_bytes_removed() {
                                                                                                                      
        let d = tmpdir("cxl320");
        let u = "u-cxl320";
        let url = test_server(Serve::Body(vec![b'z'; 4 * 1024 * 1024], 64, 50)).await;                            
        let id = enqueue_core(Fetcher::Direct, &d, u, &url, 60000, u64::MAX, u64::MAX, 0).await.unwrap();
        let part = dir(&d, u).join(format!("{id}.part"));
        let mut reached = 0u64;
        for _ in 0..400 {                                                                           
            let n = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            if n >= 320 * 1024 { reached = n; break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(reached >= 320 * 1024, "partial never reached 320KiB (got {reached})");
        remove_item(&d, u, &id, true);
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        assert!(states(u).is_empty());
        assert!(!part.exists(), "320KiB+ partial payload survived cancel");
        assert!(!dir(&d, u).join(&id).exists());
        assert!(!dir(&d, u).join(format!("{id}.json")).exists());
        assert!(std::fs::read_dir(dir(&d, u)).map(|mut r| r.next().is_none()).unwrap_or(true));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn cancel_mid_fetch_removes_part() {
        let d = tmpdir("cxl");
        let u = "u-cxl";
        let url = test_server(Serve::Body(vec![b'y'; 65536], 16, 100)).await;
        let id = enqueue_core(Fetcher::Direct, &d, u, &url, 60000, u64::MAX, u64::MAX, 0).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;               
        remove_item(&d, u, &id, true);
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        assert!(states(u).is_empty());
        assert!(!dir(&d, u).join(format!("{id}.part")).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn cross_user_file_404() {
        let d = tmpdir("xuser");
        let url = test_server(Serve::Body(b"secret".to_vec(), 1, 0)).await;
        let id = enqueue_core(Fetcher::Direct, &d, "u-a", &url, 60000, u64::MAX, u64::MAX, 0).await.unwrap();
        assert!(wait_state("u-a", &id, St::Ready, 5000).await);
        let mut q = HashMap::new();
        q.insert("id".to_string(), id.clone());
        let r = file(&d, "u-b", &q).await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);                                            
        assert!(states("u-b").is_empty());
        remove_item(&d, "u-a", &id, false);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn expiry_read_through_unlink() {
        let d = tmpdir("fdv");
        let u = "u-fdv";
        let payload = b"fd stays valid".to_vec();
        let url = test_server(Serve::Body(payload.clone(), 1, 0)).await;
        let id = enqueue_core(Fetcher::Direct, &d, u, &url, 60000, u64::MAX, u64::MAX, 0).await.unwrap();
        assert!(wait_state(u, &id, St::Ready, 5000).await);
        let p = dir(&d, u).join(&id);
        let mut f = std::fs::File::open(&p).unwrap();
        remove_item(&d, u, &id, false);                                
        assert!(!p.exists());
        let mut got = Vec::new();
        f.read_to_end(&mut got).unwrap();                              
        assert_eq!(got, payload);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn boot_sweep_clears_leftovers() {
        let d = tmpdir("sweep");
        let dd = dir(&d, "u-old");
        std::fs::create_dir_all(&dd).unwrap();
        std::fs::write(dd.join("abc.part"), b"partial").unwrap();
        std::fs::write(dd.join("def"), b"done").unwrap();
        boot_sweep(&d);
        assert!(!d.join("downloads").exists());
        boot_sweep(&d);                              
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn lane_egress_down_fails_closed_no_part() {
                                                                                              
                                                                                            
                                                                                      
        let st = std::sync::Arc::new(crate::auth_api::devices::tests::fixture("dl-lane-down"));
        let d = st.data_dir.clone();
        let u = "u-lane";
        let id = enqueue_core(Fetcher::Lane(st), &d, u, "https://example.com/big.iso", 60000, u64::MAX, u64::MAX, 0).await.unwrap();
        assert!(wait_state(u, &id, St::Failed, 5000).await);
        assert!(!dir(&d, u).join(format!("{id}.part")).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ssrf_guard_still_rejects() {
                                                                                       
                                                              
        for u in ["not a url", "gopher://x/", "http://example.com:8080/x"] {
            assert!(crate::lite::ssrf::check_url(u).is_err(), "{u}");
        }
        assert!(crate::lite::ssrf::check_url("https://example.com/file.zip").is_ok());
    }
                                                                                                           

    fn sha_hex(b: &[u8]) -> String { use sha2::Digest; format!("{:x}", sha2::Sha256::digest(b)) }
    fn st_of(u: &str, id: &str) -> Option<St> { let g = lock(); g.get(u).and_then(|v| v.iter().find(|(i, _)| i == id)).map(|(_, it)| it.st.clone()) }

    #[tokio::test]
    async fn stage_roundtrip_bytes_exact() {
        let d = tmpdir("stg-ok"); let u = "u-stg-ok";
        let id = stage_init_core(&d, u, "sessA", "f.bin".into(), Some(6), u64::MAX, u64::MAX, 0, 60000, 600).unwrap();
        assert_eq!(stage_part_core(&d, u, "sessA", &id, 0, 3, &sha_hex(b"abc"), b"abc", 1 << 20, 60000).unwrap(), 3);
        assert_eq!(stage_part_core(&d, u, "sessA", &id, 3, 3, &sha_hex(b"def"), b"def", 1 << 20, 60000).unwrap(), 6);
        stage_complete_core(&d, u, "sessA", &id, 60000).unwrap();
        assert_eq!(st_of(u, &id), Some(St::Ready));
        assert_eq!(std::fs::read(dir(&d, u).join(&id)).unwrap(), b"abcdef");
        let meta: Value = serde_json::from_slice(&std::fs::read(dir(&d, u).join(format!("{id}.json"))).unwrap()).unwrap();
        assert_eq!(meta["size"].as_u64(), Some(6));
        assert!(meta["expires_at"].as_i64().unwrap() > super::super::millis());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_retry_duplicate_no_rewrite() {
                                                                                                         
        let d = tmpdir("stg-dup"); let u = "u-stg-dup";
        let id = stage_init_core(&d, u, "sessA", "f.bin".into(), None, u64::MAX, u64::MAX, 0, 60000, 600).unwrap();
        assert_eq!(stage_part_core(&d, u, "sessA", &id, 0, 3, &sha_hex(b"abc"), b"abc", 1 << 20, 60000).unwrap(), 3);
        assert_eq!(stage_part_core(&d, u, "sessA", &id, 0, 3, &sha_hex(b"abc"), b"abc", 1 << 20, 60000).unwrap(), 3);
        assert_eq!(std::fs::metadata(dir(&d, u).join(format!("{id}.part"))).unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_sha_mismatch_rejected_nothing_written() {
        let d = tmpdir("stg-sha"); let u = "u-stg-sha";
        let id = stage_init_core(&d, u, "sessA", "f.bin".into(), None, u64::MAX, u64::MAX, 0, 60000, 600).unwrap();
        assert!(stage_part_core(&d, u, "sessA", &id, 0, 3, &sha_hex(b"WRONG"), b"abc", 1 << 20, 60000).is_err());
        assert!(!dir(&d, u).join(format!("{id}.part")).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_gap_and_overlap_conflicts() {
        let d = tmpdir("stg-gap"); let u = "u-stg-gap";
        let id = stage_init_core(&d, u, "sessA", "f.bin".into(), None, u64::MAX, u64::MAX, 0, 60000, 600).unwrap();
        assert!(stage_part_core(&d, u, "sessA", &id, 5, 3, &sha_hex(b"abc"), b"abc", 1 << 20, 60000).is_err());                      
        stage_part_core(&d, u, "sessA", &id, 0, 6, &sha_hex(b"abcdef"), b"abcdef", 1 << 20, 60000).unwrap();
        assert!(stage_part_core(&d, u, "sessA", &id, 3, 6, &sha_hex(b"defghi"), b"defghi", 1 << 20, 60000).is_err());                     
        assert!(stage_part_core(&d, u, "sessA", &id, 0, 3, &sha_hex(b"XYZ"), b"XYZ", 1 << 20, 60000).is_err());                             
        assert_eq!(std::fs::read(dir(&d, u).join(format!("{id}.part"))).unwrap(), b"abcdef");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_cap_mid_append_never_overshoots() {
        let d = tmpdir("stg-cap"); let u = "u-stg-cap";
        let id = stage_init_core(&d, u, "sessA", "f.bin".into(), None, u64::MAX, u64::MAX, 0, 60000, 600).unwrap();
        stage_part_core(&d, u, "sessA", &id, 0, 3, &sha_hex(b"abc"), b"abc", 4, 60000).unwrap();
        assert!(stage_part_core(&d, u, "sessA", &id, 3, 2, &sha_hex(b"de"), b"de", 4, 60000).is_err());
        assert_eq!(st_of(u, &id), Some(St::Failed));
        assert!(!dir(&d, u).join(format!("{id}.part")).exists());
        assert!(!dir(&d, u).join(&id).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_session_rotation_rejected() {
        let d = tmpdir("stg-sess"); let u = "u-stg-sess";
        let id = stage_init_core(&d, u, "sessA", "f.bin".into(), None, u64::MAX, u64::MAX, 0, 60000, 600).unwrap();
        assert!(stage_part_core(&d, u, "sessB", &id, 0, 3, &sha_hex(b"abc"), b"abc", 1 << 20, 60000).is_err());
        assert!(stage_complete_core(&d, u, "sessB", &id, 60000).is_err());
        assert!(stage_part_core(&d, u, "sessA", &id, 0, 3, &sha_hex(b"abc"), b"abc", 1 << 20, 60000).is_ok());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_cross_user_hidden() {
        let d = tmpdir("stg-xu"); let ua = "u-a"; let ub = "u-b";
        let id = stage_init_core(&d, ua, "sessA", "f.bin".into(), None, u64::MAX, u64::MAX, 0, 60000, 600).unwrap();
        assert!(stage_part_core(&d, ub, "sessA", &id, 0, 3, &sha_hex(b"abc"), b"abc", 1 << 20, 60000).is_err());
        assert!(stage_complete_core(&d, ub, "sessA", &id, 60000).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_one_in_flight_both_kinds() {
                                                                                             
        let d = tmpdir("stg-1f"); let u = "u-stg-1f";
        let _id = stage_init_core(&d, u, "sessA", "f.bin".into(), None, u64::MAX, u64::MAX, 0, 60000, 600).unwrap();
        assert!(stage_init_core(&d, u, "sessA", "g.bin".into(), None, u64::MAX, u64::MAX, 0, 60000, 600).is_err());
        let url = test_server(Serve::Body(vec![b'x'; 4096], 8, 120)).await;
        assert!(enqueue_core(Fetcher::Direct, &d, u, &url, 60000, u64::MAX, u64::MAX, 0).await.is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_concurrent_double_init_exactly_one_wins() {
        let d = tmpdir("stg-race"); let u = "u-stg-race";
        let d2 = d.clone(); let d3 = d.clone();
        let (a, b) = tokio::join!(
            tokio::spawn(async move { stage_init_core(&d2, u, "sessA", "a.bin".into(), None, u64::MAX, u64::MAX, 0, 60000, 600).is_ok() }),
            tokio::spawn(async move { stage_init_core(&d3, u, "sessA", "b.bin".into(), None, u64::MAX, u64::MAX, 0, 60000, 600).is_ok() }),
        );
        assert_eq!(a.unwrap() as u8 + b.unwrap() as u8, 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_complete_decl_mismatch_fails() {
        let d = tmpdir("stg-decl"); let u = "u-stg-decl";
        let id = stage_init_core(&d, u, "sessA", "f.bin".into(), Some(10), u64::MAX, u64::MAX, 0, 60000, 600).unwrap();
        stage_part_core(&d, u, "sessA", &id, 0, 5, &sha_hex(b"abcde"), b"abcde", 1 << 20, 60000).unwrap();
        assert!(stage_complete_core(&d, u, "sessA", &id, 60000).is_err());
        assert_eq!(st_of(u, &id), Some(St::Failed));
        assert!(!dir(&d, u).join(&id).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_deadline_fails_closed_part_removed() {
        let d = tmpdir("stg-dl"); let u = "u-stg-dl";
        let id = stage_init_core(&d, u, "sessA", "f.bin".into(), None, u64::MAX, u64::MAX, 0, 60000, 1).unwrap();
        stage_part_core(&d, u, "sessA", &id, 0, 3, &sha_hex(b"abc"), b"abc", 1 << 20, 60000).unwrap();
        assert!(wait_state(u, &id, St::Failed, 5000).await);
        assert!(!dir(&d, u).join(format!("{id}.part")).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_complete_after_cancel_gone_cancel_idempotent() {
        let d = tmpdir("stg-cxl"); let u = "u-stg-cxl";
        let id = stage_init_core(&d, u, "sessA", "f.bin".into(), None, u64::MAX, u64::MAX, 0, 60000, 600).unwrap();
        stage_part_core(&d, u, "sessA", &id, 0, 3, &sha_hex(b"abc"), b"abc", 1 << 20, 60000).unwrap();
        remove_item(&d, u, &id, true);
        assert!(stage_complete_core(&d, u, "sessA", &id, 60000).is_err());
        remove_item(&d, u, &id, true);                                                   
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_declared_oversize_rejected_at_init() {
        let d = tmpdir("stg-big"); let u = "u-stg-big";
                                                                                                      
        let body = serde_json::json!({"name": "big.iso", "size": MAX_FILE + 1}).to_string();
        let r = stage_init(&d, u, "sessA", body.as_bytes());
        assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_zero_byte_file_explicit() {
                                                                                                       
        let d = tmpdir("stg-zero"); let u = "u-stg-zero";
        let id = stage_init_core(&d, u, "sessA", "empty.txt".into(), Some(0), u64::MAX, u64::MAX, 0, 60000, 600).unwrap();
        stage_complete_core(&d, u, "sessA", &id, 60000).unwrap();
        assert_eq!(st_of(u, &id), Some(St::Ready));
        assert_eq!(std::fs::metadata(dir(&d, u).join(&id)).unwrap().len(), 0);
        let meta: Value = serde_json::from_slice(&std::fs::read(dir(&d, u).join(format!("{id}.json"))).unwrap()).unwrap();
        assert_eq!(meta["size"].as_u64(), Some(0));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_zero_byte_undeclared_ok_after_ready() {
        let d = tmpdir("stg-zero2"); let u = "u-stg-zero2";
        let id = stage_init_core(&d, u, "sessA", "empty.txt".into(), Some(0), u64::MAX, u64::MAX, 0, 60000, 600).unwrap();
        stage_complete_core(&d, u, "sessA", &id, 60000).unwrap();
                                                                                                        
        let id2 = stage_init_core(&d, u, "sessA", "empty2.txt".into(), None, u64::MAX, u64::MAX, 0, 60000, 600).unwrap();
        stage_complete_core(&d, u, "sessA", &id2, 60000).unwrap();
        assert_eq!(st_of(u, &id2), Some(St::Ready));
        assert_eq!(std::fs::metadata(dir(&d, u).join(&id2)).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_post_complete_part_rejected_accounting_intact() {
                                                                                                     
        let d = tmpdir("stg-pc"); let u = "u-stg-pc";
        let id = stage_init_core(&d, u, "sessA", "f.bin".into(), None, u64::MAX, u64::MAX, 0, 60000, 600).unwrap();
        stage_part_core(&d, u, "sessA", &id, 0, 3, &sha_hex(b"abc"), b"abc", 1 << 20, 60000).unwrap();
        stage_complete_core(&d, u, "sessA", &id, 60000).unwrap();
        assert!(stage_part_core(&d, u, "sessA", &id, 3, 3, &sha_hex(b"def"), b"def", 1 << 20, 60000).is_err());
        assert_eq!(std::fs::metadata(dir(&d, u).join(&id)).unwrap().len(), 3);
        let g = lock();
        let it = &g.get(u).unwrap().iter().find(|(i, _)| i == &id).unwrap().1;
        assert!(it.st == St::Ready && it.size == 3);
        drop(g);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn stage_part_header_parse_rejections() {
                                                                                  
        let d = tmpdir("stg-hdr"); let u = "u-stg-hdr";
        let id = stage_init_core(&d, u, "sessA", "f.bin".into(), None, u64::MAX, u64::MAX, 0, 60000, 600).unwrap();
        let mut q = HashMap::new(); q.insert("id".to_string(), id.clone());
        assert_eq!(stage_part(&d, u, "sessA", &q, None, Some("3"), Some(&sha_hex(b"abc")), b"abc").status(), StatusCode::BAD_REQUEST);
        assert_eq!(stage_part(&d, u, "sessA", &q, Some("x"), Some("3"), Some(&sha_hex(b"abc")), b"abc").status(), StatusCode::BAD_REQUEST);
        assert_eq!(stage_part(&d, u, "sessA", &q, Some("0"), Some("3"), Some("nothex"), b"abc").status(), StatusCode::BAD_REQUEST);
        assert_eq!(stage_part(&d, u, "sessA", &q, Some("0"), Some("3"), Some(&sha_hex(b"abc")), b"abc").status(), StatusCode::OK);
        let _ = std::fs::remove_dir_all(&d);
    }

}
