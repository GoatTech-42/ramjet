                                                                                                   
                                                                                              
                                                                                                 
                                                                                                                                 
                                                                                               
                                                                                                    
use axum::http::StatusCode;
use axum::response::Response;
use std::path::Path;
use crate::lite::{json_ord, json_err, OJ};
use super::{fresh_id, io_fail, js_string, millis, parse_body2, too_large, BodyErr};

pub const IDLE_PARK_MS: i64 = 120_000;
pub const IDLE_DEAD_MS: i64 = 600_000;
pub const HANDOFF_CAP_MS: i64 = 6 * 3600_000;                                            
pub const STALL_MS: i64 = 120_000;                                                           
pub const DRAIN_MS: i64 = 60_000;                                                                 
pub const SEG_STALL_MS: i64 = 30_000;                                                                                                                                             
pub const START_TIMEOUT_MS: i64 = 30_000;                                                           
const MAX_TABS: usize = 8;
const RATE_CAP: usize = 10;                                                      
const TOUCH_MAX_WAIT_S: i64 = 30;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State { Starting, Ready, Paused, Parked, Draining, Dead }
fn state_str(s: State) -> &'static str {
    match s { State::Starting => "starting", State::Ready => "ready", State::Paused => "paused",
              State::Parked => "parked", State::Draining => "draining", State::Dead => "dead" }
}

#[derive(Clone)]
pub struct Tab { pub url: String, pub title: String, pub depth: u32, pub viewed: u64 }                                                        

                                                                                              
#[derive(Clone, PartialEq, Eq)]
pub struct Media { pub id: String, pub kind: String }

                                                                                          
pub trait SegWriter: Send {
    fn begin(&mut self, dir: &Path);
    fn segment(&mut self);                                                                            
    fn endlist(&mut self);                                             
                                                                                                                  
                                                                                                   
    fn deferred_ready(&self) -> bool { false }
                                                                                                               
    fn event(&mut self, _e: &serde_json::Value, _active_url: &str) {}
                                                                                                                                
                                                                                                                      
    fn progress_age_ms(&self) -> Option<i64> { None }
}
                                                                                                                    
                                                                                                             
#[cfg(test)]
struct NullWriter;
#[cfg(test)]
impl SegWriter for NullWriter {
    fn begin(&mut self, _dir: &Path) {}
    fn segment(&mut self) {}
    fn endlist(&mut self) {}
}

                                                                                                     
                                                                                                    
                                                                                                            
                                                                                                                                                                                                  
                                                                                                 
const WORKER_W: &str = "1280";                                                                    
const WORKER_H: &str = "658";
const WORKER_FPS: &str = "12";
const WORKER_STOP_GRACE_S: u64 = 6;

pub struct ChromeWriter {
    id: String, url: String, cmd: String, proxy: String, chrome: Option<String>, ffmpeg: Option<String>,
    progress: std::sync::Arc<std::sync::atomic::AtomicI64>,                                                                                 
    tx: Option<tokio::sync::mpsc::Sender<String>>,
    dir: Option<std::path::PathBuf>,
    shown: String,
    dropped: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl ChromeWriter {
                                                                                                                                        
                                                                                                                
    fn from_env(id: &str, url: &str) -> Option<Self> {
        if let Some(c) = crate::render_config::current() {
            return Some(ChromeWriter { id: id.to_string(), url: url.to_string(), cmd: c.cmd.clone(), proxy: c.proxy_url.clone(), chrome: Some(c.chrome.clone()), ffmpeg: Some(c.ffmpeg.clone()), progress: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(-1)), tx: None, dir: None, shown: url.to_string(), dropped: Default::default() });
        }
        #[cfg(test)]
        {
            let cmd = std::env::var("RJ_RENDER_CMD").ok().filter(|c| Path::new(c).is_absolute())?;
            let proxy = std::env::var("RJ_RENDER_PROXY").ok().filter(|p| !p.is_empty())?;
            return Some(ChromeWriter { id: id.to_string(), url: url.to_string(), cmd, proxy, chrome: None, ffmpeg: None, progress: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(-1)), tx: None, dir: None, shown: url.to_string(), dropped: Default::default() });
        }
        #[cfg(not(test))]
        None
    }
    fn send(&self, line: String) { if let Some(tx) = &self.tx { let _ = tx.try_send(line); } }                                                       
}
impl SegWriter for ChromeWriter {
    fn begin(&mut self, dir: &Path) {
                                                                                                                       
        let Ok(h) = tokio::runtime::Handle::try_current() else { return; };
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        self.tx = Some(tx); self.dir = Some(dir.to_path_buf());
        self.progress.store(mono_ms(), std::sync::atomic::Ordering::Relaxed);                                                             
        h.spawn(pump(self.id.clone(), self.cmd.clone(), self.proxy.clone(), self.chrome.clone(), self.ffmpeg.clone(), self.progress.clone(), dir.to_path_buf(), self.url.clone(), rx, self.dropped.clone()));
    }
    fn segment(&mut self) {}                                             
    fn endlist(&mut self) { self.send("{\"op\":\"stop\"}\n".to_string()); }                                                         
    fn deferred_ready(&self) -> bool { true }
    fn progress_age_ms(&self) -> Option<i64> {
                                                                                                                                                      
                                                                                                                      
        let v = self.progress.load(std::sync::atomic::Ordering::Relaxed);
        if v < 0 { None } else { Some((mono_ms() - v).max(0)) }
    }
    fn event(&mut self, e: &serde_json::Value, active_url: &str) {
        let op = match e["type"].as_str().unwrap_or("") {
            "key" => { let k = js_string(&e["key"]); if k.is_empty() { return; } serde_json::json!({"op":"key","key":k}) }
            "text" => serde_json::json!({"op":"text","text":js_string(&e["text"])}),
            "back" => serde_json::json!({"op":"back"}),
                                                                                                               
            "nav" | "tab_new" | "tab_switch" | "tab_close" => {
                if active_url.is_empty() || active_url == self.shown { return; }
                self.shown = active_url.to_string();
                serde_json::json!({"op":"nav","url":active_url})
            }
            _ => return,
        };
        self.send(format!("{op}\n"));
    }
}
                                                                                                                                                       
fn mono_ms() -> i64 { static T0: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new(); (T0.get_or_init(std::time::Instant::now).elapsed().as_millis() + 3_600_000).min(i64::MAX as u128 / 4) as i64 }
                                                                                                                                                              
                                                                    
fn playlist_changed(last: &mut Option<std::time::SystemTime>, now: Option<std::time::SystemTime>) -> bool {
    match now { Some(t) if *last != Some(t) => { *last = Some(t); true } _ => false }
}
impl Drop for ChromeWriter {
    fn drop(&mut self) {
        self.dropped.store(true, std::sync::atomic::Ordering::Relaxed);
        self.tx = None;                                                                                         
        if let Some(d) = &self.dir { let _ = std::fs::remove_dir_all(d); }
    }
}

async fn pump(id: String, cmd: String, proxy: String, chrome: Option<String>, ffmpeg: Option<String>, progress: std::sync::Arc<std::sync::atomic::AtomicI64>, dir: std::path::PathBuf, url: String, mut rx: tokio::sync::mpsc::Receiver<String>, dropped: std::sync::Arc<std::sync::atomic::AtomicBool>) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let _ = tokio::fs::create_dir_all(&dir).await;
    let mut c = tokio::process::Command::new(&cmd);
    c.args(["--dir"]).arg(&dir).args(["--url", url.as_str(), "--w", WORKER_W, "--h", WORKER_H, "--fps", WORKER_FPS])
        .env_clear().env("RJ_RENDER_PROXY", &proxy).env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    if let Some(x) = &chrome { c.env("RJ_CHROME", x); }
    if let Some(x) = &ffmpeg { c.env("RJ_FFMPEG", x); }
                                                                                                                                                                
                                                                                                
    #[cfg(test)]
    for k in ["PATH", "RJ_CHROME", "RJ_FFMPEG", "RJ_RENDER_NO_SANDBOX"] { if let Ok(v) = std::env::var(k) { c.env(k, v); } }
    let Ok(mut child) = c.spawn() else { worker_gone(&id); return; };
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else { worker_gone(&id); return; };
    let mut rdr = tokio::io::BufReader::new(stdout);                                                                                   
    let (mut fb, mut ev_rate) = (Vec::<u8>::new(), EvRate::new());
    let mut open = true;
    let (mut last_mtime, mut tick) = (None, tokio::time::interval(std::time::Duration::from_secs(1)));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let index = dir.join("index.m3u8");
    loop {
        tokio::select! {
            _ = tick.tick() => {                                                                                                               
                let m = tokio::fs::symlink_metadata(&index).await.ok().filter(|m| m.is_file()).and_then(|m| m.modified().ok());
                if playlist_changed(&mut last_mtime, m) { progress.store(mono_ms(), std::sync::atomic::Ordering::Relaxed); }
            }
            f = read_frame(&mut rdr, &mut fb) => match f {
                Frame::Line => {
                    if !ev_rate.allow() { break; }                                                       
                    let l = String::from_utf8_lossy(&fb).into_owned(); fb.clear();
                    on_worker_line(&id, &l);
                }
                Frame::Eof | Frame::TooLong => break,                                                                   
            },
            m = rx.recv(), if open => match m {
                Some(m) => {
                                                                                                                                                                        
                    let w = tokio::time::timeout(std::time::Duration::from_secs(2), async { stdin.write_all(m.as_bytes()).await?; stdin.flush().await }).await;
                    if !matches!(w, Ok(Ok(()))) { break; }                                                                             
                }
                None => {                                                                        
                    open = false; let _ = stdin.shutdown().await;
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(WORKER_STOP_GRACE_S), async { while matches!(read_frame(&mut rdr, &mut fb).await, Frame::Line) { fb.clear(); } }).await;
                    break;
                }
            },
        }
    }
    let _ = child.kill().await;                                         
    worker_gone(&id);
    if dropped.load(std::sync::atomic::Ordering::Relaxed) { let _ = std::fs::remove_dir_all(&dir); }                                                          
}

const WORKER_LINE_MAX: usize = 4096;                                                                                            
const WORKER_URL_MAX: usize = 2048;
const WORKER_EV_PER_S: u32 = 20;
                                                                    
fn worker_url_ok(u: &str) -> bool { u.len() <= WORKER_URL_MAX && !bad_url(u) }
enum Frame { Line, Eof, TooLong }
                                                                                                                                                                 
async fn read_frame<R: tokio::io::AsyncBufRead + Unpin>(r: &mut R, buf: &mut Vec<u8>) -> Frame {
    use tokio::io::AsyncBufReadExt;
    loop {
        let (n, done) = {
            let c = match r.fill_buf().await { Ok(c) if !c.is_empty() => c, _ => return Frame::Eof };
            match c.iter().position(|b| *b == b'\n') {
                Some(i) => { if buf.len() + i > WORKER_LINE_MAX { return Frame::TooLong; } buf.extend_from_slice(&c[..i]); (i + 1, true) }
                None => { if buf.len() + c.len() > WORKER_LINE_MAX { return Frame::TooLong; } buf.extend_from_slice(c); (c.len(), false) }
            }
        };
        r.consume(n);
        if done { return Frame::Line; }
    }
}
                               
struct EvRate { start: std::time::Instant, n: u32 }
impl EvRate {
    fn new() -> Self { Self { start: std::time::Instant::now(), n: 0 } }
    fn allow(&mut self) -> bool {
        if self.start.elapsed() >= std::time::Duration::from_secs(1) { self.start = std::time::Instant::now(); self.n = 0; }
        self.n += 1; self.n <= WORKER_EV_PER_S
    }
}
                                                                                            
fn on_worker_line(id: &str, line: &str) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return; };
    match v["ev"].as_str().unwrap_or("") {
        "segment" => segment_landed(id),
        "url" => {
            let u = js_string(&v["url"]);
            if u.is_empty() || !worker_url_ok(&u) { return; }
            RenderLock::with(|st| if let Some(s) = st.live.as_mut().filter(|s| s.id == id) {
                if let Some(t) = s.tabs.get_mut(s.active) { if t.url != u { t.url = u.clone(); t.title = u; bump(s); } }
            });
        }
        _ => {}                                                       
    }
}
                                                                                                               
fn segment_landed(id: &str) {
    RenderLock::with(|st| if let Some(s) = st.live.as_mut().filter(|s| s.id == id) {
        if s.state == State::Starting { s.state = State::Ready; bump(s); }
    });
}
                                                                                                                    
fn worker_gone(id: &str) {
    RenderLock::with(|st| if let Some(s) = st.live.as_mut().filter(|s| s.id == id) {
        if s.state != State::Dead && s.state != State::Draining { s.state = State::Dead; bump(s); }
    });
}
#[cfg(test)] static TEST_WRITER_MODE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);                                                                          
#[cfg(test)] static TEST_LOG: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
#[cfg(test)]
struct DeferredMock;
#[cfg(test)]
impl SegWriter for DeferredMock {
    fn begin(&mut self, _dir: &Path) { TEST_LOG.lock().unwrap().push("begin".into()); }
    fn segment(&mut self) {}
    fn endlist(&mut self) { TEST_LOG.lock().unwrap().push("endlist".into()); }
    fn deferred_ready(&self) -> bool { true }
    fn event(&mut self, e: &serde_json::Value, u: &str) { TEST_LOG.lock().unwrap().push(format!("{}:{}", e["type"].as_str().unwrap_or(""), u)); }
    fn progress_age_ms(&self) -> Option<i64> { let a = TEST_PROGRESS_AGE.load(std::sync::atomic::Ordering::Relaxed); if a < 0 { None } else { Some(a) } }
}
#[cfg(test)] static TEST_PROGRESS_AGE: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(-1);                         
                                                                                                             
fn make_writer(id: &str, url: &str) -> Option<Box<dyn SegWriter>> {
    #[cfg(test)]
    match TEST_WRITER_MODE.load(std::sync::atomic::Ordering::Relaxed) {
        0 => return Some(Box::new(NullWriter)),
        1 => return Some(Box::new(DeferredMock)),
        _ => {}
    }
    ChromeWriter::from_env(id, url).map(|w| Box::new(w) as Box<dyn SegWriter>)
}
fn renderer_unavailable() -> Response { json_err(StatusCode::SERVICE_UNAVAILABLE, "the renderer is not available on this box") }
fn apply_fwd(s: &mut Session, e: &serde_json::Value) {
    apply_event(s, e);
    let u = s.tabs.get(s.active).map(|t| t.url.clone()).unwrap_or_default();
    s.writer.event(e, &u);
}

pub struct Session {
    pub id: String, pub owner: String, pub origin_device: Option<String>, pub state: State,
    pub tabs: Vec<Tab>, pub active: usize,
    pub seq: u64, pub touch_at: i64, pub version: u64,                                           
    pub media: Option<Media>, pub media_ever: bool,                                         
    pub media_since: i64, pub last_pull: i64, pub media_gen: u64,
    pub started_at: i64, pub drain_at: i64,
    pub stream_pulls: u32,
    pub ticket: Option<(String, i64)>,                                                                                          
    pub view_ctr: u64,
    pub event_ts: Vec<i64>,
    pub writer: Box<dyn SegWriter>,
}

#[derive(Default)]
pub struct RenderStore { pub live: Option<Session>, pub draining: Vec<Session> }                                                                                         
static RENDER: std::sync::Mutex<Option<RenderStore>> = std::sync::Mutex::new(None);
struct RenderLock;
impl RenderLock {
    fn with<R>(f: impl FnOnce(&mut RenderStore) -> R) -> R {
        let mut g = RENDER.lock().unwrap_or_else(|e| e.into_inner());
        f(g.get_or_insert_with(RenderStore::default))
    }
}
                                                                                                          
static RENDER_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn bump(s: &mut Session) { s.version += 1; RENDER_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }

                                                                                                         
                                                                                                
                                                                                                           
                                                                                                       
pub(crate) struct Hooks { clock: Option<(i64, i64, std::time::Instant)>, pub(crate) guard: Option<bool>, slow_start: bool, crash_armed: std::sync::atomic::AtomicBool }
#[cfg(any(test, feature = "qa-hooks"))]
pub(crate) fn hooks() -> &'static Hooks {
    static H: std::sync::OnceLock<Hooks> = std::sync::OnceLock::new();
    H.get_or_init(|| {
        if std::env::var("RAMJET_RENDER_TEST_HOOKS").ok().as_deref() != Some("1") {
            return Hooks { clock: None, guard: None, slow_start: false, crash_armed: false.into() };
        }
        let clock = std::env::var("RAMJET_RENDER_CLOCK").ok().and_then(|v| v.parse::<i64>().ok())
            .map(|base| (base, std::env::var("RAMJET_RENDER_CLOCK_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(1), std::time::Instant::now()));
        let guard = std::env::var("RAMJET_RENDER_GUARD").ok().and_then(|v| match v.as_str() { "ok" => Some(true), "fail" => Some(false), _ => None });
        Hooks { clock, guard,
            slow_start: std::env::var("RAMJET_RENDER_SLOW_START").ok().as_deref() == Some("1"),
                                                                                                  
                                                                                                     
            crash_armed: (std::env::var("RAMJET_RENDER_CRASH_NEXT").ok().as_deref() == Some("1")).into() }
    })
}
                                                                                                           
                                                                                                            
                                                                                                             
#[cfg(not(any(test, feature = "qa-hooks")))]
fn hooks() -> &'static Hooks {
    static H: Hooks = Hooks { clock: None, guard: None, slow_start: false, crash_armed: std::sync::atomic::AtomicBool::new(false) };
    &H
}
#[cfg(test)] static TEST_NOW: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
fn now_ms() -> i64 {
    #[cfg(test)] { let t = TEST_NOW.load(std::sync::atomic::Ordering::Relaxed); if t != 0 { return t; } }
    if let Some((base, scale, t0)) = &hooks().clock { return base + t0.elapsed().as_millis() as i64 * scale; }
    millis()
}

                                                                                            
                                                                                               
                                                                                                    
fn blocked_host(h: &str) -> bool {
    let host = if let Some(rest) = h.strip_prefix('[') { rest.split(']').next().unwrap_or(rest) }
        else if h.parse::<std::net::IpAddr>().is_ok() { h }
        else { h.split(':').next().unwrap_or("") };
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v) => v.is_loopback() || v.is_link_local() || v.is_unspecified() || v.is_private(),
            std::net::IpAddr::V6(v) => v.is_loopback() || v.is_unspecified() || (v.segments()[0] & 0xffc0 == 0xfe80)
                || (v.segments()[0] & 0xfe00 == 0xfc00) || v.to_ipv4_mapped().is_some_and(|v| v.is_loopback() || v.is_link_local() || v.is_unspecified() || v.is_private()),
        };
    }
    host.eq_ignore_ascii_case("localhost")
}
fn bad_url(u: &str) -> bool {
    let Ok(parsed) = url::Url::parse(u) else { return true; };
    if !matches!(parsed.scheme(), "http" | "https") || !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() { return true; }
    parsed.host_str().map_or(true, blocked_host)
}

                                                                                                                                   
                                                                                                 
pub fn memory_ok(data_dir: &Path) -> bool {
    if let Some(g) = hooks().guard { return g; }                 
    let Some(reserve_mb) = reserve_mb(data_dir) else { return false; };
    let avail_kb = std::fs::read_to_string("/proc/meminfo").ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("MemAvailable:"))
            .and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok())).unwrap_or(0);
    avail_kb >= required_free_kb(reserve_mb)                                                                   
}

fn required_free_kb(reserve_mb: u64) -> u64 { reserve_mb.max(2048).saturating_mul(1024) }

fn reserve_mb(data_dir: &Path) -> Option<u64> {
    let text = std::fs::read_to_string(data_dir.join("ilhsmc.json")).ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok()?["reserve_mb"].as_u64()
}

                                                                                                  
                                                                                                      
                                                                                            
                                                                                                 
fn sweep(st: &mut RenderStore, now: i64) {
    let nd = st.draining.len();
    st.draining.retain(|d| now - d.drain_at < DRAIN_MS);                                           
    if st.draining.len() != nd { RENDER_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
    let Some(s) = st.live.as_mut() else { return; };
    let idle = if s.stream_pulls > 0 { 0 } else { now - s.touch_at };
    let mut kill = false;
    match s.state {
        State::Dead => { kill = true; }                                                                                 
        State::Draining => { kill = now - s.drain_at >= DRAIN_MS; },
        State::Starting => { if now - s.started_at >= START_TIMEOUT_MS { kill = true; } }                     
        State::Ready | State::Parked => { if idle >= IDLE_DEAD_MS { kill = true; } else if s.state == State::Ready && idle >= IDLE_PARK_MS { s.state = State::Parked; bump(s); } }
        State::Paused => {
            if s.media.is_some() {
                                                                                                   
                                                                                      
                if now - s.media_since >= HANDOFF_CAP_MS { kill = true; }
                else if now - s.last_pull >= STALL_MS { s.media = None; s.touch_at = now; bump(s); }
            } else if idle >= IDLE_DEAD_MS { kill = true; }
            else if idle >= IDLE_PARK_MS { s.state = State::Parked; bump(s); }                                       
        }
    }
                                                                                                                                                   
                                                                                                                                                      
                                                                                                                                                               
    if !kill && matches!(s.state, State::Ready | State::Parked | State::Paused) {
        if s.writer.progress_age_ms().map_or(false, |a| a >= SEG_STALL_MS) { kill = true; }
    }
    if kill {
        let mut s = st.live.take().unwrap();
        s.state = State::Dead; s.writer.endlist();
        RENDER_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

                                                                                          
pub fn start_sweeper() {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::Relaxed) { return; }
    tokio::spawn(async {
        let mut ticks = tokio::time::interval(std::time::Duration::from_secs(1));
        loop { ticks.tick().await; RenderLock::with(|st| sweep(st, now_ms())); }
    });
}

                                                                                                     
                                                                                 
fn wake(st: &mut RenderStore, data_dir: &Path) -> bool {
    let Some(s) = st.live.as_mut() else { return false };
    if s.state != State::Parked { return true; }
    if memory_ok(data_dir) { s.state = State::Ready; s.writer.segment(); bump(s); true }
    else { let mut s = st.live.take().unwrap(); s.state = State::Dead; s.writer.endlist(); RENDER_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed); false }
}

enum Found<'a> { Live(&'a mut Session), Draining, Gone, NotYours }
fn find<'a>(st: &'a mut RenderStore, id: &str, user: &str) -> Found<'a> {
    if let Some(s) = st.live.as_mut() {
        if s.id == id { return if s.owner == user { Found::Live(s) } else { Found::NotYours }; }
    }
    for d in &st.draining {
        if d.id == id { return if d.owner == user { Found::Draining } else { Found::NotYours }; }
    }
    Found::Gone
}

fn gone404() -> Response { json_err(StatusCode::NOT_FOUND, "that session is gone") }
fn not_yours() -> Response { json_err(StatusCode::FORBIDDEN, "not your session") }
fn dead_touch() -> Response { json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("state", OJ::Str("dead".to_string()))]) }                
fn winding_down() -> Response { json_err(StatusCode::CONFLICT, "the renderer is winding down") }                                        
fn starting_up() -> Response { json_ord(StatusCode::CONFLICT, vec![("ok", OJ::Bool(false)), ("error", OJ::Str("the renderer is starting up - give it a few seconds".into())), ("code", OJ::Str("starting_up".into()))]) }                       

fn tab_json(t: &Tab) -> OJ {
    OJ::Raw(format!("{{\"url\":{},\"title\":{}}}", serde_json::to_string(&t.url).unwrap(), serde_json::to_string(&t.title).unwrap()))
}

fn touch_body(s: &Session, ticket: Option<String>) -> Response {
                                                                                         
    let t = &s.tabs[s.active];
    let mut pairs = vec![
        ("ok", OJ::Bool(true)),
        ("state", OJ::Str(state_str(s.state).to_string())),
        ("tabs", OJ::Arr(s.tabs.iter().map(tab_json).collect())),
        ("active", OJ::Num(s.active as i64)),
        ("url", OJ::Str(t.url.clone())),
        ("title", OJ::Str(t.title.clone())),
        ("can_back", OJ::Bool(t.depth > 1)),
    ];
                                                                                                  
                                                                                                     
                                                                                  
    if let Some(m) = &s.media {
        let mut raw = format!("{{\"id\":{},\"kind\":{}", serde_json::to_string(&m.id).unwrap(), serde_json::to_string(&m.kind).unwrap());
        if m.kind == "video" { raw += &format!(",\"stream\":{}", serde_json::to_string(&format!("/api/apps/jetstream/stream?id={}", m.id)).unwrap()); }
        if ["video", "audio", "vp9video", "lvideo", "lvp9video"].contains(&m.kind.as_str()) { raw += &format!(",\"vsrc\":{}", serde_json::to_string(&format!("/api/apps/jetstream/vsrc?id={}&kind={}", m.id, m.kind)).unwrap()); }
        raw += "}";
        pairs.push(("media", OJ::Raw(raw)));
    } else if s.media_ever { pairs.push(("media", OJ::Null)); }
    if let Some(tk) = ticket { pairs.push(("thumbTicket", OJ::Str(tk))); }
    json_ord(StatusCode::OK, pairs)
}

fn close_target(e: &serde_json::Value, count: usize, active: usize) -> Option<usize> {
    match e.get("tab") {
        None => Some(active),
        Some(v) => v.as_u64().filter(|i| *i < count as u64).map(|i| i as usize),
    }
}

const EVENT_VOCAB: [&str; 9] = ["key", "text", "back", "tab_new", "tab_close", "tab_switch", "nav", "pause", "resume"];                       

fn apply_event(s: &mut Session, e: &serde_json::Value) {
    match e["type"].as_str().unwrap_or("") {
        "key" | "text" => {}                                                   
        "back" => { let t = &mut s.tabs[s.active]; if t.depth > 1 { t.depth -= 1; } }
        "nav" => {
            let u = js_string(&e["url"]);
            if !u.is_empty() && !bad_url(&u) { s.view_ctr += 1; let vc = s.view_ctr; let t = &mut s.tabs[s.active]; t.url = u.clone(); t.title = u; t.depth += 1; t.viewed = vc; }                                        
        }
        "tab_new" => {
            let u = js_string(&e["url"]);
            let u = if bad_url(&u) { String::new() } else { u };                                     
            s.view_ctr += 1;
            s.tabs.push(Tab { url: u.clone(), title: u, depth: 1, viewed: s.view_ctr });
            if s.tabs.len() > MAX_TABS {                                                                         
                let mut drop_i = 0; let mut oldest = u64::MAX;
                for (i, t) in s.tabs.iter().enumerate() { if i != s.active && t.viewed < oldest { oldest = t.viewed; drop_i = i; } }
                s.tabs.remove(drop_i);
                if s.active > drop_i { s.active -= 1; }
            }
            s.active = s.tabs.len() - 1;                                              
        }
        "tab_close" => {                                                                               
                                                                                                
            let Some(target) = close_target(e, s.tabs.len(), s.active) else { return; };
            match target {
                i if i != s.active && s.tabs.len() > 1 => {
                    s.tabs.remove(i);
                    if s.active > i { s.active -= 1; }
                }
                _ if s.tabs.len() > 1 => {
                    let closing_active = s.active;
                    s.tabs.remove(closing_active);
                                                                                                      
                    let mut mru = 0; let mut newest = 0u64;
                    for (i, t) in s.tabs.iter().enumerate() { if t.viewed > newest { newest = t.viewed; mru = i; } }
                    s.active = mru;
                }
                _ => {}                                                                         
            }
        }
        "tab_switch" => {
            let i = e["index"].as_u64().unwrap_or(usize::MAX as u64) as usize;
            if i < s.tabs.len() { s.active = i; s.view_ctr += 1; s.tabs[i].viewed = s.view_ctr; }
        }
        "pause" => { if s.state == State::Ready { s.state = State::Paused; } }                               
        "resume" => { if s.state == State::Paused { s.state = State::Ready; s.writer.segment(); } }                           
        _ => {}
    }
}

pub async fn handle(data_dir: &Path, user: &str, device: bool, method: &str, sub: &str,
                    query: &std::collections::HashMap<String, String>, body: &[u8]) -> Response {
    handle_origin(data_dir,user,device,None,method,sub,query,body).await
}

pub async fn handle_origin(data_dir: &Path,user: &str,device: bool,origin_device: Option<&str>,method: &str,sub: &str,
    query: &std::collections::HashMap<String,String>,body: &[u8])->Response {
    handle_checked(data_dir,user,device,origin_device,None,method,sub,query,body).await
}

pub async fn handle_checked(data_dir:&Path,user:&str,device:bool,origin_device:Option<&str>,auth:Option<&crate::auth_api::store::AuthStore>,method:&str,sub:&str,
    query:&std::collections::HashMap<String,String>,body:&[u8])->Response {
    match (method, sub) {
        ("POST", "start") => {
            let b = match parse_body2(body, 65536) { Ok(v) => v.unwrap_or_else(|| serde_json::json!({})), Err(BodyErr::TooLarge) => return too_large() };
            let url = js_string(&b["url"]);
            if bad_url(&url) { return json_err(StatusCode::BAD_REQUEST, "bad url"); }             
            let take = b["take"].as_bool().unwrap_or(false);
            RENDER_GEN.fetch_add(0, std::sync::atomic::Ordering::Relaxed);
            RenderLock::with(|st| {
                let now = now_ms();                                                            
                sweep(st, now);
                                                                                                  
                                                                                                       
                if let Some(db)=auth { if device && !origin_device.is_some_and(|id|db.device_active(user,id)) {return json_err(StatusCode::UNAUTHORIZED,"not signed in")} }
                                                                                                 
                                                 
                if !memory_ok(data_dir) { return json_err(StatusCode::SERVICE_UNAVAILABLE, "the box is short on memory right now - try again in a bit"); }
                if st.live.is_some() && !take {
                    return json_ord(StatusCode::CONFLICT, vec![("ok", OJ::Bool(false)), ("error", OJ::Str("the renderer is in use".into())), ("code", OJ::Str("renderer_busy".into()))]);
                }
                                                                                             
                if st.draining.len() >= 16 {
                    return json_ord(StatusCode::CONFLICT, vec![("ok", OJ::Bool(false)), ("error", OJ::Str("the renderer is in use".into())), ("code", OJ::Str("renderer_busy".into()))]);
                }
                let Some(id) = fresh_id(12, |_| false) else { return io_fail() };                                                   
                                                                                                       
                let Some(w) = make_writer(&id, &url) else { return renderer_unavailable() };
                static BOOT_CLEAN: std::sync::Once = std::sync::Once::new();
                BOOT_CLEAN.call_once(|| { crate::render_config::clean_contents(&data_dir.join("render")); });                                                                                                                        
                let mut s = Session {
                    id: id.clone(), owner: user.to_string(), origin_device: origin_device.map(str::to_string), state: State::Starting,
                    tabs: vec![Tab { url: url.clone(), title: url, depth: 1, viewed: 1 }], active: 0,
                    seq: 0, touch_at: now, version: 1, media: None, media_ever: false,
                    media_since: 0, last_pull: now, media_gen: 0, started_at: now, drain_at: 0, stream_pulls: 0, ticket: None, view_ctr: 1, event_ts: vec![], writer: w,
                };
                if !s.writer.deferred_ready() && !hooks().slow_start { s.writer.segment(); s.state = State::Ready; }                                                                       
                if hooks().crash_armed.swap(false, std::sync::atomic::Ordering::Relaxed) { s.state = State::Dead; s.writer.endlist(); return dead_touch(); }                                                           
                let stream = format!("/api/apps/browse/render/stream/{id}/index.m3u8");
                                                                                                    
                                                                                     
                                                                                                  
                let Some(t) = crate::auth_api::wisp::thumb_ticket(data_dir, user) else { return io_fail() };
                s.ticket = Some((t.clone(), now));
                if st.live.is_some() {
                                                                                                  
                    let mut old = st.live.take().unwrap();
                    old.state = State::Draining; old.drain_at = now; old.writer.endlist();
                    st.draining.push(old);                              
                    RENDER_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                st.live = Some(s);
                                                                                                                  
                if let Some(s) = st.live.as_mut() { s.writer.begin(&data_dir.join("render").join(&id)); }
                RENDER_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                json_ord(StatusCode::OK, vec![
                    ("ok", OJ::Bool(true)), ("session", OJ::Str(id)), ("stream", OJ::Str(stream)),
                    ("expires", OJ::Num(now + IDLE_DEAD_MS)), ("thumbTicket", OJ::Str(t)),
                ])
            })
        }
        ("POST", "input") => {
            let b = match parse_body2(body, 65536) { Ok(v) => v.unwrap_or_else(|| serde_json::json!({})), Err(BodyErr::TooLarge) => return too_large() };
            let id = js_string(&b["session"]);
            RenderLock::with(|st| {
                let now = now_ms();                                                            
                sweep(st, now);
                                                                                                       
                let (state0, last_seq) = match find(st, &id, user) {
                    Found::Live(s) => (s.state, s.seq),
                    Found::Draining => return winding_down(),                              
                    Found::Gone => return gone404(),                                                   
                    Found::NotYours => return not_yours(),
                };
                if state0 == State::Starting { return starting_up(); }                                      
                let Some(seq) = b["seq"].as_u64() else { return json_err(StatusCode::BAD_REQUEST, "bad seq") };              
                if seq <= last_seq { return json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true))]); }
                let events: Vec<serde_json::Value> = b["events"].as_array().cloned().unwrap_or_default();
                if events.iter().any(|e| !e["type"].as_str().map(|t| EVENT_VOCAB.contains(&t)).unwrap_or(false)) {
                    return json_err(StatusCode::BAD_REQUEST, "bad event");                 
                }
                {
                    let s = st.live.as_ref().unwrap();
                    let mut count = s.tabs.len();
                    let effective = if state0 == State::Paused {
                        events.iter().position(|e| e["type"] == "resume").map(|i| &events[i+1..]).unwrap_or(&[])
                    } else { &events[..] };
                    for e in effective {
                        if e["type"] == "tab_new" { count = (count + 1).min(MAX_TABS); }
                        if e["type"] == "tab_close" {
                            if close_target(e, count, 0).is_none() {
                                return json_err(StatusCode::NOT_FOUND, "that tab is gone");
                            }
                            count = count.saturating_sub(1).max(1);
                        }
                    }
                }
                                                                                                
                                                                                         
                {
                    let Some(s) = st.live.as_mut() else { return gone404() };
                    s.event_ts.retain(|&t| now - t < 1000);
                    if s.event_ts.len() + events.len() > RATE_CAP {                                                
                        let mut r = json_err(StatusCode::TOO_MANY_REQUESTS, "slow down a bit");
                        r.headers_mut().insert(axum::http::header::RETRY_AFTER, "1".parse().unwrap());
                        return r;
                    }
                }
                                                                                                  
                                                                                                         
                if state0 == State::Parked && events.iter().any(|e| e["type"].as_str() != Some("pause")) {
                    if !wake(st, data_dir) { return gone404(); }
                }
                                                                                                        
                let Some(s) = st.live.as_mut() else { return gone404() };
                s.seq = seq;
                s.event_ts.extend(events.iter().map(|_| now));
                s.touch_at = now;
                if s.state == State::Paused {
                                                                                                            
                    if let Some(ri) = events.iter().position(|e| e["type"].as_str() == Some("resume")) {
                        s.state = State::Ready; s.media = None; s.writer.segment();
                        for e in &events[ri + 1..] { apply_fwd(s, e); }
                    }
                } else {
                    for e in &events { apply_fwd(s, e); }
                }
                bump(s);
                json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true))])
            })
        }
        ("GET", "touch") => {
            let id = query.get("session").cloned().unwrap_or_default();
            let wait = query.get("wait").and_then(|w| w.parse::<i64>().ok()).unwrap_or(25).clamp(1, TOUCH_MAX_WAIT_S);
                                                                                                             
                                                                                                 
            let gen0 = RenderLock::with(|st| {
                let now = now_ms();                             
                sweep(st, now);
                let gen_before_wake = RENDER_GEN.load(std::sync::atomic::Ordering::Relaxed);
                match find(st, &id, user) {
                    Found::Live(s) => {
                        s.touch_at = now;
                        if s.state == State::Parked { let _ = wake(st, data_dir); }                                            
                    }
                    Found::Draining => {}
                    Found::Gone => return Err(dead_touch()),                                                               
                    Found::NotYours => return Err(not_yours()),
                }
                Ok(gen_before_wake)
            });
            let gen0 = match gen0 { Ok(g) => g, Err(r) => return r };
                                                                                  
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(wait as u64);
            loop {
                if RENDER_GEN.load(std::sync::atomic::Ordering::Relaxed) != gen0 { break; }
                if std::time::Instant::now() >= deadline { break; }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            RenderLock::with(|st| {
                let now = now_ms();
                sweep(st, now);
                match find(st, &id, user) {
                    Found::Live(s) => {
                        if device {
                            let stale = match &s.ticket { Some((_, at)) => now - at > crate::auth_api::wisp::THUMB_TTL_MS - 60_000, None => true };
                            if stale { s.ticket = crate::auth_api::wisp::thumb_ticket(data_dir, user).map(|t| (t, now)); }
                        }
                        let tk = if device { s.ticket.clone().map(|(t, _)| t) } else { None };
                        touch_body(s, tk)
                    }
                    Found::Draining => json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("state", OJ::Str("draining".to_string()))]),             
                    Found::Gone => dead_touch(),                                                        
                    Found::NotYours => not_yours(),
                }
            })
        }
        ("POST", "stop") => {
            let b = match parse_body2(body, 65536) { Ok(v) => v.unwrap_or_else(|| serde_json::json!({})), Err(BodyErr::TooLarge) => return too_large() };
            let id = js_string(&b["session"]);
            RenderLock::with(|st| {
                let now = now_ms();                             
                sweep(st, now);
                match find(st, &id, user) {
                    Found::Draining => json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true))]),                                                           
                    Found::Gone => gone404(),
                    Found::NotYours => not_yours(),
                    Found::Live(_) => {
                        let mut s = st.live.take().unwrap();
                                                                                                      
                        s.state = State::Draining; s.drain_at = now; s.writer.endlist();
                        st.draining.push(s);
                        RENDER_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true))])
                    }
                }
            })
        }
        ("GET", p) if p.starts_with("stream/") => {
            let rest = &p[7..];
            let Some((id, file)) = rest.split_once('/') else { return gone404() };
            let ok_name = file == "index.m3u8" || file == "init.mp4"
                || (file.starts_with("seg_") && file.ends_with(".m4s") && file[4..file.len() - 4].bytes().all(|b| b.is_ascii_digit()));
            if !ok_name { return gone404(); }
                                                                                                                     
            enum V { Serve, Gone, NotYours }
            let v = RenderLock::with(|st| {
                let now = now_ms();                             
                sweep(st, now);                                                                      
                match find(st, id, user) {
                Found::Gone => V::Gone,
                Found::NotYours => V::NotYours,
                Found::Live(s) => {
                    s.stream_pulls = s.stream_pulls.saturating_add(1);
                                                                                                  
                    V::Serve
                }
                Found::Draining => V::Serve,                                      
                }
            });
            match v { V::Serve => {
                let _pull = PullGuard { session: id.to_string(), owner: user.to_string() };
                let response = serve_ring(data_dir, id, file).await;
                                                                                                
                                                                                                     
                                                                                                      
                let admitted = RenderLock::with(|st| {
                    let now = now_ms(); sweep(st, now);
                    match find(st, id, user) {
                        Found::Live(s) => {
                            if response.status().is_success() { s.touch_at = now; }
                            true
                        }
                        Found::Draining => true,
                        _ => false,
                    }
                });
                if admitted { response } else { gone404() }
            }, V::Gone => gone404(), V::NotYours => not_yours() }
        }
        _ => json_err(StatusCode::NOT_FOUND, "unknown render call"),
    }
}

                                                                                               
pub fn revoke_device(user:&str,device_id:&str) {
    RenderLock::with(|st| {
        if st.live.as_ref().is_some_and(|s|s.owner==user&&s.origin_device.as_deref()==Some(device_id)) {
            let mut s=st.live.take().unwrap();s.state=State::Dead;s.writer.endlist();RENDER_GEN.fetch_add(1,std::sync::atomic::Ordering::Relaxed);
        }
        st.draining.retain(|s|!(s.owner==user&&s.origin_device.as_deref()==Some(device_id)));
    });
}

                                                                                        
struct PullGuard { session: String, owner: String }
impl Drop for PullGuard {
    fn drop(&mut self) {
        RenderLock::with(|st| {
            if let Found::Live(s) = find(st, &self.session, &self.owner) { s.stream_pulls = s.stream_pulls.saturating_sub(1); }
        });
    }
}

                                                                                                                                                            
                                                                                                                                                                                               
                                                                                                                                                                                              
                                                                                     
const RING_FILE_MAX: u64 = 16 * 1024 * 1024;
fn read_ring_file(root: &Path, id: &str, file: &str) -> Option<Vec<u8>> {
    use std::ffi::CString;
    use std::io::Read;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::io::{FromRawFd, OwnedFd};
    let bad = |s: &str| s.is_empty() || s == "." || s == ".." || s.contains('/') || s.contains('\0');
    if bad(id) || bad(file) { return None; }
    let own = |fd: i32| -> Option<OwnedFd> { if fd < 0 { None } else { Some(unsafe { OwnedFd::from_raw_fd(fd) }) } };
    let rc = CString::new(root.as_os_str().as_bytes()).ok()?;
    let dflags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let rfd = own(unsafe { libc::open(rc.as_ptr(), dflags) })?;
    let ic = CString::new(id).ok()?;
    let sfd = own(unsafe { libc::openat(std::os::unix::io::AsRawFd::as_raw_fd(&rfd), ic.as_ptr(), dflags) })?;
    let fc = CString::new(file).ok()?;
    let ffd = own(unsafe { libc::openat(std::os::unix::io::AsRawFd::as_raw_fd(&sfd), fc.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC) })?;
    let f = std::fs::File::from(ffd);
    let m = f.metadata().ok()?;
    if !m.file_type().is_file() || m.nlink() != 1 || m.len() > RING_FILE_MAX { return None; }
    let mut buf = Vec::new();
    (&f).take(RING_FILE_MAX + 1).read_to_end(&mut buf).ok()?;
    if buf.len() as u64 > RING_FILE_MAX { return None; }
    Some(buf)
}

                                                                                                   
                              
async fn serve_ring(data_dir: &Path, id: &str, file: &str) -> Response {
    let root = data_dir.join("render");
    let (idc, filec) = (id.to_string(), file.to_string());
    let got = tokio::task::spawn_blocking(move || read_ring_file(&root, &idc, &filec)).await.ok().flatten();
    match got {
        Some(bytes) => {
            let mime = if file == "index.m3u8" { "application/vnd.apple.mpegurl" } else { "video/mp4" };
            let cache = if file == "index.m3u8" { "no-store" } else if file == "init.mp4" { "public, max-age=31536000, immutable" } else { "no-store" };
            let mut r = Response::new(axum::body::Body::from(bytes));
            let h = r.headers_mut();
            h.insert(axum::http::header::CONTENT_TYPE, mime.parse().unwrap());
            h.insert(axum::http::header::CACHE_CONTROL, cache.parse().unwrap());
            r
        }
        None => json_err(StatusCode::NOT_FOUND, "segment gone"),
    }
}

                                                                                   
                                                                                                 
                                                                                          
pub fn set_media(data_dir: &Path, user: &str, session: &str, media: Option<Media>) -> bool {
    media.and_then(|m| begin_media(data_dir, user, session, m)).is_some()
}

                                                                                             
pub fn begin_media(data_dir: &Path, user: &str, session: &str, media: Media) -> Option<u64> {
    RenderLock::with(|st| {
        let now = now_ms(); sweep(st, now);
        let s = st.live.as_mut()?;
        if s.owner != user || s.id != session || s.state == State::Starting || s.state == State::Dead { return None; }
        if s.media.as_ref() == Some(&media) { return Some(s.media_gen); }
        if s.state == State::Parked && !wake(st, data_dir) { return None; }
        let s = st.live.as_mut()?;
        s.media_gen += 1; s.media = Some(media); s.media_ever = true;
        s.media_since = now; s.last_pull = now; s.state = State::Paused;
        bump(s); Some(s.media_gen)
    })
}

                                                                                      
pub fn media_generation(user: &str, session: &str) -> Option<u64> {
    RenderLock::with(|st| st.live.as_ref().filter(|s| s.owner == user && s.id == session && s.media.is_some()).map(|s| s.media_gen))
}

                                                                                                              
pub fn end_media(data_dir: &Path, user: &str, session: &str, expected_generation: u64) -> bool {
    RenderLock::with(|st| {
        let now = now_ms(); sweep(st, now);
        let Some(s) = st.live.as_mut() else { return false };
        if s.owner != user || s.id != session || s.media_gen != expected_generation || s.media.is_none() { return false; }
        s.media = None; s.touch_at = now; bump(s); true
    })
}

                                                                                            
                                                                                             
                                                             
pub fn stamp_media_pull(user: &str, video_id: &str) -> bool {
    RenderLock::with(|st| {
        let now = now_ms();
        let Some(s) = st.live.as_mut() else { return false };
        if s.owner != user || s.state == State::Dead { return false; }
        if s.media.as_ref().map(|m| m.id.as_str()) != Some(video_id) { return false; }
        s.touch_at = now; s.last_pull = now;
        true
    })
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn read_frame_bounds() {
        let mut b = Vec::new();
        let mut r: &[u8] = b"{\"ev\":\"segment\"}\nxx\n";
        assert!(matches!(read_frame(&mut r, &mut b).await, Frame::Line)); assert_eq!(b, b"{\"ev\":\"segment\"}"); b.clear();
        assert!(matches!(read_frame(&mut r, &mut b).await, Frame::Line)); assert_eq!(b, b"xx"); b.clear();
        assert!(matches!(read_frame(&mut r, &mut b).await, Frame::Eof));
                                                                                                                            
        let mut ok = vec![b'a'; WORKER_LINE_MAX]; ok.push(b'\n');
        let mut r2 = tokio::io::BufReader::with_capacity(7, &ok[..]); b.clear();
        assert!(matches!(read_frame(&mut r2, &mut b).await, Frame::Line)); assert_eq!(b.len(), WORKER_LINE_MAX);
        let over = vec![b'a'; WORKER_LINE_MAX + 1];
        let mut r3 = tokio::io::BufReader::with_capacity(7, &over[..]); b.clear();
        assert!(matches!(read_frame(&mut r3, &mut b).await, Frame::TooLong));
        let mut over2 = over.clone(); over2.push(b'\n');
        let mut r4 = &over2[..]; b.clear();
        assert!(matches!(read_frame(&mut r4, &mut b).await, Frame::TooLong));
        assert!(b.len() <= WORKER_LINE_MAX);
    }
    #[test]
    fn ev_rate_and_url_caps() {
        let mut e = EvRate::new();
        for _ in 0..WORKER_EV_PER_S { assert!(e.allow()); }
        assert!(!e.allow());
        assert!(worker_url_ok("https://example.com/"));
        let long = format!("https://example.com/{}", "a".repeat(WORKER_URL_MAX));
        assert!(!worker_url_ok(&long));
        assert!(!worker_url_ok("http://127.0.0.1/"));
    }
    use super::*;
    use std::sync::atomic::Ordering::Relaxed;

                                                                                           
                                                                                             
                                                                                              
                                                                                               
                                                                                            
                                                                                
    static RENDER_TEST_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn serial() -> std::sync::MutexGuard<'static, ()> { RENDER_TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner()) }                                                                           
    fn dir() -> std::path::PathBuf {
        static CTR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!("render-{}-{}", std::process::id(), CTR.fetch_add(1, Relaxed)));
        std::fs::create_dir_all(&d).unwrap(); std::fs::write(d.join("ilhsmc.json"), "{\"reserve_mb\":0}").unwrap(); d
    }
    fn reset() { RenderLock::with(|st| { st.live = None; st.draining.clear(); }); TEST_NOW.store(1_800_000_000_000, Relaxed); TEST_WRITER_MODE.store(0, Relaxed); TEST_LOG.lock().unwrap().clear(); TEST_PROGRESS_AGE.store(-1, Relaxed); }
    async fn body(r: Response) -> String { String::from_utf8(axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap() }
    async fn start(d: &Path, url: &str, take: bool) -> (StatusCode, String) {
        let b = format!("{{\"url\":{},\"take\":{take}}}", serde_json::to_string(url).unwrap());
        let r = handle(d, "u", true, "POST", "start", &Default::default(), b.as_bytes()).await;
        (r.status(), body(r).await)
    }
    fn sid() -> String { RenderLock::with(|st| st.live.as_ref().unwrap().id.clone()) }
    fn touch_q(id: &str) -> std::collections::HashMap<String, String> {
        let mut q = std::collections::HashMap::new(); q.insert("session".to_string(), id.to_string()); q.insert("wait".to_string(), "1".into()); q
    }
    async fn touch(d: &Path, id: &str) -> (StatusCode, String) {
        let r = handle(d, "u", true, "GET", "touch", &touch_q(id), b"").await; (r.status(), body(r).await)
    }
    async fn input(d: &Path, id: &str, seq: u64, events: &str) -> StatusCode {
        handle(d, "u", true, "POST", "input", &Default::default(), format!("{{\"session\":\"{id}\",\"seq\":{seq},\"events\":{events}}}").as_bytes()).await.status()
    }
    fn media(id: &str) -> Media { Media { id: id.into(), kind: "video".into() } }

    #[test]
    fn reserve_file_fails_closed() {
        assert_eq!(required_free_kb(3687), 3687 * 1024);                                     
        assert_eq!(required_free_kb(0), 2048 * 1024);                              
        let d = dir(); std::fs::remove_file(d.join("ilhsmc.json")).unwrap(); assert_eq!(reserve_mb(&d), None);
        for bad in ["not json", "{}", "{\"reserve_mb\":-1}", "{\"reserve_mb\":\"1024\"}", "{\"reserve_mb\":null}"] {
            std::fs::write(d.join("ilhsmc.json"), bad).unwrap(); assert_eq!(reserve_mb(&d), None);
        }
        std::fs::write(d.join("ilhsmc.json"), "{\"reserve_mb\":2048}").unwrap();
        assert_eq!(reserve_mb(&d), Some(2048));
    }

    #[tokio::test]
    async fn start_matrix_takeover_and_identity() {
        let _serial = serial();
        let d = dir(); reset();
        for u in ["http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://127.0.0.1:80/", "http://2130706433/", "http://0177.0.0.1/", "http://0x7f000001/", "http://127.1/", "ftp://x", "https://u:p@host/", "https://host/#frag", "https://"] {
            let r = handle(&d, "u", false, "POST", "start", &Default::default(), format!("{{\"url\":\"{u}\"}}").as_bytes()).await;
            assert_eq!(r.status(), StatusCode::BAD_REQUEST, "{u}");
        }
        let (s, b) = start(&d, "https://example.com", false).await;
        assert_eq!(s, StatusCode::OK);
        assert!(b.starts_with("{\"ok\":true,\"session\":\"") && b.contains("\"stream\":\"/api/apps/browse/render/stream/") && b.contains("\"thumbTicket\":\""), "{b}");                                              
        let id = sid();
        let (s2, b2) = start(&d, "https://two.example", false).await;
        assert_eq!((s2, b2.as_str()), (StatusCode::CONFLICT, "{\"ok\":false,\"error\":\"the renderer is in use\",\"code\":\"renderer_busy\"}"));
        let _ = start(&d, "https://two.example", true).await;
        let (s3, b3) = touch(&d, &id).await;
        assert_eq!((s3, b3.as_str()), (StatusCode::OK, "{\"ok\":true,\"state\":\"draining\"}"));                                        
        let id2 = sid();
        for _ in 0..5 { assert_eq!(start(&d, "https://more.example", true).await.0, StatusCode::OK); }
        let _ = start(&d, "https://three.example", true).await;
        let (_, b) = touch(&d, &id2).await;
        assert_eq!(b, "{\"ok\":true,\"state\":\"draining\"}", "{b}");                                                  
        let (_, b) = touch(&d, &id).await;
        assert_eq!(b, "{\"ok\":true,\"state\":\"draining\"}", "{b}");
        let r = handle(&d, "u", true, "POST", "input", &Default::default(), format!("{{\"session\":\"{id}\",\"seq\":1,\"events\":[]}}").as_bytes()).await;
        assert_eq!(r.status(), StatusCode::CONFLICT);                                                
        let r = handle(&d, "someone-else", true, "GET", "touch", &touch_q(&sid()), b"").await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn input_rules_and_can_back() {
        let _serial = serial();
        let d = dir(); reset(); start(&d, "https://example.com", false).await; let id = sid();
        let r = handle(&d, "u", true, "POST", "input", &Default::default(), format!("{{\"session\":\"{id}\",\"events\":[]}}").as_bytes()).await;
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);                      
        assert_eq!(input(&d, &id, 1, "[{\"type\":\"tab_close\",\"tab\":999}]").await, StatusCode::NOT_FOUND);
        assert_eq!(input(&d, &id, 1, "[{\"type\":\"mystery\"}]").await, StatusCode::BAD_REQUEST);        
        assert_eq!(input(&d, &id, 1, "[{\"type\":\"nav\",\"url\":\"https://example.com/a\"}]").await, StatusCode::OK);
        let (_, b) = touch(&d, &id).await; assert!(b.contains("\"can_back\":true"), "{b}");
        assert_eq!(input(&d, &id, 1, "[{\"type\":\"nav\",\"url\":\"https://example.com/b\"}]").await, StatusCode::OK);                             
        let (_, b) = touch(&d, &id).await; assert!(b.contains("\"url\":\"https://example.com/a\""), "{b}");
        assert_eq!(input(&d, &id, 2, "[{\"type\":\"back\"}]").await, StatusCode::OK);
        let (_, b) = touch(&d, &id).await; assert!(b.contains("\"can_back\":false"), "{b}");
        assert_eq!(input(&d, &id, 3, "[{\"type\":\"tab_new\"},{\"type\":\"tab_close\"}]").await, StatusCode::OK);                                          
        let (_, b) = touch(&d, &id).await; assert!(b.contains("\"active\":0") && !b.contains("two.example"), "{b}");
        TEST_NOW.fetch_add(1001, Relaxed);                                                                          
        let ten = "[{\"type\":\"key\"},{\"type\":\"key\"},{\"type\":\"key\"},{\"type\":\"key\"},{\"type\":\"key\"},{\"type\":\"key\"},{\"type\":\"key\"},{\"type\":\"key\"},{\"type\":\"key\"},{\"type\":\"key\"}]";
        assert_eq!(input(&d, &id, 4, ten).await, StatusCode::OK);
        let r = handle(&d, "u", true, "POST", "input", &Default::default(), format!("{{\"session\":\"{id}\",\"seq\":5,\"events\":[{{\"type\":\"key\"}}]}}").as_bytes()).await;
        assert_eq!(r.status(), StatusCode::TOO_MANY_REQUESTS);                                  
        assert_eq!(r.headers().get(axum::http::header::RETRY_AFTER).unwrap().to_str().unwrap(), "1");
    }

    #[tokio::test]
    async fn revoke_matches_device_origin_not_just_owner() {
        let _serial = serial();
        let d=dir();reset();let auth=crate::auth_api::devices::tests::fixture("render-fixture");auth.auth_db.device_insert("tv-a","render-fixture","tv","roku","fixture-render-token").unwrap();
        let r=handle_checked(&d,"render-fixture",true,Some("tv-a"),Some(&auth.auth_db),"POST","start",&Default::default(),b"{\"url\":\"https://example.com\"}").await;
        assert_eq!(r.status(),StatusCode::OK);let id=sid();
        revoke_device("render-fixture","tv-b");assert_eq!(sid(),id);
        revoke_device("other","tv-a");assert_eq!(sid(),id);
        revoke_device("render-fixture","tv-a");assert_eq!(body(handle_checked(&d,"render-fixture",false,None,Some(&auth.auth_db),"GET","touch",&touch_q(&id),b"").await).await,"{\"ok\":true,\"state\":\"dead\"}");
        assert_eq!(handle_checked(&d,"render-fixture",false,None,Some(&auth.auth_db),"POST","input",&Default::default(),format!("{{\"session\":\"{id}\",\"seq\":1,\"events\":[]}}").as_bytes()).await.status(),StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn drain_cap_covers_stop_start_cycles() {
        let _serial = serial();
        let d = dir(); reset();
        for _ in 0..16 {
            assert_eq!(start(&d, "https://example.com", false).await.0, StatusCode::OK);
            let id = sid();
            assert_eq!(handle(&d, "u", true, "POST", "stop", &Default::default(), format!("{{\"session\":\"{id}\"}}").as_bytes()).await.status(), StatusCode::OK);
        }
        assert_eq!(RenderLock::with(|st| st.draining.len()), 16);
        assert_eq!(start(&d, "https://example.com", true).await.0, StatusCode::CONFLICT);
        assert_eq!(RenderLock::with(|st| st.draining.len()), 16);
        TEST_NOW.fetch_add(DRAIN_MS + 1, Relaxed);
        assert_eq!(start(&d, "https://example.com", false).await.0, StatusCode::OK);
        let id = sid();
        RenderLock::with(|st| st.live.as_mut().unwrap().stream_pulls += 1);
        { let _guard = PullGuard { session: id, owner: "u".into() }; }
        assert_eq!(RenderLock::with(|st| st.live.as_ref().unwrap().stream_pulls), 0);
    }

    #[tokio::test]
    async fn paused_close_validates_only_effective_suffix() {
        let _serial = serial();
        let d = dir(); reset(); start(&d, "https://example.com", false).await; let id = sid();
        assert!(set_media(&d, "u", &id, Some(media("v"))));
        assert_eq!(input(&d, &id, 1, "[{\"type\":\"tab_new\",\"url\":\"https://two.example\"},{\"type\":\"resume\"},{\"type\":\"tab_close\",\"tab\":1}]").await, StatusCode::NOT_FOUND);
        assert_eq!(input(&d, &id, 1, "[{\"type\":\"tab_close\",\"tab\":999},{\"type\":\"resume\"}]").await, StatusCode::OK);
        assert_eq!(RenderLock::with(|st| st.live.as_ref().unwrap().tabs.len()), 1);
    }

    #[tokio::test]
    async fn handoff_stall_resume_and_movie_rule() {
        let _serial = serial();
        let d = dir(); reset(); start(&d, "https://example.com", false).await; let id = sid();
        assert!(set_media(&d, "u", &id, Some(media("vid123"))));
        assert!(!set_media(&d, "u", "stale-session-id", None), "stale session id: no-op (data-lane P1)");
        let (_, b) = touch(&d, &id).await;
        assert!(b.contains("\"state\":\"paused\"") && b.contains("\"media\":{\"id\":\"vid123\",\"kind\":\"video\",\"stream\":\"/api/apps/jetstream/stream?id=vid123\",\"vsrc\":\"/api/apps/jetstream/vsrc?id=vid123&kind=video\"}"), "{b}");                      
        assert_eq!(input(&d, &id, 1, "[{\"type\":\"key\"}]").await, StatusCode::OK);                     
        assert!(set_media(&d, "u", &id, Some(Media { id: "aud1".into(), kind: "audio".into() })));
        let (_, b) = touch(&d, &id).await;
        assert!(b.contains("\"vsrc\":") && !b.contains("\"stream\":"), "audio kind: vsrc leg only, no muxed stream: {b}");                       
        assert!(set_media(&d, "u", &id, Some(media("vid123"))));
        let old_gen = media_generation("u", &id).unwrap();
        assert!(set_media(&d, "u", &id, Some(Media { id: "vid123".into(), kind: "audio".into() })));
        assert!(!end_media(&d, "u", &id, old_gen));
        let changed = media_generation("u", &id).unwrap(); assert!(changed > old_gen);
        assert!(end_media(&d, "u", &id, changed));
        assert!(set_media(&d, "u", &id, Some(media("vid123"))));
        assert!(stamp_media_pull("u", "vid123"));
                                                                   
        TEST_NOW.fetch_add(300_000, Relaxed); assert!(stamp_media_pull("u", "vid123"));
        let (_, b) = touch(&d, &id).await; assert!(b.contains("\"state\":\"paused\""), "{b}");
                                                                                               
        TEST_NOW.fetch_add(121_000, Relaxed);
        let (_, b) = touch(&d, &id).await; assert!(b.contains("\"media\":null") && b.contains("\"state\":\"paused\""), "{b}");
        assert_eq!(input(&d, &id, 2, "[{\"type\":\"resume\"},{\"type\":\"nav\",\"url\":\"https://example.com/c\"}]").await, StatusCode::OK);                                    
        let (_, b) = touch(&d, &id).await; assert!(b.contains("\"state\":\"ready\"") && b.contains("/c\""), "{b}");
    }

    #[tokio::test]
    async fn park_wake_dead_and_draining() {
        let _serial = serial();
        let d = dir(); reset(); start(&d, "https://example.com", false).await; let id = sid();
        TEST_NOW.fetch_add(IDLE_PARK_MS + 1000, Relaxed);
        let before = std::time::Instant::now();
        let (_, b) = touch(&d, &id).await;
        assert!(before.elapsed() < std::time::Duration::from_secs(1));
        assert!(b.contains("\"state\":\"ready\""), "waking touch returns the POST-wake state: {b}");        
        TEST_NOW.fetch_add(IDLE_DEAD_MS + 1000, Relaxed);
        let (_, b) = touch(&d, &id).await;
        assert_eq!(b, "{\"ok\":true,\"state\":\"dead\"}");                                
        let (s, _) = start(&d, "https://example.com", false).await; assert_eq!(s, StatusCode::OK);                               
        let id2 = sid();
        let r = handle(&d, "u", true, "POST", "stop", &Default::default(), format!("{{\"session\":\"{id2}\"}}").as_bytes()).await;
        assert_eq!(r.status(), StatusCode::OK);
        let (_, b) = touch(&d, &id2).await;
        assert_eq!(b, "{\"ok\":true,\"state\":\"draining\"}");        
        let r = handle(&d, "u", true, "POST", "input", &Default::default(), format!("{{\"session\":\"{id2}\",\"seq\":9,\"events\":[]}}").as_bytes()).await;
        assert_eq!(r.status(), StatusCode::CONFLICT);                           
        let r = handle(&d, "u", true, "POST", "stop", &Default::default(), format!("{{\"session\":\"{id2}\"}}").as_bytes()).await;
        assert_eq!(r.status(), StatusCode::OK);                                     
        TEST_NOW.fetch_add(DRAIN_MS + 1000, Relaxed);
        let (_, b) = touch(&d, &id2).await;
        assert_eq!(b, "{\"ok\":true,\"state\":\"dead\"}");                          
    }

    fn st_now() -> State { RenderLock::with(|st| st.live.as_ref().unwrap().state) }

    #[tokio::test]
    async fn deferred_writer_is_starting_until_segment_then_ready_and_times_out_without_one() {
        let _g = serial(); reset(); TEST_WRITER_MODE.store(1, Relaxed);
        let d = dir();
        let (c, _) = start(&d, "https://example.com/", false).await; assert_eq!(c, StatusCode::OK);
        assert_eq!(st_now(), State::Starting, "must not be ready before the writer reports a segment");
        on_worker_line("not-this-session", "{\"ev\":\"segment\"}");
        assert_eq!(st_now(), State::Starting, "a stray session id must not flip it");
        on_worker_line(&sid(), "{\"ev\":\"segment\"}");
        assert_eq!(st_now(), State::Ready);
                                                                                                     
        let (c, _) = start(&d, "https://example.com/b", true).await; assert_eq!(c, StatusCode::OK);
        TEST_LOG.lock().unwrap().clear();
        TEST_NOW.store(1_800_000_000_000 + START_TIMEOUT_MS + 1, Relaxed);
        RenderLock::with(|st| sweep(st, now_ms()));
        assert!(RenderLock::with(|st| st.live.is_none()));
        assert!(TEST_LOG.lock().unwrap().iter().any(|l| l == "endlist"));
    }

    #[tokio::test]
    async fn progress_watchdog_kills_stalled_worker_in_ready_paused_and_parked_but_not_fresh_unknown_or_starting() {
        let _g = serial(); reset(); TEST_WRITER_MODE.store(1, Relaxed);
        let d = dir();
                                                                                      
        start(&d, "https://example.com/", false).await;
        TEST_PROGRESS_AGE.store(10 * SEG_STALL_MS, Relaxed);
        RenderLock::with(|st| sweep(st, now_ms()));
        assert_eq!(st_now(), State::Starting, "starting is never killed by the progress watchdog");
        on_worker_line(&sid(), "{\"ev\":\"segment\"}"); assert_eq!(st_now(), State::Ready);
                                       
        TEST_PROGRESS_AGE.store(SEG_STALL_MS - 1, Relaxed); RenderLock::with(|st| sweep(st, now_ms())); assert_eq!(st_now(), State::Ready, "29.999s is not stalled");
        TEST_PROGRESS_AGE.store(-1, Relaxed); RenderLock::with(|st| sweep(st, now_ms())); assert_eq!(st_now(), State::Ready, "unknown progress never kills");
                                                      
        TEST_LOG.lock().unwrap().clear(); TEST_PROGRESS_AGE.store(SEG_STALL_MS, Relaxed);
        RenderLock::with(|st| sweep(st, now_ms()));
        assert!(RenderLock::with(|st| st.live.is_none()), "stalled ready worker ends the session");
        assert!(TEST_LOG.lock().unwrap().iter().any(|l| l == "endlist"));
                                                                                                                        
        for target in [State::Paused, State::Parked] {
            reset(); TEST_WRITER_MODE.store(1, Relaxed); TEST_PROGRESS_AGE.store(-1, Relaxed);
            start(&d, "https://example.com/", false).await; on_worker_line(&sid(), "{\"ev\":\"segment\"}");
            RenderLock::with(|st| { st.live.as_mut().unwrap().state = target; });
            TEST_PROGRESS_AGE.store(SEG_STALL_MS - 1, Relaxed); RenderLock::with(|st| sweep(st, now_ms())); assert!(RenderLock::with(|st| st.live.is_some()), "{target:?} fresh stays");
            TEST_PROGRESS_AGE.store(SEG_STALL_MS + 1, Relaxed); RenderLock::with(|st| sweep(st, now_ms())); assert!(RenderLock::with(|st| st.live.is_none()), "{target:?} stalled dies");
        }
                                                                                           
        reset(); TEST_WRITER_MODE.store(1, Relaxed); TEST_PROGRESS_AGE.store(0, Relaxed);
        start(&d, "https://example.com/", false).await; on_worker_line(&sid(), "{\"ev\":\"segment\"}");
        RenderLock::with(|st| { let s = st.live.as_mut().unwrap(); s.state = State::Paused; s.media = Some(Media { id: "v".into(), kind: "video".into() }); s.media_since = now_ms(); s.last_pull = now_ms(); });
        RenderLock::with(|st| sweep(st, now_ms())); assert!(RenderLock::with(|st| st.live.is_some()), "fresh playlist + handoff is not killed");
        TEST_PROGRESS_AGE.store(-1, Relaxed);
    }

    #[test]
    fn playlist_change_detection_is_clock_step_safe_and_progress_age_is_monotonic() {
        use std::time::{Duration as D, SystemTime as T};
        let t0 = T::now(); let mut last = None;
        assert!(!playlist_changed(&mut last, None), "missing/non-file index is no change");
        assert!(playlist_changed(&mut last, Some(t0)), "first sighting is a change");
        assert!(!playlist_changed(&mut last, Some(t0)), "same mtime = no progress");
        assert!(playlist_changed(&mut last, Some(t0 + D::from_secs(1))));
        assert!(playlist_changed(&mut last, Some(t0 + D::from_secs(3600))), "forward clock step reads as a change, not a stall");
        assert!(playlist_changed(&mut last, Some(t0 - D::from_secs(3600))), "backward step likewise");
        assert!(!playlist_changed(&mut last, None), "an index that vanished is NOT progress (ages naturally into the stall kill)");
        let w = ChromeWriter { id: "x".into(), url: "u".into(), cmd: "/bin/true".into(), proxy: "http://127.0.0.1:1".into(), chrome: None, ffmpeg: None, progress: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(-1)), tx: None, dir: None, shown: "u".into(), dropped: Default::default() };
        assert_eq!(w.progress_age_ms(), None, "not begun = unknown");
        w.progress.store(mono_ms() - 31_000, Relaxed); assert!(w.progress_age_ms().unwrap() >= 31_000);
        w.progress.store(mono_ms() + 5_000, Relaxed); assert_eq!(w.progress_age_ms().unwrap(), 0, "never negative");
    }

                                                                                                                                             
    fn fake_worker(d: &Path, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        static C: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = d.join(format!("fake-{}.sh", C.fetch_add(1, Relaxed)));
        std::fs::write(&p, format!("#!/bin/bash\n{body}\n")).unwrap();                                                       
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p.to_string_lossy().to_string()
    }
    async fn wait_until<F: Fn() -> bool>(max_ms: u64, f: F) -> bool {
        let t0 = std::time::Instant::now();
        while t0.elapsed().as_millis() < max_ms as u128 { if f() { return true; } tokio::time::sleep(std::time::Duration::from_millis(25)).await; }
        f()
    }
                                                                                                       
    async fn fake_pid(d: &Path) -> (u32, std::path::PathBuf) {
        let found = || -> Option<(u32, std::path::PathBuf)> {
            for e in std::fs::read_dir(d.join("render")).ok()?.flatten() {
                if let Ok(t) = std::fs::read_to_string(e.path().join("pid")) { if let Ok(n) = t.trim().parse::<u32>() { return Some((n, e.path())); } }
            }
            None
        };
        assert!(wait_until(4000, || found().is_some()).await, "fake worker did not start");
        found().unwrap()
    }
                                                                                                                                                               
                                                                                                                 
    fn alive(pid: u32) -> bool {
        let Ok(st) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { return false };
        let after = st.rsplit_once(')').map(|x| x.1).unwrap_or("");                     
        after.split_whitespace().nth(1).and_then(|p| p.parse::<u32>().ok()) == Some(std::process::id())
    }
                                                                                                      
    fn procs_with_arg(needle: &str) -> usize {
        std::fs::read_dir("/proc").map(|rd| rd.flatten().filter(|e| e.file_name().to_string_lossy().bytes().all(|b| b.is_ascii_digit()))
            .filter(|e| std::fs::read(e.path().join("cmdline")).map_or(false, |c| String::from_utf8_lossy(&c).contains(needle))).count()).unwrap_or(0)
    }
                                                                                                                                                             
                                                                                                                             
    async fn flood(n: usize) {
        for _ in 0..n {
            let e = serde_json::json!({"type":"text","text":"x".repeat(60_000)});
            RenderLock::with(|st| if let Some(s) = st.live.as_mut() { s.writer.event(&e, ""); });
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn stalled_stdin_reader_is_killed_within_bound_and_cleaned_up() {
        let _g = serial(); reset(); TEST_WRITER_MODE.store(2, Relaxed);
        let d = dir();
        std::env::set_var("RJ_RENDER_CMD", fake_worker(&d, "echo $$ > \"$2/pid\"\nexec sleep 600")); std::env::set_var("RJ_RENDER_PROXY", "http://127.0.0.1:1");
        let (c, b) = start(&d, "https://example.com/", false).await; assert_eq!(c, StatusCode::OK, "{b}");
        let (pid, ring) = fake_pid(&d).await; assert!(alive(pid));
        let t0 = std::time::Instant::now();
        flood(40).await;                                                                                         
        assert!(wait_until(8000, || !alive(pid)).await, "stalled worker must be killed and reaped");
        let took = t0.elapsed();
        assert!(took >= std::time::Duration::from_millis(1500) && took < std::time::Duration::from_secs(6), "bounded by the 2s write timeout, not instant and not hung: {took:?}");
        assert!(wait_until(2000, || st_now() == State::Dead).await, "worker_gone marks the session dead");
        RenderLock::with(|st| sweep(st, now_ms()));                                                   
        assert!(RenderLock::with(|st| st.live.is_none()));
        assert!(wait_until(3000, || !ring.exists()).await, "ring dir removed");
        assert!(!alive(pid), "no leftover worker");
        std::env::remove_var("RJ_RENDER_CMD"); std::env::remove_var("RJ_RENDER_PROXY");
    }

    #[tokio::test]
    async fn normal_stdin_reader_is_unaffected_by_a_huge_input_and_stops_gracefully() {
        let _g = serial(); reset(); TEST_WRITER_MODE.store(2, Relaxed);
        let d = dir();
        std::env::set_var("RJ_RENDER_CMD", fake_worker(&d, "echo $$ > \"$2/pid\"\ncat > /dev/null")                                                                                                                                    ); std::env::set_var("RJ_RENDER_PROXY", "http://127.0.0.1:1");
        let (c, b) = start(&d, "https://example.com/", false).await; assert_eq!(c, StatusCode::OK, "{b}");
        let (pid, ring) = fake_pid(&d).await;
        flood(40).await;                                                      
        tokio::time::sleep(std::time::Duration::from_millis(3500)).await;                                    
        assert!(alive(pid), "a reader that drains the flood must not be killed");
        assert!(RenderLock::with(|st| st.live.is_some()) && st_now() != State::Dead);
                                                                                                 
        let old = RenderLock::with(|st| st.live.take()); drop(old);
        assert!(wait_until(8000, || !alive(pid)).await, "worker ends after stdin EOF");
        assert!(wait_until(3000, || !ring.exists()).await, "ring dir removed");
        std::env::remove_var("RJ_RENDER_CMD"); std::env::remove_var("RJ_RENDER_PROXY");
    }

    #[tokio::test]
    async fn progress_observer_tracks_playlist_changes_and_ages_when_it_stops() {
        let _g = serial(); reset(); TEST_WRITER_MODE.store(2, Relaxed);
        let d = dir();
                                                   
        std::env::set_var("RJ_RENDER_CMD", fake_worker(&d, "echo $$ > \"$2/pid\"\nmkfifo \"$2/f\"; exec 3<>\"$2/f\"\ni=0\nwhile true; do echo $i > \"$2/index.m3u8\"; i=$((i+1)); read -r -t 0.2 -u 3 _ || true; done")); std::env::set_var("RJ_RENDER_PROXY", "http://127.0.0.1:1");
        start(&d, "https://example.com/", false).await;
        let (pid, _ring) = fake_pid(&d).await;
        tokio::time::sleep(std::time::Duration::from_millis(3200)).await;
        let age = RenderLock::with(|st| st.live.as_ref().unwrap().writer.progress_age_ms()).unwrap();
        assert!(age < 2500, "advancing playlist keeps the age small: {age}");
        RenderLock::with(|st| sweep(st, now_ms())); assert!(RenderLock::with(|st| st.live.is_some()), "Starting is never watchdog-killed");
        let script1 = std::env::var("RJ_RENDER_CMD").unwrap();
        let old = RenderLock::with(|st| st.live.take()); drop(old);
        assert!(wait_until(8000, || !alive(pid)).await);
        assert!(wait_until(2000, || procs_with_arg(&script1) == 0).await, "the rewriter uses only shell builtins (no sleep child), and nothing referencing it survives Drop");
                                                      
        reset(); TEST_WRITER_MODE.store(2, Relaxed); let d2 = dir();
        std::env::set_var("RJ_RENDER_CMD", fake_worker(&d2, "echo $$ > \"$2/pid\"\necho 0 > \"$2/index.m3u8\"\nexec sleep 600"));
        start(&d2, "https://example.com/", false).await;
        let (pid2, _r2) = fake_pid(&d2).await;
        tokio::time::sleep(std::time::Duration::from_millis(3800)).await;
        let age2 = RenderLock::with(|st| st.live.as_ref().unwrap().writer.progress_age_ms()).unwrap();
        assert!(age2 >= 2000, "a frozen playlist ages: {age2}");
        let old = RenderLock::with(|st| st.live.take()); drop(old);
        assert!(wait_until(9000, || !alive(pid2)).await);
        std::env::remove_var("RJ_RENDER_CMD"); std::env::remove_var("RJ_RENDER_PROXY");
    }

    #[tokio::test]
    async fn unconfigured_renderer_is_503_not_a_ready_lie() {
        let _g = serial(); reset(); TEST_WRITER_MODE.store(2, Relaxed);
        std::env::remove_var("RJ_RENDER_CMD");
        let d = dir();
        let (c, b) = start(&d, "https://example.com/", false).await;
        assert_eq!(c, StatusCode::SERVICE_UNAVAILABLE, "{b}");
        assert!(RenderLock::with(|st| st.live.is_none()));
                                                          
        std::env::set_var("RJ_RENDER_CMD", "render-worker"); std::env::set_var("RJ_RENDER_PROXY", "http://127.0.0.1:1");
        assert_eq!(start(&d, "https://example.com/", false).await.0, StatusCode::SERVICE_UNAVAILABLE);
        std::env::set_var("RJ_RENDER_CMD", "/bin/true"); std::env::remove_var("RJ_RENDER_PROXY");
        assert_eq!(start(&d, "https://example.com/", false).await.0, StatusCode::SERVICE_UNAVAILABLE);
        std::env::remove_var("RJ_RENDER_CMD");
    }

    #[tokio::test]
    async fn input_events_reach_the_writer_with_the_resulting_active_url() {
        let _g = serial(); reset(); TEST_WRITER_MODE.store(1, Relaxed);
        let d = dir();
        start(&d, "https://example.com/", false).await;
        let id = sid(); on_worker_line(&id, "{\"ev\":\"segment\"}");
        TEST_LOG.lock().unwrap().clear();
        let c = input(&d, &id, 1, "[{\"type\":\"key\",\"key\":\"Enter\"},{\"type\":\"nav\",\"url\":\"https://example.org/x\"},{\"type\":\"tab_new\",\"url\":\"https://example.net/\"}]").await;
        assert_eq!(c, StatusCode::OK);
        let log = TEST_LOG.lock().unwrap().clone();
        assert_eq!(log, vec!["key:https://example.com/", "nav:https://example.org/x", "tab_new:https://example.net/"]);
    }

    #[tokio::test]
    async fn worker_url_event_updates_tab_and_bad_urls_are_ignored_and_worker_exit_kills_session() {
        let _g = serial(); reset(); TEST_WRITER_MODE.store(1, Relaxed);
        let d = dir();
        start(&d, "https://example.com/", false).await;
        let id = sid(); on_worker_line(&id, "{\"ev\":\"segment\"}");
        on_worker_line(&id, "{\"ev\":\"url\",\"url\":\"https://example.com/next\"}");
        assert_eq!(RenderLock::with(|st| st.live.as_ref().unwrap().tabs[0].url.clone()), "https://example.com/next");
        on_worker_line(&id, "{\"ev\":\"url\",\"url\":\"http://127.0.0.1/admin\"}");
        on_worker_line(&id, "garbage");
        assert_eq!(RenderLock::with(|st| st.live.as_ref().unwrap().tabs[0].url.clone()), "https://example.com/next");
        worker_gone(&id);
        assert_eq!(st_now(), State::Dead);
        RenderLock::with(|st| sweep(st, now_ms()));
        assert!(RenderLock::with(|st| st.live.is_none()));
    }

    #[test]
    fn ring_file_fd_walk_rejects_symlink_fifo_hardlink_oversize() {
        use std::os::unix::fs::symlink;
        let base = std::env::temp_dir().join(format!("rj-ring-{}-{}", std::process::id(), millis()));
        let root = base.join("render"); let d = root.join("s1"); std::fs::create_dir_all(&d).unwrap();
        let secret = base.join("secret.db"); std::fs::write(&secret, b"SECRET").unwrap();
        std::fs::write(d.join("init.mp4"), b"ok").unwrap();
        assert_eq!(read_ring_file(&root, "s1", "init.mp4").as_deref(), Some(&b"ok"[..]), "regular file is served");
        symlink(&secret, d.join("seg_00001.m4s")).unwrap();
        assert!(read_ring_file(&root, "s1", "seg_00001.m4s").is_none(), "symlinked segment must not be served");
        let big = std::fs::File::create(d.join("seg_00002.m4s")).unwrap(); big.set_len(RING_FILE_MAX + 1).unwrap();
        assert!(read_ring_file(&root, "s1", "seg_00002.m4s").is_none(), "oversize file must not be served");
        let fifo = std::ffi::CString::new(d.join("seg_00003.m4s").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(read_ring_file(&root, "s1", "seg_00003.m4s").is_none(), "a FIFO must be rejected without blocking");
        std::fs::hard_link(&secret, d.join("seg_00004.m4s")).unwrap();
        assert!(read_ring_file(&root, "s1", "seg_00004.m4s").is_none(), "a hard link (nlink 2) must not be served");
        let real = root.join("s2"); std::fs::create_dir_all(&real).unwrap(); std::fs::write(real.join("init.mp4"), b"other").unwrap();
        symlink(&real, root.join("s3")).unwrap();
        assert!(read_ring_file(&root, "s3", "init.mp4").is_none(), "symlinked session dir must not be served");
        assert!(read_ring_file(&root, "s1", "../secret.db").is_none() && read_ring_file(&root, "..", "x").is_none(), "no traversal components");
        assert!(read_ring_file(&root, "s1", "missing.m4s").is_none());
        let _ = std::fs::remove_dir_all(&base);
    }
}
