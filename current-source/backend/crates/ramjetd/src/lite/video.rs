                                                                                    
                                                                                
                                                                                   
                                                                     
                                                                                     
                                                                                  
                                                                               
                                                                                 
                                                                               
                                                                            
                                                                                  
                                                                            
                                                                             
                                                      
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use super::{json_err_x, json_ord, qparam, OJ, Shared};

const LITE_MAX_SECS: f64 = 900.0;
const LITE_MAX_BYTES: u64 = 150 * 1024 * 1024;
                                                                                     
                                                                                  
                                                                                    
                                                                         
                                                                                  
                                                                                  
const ADMIN_DISK_FLOOR: u64 = 2 * 1024 * 1024 * 1024;

fn free_bytes(dir: &std::path::Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut sv: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut sv) } != 0 { return None }
    Some(sv.f_bavail as u64 * sv.f_frsize as u64)
}
const Q_SET: [u32; 4] = [360, 480, 720, 1080];

#[derive(Debug, Deserialize, Clone)]
struct Fmt {
    protocol: Option<String>,
    vcodec: Option<String>,
    acodec: Option<String>,
    url: Option<String>,
    height: Option<u32>,
    fps: Option<f64>,
    abr: Option<f64>,
    tbr: Option<f64>,
    filesize: Option<u64>,
    filesize_approx: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct YtInfo { duration: Option<f64>, formats: Option<Vec<Fmt>> }

struct LiteV { h: u32, fps: f64, size: Option<u64>, tbr: f64, url: String }
struct LiteA { abr: f64, size: Option<u64>, url: String }
struct Entry { lite_v: Vec<LiteV>, lite_a: Vec<LiteA>, duration: f64 }

#[cfg(test)]
static RESOLVE_STUB: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Result<Entry, String>>>> = std::sync::OnceLock::new();
#[cfg(test)]
fn take_resolve_stub(id: &str) -> Option<Result<Entry, String>> { RESOLVE_STUB.get_or_init(Default::default).lock().unwrap().remove(id) }
#[cfg(not(test))]
fn take_resolve_stub(_id: &str) -> Option<Result<Entry, String>> { None }

async fn resolve_stream(st: &crate::AppState, id: &str) -> Result<Entry, String> {
    if let Some(r) = take_resolve_stub(id) { return r; }
                                                                                      
                                                                                     
                                                                                        
                                                                                    
                                                                                      
                                                                                   
    st.egress()?;
    let page = format!("https://www.youtube.com/watch?v={id}");
    let mut cmd = tokio::process::Command::new(&st.ytdlp);
    cmd.args(["--no-playlist", "--no-warnings", "--skip-download", "--print", "%(.{duration,formats})j"]);
    cmd.kill_on_drop(true);                                                                      
    if !st.proxy_url.is_empty() { cmd.args(["--proxy", &st.proxy_url]); }
                                                                                  
                                                                                
                                                                  
                                                                                          
                                                                                            
                                                                                         
                                                                   
    let out = tokio::time::timeout(std::time::Duration::from_secs(30), cmd.arg("--").arg(&page).output()).await
        .map_err(|_| "can't load this video - try another".to_string())?
        .map_err(|_| "can't load this video - try another".to_string())?;
    if !out.status.success() { return Err("can't load this video - try another".into()); }                     
    let info: YtInfo = serde_json::from_slice(&out.stdout).map_err(|_| "can't load this video - try another".to_string())?;
    Ok(collect_formats(info))
}

                                                                             
                                                                             
                                                                             
                                                                             
                                                                              
                                                                               
                                                                
fn direct_transport(p: Option<&str>) -> bool { matches!(p, Some("https") | Some("http")) }

fn collect_formats(info: YtInfo) -> Entry {
    let mut v = vec![]; let mut a = vec![];
    for f in info.formats.unwrap_or_default() {
        let url = match f.url { Some(u) => u, None => continue };
        if !direct_transport(f.protocol.as_deref()) { continue; }
        let vc = f.vcodec.as_deref().unwrap_or("");
        let ac = f.acodec.as_deref().unwrap_or("");
        if vc.starts_with("avc1") && f.height.is_some() {
            v.push(LiteV { h: f.height.unwrap(), fps: f.fps.unwrap_or(30.0), size: f.filesize.or(f.filesize_approx), tbr: f.tbr.unwrap_or(0.0), url });
        } else if vc == "none" && ac.starts_with("mp4a") {
            a.push(LiteA { abr: f.abr.or(f.tbr).unwrap_or(0.0), size: f.filesize.or(f.filesize_approx), url });
        }
    }
    Entry { lite_v: v, lite_a: a, duration: info.duration.unwrap_or(0.0) }
}

struct Plan { mode: String, v: Option<LiteV>, a: Option<LiteA>, height: u32, secs: f64, est: u64 }

                                                                                     
                                                                          
fn js_num(f: f64) -> serde_json::Value {
    if f.fract() == 0.0 && f >= 0.0 && f <= u64::MAX as f64 { serde_json::json!(f as u64) } else { serde_json::json!(f) }
}

fn lite_plan(e: &Entry, q: u32) -> Plan {
    let mut vids: Vec<&LiteV> = e.lite_v.iter().filter(|f| f.h <= q).collect();
    vids.sort_by(|a, b| b.h.cmp(&a.h).then(a.fps.partial_cmp(&b.fps).unwrap_or(std::cmp::Ordering::Equal)));
    let top = vids.first();
    let pick = top.and_then(|t| vids.iter().find(|f| f.h == t.h && f.fps <= 30.0).copied()).or(top.copied());
    let aud = e.lite_a.iter().max_by(|a, b| a.abr.partial_cmp(&b.abr).unwrap_or(std::cmp::Ordering::Equal));
    let secs = e.duration;
    if let (Some(p), Some(au)) = (pick, aud) {
        let est = (p.size.unwrap_or((p.tbr * 125.0 * secs) as u64)) + (au.size.unwrap_or((au.abr * 125.0 * secs) as u64));
        return Plan { mode: "mux".into(), v: Some(p.clone_v()), a: Some(au.clone_a()), height: p.h, secs, est };
    }
    Plan { mode: "itag18".into(), v: None, a: None, height: 360, secs, est: (60.0 * 1024.0 * secs) as u64 }
}

impl LiteV { fn clone_v(&self) -> LiteV { LiteV { h: self.h, fps: self.fps, size: self.size, tbr: self.tbr, url: self.url.clone() } } }
impl LiteA { fn clone_a(&self) -> LiteA { LiteA { abr: self.abr, size: self.size, url: self.url.clone() } } }

                                                                 
                                                                                
                                             
                                                                            
                                                                               
                                                                          
                                                                          
                                                                            
                                                                          
                                                                       
fn peak_bytes(plan: &Plan) -> u64 {
    if plan.mode == "mux" { plan.est.saturating_mul(2).saturating_add(mux_overhead_allowance(plan.est)) } else { plan.est }
}
                                                                            
                                                                               
                                                                             
                                                                              
fn mux_overhead_allowance(est: u64) -> u64 { (est / 16).max(4 << 20) }

async fn lite_hop(st: &crate::AppState, url: &str, dest: &std::path::Path, max_bytes: u64, floor: u64, prog: Option<(&str, u32)>) -> Result<u64, String> {
                                                                                       
                                                                                         
                                                                                      
                                                                                       
                                                                                          
    st.egress()?;
    let eg = crate::egress::build_stream(&st.proxy_url)?;
    let resp = eg.get(url).send().await.map_err(|e| if e.is_timeout() { "timed out".to_string() } else { "upstream error".to_string() })?;                      
    if !resp.status().is_success() { return Err(format!("cdn {}", resp.status())); }
    let mut f = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut n: u64 = 0;
    let mut since_probe: u64 = 0;
    use futures::StreamExt;
    use std::io::Write;
    while let Some(c) = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next()).await.map_err(|_| "timed out".to_string())? {                             
        let c = c.map_err(|e| if e.is_timeout() { "timed out".to_string() } else { "upstream error".to_string() })?;
        n += c.len() as u64;
        if let Some((pid, pq)) = prog { prog_add(st, pid, pq, c.len() as u64); }                                                                
        if n > max_bytes { let _ = std::fs::remove_file(dest); return Err("too big".into()); }                                                
                                                                                     
                                                                                      
        since_probe += c.len() as u64;
        if floor > 0 && since_probe >= (8 << 20) {
            since_probe = 0;
            if free_bytes(dest.parent().unwrap_or(std::path::Path::new("/"))).unwrap_or(0) < floor {
                let _ = std::fs::remove_file(dest);
                return Err("server disk ran low mid-render".into());
            }
        }
        f.write_all(&c).map_err(|e| e.to_string())?;
    }
    Ok(n)
}

                                                                             
                                                                            
                                                                                 
                                                
fn mux_args(tmpv: &std::path::Path, tmpa: &std::path::Path, tmpo: &std::path::Path) -> Vec<std::ffi::OsString> {
    let mut v: Vec<std::ffi::OsString> = ["-n", "10", "ffmpeg", "-v", "error", "-y", "-i"].iter().map(|s| s.into()).collect();
    v.push(tmpv.into());
    v.push("-i".into());
    v.push(tmpa.into());
    for a in ["-c", "copy", "-movflags", "+faststart", "-f", "mp4"] { v.push(a.into()); }
    v.push(tmpo.into());
    v
}

async fn make_video(st: &std::sync::Arc<crate::AppState>, id: &str, q: u32, entry: &Entry, max_bytes: u64, floor: u64, agg_cap: u64) -> Result<std::path::PathBuf, String> {
    prog_reset(st, id, q);                                                           
    let dir = st.data_dir.join("stream-cache");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("{id}.lite{q}"));
    if out.exists() { return Ok(out); }
    let plan = lite_plan(entry, q);
    let _guard = RenderGuard::new(st, peak_bytes(&plan), format!("{id}.lite{q}"));                                
    let tmpv = dir.join(format!("{id}.lite{q}v.part"));
    let tmpa = dir.join(format!("{id}.lite{q}a.part"));
    let tmpo = dir.join(format!("{id}.lite{q}o.part"));
    let rm = |_: bool| { for f in [&tmpv, &tmpa, &tmpo] { let _ = std::fs::remove_file(f); } };
    if plan.mode == "itag18" { rm(true); return Err("no playable stream for this one".into()); }
    let (v, a) = (plan.v.as_ref().unwrap(), plan.a.as_ref().unwrap());
    let nv = match lite_hop(st, &v.url, &tmpv, max_bytes, floor, Some((id, q))).await { Ok(n) => n, Err(e) => { rm(true); return Err(e); } };
    let na = match lite_hop(st, &a.url, &tmpa, max_bytes, floor, Some((id, q))).await { Ok(n) => n, Err(e) => { rm(true); return Err(e); } };
    if agg_cap > 0 && nv + na > agg_cap { rm(true); return Err("too big".into()); }                                           
                                                                                 
                                                                                 
                                                                                    
    if floor > 0 && free_bytes(&dir).unwrap_or(0).saturating_sub(floor) < nv + na {
        rm(true);
        return Err("server disk ran low before mux".into());
    }
    let mut cmd = tokio::process::Command::new("nice");
    cmd.args(mux_args(&tmpv, &tmpa, &tmpo)).kill_on_drop(true);
                                                                                    
                                                                                
                                                                                  
                                                     
                                                                                   
                                                                                 
                                                                                 
    let mux_cap = 120u64.max((nv + na) / (8 << 20)).min(3600);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(mux_cap);
    let ff: Result<std::process::ExitStatus, String> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {
                if std::time::Instant::now() > deadline { let _ = child.kill().await; break Err("mux stalled".into()); }
                if floor > 0 && free_bytes(&dir).unwrap_or(0) < floor { let _ = child.kill().await; break Err("server disk ran low mid-mux".into()); }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            Err(e) => break Err(e.to_string()),
        }
    };
    match ff {
        Ok(o) if o.success() => {
            let size = std::fs::metadata(&tmpo).map(|m| m.len()).unwrap_or(0);
            if size > max_bytes { rm(true); return Err("too big".into()); }
            if agg_cap > 0 && nv + na + size > agg_cap { rm(true); return Err("too big".into()); }                                     
            std::fs::rename(&tmpo, &out).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&tmpv); let _ = std::fs::remove_file(&tmpa);
            Ok(out)
        }
        Err(e) if e == "mux stalled" || e == "server disk ran low mid-mux" => { rm(true); Err(e) }
        _ => { rm(true); Err("mux failed".into()) }
    }
}

                                                                                 
                                                                                   
async fn stream_file(path: std::path::PathBuf, delete_after: bool) -> Result<(u64, axum::body::Body), String> {
    let f = tokio::fs::File::open(&path).await.map_err(|e| e.to_string())?;
    let len = f.metadata().await.map_err(|e| e.to_string())?.len();
    if delete_after { let _ = std::fs::remove_file(&path); }
    let stream = futures::stream::try_unfold(f, |mut f| async move {
        let mut buf = vec![0u8; 65536];
        match tokio::io::AsyncReadExt::read(&mut f, &mut buf).await {
            Ok(0) => Ok(None),
            Ok(k) => { buf.truncate(k); Ok(Some((buf, f))) }
            Err(e) => Err(e),
        }
    });
    Ok((len, axum::body::Body::from_stream(stream)))
}

                                                                                     
                                                                                   
                                                                                          
                                                                          
fn sweep_partials(st: &crate::AppState, dir: &std::path::Path) {
    let re = regex::Regex::new(r"^([A-Za-z0-9_-]{11}\.lite(?:360|480|720|1080))[vao]\.part$").unwrap();                            
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(1800);
    let owned: std::collections::HashSet<String> = st.lite.video_jobs.lock().map(|j| j.clone()).unwrap_or_default();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name();
            let Some(n) = name.to_str() else { continue };
            let Some(m) = re.captures(n) else { continue };
            if owned.contains(&m[1]) { continue; }                                                    
            let stale = e.metadata().and_then(|m| m.modified()).map(|t| t < cutoff).unwrap_or(false);
            if stale { let _ = std::fs::remove_file(e.path()); }
        }
    }
}

                                                                                  
                                                                                 
                                                                                   
                                                                                
                                                                      
struct RenderGuard { st: std::sync::Arc<crate::AppState>, bytes: u64, prefix: String }
impl RenderGuard {
    fn new(st: &std::sync::Arc<crate::AppState>, bytes: u64, prefix: String) -> Self {
        st.lite.video_reserved.fetch_add(bytes, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut j) = st.lite.video_jobs.lock() { j.insert(prefix.clone()); }
        RenderGuard { st: st.clone(), bytes, prefix }
    }
}
impl Drop for RenderGuard {
    fn drop(&mut self) {
        self.st.lite.video_reserved.fetch_sub(self.bytes, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut j) = self.st.lite.video_jobs.lock() { j.remove(&self.prefix); }
                                                                                   
                                                                                    
                                                                                    
                                                                                   
                                                                              
        let dir = self.st.data_dir.join("stream-cache");
        for suf in ["v", "a", "o"] { let _ = std::fs::remove_file(dir.join(format!("{}{}.part", self.prefix, suf))); }
    }
}

                                                                                 
                                                                            
fn admin_check(principal: &str) -> bool {
    !principal.is_empty() && principal == crate::auth_api::admin_name()
}

                                                                            
                                                                                 
                                                                                
                                                                                  
fn busy_state(job: &Option<(String, u32, String)>, id: &str, q: u32, principal: &str, admin: bool) -> &'static str {
    match job {
        Some((jid, jq, jp)) if jid == id && *jq == q && jp == principal => "rendering",
        Some(_) if admin => "waiting",
        _ => "proceed",
    }
}

                                                                            
                                                                                    
                                                                                
fn spawn_render(st: &std::sync::Arc<crate::AppState>, id: &str, q: u32, principal: &str, entry: Entry, max_bytes: u64, peak: u64) -> bool {
    if st.lite.video_busy.swap(1, std::sync::atomic::Ordering::SeqCst) != 0 { return false; }
    sweep_partials(st, &st.data_dir.join("stream-cache"));
    if let Ok(mut m) = st.lite.video_error.lock() { m.remove(&format!("{principal}:{id}:{q}")); }
    if let Ok(mut job) = st.lite.video_job.lock() { *job = Some((id.to_string(), q, principal.to_string())); }
    let st2 = st.clone();
    let id2 = id.to_string();
    let principal2 = principal.to_string();
    tokio::spawn(async move {
        match make_video(&st2, &id2, q, &entry, max_bytes, ADMIN_DISK_FLOOR, peak).await {
            Ok(_) => clear_neg(&st2, &id2, q),
            Err(e) => { store_neg(&st2, &id2, q, 502, 60, if e == "too big" { "adm" } else { "any" }); if let Ok(mut m) = st2.lite.video_error.lock() { if m.len() >= 50 { if let Some(k) = m.keys().next().cloned() { m.remove(&k); } } m.insert(format!("{principal2}:{id2}:{q}"), e); } }
        }
        if let Ok(mut job) = st2.lite.video_job.lock() { *job = None; }
        st2.lite.video_busy.store(0, std::sync::atomic::Ordering::SeqCst);
        prog_clear(&st2, &id2, q);                                                                   
    });
    true
}

pub async fn handler(State((st, _)): State<Shared>, method: Method, headers: HeaderMap, Query(params): Query<HashMap<String, String>>) -> Response {
    let id = qparam(&params, "id");
    let id_re = regex::Regex::new(r"^[A-Za-z0-9_-]{11}$").unwrap();
                                          
    if !id_re.is_match(&id) { return json_err_x(StatusCode::BAD_REQUEST, json!({"error": "id must be an 11-char video id"})); }
    let q: u32 = clamp_q(params.get("q").map(|s| s.as_str()));
                                                                                       
                                                                                     
                                                                                   
                                                                                     
    let principal = super::auth::cred_principal(&st, headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()))
        .unwrap_or_default();                                                         
    let admin = admin_check(&principal);
                                                                                
                                                                            
                                                                               
                                                                          
    let caller_class = if admin { "adm" } else { "ord" };
                                                                                     
                                                                                 
                                                                                    
    if method == Method::HEAD { return head_response(&st, &id, q); }
                                                                                    
                                                                                  
                                                                                   
                                                                           
                                                                                
                                                                               
                                                                                
                                                                                  
                                                                          
                                                                          
    let admit = |st: &std::sync::Arc<crate::AppState>, peak: u64| -> Result<u64, Response> {
        let budget = free_bytes(&st.data_dir).unwrap_or(0)
            .saturating_sub(ADMIN_DISK_FLOOR)
            .saturating_sub(st.lite.video_reserved.load(std::sync::atomic::Ordering::SeqCst));
        if peak > budget {
            Err(json_err_x(StatusCode::PAYLOAD_TOO_LARGE, json!({"error": "not enough free server disk for this one"})))
        } else { Ok(budget) }
    };
    if qparam(&params, "json") == "1" {
                                                                                 
                                                                              
                                                                                    
                                                                                
                                                                                 
                                                                                  
                                                                                   
                                                                            
                                                                                   
                                                                                    
                                                                              
                             
        let cached = std::path::Path::new(&st.data_dir.join("stream-cache").join(format!("{id}.lite{q}"))).exists();
        if cached {
            return json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("state", OJ::Str("ready".into())), ("id", OJ::Str(id)), ("q", OJ::U64(q as u64))]);
        }
        if st.lite.video_busy.load(std::sync::atomic::Ordering::SeqCst) != 0 {
                                                                                     
                                                                                   
            let job = st.lite.video_job.lock().ok().and_then(|j| j.clone());
            match busy_state(&job, &id, q, &principal, admin) {
                "rendering" => {
                    let done = prog_get(&st, &id, q);                                                      
                    return json_ord(StatusCode::OK, vec![("ok", OJ::Bool(false)), ("state", OJ::Str("rendering".into())), ("rendered_bytes", OJ::U64(done))]);
                }
                "waiting" => {
                    return json_ord(StatusCode::OK, vec![("ok", OJ::Bool(false)), ("state", OJ::Str("waiting".into()))]);
                }
                _ => {}                                                                      
            }
        }
        if let Ok(m) = st.lite.video_error.lock() {
            if let Some(msg) = m.get(&format!("{principal}:{id}:{q}")) {
                return json_ord(StatusCode::OK, vec![("ok", OJ::Bool(false)), ("state", OJ::Str("error".into())), ("error", OJ::Str(msg.clone()))]);
            }
        }
                                                                              
                                                                                   
        {
            let dir0 = st.data_dir.join("stream-cache");
            if let Some((502, exp, class)) = read_neg(&dir0, &id, q) {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                if (exp == 0 || now < exp) && (class == "any" || class == caller_class) {
                    return json_ord(StatusCode::OK, vec![("ok", OJ::Bool(false)), ("state", OJ::Str("error".into())), ("error", OJ::Str("could not build that video, try another or q=360".into())), ("retryable", OJ::Bool(true))]);
                }
            }
        }
                                                                              
                                                                                
                                                                   
        let entry = match resolve_stream(&st, &id).await {
            Ok(e) => e,
            Err(e) => { store_neg(&st, &id, q, 502, 60, "any"); return json_ord(StatusCode::OK, vec![("ok", OJ::Bool(false)), ("state", OJ::Str("error".into())), ("error", OJ::Str(e.chars().take(160).collect::<String>())), ("retryable", OJ::Bool(true))]); }
        };
        let plan = lite_plan(&entry, q);
                                                                                 
        if !admin && plan.secs > 0.0 && plan.secs > LITE_MAX_SECS {
            return json_err_x(StatusCode::PAYLOAD_TOO_LARGE, json!({"error": "longer than 15 minutes; try q=360", "seconds": js_num(plan.secs)}));
        }
        if !admin && plan.est > LITE_MAX_BYTES {
            let mb = (plan.est as f64 / 1048576.0).round() as u64;
            return json_err_x(StatusCode::PAYLOAD_TOO_LARGE, json!({"error": format!("about {mb} MB, over the 150 MB cap; try q=360"), "est_mb": mb}));
        }
        let long = plan.secs > LITE_MAX_SECS || plan.est > LITE_MAX_BYTES;
        let peak = peak_bytes(&plan);
        if admin && long {
            let max_bytes = match admit(&st, peak) { Ok(b) => b, Err(r) => return r };                                        
            let _ = spawn_render(&st, &id, q, &principal, entry, max_bytes, peak);
            return json_ord(StatusCode::OK, vec![("ok", OJ::Bool(false)), ("state", OJ::Str("rendering".into())), ("rendered_bytes", OJ::U64(0))]);
        }
                                                                                
                                                                              
        if let Ok(mut m) = st.lite.video_error.lock() { m.remove(&format!("{principal}:{id}:{q}")); }
        return match make_video(&st, &id, q, &entry, LITE_MAX_BYTES, 0, 0).await {
            Ok(_) => { clear_neg(&st, &id, q); prog_clear(&st, &id, q); json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("state", OJ::Str("ready".into())), ("id", OJ::Str(id)), ("q", OJ::U64(q as u64))]) }
            Err(e) => { store_neg(&st, &id, q, 502, 60, if e == "too big" { caller_class } else { "any" }); prog_clear(&st, &id, q); if let Ok(mut m) = st.lite.video_error.lock() { if m.len() >= 50 { if let Some(k) = m.keys().next().cloned() { m.remove(&k); } } m.insert(format!("{principal}:{id}:{q}"), e.clone()); } json_ord(StatusCode::OK, vec![("ok", OJ::Bool(false)), ("state", OJ::Str("error".into())), ("error", OJ::Str(e))]) }
        };
    }
    let entry = match resolve_stream(&st, &id).await {
        Ok(e) => e,
                                                                               
        Err(e) => { store_neg(&st, &id, q, 502, 60, "any"); return json_err_x(StatusCode::BAD_GATEWAY, json!({"error": e.chars().take(160).collect::<String>()})) }                                         
    };
                                                                                        
                                                                                           
                                                                          
    if let Some(user) = crate::auth_api::user(&st, &headers).or_else(|| crate::auth_api::devices::bearer_user(&st, &headers)) {
        crate::apps::jetstream::record_play(&st.data_dir, &user, &id, "", "", 0.0);
    }
    let plan = lite_plan(&entry, q);
    if !admin && plan.secs > 0.0 && plan.secs > LITE_MAX_SECS {
                                                                                    
                                                                                  
                                                                           
                                                                                
                                                                           
        return json_err_x(StatusCode::PAYLOAD_TOO_LARGE, json!({"error": "longer than 15 minutes; try q=360", "seconds": js_num(plan.secs)}));
    }
    if !admin && plan.est > LITE_MAX_BYTES {
        let mb = (plan.est as f64 / 1048576.0).round() as u64;                                   
                                                                                
                                                                                     
        return json_err_x(StatusCode::PAYLOAD_TOO_LARGE, json!({"error": format!("about {mb} MB, over the 150 MB cap; try q=360"), "est_mb": mb}));
    }
                                                                                  
                                                                               
                                                                             
    let long = plan.secs > LITE_MAX_SECS || plan.est > LITE_MAX_BYTES;
                                                                                     
                                                                                 
                                                                               
                                                                                   
    let peak = peak_bytes(&plan);
    if qparam(&params, "info") == "1" {
                                                                                             
        return json_ord(StatusCode::OK, vec![
            ("ok", OJ::Bool(true)),
            ("id", OJ::Str(id)),
            ("q", OJ::U64(q as u64)),
            ("height", OJ::U64(plan.height as u64)),
            ("mode", OJ::Str(plan.mode)),
            ("seconds", OJ::Val(js_num(plan.secs))),
            ("est_bytes", OJ::U64(plan.est)),
        ]);
    }
                                                                                
                                                                             
                                                                                                                                           
                                                                                   
                                                                                   
                                                                                  
                                                                              
                                                                              
                                                                              
    if qparam(&params, "json") != "1" {
        let dir0 = st.data_dir.join("stream-cache");
        if let Some((502, exp, class)) = read_neg(&dir0, &id, q) {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            if (exp == 0 || now < exp) && (class == "any" || class == caller_class) {
                return json_err_x(StatusCode::BAD_GATEWAY, json!({"error": "could not build that video, try another or q=360"}));
            }
        }
    }
    let file = if admin && long && !std::path::Path::new(&st.data_dir.join("stream-cache").join(format!("{id}.lite{q}"))).exists() {
                                                                              
                                                                                  
                                                                        
                                                                               
                                                                         
                                                                                 
                                                                        
        let max_bytes = match admit(&st, peak) { Ok(b) => b, Err(r) => return r };                                        
        let _ = spawn_render(&st, &id, q, &principal, entry, max_bytes, peak);
        return Response::builder().status(StatusCode::SERVICE_UNAVAILABLE).header(header::RETRY_AFTER, "1").header(header::CACHE_CONTROL, "no-store").body(axum::body::Body::empty()).unwrap();
    } else {
        match make_video(&st, &id, q, &entry, LITE_MAX_BYTES, 0, 0).await {
        Ok(f) => { prog_clear(&st, &id, q); f }
        Err(e) => {
            prog_clear(&st, &id, q);
            return if e == "too big" {
                                                                                     
                                                                                 
                                                                                  
                                                                                  
                                                                                     
                store_neg(&st, &id, q, 413, too_big_ttl(caller_class), caller_class);                                                    
                                                      
                json_err_x(StatusCode::PAYLOAD_TOO_LARGE, json!({"error": "over the 150 MB cap; try q=360"}))
            } else {
                store_neg(&st, &id, q, 502, 60, "any");                                                                   
                                                      
                json_err_x(StatusCode::BAD_GATEWAY, json!({"error": "could not build that video, try another or q=360"}))
            };
        }
        }
    };
    clear_neg(&st, &id, q);                                                                  
                                                                                   
                                                                                    
                                                                               
                                                                             
                                                                           
                                                                                   
                                                                                 
                                                                          
    let (len, body) = match stream_file(file, admin).await { Ok(v) => v, Err(e) => return json_err_x(StatusCode::BAD_GATEWAY, json!({"error": e})) };
    Response::builder()
        .header(header::CONTENT_TYPE, "video/mp4")
        .header(header::CONTENT_LENGTH, len)
        .header("content-disposition", format!("inline; filename=\"{id}.mp4\""))
        .header(header::CACHE_CONTROL, "private, no-store")
        .header("accept-ranges", "none")
        .body(body)
        .unwrap()
}

                                                                              
                                                                  
fn too_big_ttl(class: &str) -> u64 { if class == "adm" { 300 } else { 86400 } }

fn prog_key(id: &str, q: u32) -> String { format!("{id}.lite{q}") }
                                                                                
                                                                               
                                                                              
                                                                      
fn prog_reset(st: &crate::AppState, id: &str, q: u32) { if let Ok(mut m) = st.lite.video_progress.lock() { m.insert(prog_key(id, q), 0); } }
fn prog_add(st: &crate::AppState, id: &str, q: u32, n: u64) { if let Ok(mut m) = st.lite.video_progress.lock() { *m.entry(prog_key(id, q)).or_insert(0) += n; } }
fn prog_get(st: &crate::AppState, id: &str, q: u32) -> u64 { st.lite.video_progress.lock().ok().and_then(|m| m.get(&prog_key(id, q)).copied()).unwrap_or(0) }
fn prog_clear(st: &crate::AppState, id: &str, q: u32) { if let Ok(mut m) = st.lite.video_progress.lock() { m.remove(&prog_key(id, q)); } }

fn neg_path(dir: &std::path::Path, id: &str, q: u32) -> std::path::PathBuf { dir.join(format!("{id}.lite{q}.neg")) }

                                                                           
                                                                                  
                                                                                 
                                                                           
                                                        
fn read_neg(dir: &std::path::Path, id: &str, q: u32) -> Option<(u16, u64, String)> {
    let t = std::fs::read_to_string(neg_path(dir, id, q)).ok()?;
    let mut it = t.split_whitespace();
    let status: u16 = it.next()?.parse().ok()?;
    let exp: u64 = it.next()?.parse().ok()?;
    let class = it.next().unwrap_or("any").to_string();
    if status == 413 && exp == 0 {
        let _ = std::fs::remove_file(neg_path(dir, id, q));                                
        return None;
    }
    Some((status, exp, class))
}

                                                                                    
                                                                                   
                                                                          
                                                                                 
                                                                                   
fn store_neg(st: &crate::AppState, id: &str, q: u32, status: u16, ttl_secs: u64, class: &str) {
    let dir = st.data_dir.join("stream-cache");
    let _ = std::fs::create_dir_all(&dir);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let exp = if ttl_secs == 0 { 0 } else { now + ttl_secs };
    let _ = std::fs::write(neg_path(&dir, id, q), format!("{status} {exp} {class}"));
}

fn clear_neg(st: &crate::AppState, id: &str, q: u32) {
    let _ = std::fs::remove_file(neg_path(&st.data_dir.join("stream-cache"), id, q));
}

                                                                                   
                                                                                     
                                                                                  
                                                                             
                                                                                   
                                                                                   
fn head_response(st: &crate::AppState, id: &str, q: u32) -> Response {
    let dir = st.data_dir.join("stream-cache");
    if let Some((status, exp, class)) = read_neg(&dir, id, q) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        if exp != 0 && now >= exp {
            let _ = std::fs::remove_file(neg_path(&dir, id, q));                             
        } else if class == "any" {
                                                                                    
                                                                                  
                                                                                
                                                                                
            return Response::builder().status(StatusCode::from_u16(status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE)).header(header::CACHE_CONTROL, "no-store").body(axum::body::Body::empty()).unwrap();
        }
    }
    if let Ok(m) = std::fs::metadata(dir.join(format!("{id}.lite{q}"))) {
        if m.is_file() {
            return Response::builder()
                .header(header::CONTENT_TYPE, "video/mp4")
                .header(header::CONTENT_LENGTH, m.len())
                .header("content-disposition", format!("inline; filename=\"{id}.mp4\""))
                .header(header::CACHE_CONTROL, "private, no-store")
                .header("accept-ranges", "none")
                .body(axum::body::Body::empty())
                .unwrap();
        }
    }
    Response::builder().status(StatusCode::SERVICE_UNAVAILABLE).header(header::RETRY_AFTER, "1").header(header::CACHE_CONTROL, "no-store").body(axum::body::Body::empty()).unwrap()
}

fn clamp_q(q: Option<&str>) -> u32 {
    q.and_then(|v| v.parse().ok()).filter(|q| Q_SET.contains(q)).unwrap_or(480)
}

#[cfg(test)]
mod tests {
    #[test]
    fn q_quality_set() {
                                                                                    
                                                                           
        assert_eq!(super::clamp_q(Some("1080")), 1080);
        assert_eq!(super::clamp_q(Some("720")), 720);
        assert_eq!(super::clamp_q(Some("360")), 360);
        assert_eq!(super::clamp_q(Some("abc")), 480);
        assert_eq!(super::clamp_q(None), 480);
    }
    #[test]
    fn sweep_partials_removes_only_stale_owned_partials() {
        let dir = std::env::temp_dir().join(format!("sweep-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stale = dir.join("ABCDEFGHIJK.lite1080v.part");
        let fresh = dir.join("ABCDEFGHIJK.lite1080a.part");
        let otherq = dir.join("ABCDEFGHIJK.lite999v.part");                        
        let unrelated = dir.join("ABCDEFGHIJK.mp4");
        let other = dir.join("notes.txt");
        let active = dir.join("CCCCCCCCCCC.lite480v.part");
        for f in [&stale, &fresh, &otherq, &unrelated, &other, &active] { std::fs::write(f, b"x").unwrap(); }
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        for f in [&stale, &otherq, &unrelated, &other, &active] { std::fs::File::options().write(true).open(f).unwrap().set_modified(old).unwrap(); }
        let st = crate::auth_api::devices::tests::fixture("sweep-own");
        st.lite.video_jobs.lock().unwrap().insert("CCCCCCCCCCC.lite480".to_string());                                      
        super::sweep_partials(&st, &dir);
        assert!(!stale.exists(), "stale unowned partial removed");
        assert!(active.exists(), "stale-looking but job-owned partial kept");
        assert!(fresh.exists(), "young partial kept");
        assert!(otherq.exists(), "non-Q_SET name untouched");
        assert!(unrelated.exists(), "finished file untouched");
        assert!(other.exists(), "unrelated file untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn reserve_guard_releases_on_drop() {
        let st = std::sync::Arc::new(crate::auth_api::devices::tests::fixture("resv-drop"));
        let g1 = super::RenderGuard::new(&st, 500, "AAAAAAAAAAA.lite720".into());
        let g = super::RenderGuard::new(&st, 700, "BBBBBBBBBBB.lite360".into());
        assert_eq!(st.lite.video_reserved.load(std::sync::atomic::Ordering::SeqCst), 1200);
        assert!(st.lite.video_jobs.lock().unwrap().contains("AAAAAAAAAAA.lite720"));
        assert!(st.lite.video_jobs.lock().unwrap().contains("BBBBBBBBBBB.lite360"));
        drop(g);
        assert_eq!(st.lite.video_reserved.load(std::sync::atomic::Ordering::SeqCst), 500);
        assert!(!st.lite.video_jobs.lock().unwrap().contains("BBBBBBBBBBB.lite360"));
        drop(g1);
        assert_eq!(st.lite.video_reserved.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(st.lite.video_jobs.lock().unwrap().is_empty());
    }
    #[test]
    fn admin_check_rejects_empty_principal() {
                                                                          
        assert!(!super::admin_check(""));
        assert!(super::admin_check(&crate::auth_api::admin_name()));
        assert!(!super::admin_check("somebody-else"));
    }
    #[test]
    fn mux_argv_is_pinned_exact() {
                                                                               
                                                                         
        let v = super::mux_args(std::path::Path::new("/tmp/v.part"), std::path::Path::new("/tmp/a.part"), std::path::Path::new("/tmp/o.part"));
        let got: Vec<String> = v.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        assert_eq!(got, vec![
            "-n", "10", "ffmpeg", "-v", "error", "-y", "-i", "/tmp/v.part",
            "-i", "/tmp/a.part", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", "/tmp/o.part",
        ]);
    }
    #[test]
    fn render_guard_drop_removes_owned_partials() {
                                                                             
        let st = std::sync::Arc::new(crate::auth_api::devices::tests::fixture("guard-clean"));
        let dir = st.data_dir.join("stream-cache");
        std::fs::create_dir_all(&dir).unwrap();
        let prefix = "DDDDDDDDDDD.lite720";
        for suf in ["v", "a", "o"] { std::fs::write(dir.join(format!("{prefix}{suf}.part")), b"x").unwrap(); }
        let unrelated = dir.join("EEEEEEEEEEE.lite720v.part");
        std::fs::write(&unrelated, b"x").unwrap();
        { let _g = super::RenderGuard::new(&st, 100, prefix.to_string()); }
        for suf in ["v", "a", "o"] { assert!(!dir.join(format!("{prefix}{suf}.part")).exists(), "owned partial removed on drop"); }
        assert!(unrelated.exists(), "other job's partial untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

                                                                            
                                                                               
                                                                          
    fn stub_state(user: &str) -> std::sync::Arc<crate::AppState> {
        let mut st = crate::auth_api::devices::tests::fixture(user);
        let p = st.data_dir.join("ytstub.sh");
        std::fs::write(&p, "#!/bin/sh\nprintf '%s' '{\"duration\":60.0,\"formats\":[\"{\"url\":\"http://127.0.0.1:1/v1080\",\"vcodec\":\"avc1.42\",\"height\":1080,\"fps\":30.0,\"filesize\":4000,\"acodec\":\"none\"}]}'\n").unwrap();
                                                                   
        let payload = serde_json::json!({"duration":60.0,"formats":[
            {"url":"http://127.0.0.1:1/v1080","vcodec":"avc1.42","height":1080,"fps":30.0,"filesize":4000,"acodec":"none"},
            {"url":"http://127.0.0.1:1/v720","vcodec":"avc1.42","height":720,"fps":30.0,"filesize":3000,"acodec":"none"},
            {"url":"http://127.0.0.1:1/v480","vcodec":"avc1.42","height":480,"fps":30.0,"filesize":2000,"acodec":"none"},
            {"url":"http://127.0.0.1:1/v360","vcodec":"avc1.42","height":360,"fps":30.0,"filesize":1000,"acodec":"none"},
            {"url":"http://127.0.0.1:1/a","vcodec":"none","acodec":"mp4a.40","abr":128.0,"filesize":500}
        ]});
        std::fs::write(&p, format!("#!/bin/sh\nprintf '%s' '{}'\n", payload.to_string().replace('\'', "'\\''"))).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        st.ytdlp = p.to_string_lossy().into_owned().into();
        st.egress_client = Some(reqwest::Client::new());
        std::sync::Arc::new(st)
    }
    async fn poll(st: &std::sync::Arc<crate::AppState>, user: &str, id: &str, q: u32) -> (axum::http::StatusCode, serde_json::Value) {
        use base64::Engine;
        let tok = base64::engine::general_purpose::STANDARD.encode(format!("{user}:fixture pass"));
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(axum::http::header::AUTHORIZATION, format!("Basic {tok}").parse().unwrap());
        let mut params = std::collections::HashMap::new();
        params.insert("id".to_string(), id.to_string());
        params.insert("q".to_string(), q.to_string());
        params.insert("json".to_string(), "1".to_string());
        let r = super::handler(axum::extract::State((st.clone(), std::path::PathBuf::new())), axum::http::Method::GET, headers, axum::extract::Query(params)).await;
        let status = r.status();
        let body = axum::body::to_bytes(r.into_body(), 65536).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }
    #[tokio::test]
    async fn json_ready_rendering_waiting_error_states() {
        let admin = crate::auth_api::admin_name();
        let st = stub_state(&admin);
        let dir = st.data_dir.join("stream-cache");
        std::fs::create_dir_all(&dir).unwrap();
                                               
        std::fs::write(dir.join("READY000001.lite480"), b"mp4").unwrap();
        let (s, j) = poll(&st, &admin, "READY000001", 480).await;
        assert_eq!(s, axum::http::StatusCode::OK);
        assert_eq!(j, serde_json::json!({"ok":true,"state":"ready","id":"READY000001","q":480}));
                                              
        st.lite.video_busy.store(1, std::sync::atomic::Ordering::SeqCst);
        *st.lite.video_job.lock().unwrap() = Some(("BUSY0000001".into(), 480, admin.clone()));
        st.lite.video_progress.lock().unwrap().insert("BUSY0000001.lite480".into(), 12345);
        let (s, j) = poll(&st, &admin, "BUSY0000001", 480).await;
        assert_eq!((s, j.clone()), (axum::http::StatusCode::OK, serde_json::json!({"ok":false,"state":"rendering","rendered_bytes":12345})));
                                                                               
                                                                   
        let (s, j) = poll(&st, &admin, "OTHER000001", 480).await;
        assert_eq!((s, j), (axum::http::StatusCode::OK, serde_json::json!({"ok":false,"state":"waiting"})));
        st.lite.video_busy.store(0, std::sync::atomic::Ordering::SeqCst);
        *st.lite.video_job.lock().unwrap() = None;
                                                    
        st.lite.video_error.lock().unwrap().insert(format!("{admin}:ERR00000001:480"), "mux stalled".into());
        let (s, j) = poll(&st, &admin, "ERR00000001", 480).await;
        assert_eq!((s, j), (axum::http::StatusCode::OK, serde_json::json!({"ok":false,"state":"error","error":"mux stalled"})));
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[tokio::test]
    async fn json_cross_principal_isolation() {
        let admin = crate::auth_api::admin_name();
        let st = stub_state(&admin);
        st.auth_db.claim("bobby", "fixture pass", false).unwrap();
                                                                 
        st.lite.video_error.lock().unwrap().insert(format!("{admin}:ERR00000002:480"), "admin-only failure detail".into());
        let (_, j) = poll(&st, "bobby", "ERR00000002", 480).await;
        assert_eq!(j["state"], "error");                                                     
        assert_ne!(j["error"], "admin-only failure detail");
                                                                                   
        let (_, j) = poll(&st, &admin, "ERR00000002", 480).await;
        assert_eq!(j["error"], "admin-only failure detail");
                                                                                              
        st.lite.video_busy.store(1, std::sync::atomic::Ordering::SeqCst);
        *st.lite.video_job.lock().unwrap() = Some(("BUSY0000002".into(), 480, admin.clone()));
        let (_, j) = poll(&st, "bobby", "BUSY0000002", 480).await;
        assert!(j["state"] != "waiting" && j["state"] != "rendering", "ordinary caller blind to foreign job: {j}");
    }
    #[tokio::test]
    async fn json_terminal_negative_retry_and_false_ready() {
        let admin = crate::auth_api::admin_name();
        let st = stub_state(&admin);
        let dir = st.data_dir.join("stream-cache");
        std::fs::create_dir_all(&dir).unwrap();
                                                                                  
        super::store_neg(&st, "NEG00000001", 480, 502, 60, "any");
        let (s, j) = poll(&st, &admin, "NEG00000001", 480).await;
        assert_eq!(s, axum::http::StatusCode::OK, "poll contract: json leg stays 200 even on stored negative");
        assert_eq!(j["state"], "error");
        assert_eq!(j["retryable"], true);
                                                                               
                                                                       
        std::fs::write(super::neg_path(&dir, "NEG00000001", 480), "502 1").unwrap();
        let (s, j) = poll(&st, &admin, "NEG00000001", 480).await;
        assert_eq!(s, axum::http::StatusCode::OK);
        assert_eq!(j["state"], "error");
        assert!(j.get("retryable").is_none(), "fresh attempt failure is not the stored-negative shape");
                                                                              
                                                                             
                                                                                
                                                                            
        st.auth_db.claim("bobby", "fixture pass", false).unwrap();
        super::store_neg(&st, "CLS00000001", 480, 502, 60, "adm");
        let (_, j) = poll(&st, &admin, "CLS00000001", 480).await;
        assert_eq!((j["state"].as_str(), j["retryable"].as_bool()), (Some("error"), Some(true)));
        let (_, j) = poll(&st, "bobby", "CLS00000001", 480).await;
        assert_eq!(j["state"], "error");
        assert!(j.get("retryable").is_none(), "ordinary caller bypasses the adm-tagged stored failure");
                                                                                  
        std::fs::write(dir.join("FALSE000001.lite360"), b"mp4").unwrap();
        let (_, j) = poll(&st, &admin, "FALSE000001", 720).await;
        assert_ne!(j["state"], "ready");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn busy_state_binds_principal_and_hides_foreign_jobs() {
        let job = Some(("AAAAAAAAAAA".to_string(), 1080u32, "luke".to_string()));
        assert_eq!(super::busy_state(&job, "AAAAAAAAAAA", 1080, "luke", true), "rendering");                                   
        assert_eq!(super::busy_state(&job, "AAAAAAAAAAA", 1080, "other", false), "proceed");                                                    
        assert_eq!(super::busy_state(&job, "BBBBBBBBBBB", 720, "luke", true), "waiting");                                                           
        assert_eq!(super::busy_state(&job, "BBBBBBBBBBB", 720, "someone", false), "proceed");                                   
        assert_eq!(super::busy_state(&None, "AAAAAAAAAAA", 1080, "luke", true), "proceed");                          
    }
    #[test]
    fn floor_matches_host_two_gib_precedent() {
        assert_eq!(super::ADMIN_DISK_FLOOR, 2 * 1024 * 1024 * 1024);
    }
    #[test]
    fn peak_bytes_mux_double_progressive_single() {
        let mk = |mode: &str, est: u64| super::Plan { mode: mode.into(), v: None, a: None, height: 0, secs: 0.0, est };
                                                                                           
        assert_eq!(super::peak_bytes(&mk("mux", 100)), 200 + (4 << 20));
        assert_eq!(super::peak_bytes(&mk("itag18", 100)), 100);
        assert_eq!(super::peak_bytes(&mk("mux", u64::MAX)), u64::MAX);                            
        assert_eq!(super::peak_bytes(&mk("mux", 64 << 20)), (128 << 20) + (4 << 20));                          
        assert_eq!(super::peak_bytes(&mk("mux", 1 << 30)), (2 << 30) + (1 << 26));                             
    }
    #[test]
    fn free_bytes_reads_real_fs() {
        let st = crate::auth_api::devices::tests::fixture("lite-freeb");
        let b = super::free_bytes(&st.data_dir).expect("statvfs on data dir");
        assert!(b > 0);
    }
    #[test]
    fn js_num_integer_form() {
        assert_eq!(super::js_num(7220.0).to_string(), "7220");
        assert_eq!(super::js_num(19.0).to_string(), "19");
        assert_eq!(super::js_num(1.5).to_string(), "1.5");
    }
    #[test]
    fn too_big_ttl_splits_budget_transient_from_content_deterministic() {
                                                                                     
                                                                                       
        assert_eq!(super::too_big_ttl("adm"), 300);
        assert_eq!(super::too_big_ttl("ord"), 86400);
        assert_eq!(super::too_big_ttl("any"), 86400);
    }
    #[test]
    fn progress_keys_isolate_jobs() {
        let admin = crate::auth_api::admin_name();
        let st = stub_state(&admin);
        super::prog_reset(&st, "JOBA0000001", 1080);
        super::prog_add(&st, "JOBA0000001", 1080, 100);
        super::prog_reset(&st, "JOBB0000001", 480);
        super::prog_add(&st, "JOBB0000001", 480, 5);
        assert_eq!(super::prog_get(&st, "JOBA0000001", 1080), 100, "job A keeps its own count");
        assert_eq!(super::prog_get(&st, "JOBB0000001", 480), 5, "job B starts from its own zero");
        super::prog_clear(&st, "JOBA0000001", 1080);
        assert_eq!(super::prog_get(&st, "JOBA0000001", 1080), 0, "absent key reads as 0");
        assert_eq!(super::prog_get(&st, "JOBB0000001", 480), 5, "clearing A leaves B untouched");
    }
    #[tokio::test]
    async fn unrelated_render_does_not_touch_another_jobs_progress() {
                                                                                  
                                                                                  
                                                                                 
                                                                                  
                                                                                  
        let admin = crate::auth_api::admin_name();
        let st = stub_state(&admin);
        super::prog_add(&st, "JOBA0000002", 1080, 12345);
        let (s, j) = poll(&st, &admin, "JOBB0000002", 480).await;
        assert_eq!(s, axum::http::StatusCode::OK);
        assert_eq!(j["state"], "error", "offline CDN: B's sync render fails cleanly");
        assert_eq!(super::prog_get(&st, "JOBA0000002", 1080), 12345, "A's progress untouched by B's render");
        assert!(st.lite.video_progress.lock().unwrap().get("JOBB0000002.lite480").is_none(), "B's key cleared when its job settled");
    }
    #[test]
    fn r7_selection_excludes_hls_and_prefers_direct_https() {
                                                                             
                                                                           
                                                                           
                                                                            
        let parse = |body: &str| super::collect_formats(serde_json::from_str::<super::YtInfo>(body).unwrap());
        let e = parse(r#"{"duration":2555.0,"formats":[
            {"url":"https://manifest.example/312.m3u8","protocol":"m3u8_native","vcodec":"avc1.640028","height":1080,"fps":60.0},
            {"url":"https://cdn.example/299.mp4","protocol":"https","vcodec":"avc1.640028","height":1080,"fps":60.0,"filesize":1500707626},
            {"url":"https://manifest.example/617.m3u8","protocol":"m3u8_native","vcodec":"vp09.00.40.08","height":1080,"fps":60.0},
            {"url":"https://cdn.example/140.m4a","protocol":"https","vcodec":"none","acodec":"mp4a.40.2","abr":128.0,"filesize":41348029}
        ]}"#);
        let plan = super::lite_plan(&e, 1080);
        assert_eq!(plan.mode, "mux");
        assert_eq!(plan.v.as_ref().map(|v| v.url.as_str()), Some("https://cdn.example/299.mp4"), "direct HTTPS 299 chosen, HLS 312 excluded");
        assert_eq!(plan.v.as_ref().and_then(|v| v.size), Some(1500707626));
        assert_eq!(plan.a.as_ref().map(|a| a.url.as_str()), Some("https://cdn.example/140.m4a"));
                                                                                          
        let e2 = parse(r#"{"duration":10.0,"formats":[{"url":"https://m.example/x.m3u8","protocol":"m3u8_native","vcodec":"avc1.42","height":480,"fps":30.0}]}"#);
        assert!(e2.lite_v.is_empty(), "m3u8-only listing produces no fetchable video");
                          
        assert!(super::direct_transport(Some("https")) && super::direct_transport(Some("http")));
        assert!(!super::direct_transport(Some("m3u8_native")) && !super::direct_transport(Some("http_dash_segments")) && !super::direct_transport(None));
    }
    #[tokio::test]
    async fn r7_accurate_estimate_mux_overhead_fail_prepatch_pass_corrected() {
                                                                         
                                                                              
                                                                           
                                                                               
                                                                               
                                                                             
                                                            
        use std::io::{Read, Write};
        let mut st = crate::auth_api::devices::tests::fixture("lite-r7-margin");
        let dir = st.data_dir.clone();
        let v = dir.join("r7-v.mp4");
        let a = dir.join("r7-a.m4a");
        assert!(std::process::Command::new("ffmpeg").args(["-v","error","-f","lavfi","-i","testsrc2=size=320x180:rate=30:duration=1","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-y"]).arg(&v).status().unwrap().success());
        assert!(std::process::Command::new("ffmpeg").args(["-v","error","-f","lavfi","-i","sine=frequency=440:duration=1","-c:a","aac","-y"]).arg(&a).status().unwrap().success());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (vd, ad) = (v.clone(), a.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut c) = conn else { break };
                let mut buf = vec![0u8; 8192];
                let n = c.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let line = req.lines().next().unwrap_or("").to_string();
                let body = if line.contains("r7-v") { std::fs::read(&vd).unwrap() }
                    else if line.contains("r7-a") { std::fs::read(&ad).unwrap() }
                    else { vec![] };
                let _ = c.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes());
                let _ = c.write_all(&body);
            }
        });
        st.egress_client = Some(reqwest::Client::new());
        st.proxy_url = format!("http://127.0.0.1:{port}");
        let st = std::sync::Arc::new(st);
        let nv_actual = std::fs::metadata(&v).unwrap().len();
        let na_actual = std::fs::metadata(&a).unwrap().len();
        let mk_entry = || super::Entry {
            lite_v: vec![super::LiteV { h: 180, fps: 30.0, size: Some(nv_actual), tbr: 0.0, url: "http://cdn.fixture/r7-v.mp4".into() }],
            lite_a: vec![super::LiteA { abr: 128.0, size: Some(na_actual), url: "http://cdn.fixture/r7-a.m4a".into() }],
            duration: 1.0,
        };
        let entry = mk_entry();
        let plan = super::lite_plan(&entry, 1080);
        assert_eq!(plan.mode, "mux");
        let est = plan.est;
        assert_eq!(est, nv_actual + na_actual, "ACCURATE estimate: declared == actual");
                                                                              
                                                                         
        let pre = super::make_video(&st, "R7PRE000001", 1080, &entry, u64::MAX >> 2, 0, est.saturating_mul(2)).await;
        assert_eq!(pre.err().as_deref(), Some("too big"), "prepatch reservation must still be provably insufficient");
                                                                            
        let cap = super::peak_bytes(&plan);
        let out = super::make_video(&st, "R7POST00001", 1080, &entry, u64::MAX >> 2, 0, cap).await.expect("r7 reservation admits the accurate render");
        let out_size = std::fs::metadata(&out).unwrap().len();
        let true_peak = nv_actual + na_actual + out_size;
        assert!(true_peak > est.saturating_mul(2), "repro condition: true peak {true_peak} exceeds the prepatch reservation {}", est * 2);
        let overhead = out_size - (nv_actual + na_actual);
        assert!(overhead <= super::mux_overhead_allowance(est), "measured mux overhead {overhead} within allowance {}", super::mux_overhead_allowance(est));
        assert!(true_peak <= cap, "r7 reservation covers the true peak");
        let _ = std::fs::remove_dir_all(&dir);
    }

                                                                                  
                                                                                  
                                                                            
    fn stub_state_long(user: &str) -> std::sync::Arc<crate::AppState> {
        let mut st = crate::auth_api::devices::tests::fixture(user);
        let p = st.data_dir.join("ytstub.sh");
        let payload = serde_json::json!({"duration":2400.0,"formats":[
            {"url":"http://127.0.0.1:1/v1080","protocol":"http","vcodec":"avc1.42","height":1080,"fps":30.0,"filesize":5770136,"acodec":"none"},
            {"url":"http://127.0.0.1:1/a","protocol":"http","vcodec":"none","acodec":"mp4a.40","abr":128.0,"filesize":29473}
        ]});
        std::fs::write(&p, format!("#!/bin/sh\nprintf '%s' '{}'\n", payload.to_string().replace('\'', "'\\''"))).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        st.ytdlp = p.to_string_lossy().into_owned().into();
        st.egress_client = Some(reqwest::Client::new());
        std::sync::Arc::new(st)
    }
    fn r8_entry() -> super::Entry {
        super::Entry {
            lite_v: vec![super::LiteV { h: 1080, fps: 30.0, size: Some(5770136), tbr: 0.0, url: "http://cdn.fixture/v".into() }],
            lite_a: vec![super::LiteA { abr: 128.0, size: Some(29473), url: "http://cdn.fixture/a".into() }],
            duration: 2400.0,
        }
    }
                                                                              
                                                                                
                                                                             
                                                                               
                                                                        
    fn band_reserve(st: &std::sync::Arc<crate::AppState>, peak: u64) {
        let free = super::free_bytes(&st.data_dir).unwrap_or(0);
        let r = free.saturating_sub(super::ADMIN_DISK_FLOOR).saturating_sub(peak).saturating_add(1);
        st.lite.video_reserved.store(r, std::sync::atomic::Ordering::SeqCst);
    }
    #[tokio::test]
    async fn r8_own_poll_under_reserved_budget() {
        let admin = crate::auth_api::admin_name();
        let st = stub_state_long(&admin);
        let peak = super::peak_bytes(&super::lite_plan(&r8_entry(), 1080));
        assert_eq!(peak, 15_793_522, "pin band arithmetic: 2*5799609 + 4MiB allowance");
        let id = "POLLTEST001"; let q = 1080u32;
        st.lite.video_busy.store(1, std::sync::atomic::Ordering::SeqCst);
        *st.lite.video_job.lock().unwrap() = Some((id.to_string(), q, admin.clone()));
        st.lite.video_progress.lock().unwrap().insert(format!("{id}.lite{q}"), 917504);
        band_reserve(&st, peak);                                                       
        let (s, j) = poll(&st, &admin, id, q).await;
        st.lite.video_reserved.store(0, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(s, axum::http::StatusCode::OK, "own poll must not re-admit (real run 413'd here)");
        assert_eq!(j, serde_json::json!({"ok":false,"state":"rendering","rendered_bytes":917504}));
    }
    #[tokio::test]
    async fn r8_foreign_job_waiting_under_reserved_budget() {
        let admin = crate::auth_api::admin_name();
        let st = stub_state_long(&admin);
        let peak = super::peak_bytes(&super::lite_plan(&r8_entry(), 1080));
        let id = "POLLTEST002"; let q = 1080u32;
        st.lite.video_busy.store(1, std::sync::atomic::Ordering::SeqCst);
        *st.lite.video_job.lock().unwrap() = Some((id.to_string(), q, "otheradmin".to_string()));
        band_reserve(&st, peak);
        let (s, j) = poll(&st, &admin, id, q).await;
        st.lite.video_reserved.store(0, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(s, axum::http::StatusCode::OK);
        assert_eq!(j, serde_json::json!({"ok":false,"state":"waiting"}));
    }
    #[tokio::test]
    async fn r8_warm_serve_under_reserved_budget() {
        let admin = crate::auth_api::admin_name();
        let st = stub_state_long(&admin);
        let peak = super::peak_bytes(&super::lite_plan(&r8_entry(), 1080));
        let id = "WARMSERVE01"; let q = 1080u32;
        let dir = st.data_dir.join("stream-cache");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join(format!("{id}.lite{q}"));
        std::fs::write(&f, vec![7u8; 12345]).unwrap();
        band_reserve(&st, peak);                                                                    
        use base64::Engine;
        let tok = base64::engine::general_purpose::STANDARD.encode(format!("{admin}:fixture pass"));
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(axum::http::header::AUTHORIZATION, format!("Basic {tok}").parse().unwrap());
        let mut params = std::collections::HashMap::new();
        params.insert("id".to_string(), id.to_string());
        params.insert("q".to_string(), q.to_string());
        let r = super::handler(axum::extract::State((st.clone(), std::path::PathBuf::new())), axum::http::Method::GET, headers, axum::extract::Query(params)).await;
        let status = r.status();
        let ct = r.headers().get(axum::http::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
        let body = axum::body::to_bytes(r.into_body(), 65536).await.unwrap();
        st.lite.video_reserved.store(0, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(status, axum::http::StatusCode::OK, "warm serve allocates nothing: must not admit");
        assert_eq!(ct.as_deref(), Some("video/mp4"));
        assert_eq!(body.len(), 12345);
        assert!(!f.exists(), "serve-then-delete for admin saves");
    }
    #[tokio::test]
    async fn r8_ordinary_isolated_from_admin_job_and_budget() {
        let admin = crate::auth_api::admin_name();
        let st = stub_state_long(&admin);
        let peak = super::peak_bytes(&super::lite_plan(&r8_entry(), 1080));
        let id = "ORDISOLATE1"; let q = 1080u32;
        st.lite.video_busy.store(1, std::sync::atomic::Ordering::SeqCst);
        *st.lite.video_job.lock().unwrap() = Some((id.to_string(), q, admin.clone()));
        band_reserve(&st, peak);
                                                                                  
        let (s, j) = poll(&st, "bobby", id, q).await;
        st.lite.video_reserved.store(0, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(s, axum::http::StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(j["error"], "longer than 15 minutes; try q=360");                                        
        assert!(j.get("state").is_none() && j.get("rendered_bytes").is_none(), "no job existence/progress leak");
    }
    #[tokio::test]
    async fn r8_cold_start_admission_still_enforced() {
        let admin = crate::auth_api::admin_name();
        let st = stub_state_long(&admin);
        let peak = super::peak_bytes(&super::lite_plan(&r8_entry(), 1080));
        band_reserve(&st, peak);                                                               
        let (s, j) = poll(&st, &admin, "COLDSTART01", 1080).await;
        st.lite.video_reserved.store(0, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(s, axum::http::StatusCode::PAYLOAD_TOO_LARGE, "render starts stay gated");
        assert_eq!(j["error"], "not enough free server disk for this one");
        assert_eq!(st.lite.video_busy.load(std::sync::atomic::Ordering::SeqCst), 0, "no render started");
    }
}

#[cfg(test)]
mod head_probe_tests {
    use super::*;
    fn fix(name: &str) -> crate::AppState { crate::auth_api::devices::tests::fixture(name) }
    fn plant(st: &crate::AppState, id: &str, q: u32, bytes: &[u8]) {
        let dir = st.data_dir.join("stream-cache");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.lite{q}")), bytes).unwrap();
    }
    #[test] fn cold_no_state_is_503_with_retry_after() {
        let st = fix("lite-head-cold");
        let r = head_response(&st, "COLDHEAD001", 360);
        assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(r.headers()[header::RETRY_AFTER], "1");
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
        assert!(!st.data_dir.join("stream-cache").join("COLDHEAD001.lite360").exists());
    }
    #[test] fn warm_render_is_200_with_get_contract_headers() {
        let st = fix("lite-head-warm");
        plant(&st, "WARMHEAD001", 360, b"hello");
        let r = head_response(&st, "WARMHEAD001", 360);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()[header::CONTENT_LENGTH], "5");
        assert_eq!(r.headers()["accept-ranges"], "none");
        assert_eq!(r.headers()[header::CACHE_CONTROL], "private, no-store");
    }
    #[test] fn legacy_permanent_413_is_purged_on_read() {
                                                                               
                                                                                   
        let st = fix("lite-head-permneg");
        let dir = st.data_dir.join("stream-cache");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(neg_path(&dir, "PERMNEG0001", 360), "413 0").unwrap();                              
        let r = head_response(&st, "PERMNEG0001", 360);
        assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(r.headers().get(header::RETRY_AFTER).is_some());
        assert!(!neg_path(&dir, "PERMNEG0001", 360).exists(), "poison file purged");
        assert_eq!(read_neg(&dir, "PERMNEG0001", 360), None);
    }
    #[test] fn class_tagged_neg_reads_cold_on_head_and_is_kept() {
                                                                            
                                                                                   
        let st = fix("lite-head-clsneg");
        store_neg(&st, "CLSNEG00001", 360, 413, 86400, "ord");
        let r = head_response(&st, "CLSNEG00001", 360);
        assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(r.headers()[header::RETRY_AFTER], "1");
        assert!(neg_path(&st.data_dir.join("stream-cache"), "CLSNEG00001", 360).exists());
    }
    #[test] fn transient_neg_answers_inside_window() {
        let st = fix("lite-head-transneg");
        store_neg(&st, "TRANSNEG001", 360, 502, 60, "any");
        assert_eq!(head_response(&st, "TRANSNEG001", 360).status(), StatusCode::BAD_GATEWAY);
    }
    #[test] fn lapsed_marker_falls_through_to_503_and_is_removed() {
        let st = fix("lite-head-lapsed");
        let dir = st.data_dir.join("stream-cache");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(neg_path(&dir, "LAPSEDNEG01", 360), "413 1").unwrap();                                   
        let r = head_response(&st, "LAPSEDNEG01", 360);
        assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(!neg_path(&dir, "LAPSEDNEG01", 360).exists());
    }
    #[test] fn stored_neg_wins_over_warm_file() {
        let st = fix("lite-head-negwins");
        plant(&st, "NEGWINS0001", 360, b"hello");
        store_neg(&st, "NEGWINS0001", 360, 502, 60, "any");
        assert_eq!(head_response(&st, "NEGWINS0001", 360).status(), StatusCode::BAD_GATEWAY);
    }
    #[test] fn clear_neg_restores_cold_semantics() {
        let st = fix("lite-head-clear");
        store_neg(&st, "CLEARNEG001", 360, 502, 60, "any");
        clear_neg(&st, "CLEARNEG001", 360);
        assert_eq!(head_response(&st, "CLEARNEG001", 360).status(), StatusCode::SERVICE_UNAVAILABLE);
    }
    #[test] fn garbage_marker_is_ignored() {
        let st = fix("lite-head-garbage");
        let dir = st.data_dir.join("stream-cache");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(neg_path(&dir, "GARBAGE0001", 360), "junk").unwrap();
        assert_eq!(head_response(&st, "GARBAGE0001", 360).status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(read_neg(&dir, "GARBAGE0001", 360), None);
    }
    #[test] fn q_keys_are_independent() {
        let st = fix("lite-head-qkey");
        store_neg(&st, "QKEYNEG0001", 360, 502, 60, "any");
        assert_eq!(head_response(&st, "QKEYNEG0001", 720).status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(head_response(&st, "QKEYNEG0001", 360).status(), StatusCode::BAD_GATEWAY);
    }
}

#[cfg(test)]
mod egress_gate_tests {
    use super::*;
    use std::sync::Arc;

    fn shared(name: &str) -> (Shared, Arc<crate::AppState>) {
        let st = Arc::new(crate::auth_api::devices::tests::fixture(name));
        let dir = st.data_dir.clone();
        ((st.clone(), dir), st)
    }
    fn get_params(id: &str) -> HashMap<String, String> { HashMap::from([("id".to_string(), id.to_string())]) }

    #[tokio::test]
    async fn resolve_refuses_to_spawn_without_egress() {
                                                                                          
                                                                                          
                                                                  
        let st = crate::auth_api::devices::tests::fixture("egate-none");
        let err = resolve_stream(&st, "EGATE000001").await.err().unwrap();
        assert_eq!(err, "egress unavailable");
    }
    #[tokio::test]
    async fn hop_refuses_transfer_without_egress() {
                                                                                           
        let st = crate::auth_api::devices::tests::fixture("egate-hop");
        let dest = st.data_dir.join("hop.part");
        let err = lite_hop(&st, "http://127.0.0.1:9/x", &dest, super::LITE_MAX_BYTES, 0, None).await.err().unwrap();
        assert_eq!(err, "egress unavailable");
        assert!(!dest.exists());
    }
    #[tokio::test]
    async fn proxy_url_alone_does_not_open_the_gate() {
                                                                                         
        let mut st = crate::auth_api::devices::tests::fixture("egate-probefail");
        st.proxy_url = "http://127.0.0.1:9".into();
        let err = resolve_stream(&st, "EGATE000001").await.err().unwrap();
        assert_eq!(err, "egress unavailable");
    }
    #[tokio::test]
    async fn egress_up_passes_gate_and_fails_downstream() {
                                                                                          
                                                                                   
        let mut st = crate::auth_api::devices::tests::fixture("egate-up");
        st.proxy_url = "http://127.0.0.1:9".into();
        st.egress_client = Some(reqwest::Client::new());
        let err = resolve_stream(&st, "EGATE000001").await.err().unwrap();
        assert_eq!(err, "can't load this video - try another");
    }
    #[tokio::test]
    async fn head_cold_is_503_even_without_egress() {
                                                                                      
                                                       
        let (sh, _st) = shared("egate-head");
        let r = handler(State(sh), Method::HEAD, HeaderMap::new(), Query(get_params("EGATE000001"))).await;
        assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(r.headers()[header::RETRY_AFTER], "1");
    }
    #[tokio::test]
    async fn get_without_egress_is_502_and_stores_transient_neg() {
        let (sh, st) = shared("egate-get");
        let r = handler(State(sh), Method::GET, HeaderMap::new(), Query(get_params("EGATE000001"))).await;
        assert_eq!(r.status(), StatusCode::BAD_GATEWAY);
        let body = axum::body::to_bytes(r.into_body(), 65536).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["error"], "egress unavailable");
        let neg = std::fs::read_to_string(st.data_dir.join("stream-cache").join("EGATE000001.lite480.neg")).unwrap();
        assert!(neg.starts_with("502 "));
    }
}


#[cfg(test)]
mod poll_order_tests {
                                                                                
                                                                                  
                                                                            
    use super::*;
    fn fx(user: &str) -> std::sync::Arc<crate::AppState> { std::sync::Arc::new(crate::auth_api::devices::tests::fixture(user)) }
    async fn vcall(st: &std::sync::Arc<crate::AppState>, id: &str, user: &str) -> (axum::http::StatusCode, String) {
        let sh: crate::Shared = (st.clone(), st.data_dir.clone());
        let mut h = axum::http::HeaderMap::new();
        h.insert(axum::http::header::AUTHORIZATION, format!("Bearer {user}:fixture pass").parse().unwrap());
        let params: HashMap<String, String> = [("id".to_string(), id.to_string()), ("q".to_string(), "720".to_string()), ("json".to_string(), "1".to_string())].into_iter().collect();
        let r = super::handler(axum::extract::State(sh), axum::http::Method::GET, h, axum::extract::Query(params)).await;
        let s = r.status();
        let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        (s, String::from_utf8(b.to_vec()).unwrap())
    }
    fn entry(secs: f64, vsz: u64, asz: u64) -> super::Entry {
        super::Entry {
            lite_v: vec![super::LiteV { h: 360, fps: 30.0, size: Some(vsz), tbr: 100.0, url: "http://127.0.0.1/v".into() }],
            lite_a: vec![super::LiteA { abr: 100.0, size: Some(asz), url: "http://127.0.0.1/a".into() }],
            duration: secs,
        }
    }
    fn stub(id: &str, r: Result<super::Entry, String>) {
        super::RESOLVE_STUB.get_or_init(Default::default).lock().unwrap().insert(id.to_string(), r);
    }
    // the stub map is global, so the tests that install stubs (and the two that
    // assert the map is empty afterwards) must not interleave: hold one
    // file-scope lock for the whole body of each stub-using test. poison is
    // recovered so one panicking test does not wedge the rest of the run.
    static STUB_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn stub_test_guard() -> std::sync::MutexGuard<'static, ()> {
        STUB_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn cache_dir(st: &crate::AppState) -> std::path::PathBuf { let d = st.data_dir.join("stream-cache"); std::fs::create_dir_all(&d).unwrap(); d }

    #[tokio::test]
    async fn warm_poll_ready_without_resolve() {
        let st = fx("po-warm"); let id = "POLLWARM001";
        std::fs::write(cache_dir(&st).join(format!("{id}.lite720")), b"x").unwrap();
                                                                                
        let (s, b) = vcall(&st, id, "po-warm").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["state"], "ready");
    }
    #[tokio::test]
    async fn busy_own_job_poll_progress_without_resolve() {
        let st = fx("po-busy"); let id = "POLLBUSY001";
        st.lite.video_busy.store(1, std::sync::atomic::Ordering::SeqCst);
        *st.lite.video_job.lock().unwrap() = Some((id.to_string(), 720, "po-busy".to_string()));
        st.lite.video_progress.lock().unwrap().insert(format!("{id}.lite720"), 12345);
        let (s, b) = vcall(&st, id, "po-busy").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["state"], "rendering");
        assert_eq!(j["rendered_bytes"], 12345);
        st.lite.video_busy.store(0, std::sync::atomic::Ordering::SeqCst);
    }
    #[tokio::test]
    async fn error_poll_serves_stored_error_without_resolve() {
        let st = fx("po-err"); let id = "POLLERR0001";
        st.lite.video_error.lock().unwrap().insert(format!("po-err:{id}:720"), "boom".to_string());
        let (s, b) = vcall(&st, id, "po-err").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["state"], "error");
        assert_eq!(j["error"], "boom");
    }
    #[tokio::test]
    async fn stored_neg_poll_error_retryable_without_resolve() {
        let st = fx("po-neg"); let id = "POLLNEG0001";
        let exp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 60;
        std::fs::write(cache_dir(&st).join(format!("{id}.lite720.neg")), format!("502 {exp} any")).unwrap();
        let (s, b) = vcall(&st, id, "po-neg").await;
        assert_eq!(s, axum::http::StatusCode::OK);
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["state"], "error");
        assert_eq!(j["retryable"], true);
    }
    #[tokio::test]
    async fn cold_poll_resolve_failure_is_on_contract_200_and_stores_neg() {
        let _g = stub_test_guard();
        let st = fx("po-cold"); let id = "POLLCOLD001";
        stub(id, Err("can't load this video - try another".to_string()));
        let (s, b) = vcall(&st, id, "po-cold").await;
        assert_eq!(s, axum::http::StatusCode::OK, "poll contract: cold resolve failure is 200, not HTTP 502: {b}");
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["state"], "error");
        assert_eq!(j["error"], "can't load this video - try another");
        assert_eq!(j["retryable"], true);
        assert!(super::RESOLVE_STUB.get().unwrap().lock().unwrap().is_empty(), "exactly one resolve, stub consumed");
        assert!(matches!(super::read_neg(&st.data_dir.join("stream-cache"), id, 720), Some((502, _, _))), "same 60s any negative as the plain-GET leg");
                                                                                         
        let (s2, b2) = vcall(&st, id, "po-cold").await;
        assert_eq!(s2, axum::http::StatusCode::OK);
        assert_eq!(serde_json::from_str::<serde_json::Value>(&b2).unwrap()["state"], "error");
    }
    #[tokio::test]
    async fn cold_poll_ordinary_duration_gate_preserved() {
        let _g = stub_test_guard();
        let st = fx("po-dur"); let id = "POLLDUR0001";
        stub(id, Ok(entry(901.0, 1000, 1000)));
        let (s, b) = vcall(&st, id, "po-dur").await;
        assert_eq!(s, axum::http::StatusCode::PAYLOAD_TOO_LARGE);
        assert!(b.contains("longer than 15 minutes; try q=360") && b.contains("\"seconds\":901"), "exact established 413 shape: {b}");
    }
    #[tokio::test]
    async fn cold_poll_ordinary_size_gate_preserved() {
        let _g = stub_test_guard();
        let st = fx("po-size"); let id = "POLLSIZE001";
        stub(id, Ok(entry(100.0, 120_000_000, 40_000_000)));                           
        let (s, b) = vcall(&st, id, "po-size").await;
        assert_eq!(s, axum::http::StatusCode::PAYLOAD_TOO_LARGE);
        assert!(b.contains("over the 150 MB cap; try q=360"), "exact established 413 shape: {b}");
    }
    #[tokio::test]
    async fn cold_poll_admin_long_starts_render_on_contract_200() {
        let _g = stub_test_guard();
        let st = fx("luke"); let id = "POLLADMIN01";
        stub(id, Ok(entry(901.0, 1000, 1000)));
        let (s, b) = vcall(&st, id, "luke").await;
        assert_eq!(s, axum::http::StatusCode::OK, "admin-long cold start stays on the poll contract: {b}");
        let j: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(j["state"], "rendering");
        assert_eq!(j["rendered_bytes"], 0);
        assert!(super::RESOLVE_STUB.get().unwrap().lock().unwrap().is_empty());
    }
}
