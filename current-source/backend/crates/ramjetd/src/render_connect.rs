                                                                                                                  
                                                                                                                            
                                                                                                                                                         
                                                                                        
                                                                                                                                                                                                                                    
                                                                                                                                                                                                 
                                                                                                                                                                                                                           
                                                                                                                                                                         
                                                                                                                                                                                                                                    
                                                                                                                                                                                                                 
                                                                                                                                                                                                                                                      
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use crate::lite::ssrf::blocked_ip as base_blocked_ip;

                                                                                                                  
                                                                                                                                   
pub fn blocked_ip(ip: IpAddr) -> bool {
    if base_blocked_ip(ip) { return true; }
    if let IpAddr::V6(a) = ip {
        let g = a.segments();
                                                                                                             
        if g[..4] == [0, 0, 0, 0] && g[4] == 0xffff && g[5] == 0 { return true; }
        return (g[0] == 0x2001 && g[1] < 0x200) || (g[0] == 0x2001 && g[1] == 0x0db8) || (g[0] == 0x3fff && g[1] < 0x1000) || g[0] == 0x5f00
            || (g[0] == 0x0100 && g[1] == 0 && g[2] == 0 && g[3] == 0) || (g[0] & 0xffc0) == 0xfec0 || (g[0] == 0x0064 && g[1] == 0xff9b && g[2] == 1);
    }
    false
}

pub const ALLOWED_PORTS: [u16; 2] = [80, 443];
const MAX_HEAD: usize = 4096;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
const TUNNEL_CAP: Duration = Duration::from_secs(1800);
const VALIDATE_TIMEOUT: Duration = Duration::from_secs(12);                                                                               
const PRE_TUNNEL: usize = 32;                                                                                                             
const MAX_CONNS: usize = 64;
const MAX_ANSWERS: usize = 16;
const IDLE: Duration = Duration::from_secs(120);
const DOH_MAX_BODY: usize = 65536;
const REFUSED_KEEP: usize = 32;

                                                  
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
pub static ALLOWED: AtomicU64 = AtomicU64::new(0);
pub static REFUSED: AtomicU64 = AtomicU64::new(0);
pub static DIAL_FAIL: AtomicU64 = AtomicU64::new(0);
static RECENT_REFUSED: std::sync::Mutex<std::collections::VecDeque<String>> = std::sync::Mutex::new(std::collections::VecDeque::new());
fn note_refused(host: &str) {
    let n = REFUSED.fetch_add(1, Relaxed) + 1;
    if n <= 200 || n.is_power_of_two() { eprintln!("render_connect: refused host={} total_refused={n}", host.chars().take(80).collect::<String>().replace(|c: char| c.is_control(), "?")); }                                               
    let mut q = RECENT_REFUSED.lock().unwrap_or_else(|e| e.into_inner());
    if q.len() >= REFUSED_KEEP { q.pop_front(); }
    q.push_back(host.chars().take(80).collect());
}
pub fn recent_refused() -> Vec<String> { RECENT_REFUSED.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect() }

#[derive(Clone)]
pub struct Config { pub socks: String, pub doh_ip: IpAddr, pub doh_host: String, pub doh_port: u16 }
                                                                                                                                                                
                                                                                                                                             
pub fn config_from_env() -> Option<Config> {
    let socks = std::env::var("RJ_RENDER_SOCKS").ok().filter(|h| h.rsplit_once(':').map_or(false, |(a, p)| !a.is_empty() && p.parse::<u16>().is_ok()) && !h.contains('/'))?;
    let doh_ip: IpAddr = std::env::var("RJ_RENDER_DOH_IP").ok()?.trim_start_matches('[').trim_end_matches(']').parse().ok()?;
    if blocked_ip(doh_ip) { return None; }
    let doh_host = std::env::var("RJ_RENDER_DOH_HOST").ok().filter(|h| !h.is_empty() && h.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-'))?;
    let doh_port = match std::env::var("RJ_RENDER_DOH_PORT") { Ok(p) => p.parse::<u16>().ok().filter(|p| *p > 0)?, Err(_) => 443 };
    Some(Config { socks, doh_ip, doh_host, doh_port })
}

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub type ResolveFn = Arc<dyn Fn(String) -> BoxFut<Result<Vec<IpAddr>, String>> + Send + Sync>;
pub type DialFn = Arc<dyn Fn(IpAddr, u16) -> BoxFut<Result<TcpStream, String>> + Send + Sync>;

#[derive(Debug, PartialEq, Eq)]
pub enum Refuse { Method, Bad, Port, Policy }

                                                                                                                                 
pub fn parse_connect(head: &str) -> Result<(String, u16), Refuse> {
    let line = head.lines().next().ok_or(Refuse::Bad)?;
    let mut it = line.split(' ');
    if it.next() != Some("CONNECT") { return Err(Refuse::Method); }
    let target = it.next().ok_or(Refuse::Bad)?;
    let ver = it.next().ok_or(Refuse::Bad)?;
    if line.bytes().any(|b| b == b'\r' || b == b'\n' || b == b'\t') { return Err(Refuse::Bad); }
    if it.next().is_some() || !(ver == "HTTP/1.1" || ver == "HTTP/1.0") { return Err(Refuse::Bad); }
    let (h, p) = target.rsplit_once(':').ok_or(Refuse::Bad)?;
    let port: u16 = p.parse().map_err(|_| Refuse::Bad)?;
    if !ALLOWED_PORTS.contains(&port) { return Err(Refuse::Port); }
    let h = h.strip_prefix('[').and_then(|x| x.strip_suffix(']')).unwrap_or(h).to_ascii_lowercase();
    if h.is_empty() || h.len() > 253 || h.contains('@') { return Err(Refuse::Bad); }
    if h.parse::<IpAddr>().is_err() && !h.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') { return Err(Refuse::Bad); }                             
    Ok((h, port))
}

                                                                                                                                       
pub fn parse_forward(head: &str) -> Result<(String, u16, String), Refuse> {
                                                                                                                                                 
    if head.bytes().filter(|&b| b < 0x20 && b != b'\t' && b != b'\r' && b != b'\n' || b == 0x7f).next().is_some() { return Err(Refuse::Bad); }
    let mut lines = head.split("\r\n");
    let line = lines.next().ok_or(Refuse::Bad)?;
    let mut it = line.split(' ');
    let (method, target, ver) = (it.next().ok_or(Refuse::Bad)?, it.next().ok_or(Refuse::Bad)?, it.next().ok_or(Refuse::Bad)?);
    if it.next().is_some() || !(ver == "HTTP/1.1" || ver == "HTTP/1.0") { return Err(Refuse::Bad); }
    if !matches!(method, "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "OPTIONS" | "PATCH") { return Err(Refuse::Method); }
    let u = url::Url::parse(target).map_err(|_| Refuse::Bad)?;
    if u.scheme() != "http" || !u.username().is_empty() || u.password().is_some() { return Err(Refuse::Bad); }
    let host = u.host_str().ok_or(Refuse::Bad)?.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if host.is_empty() || host.len() > 253 { return Err(Refuse::Bad); }
    let port = u.port().unwrap_or(80);
    if port != 80 { return Err(Refuse::Port); }
    let mut path = u.path().to_string();
    if let Some(q) = u.query() { path.push('?'); path.push_str(q); }
    let host_hdr = if host.contains(':') { format!("[{host}]") } else { host.clone() };
    let mut out = format!("{method} {path} {ver}\r\nHost: {host_hdr}\r\nConnection: close\r\n");
    let (mut cl, mut te) = (0usize, false);
    for l in lines {
        if l.is_empty() { break; }
        if l.bytes().any(|b| b == b'\r' || b == b'\n') { return Err(Refuse::Bad); }                                                           
        if l.starts_with(' ') || l.starts_with('\t') || !l.contains(':') { return Err(Refuse::Bad); }                          
        let raw_name = l.split(':').next().unwrap_or("");
                                                                              
        if raw_name.is_empty() || !raw_name.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)) { return Err(Refuse::Bad); }
        let name = raw_name.to_ascii_lowercase();
        if name == "upgrade" { return Err(Refuse::Method); }
        if name == "content-length" { cl += 1; }
        if name == "transfer-encoding" { te = true; }
        if matches!(name.as_str(), "host" | "connection" | "proxy-connection" | "proxy-authorization" | "keep-alive") { continue; }
        out.push_str(l); out.push_str("\r\n");
    }
    if cl > 1 || (cl == 1 && te) { return Err(Refuse::Bad); }                                                                
    out.push_str("\r\n");
    Ok((host, port, out))
}

                                                                                                                        
pub async fn validate(host: &str, resolve: &ResolveFn) -> Result<IpAddr, Refuse> {
    if let Ok(ip) = host.parse::<IpAddr>() { return if blocked_ip(ip) { Err(Refuse::Policy) } else { Ok(ip) }; }
    if !host.contains('.') || host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal") { return Err(Refuse::Policy); }
    let mut ips = resolve(host.to_string()).await.map_err(|_| Refuse::Policy)?;
    if ips.is_empty() || ips.len() > MAX_ANSWERS || ips.iter().any(|ip| blocked_ip(*ip)) { return Err(Refuse::Policy); }                                                                                         
    ips.sort_by_key(|ip| ip.is_ipv6());                                                           
    Ok(ips[0])
}

                                                                                             
pub async fn socks5_dial(proxy: &str, ip: IpAddr, port: u16) -> Result<TcpStream, String> {
    let mut s = tokio::time::timeout(DIAL_TIMEOUT, TcpStream::connect(proxy)).await.map_err(|_| "proxy timeout".to_string())?.map_err(|e| e.to_string())?;
    let go = async {
        s.write_all(&[5, 1, 0]).await.map_err(|e| e.to_string())?;
        let mut r = [0u8; 2]; s.read_exact(&mut r).await.map_err(|e| e.to_string())?;
        if r != [5, 0] { return Err("socks auth".to_string()); }
        let mut req = vec![5, 1, 0];
        match ip { IpAddr::V4(a) => { req.push(1); req.extend_from_slice(&a.octets()); } IpAddr::V6(a) => { req.push(4); req.extend_from_slice(&a.octets()); } }
        req.extend_from_slice(&port.to_be_bytes());
        s.write_all(&req).await.map_err(|e| e.to_string())?;
        let mut h = [0u8; 4]; s.read_exact(&mut h).await.map_err(|e| e.to_string())?;
        if h[0] != 5 || h[1] != 0 { return Err("socks refused".to_string()); }
                                                                                                                                                          
        let rest = match h[3] { 1 => 4 + 2, 4 => 16 + 2, 3 => { let mut l = [0u8; 1]; s.read_exact(&mut l).await.map_err(|e| e.to_string())?; l[0] as usize + 2 } _ => return Err("socks atyp".to_string()) };
        let mut skip = vec![0u8; rest]; s.read_exact(&mut skip).await.map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    };
    tokio::time::timeout(DIAL_TIMEOUT, go).await.map_err(|_| "socks timeout".to_string())??;
    Ok(s)
}

                                                                                                                                                                                               
pub fn parse_doh(body: &[u8]) -> Result<Vec<IpAddr>, String> {
    let v: serde_json::Value = serde_json::from_slice(body).map_err(|_| "doh json".to_string())?;
    if v["Status"].as_i64() != Some(0) { return Ok(vec![]); }
    let mut out = Vec::new();
    for a in v["Answer"].as_array().into_iter().flatten() {
        let t = a["type"].as_i64().unwrap_or(0);
        if t == 1 || t == 28 { out.push(a["data"].as_str().and_then(|d| d.parse::<IpAddr>().ok()).ok_or_else(|| "doh garbage".to_string())?); }
        if out.len() > 4 * MAX_ANSWERS { return Err("doh too many".to_string()); }
    }
    Ok(out)
}

                                                                                                                                                                      
                                                                                                                                         
pub fn split_doh_reply(raw: &[u8]) -> Result<&[u8], String> {
    let i = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| "doh no head".to_string())?;
    let head = std::str::from_utf8(&raw[..i]).map_err(|_| "doh head".to_string())?;
    let mut lines = head.split("\r\n");
    let st = lines.next().unwrap_or("");
    let ok = |pre: &str| st.strip_prefix(pre).map_or(false, |r| r == "200" || r.starts_with("200 "));                                                 
    if !(ok("HTTP/1.0 ") || ok("HTTP/1.1 ")) { return Err("doh status".to_string()); }
    for l in lines { let n = l.split(':').next().unwrap_or("").trim().to_ascii_lowercase(); if n == "transfer-encoding" || n == "content-encoding" { return Err("doh encoding".to_string()); } }
    Ok(&raw[i + 4..])
}

                                                                                             
pub fn doh_name_ok(h: &str) -> bool { !h.is_empty() && h.len() <= 253 && h.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') }

                                                                                                                                                                                                                                                       
pub fn doh_tls_config() -> Arc<tokio_rustls::rustls::ClientConfig> {
    let mut roots = tokio_rustls::rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let prov = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
    let cfg = tokio_rustls::rustls::ClientConfig::builder_with_provider(prov).with_safe_default_protocol_versions().expect("tls versions")
        .with_root_certificates(roots).with_no_client_auth();
    Arc::new(cfg)
}

                                                                                                                                                                         
                                                                                                                                           
pub async fn doh_query(socks: &str, cfg: &Config, tls: &Arc<tokio_rustls::rustls::ClientConfig>, name: &str, qtype: &str) -> Result<Vec<IpAddr>, String> {
    if !doh_name_ok(name) || !matches!(qtype, "A" | "AAAA") { return Err("doh bad name".to_string()); }
    let go = async {
        let tcp = socks5_dial(socks, cfg.doh_ip, cfg.doh_port).await?;
        let sn = tokio_rustls::rustls::pki_types::ServerName::try_from(cfg.doh_host.clone()).map_err(|_| "doh server name".to_string())?;
        let mut t = tokio_rustls::TlsConnector::from(tls.clone()).connect(sn, tcp).await.map_err(|e| format!("doh tls: {e}"))?;
        let req = format!("GET /dns-query?name={name}&type={qtype} HTTP/1.0\r\nHost: {}\r\nAccept: application/dns-json\r\n\r\n", cfg.doh_host);
        t.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;
        let mut raw: Vec<u8> = Vec::new();
        let mut b = [0u8; 4096];
        loop {
            let n = t.read(&mut b).await.map_err(|e| format!("doh read: {e}"))?;
            if n == 0 { break; }
            raw.extend_from_slice(&b[..n]);
            if raw.len() > DOH_MAX_BODY + 8192 { return Err("doh too large".to_string()); }
        }
        let body = split_doh_reply(&raw)?;
        if body.len() > DOH_MAX_BODY { return Err("doh too large".to_string()); }
        parse_doh(body)
    };
    tokio::time::timeout(Duration::from_secs(5), go).await.map_err(|_| "doh timeout".to_string())?
}

                                                                                                                                              
pub fn doh_resolver(cfg: Config) -> ResolveFn {
    let tls = doh_tls_config();
    let cfg = Arc::new(cfg);
    Arc::new(move |host: String| {
        let (cfg, tls) = (cfg.clone(), tls.clone());
        Box::pin(async move {
            let mut out = Vec::new();
            for ty in ["A", "AAAA"] { out.extend(doh_query(&cfg.socks, &cfg, &tls, &host, ty).await?); }
            Ok(out)
        })
    })
}

async fn reply(s: &mut TcpStream, line: &str) { let _ = s.write_all(format!("HTTP/1.1 {line}\r\nConnection: close\r\n\r\n").as_bytes()).await; let _ = s.shutdown().await; }

                                                                                                                
                                                                                                                                                 
                                                                                                                                                         
pub async fn relay(c: &mut TcpStream, up: &mut TcpStream, idle: Duration) {
    let (mut cr, mut cw) = c.split();
    let (mut ur, mut uw) = up.split();
    let (mut a, mut b) = ([0u8; 8192], [0u8; 8192]);
    loop {
        tokio::select! {
            r = tokio::time::timeout(idle, cr.read(&mut a)) => match r { Ok(Ok(n)) if n > 0 => { if matches!(tokio::time::timeout(idle, uw.write_all(&a[..n])).await, Ok(Ok(_))) == false { return; } } _ => return },
            r = tokio::time::timeout(idle, ur.read(&mut b)) => match r { Ok(Ok(n)) if n > 0 => { if matches!(tokio::time::timeout(idle, cw.write_all(&b[..n])).await, Ok(Ok(_))) == false { return; } } _ => return },
        }
    }
}

async fn handle(mut c: TcpStream, resolve: ResolveFn, dial: DialFn, pre: tokio::sync::OwnedSemaphorePermit) {
    let mut buf = Vec::with_capacity(512);
    let head = tokio::time::timeout(HEAD_TIMEOUT, async {
        let mut b = [0u8; 512];
        loop {
            let n = c.read(&mut b).await.map_err(|_| ())?;
            if n == 0 { return Err(()); }
            buf.extend_from_slice(&b[..n]);
            if buf.len() > MAX_HEAD { return Err(()); }
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") { return Ok(i + 4); }
        }
    }).await;
    let Ok(Ok(end)) = head else { return reply(&mut c, "400 Bad Request").await; };
    let Ok(text) = std::str::from_utf8(&buf[..end]) else { return reply(&mut c, "400 Bad Request").await; };
    let is_connect = text.starts_with("CONNECT ");
    let (host, port, fwd_head) = if is_connect {
        match parse_connect(text) { Ok((h, p)) => (h, p, None), Err(e) => return refuse(&mut c, e, "?").await }
    } else {
        match parse_forward(text) { Ok((h, p, hd)) => (h, p, Some(hd)), Err(e) => return refuse(&mut c, e, "?").await }
    };
    let Ok(Ok(ip)) = tokio::time::timeout(VALIDATE_TIMEOUT, validate(&host, &resolve)).await else { note_refused(&host); return reply(&mut c, "403 Forbidden").await; };
    let up = tokio::time::timeout(DIAL_TIMEOUT, dial(ip, port)).await;
    let Ok(Ok(mut up)) = up else { DIAL_FAIL.fetch_add(1, Relaxed); return reply(&mut c, "502 Bad Gateway").await; };
    ALLOWED.fetch_add(1, Relaxed);
    drop(pre);                                                                    
    match fwd_head {
        None => { if c.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.is_err() { return; } if buf.len() > end { let _ = up.write_all(&buf[end..]).await; } }
        Some(hd) => { if up.write_all(hd.as_bytes()).await.is_err() { return; } if buf.len() > end { let _ = up.write_all(&buf[end..]).await; } }                                        
    }
    let _ = tokio::time::timeout(TUNNEL_CAP, relay(&mut c, &mut up, IDLE)).await;
}

async fn refuse(c: &mut TcpStream, e: Refuse, host: &str) {
    match e {
        Refuse::Method => reply(c, "405 Method Not Allowed").await,
        Refuse::Bad => reply(c, "400 Bad Request").await,
        _ => { note_refused(host); reply(c, "403 Forbidden").await }
    }
}

                                                                                                                                            
pub async fn serve(l: TcpListener, resolve: ResolveFn, dial: DialFn) {
    let sem = Arc::new(tokio::sync::Semaphore::new(MAX_CONNS));
    let pre = Arc::new(tokio::sync::Semaphore::new(PRE_TUNNEL));
    loop {
        let Ok((c, _)) = l.accept().await else { tokio::time::sleep(Duration::from_millis(50)).await; continue; };
        let Ok(p) = sem.clone().try_acquire_owned() else { drop(c); continue; };                                     
        let Ok(q) = pre.clone().try_acquire_owned() else { drop(c); continue; };                                      
        let (r, d) = (resolve.clone(), dial.clone());
        tokio::spawn(async move { handle(c, r, d, q).await; drop(p); });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    fn res(ips: Vec<IpAddr>) -> ResolveFn { Arc::new(move |_| { let v = ips.clone(); Box::pin(async move { Ok(v) }) }) }
    async fn echo() -> u16 { let l = TcpListener::bind("127.0.0.1:0").await.unwrap(); let p = l.local_addr().unwrap().port();
        tokio::spawn(async move { loop { let Ok((mut s, _)) = l.accept().await else { return }; tokio::spawn(async move { let mut b = [0u8; 64]; while let Ok(n) = s.read(&mut b).await { if n == 0 || s.write_all(&b[..n]).await.is_err() { return; } } }); } }); p }
    async fn proxy_run(resolve: ResolveFn, dial: DialFn, req: &str) -> String {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap(); let p = l.local_addr().unwrap().port();
        tokio::spawn(serve(l, resolve, dial));
        let mut c = TcpStream::connect(("127.0.0.1", p)).await.unwrap(); c.write_all(req.as_bytes()).await.unwrap();
        let mut got = vec![0u8; 256]; let n = tokio::time::timeout(Duration::from_secs(3), c.read(&mut got)).await.unwrap().unwrap(); String::from_utf8_lossy(&got[..n]).to_string() }
    #[test]
    fn parse_rules() {
        assert_eq!(parse_connect("CONNECT Example.COM:443 HTTP/1.1\r\n\r\n"), Ok(("example.com".into(), 443)));
        assert_eq!(parse_connect("CONNECT [2606:4700::1]:443 HTTP/1.1\r\n\r\n"), Ok(("2606:4700::1".into(), 443)));
        assert_eq!(parse_connect("GET http://a.b/ HTTP/1.1\r\n\r\n"), Err(Refuse::Method));
        assert_eq!(parse_connect("CONNECT a.b:22 HTTP/1.1\r\n\r\n"), Err(Refuse::Port));
        assert_eq!(parse_connect("CONNECT u@a.b:443 HTTP/1.1\r\n\r\n"), Err(Refuse::Bad));
        assert_eq!(parse_connect("CONNECT a b:443 HTTP/1.1\r\n\r\n"), Err(Refuse::Bad));
        assert_eq!(parse_connect("CONNECT a.b:443 HTTP/2\r\n\r\n"), Err(Refuse::Bad));
    }
    #[tokio::test]
    async fn validate_refuses_any_private_answer_and_literals() {
        let pubip: IpAddr = "93.184.216.34".parse().unwrap(); let priv_: IpAddr = "10.0.0.5".parse().unwrap();
        assert_eq!(validate("a.example", &res(vec![pubip])).await, Ok(pubip));
        assert_eq!(validate("a.example", &res(vec![pubip, priv_])).await, Err(Refuse::Policy), "one private answer poisons the set");
        assert_eq!(validate("a.example", &res(vec![])).await, Err(Refuse::Policy));
        for lit in ["127.0.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1", "100.64.0.1"] { assert_eq!(validate(lit, &res(vec![pubip])).await, Err(Refuse::Policy), "{lit}"); }
        assert_eq!(validate("localhost", &res(vec![pubip])).await, Err(Refuse::Policy));
        assert_eq!(validate("db.internal", &res(vec![pubip])).await, Err(Refuse::Policy));
    }
    #[tokio::test]
    async fn tunnel_dials_the_validated_ip_literal_once_and_private_never_dials() {
        let ep = echo().await; let pubip: IpAddr = "93.184.216.34".parse().unwrap();
        let dialed: Arc<Mutex<Vec<(IpAddr, u16)>>> = Default::default(); let d2 = dialed.clone();
        let dial: DialFn = Arc::new(move |ip, port| { d2.lock().unwrap().push((ip, port)); Box::pin(async move { TcpStream::connect(("127.0.0.1", ep)).await.map_err(|e| e.to_string()) }) });
        let out = proxy_run(res(vec![pubip]), dial.clone(), "CONNECT ok.example:443 HTTP/1.1\r\n\r\n").await;
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        assert_eq!(*dialed.lock().unwrap(), vec![(pubip, 443)], "dialed the resolver's validated IP literal, once");
        dialed.lock().unwrap().clear();
        let out = proxy_run(res(vec![pubip, "192.168.1.9".parse().unwrap()]), dial.clone(), "CONNECT mixed.example:443 HTTP/1.1\r\n\r\n").await;
        assert!(out.starts_with("HTTP/1.1 403"), "{out}");
        let out = proxy_run(res(vec![pubip]), dial.clone(), "CONNECT a.example:22 HTTP/1.1\r\n\r\n").await; assert!(out.starts_with("HTTP/1.1 403"), "{out}");
        let out = proxy_run(res(vec![pubip]), dial.clone(), "TRACE http://a.example/ HTTP/1.1\r\n\r\n").await; assert!(out.starts_with("HTTP/1.1 405"), "{out}");
        assert!(dialed.lock().unwrap().is_empty(), "refused requests never reach the dialer");
    }
    #[tokio::test]
    async fn oversize_head_is_400_and_socks5_uses_ip_literal_atyp() {
        let big = format!("CONNECT a.example:443 HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(5000));
        let out = proxy_run(res(vec![]), Arc::new(|_, _| Box::pin(async { Err("no".to_string()) })), &big).await; assert!(out.starts_with("HTTP/1.1 400"), "{out}");
                                                       
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap(); let p = l.local_addr().unwrap().port();
        let seen: Arc<Mutex<Vec<u8>>> = Default::default(); let s2 = seen.clone();
        tokio::spawn(async move { let (mut s, _) = l.accept().await.unwrap(); let mut g = [0u8; 3]; s.read_exact(&mut g).await.unwrap(); s.write_all(&[5, 0]).await.unwrap();
            let mut r = [0u8; 10]; s.read_exact(&mut r).await.unwrap(); s2.lock().unwrap().extend_from_slice(&r); s.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap(); });
        socks5_dial(&format!("127.0.0.1:{p}"), "93.184.216.34".parse().unwrap(), 443).await.unwrap();
        assert_eq!(*seen.lock().unwrap(), vec![5, 1, 0, 1, 93, 184, 216, 34, 1, 187], "ATYP=1 + raw IPv4 + port, never a domain name");
    }

    #[test]
    fn forward_rejects_ctl_and_bare_cr_lf() {
        for h in ["GET http://a.b/ HTTP/1.1\r\nX: a\nHost: evil\r\n\r\n", "GET http://a.b/ HTTP/1.1\r\nX: a\rInjected: 1\r\n\r\n",
                  "GET http://a.b/ HTTP/1.1\r\nX: a\0b\r\n\r\n", "GET http://a.b/ HTTP/1.1\r\nX: a\x7fb\r\n\r\n", "GET http://a.b/ HTTP/1.1\r\nX: a\x01\r\n\r\n",
                  "GET http://a.b/\nHost: x HTTP/1.1\r\n\r\n", "GET http://a.b/ HTTP/1.1\n\r\n"] {
            assert_eq!(parse_forward(h), Err(Refuse::Bad), "{h:?}");
        }
        assert!(parse_forward("GET http://a.b/ HTTP/1.1\r\nX: a\tb\r\n\r\n").is_ok(), "HT inside a value is legal");
    }
    #[test]
    fn forward_rejects_bad_header_names() {
        for h in ["GET http://a.b/ HTTP/1.1\r\nX\t: 1\r\n\r\n", "GET http://a.b/ HTTP/1.1\r\nX : 1\r\n\r\n", "GET http://a.b/ HTTP/1.1\r\n: 1\r\n\r\n", "GET http://a.b/ HTTP/1.1\r\nX(y): 1\r\n\r\n", "GET http://a.b/ HTTP/1.1\r\nContent-Length : 1\r\n\r\n"] {
            assert_eq!(parse_forward(h), Err(Refuse::Bad), "{h:?}");
        }
        assert!(parse_forward("GET http://a.b/ HTTP/1.1\r\nX-Y_z.1: 1\r\n\r\n").is_ok());
    }
    #[test]
    fn doh_reply_split() {
        assert_eq!(split_doh_reply(b"HTTP/1.1 200 OK\r\nContent-Type: application/dns-json\r\n\r\n{}").unwrap(), b"{}");
        assert!(split_doh_reply(b"HTTP/1.1 2000 OK\r\n\r\n{}").is_err());
        assert!(split_doh_reply(b"HTTP/1.1 200\r\n\r\n{}").is_ok());
        assert!(split_doh_reply(b"HTTP/1.1 200x\r\n\r\n{}").is_err());
        assert!(split_doh_reply(b"HTTP/1.1 404 NF\r\n\r\n{}").is_err());
        assert!(split_doh_reply(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n").is_err());
        assert!(split_doh_reply(b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\nx").is_err());
        assert!(split_doh_reply(b"HTTP/1.1 200 OK").is_err());
        assert!(!doh_name_ok("a.b/../c") && !doh_name_ok("a b") && !doh_name_ok("") && doh_name_ok("x-1.example.com"));
    }
    #[test]
    fn te_only_is_forwarded_as_is_and_pinned() {
                                                                                                                                                                        
        let (_, _, out) = parse_forward("POST http://a.b/ HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
        assert_eq!(out, "POST / HTTP/1.1\r\nHost: a.b\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n");
    }
    #[test]
    fn nat64_mapped_6to4_compat_blocked() {
        for a in ["64:ff9b::a00:1", "64:ff9b::7f00:1", "64:ff9b::c0a8:1", "::ffff:10.0.0.1", "::ffff:a00:1", "2002:a00:1::", "2002:c0a8:101::", "::a00:1", "::7f00:1", "64:ff9b:1::1"] {
            assert!(blocked_ip(a.parse().unwrap()), "{a}");
        }
        assert!(!blocked_ip("2606:4700:4700::1111".parse().unwrap()));
    }
    #[test]
    fn forward_rewrite_and_refusals() {
        let h = "GET http://Example.COM/a/b?x=1 HTTP/1.1\r\nHost: evil.test\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive\r\nAccept: */*\r\n\r\n";
        let (host, port, out) = parse_forward(h).unwrap();
        assert_eq!((host.as_str(), port), ("example.com", 80));
        assert_eq!(out, "GET /a/b?x=1 HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\nAccept: */*\r\n\r\n", "origin-form, Host forced to the validated host, hop-by-hop dropped, close forced");
        assert_eq!(parse_forward("GET http://a.b:8080/ HTTP/1.1\r\n\r\n"), Err(Refuse::Port));
        assert_eq!(parse_forward("GET https://a.b/ HTTP/1.1\r\n\r\n"), Err(Refuse::Bad));
        assert_eq!(parse_forward("GET http://u:p@a.b/ HTTP/1.1\r\n\r\n"), Err(Refuse::Bad));
        assert_eq!(parse_forward("GET http://a.b/ HTTP/1.1\r\nUpgrade: websocket\r\n\r\n"), Err(Refuse::Method));
        assert_eq!(parse_forward("GET http://a.b/ HTTP/1.1\r\nX: 1\r\n folded\r\n\r\n"), Err(Refuse::Bad));
        assert_eq!(parse_forward("BREW http://a.b/ HTTP/1.1\r\n\r\n"), Err(Refuse::Method));
    }
    #[tokio::test]
    async fn http_forward_validates_dials_validated_ip_and_sends_rewritten_head() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap(); let ep = l.local_addr().unwrap().port();
        let got: Arc<Mutex<Vec<u8>>> = Default::default(); let g2 = got.clone();
        tokio::spawn(async move { let (mut s, _) = l.accept().await.unwrap(); let mut b = vec![0u8; 512]; let n = s.read(&mut b).await.unwrap(); g2.lock().unwrap().extend_from_slice(&b[..n]); s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").await.unwrap(); });
        let pubip: IpAddr = "93.184.216.34".parse().unwrap(); let dialed: Arc<Mutex<Vec<(IpAddr, u16)>>> = Default::default(); let d2 = dialed.clone();
        let dial: DialFn = Arc::new(move |ip, port| { d2.lock().unwrap().push((ip, port)); Box::pin(async move { TcpStream::connect(("127.0.0.1", ep)).await.map_err(|e| e.to_string()) }) });
        let out = proxy_run(res(vec![pubip]), dial.clone(), "GET http://fwd.example/p HTTP/1.1\r\nHost: fwd.example\r\n\r\n").await;
        assert!(out.starts_with("HTTP/1.1 200 OK"), "{out}");
        assert_eq!(*dialed.lock().unwrap(), vec![(pubip, 80)]);
        assert!(String::from_utf8_lossy(&got.lock().unwrap()).starts_with("GET /p HTTP/1.1\r\nHost: fwd.example\r\nConnection: close"));
        dialed.lock().unwrap().clear();
        let out = proxy_run(res(vec![pubip, "10.9.9.9".parse().unwrap()]), dial, "GET http://priv.example/ HTTP/1.1\r\n\r\n").await;
        assert!(out.starts_with("HTTP/1.1 403"), "{out}"); assert!(dialed.lock().unwrap().is_empty());
        assert!(recent_refused().iter().any(|h| h == "priv.example"));
    }
    #[tokio::test]
    async fn relay_survives_one_way_traffic_longer_than_idle() {
        async fn pair() -> (TcpStream, TcpStream) { let l = TcpListener::bind("127.0.0.1:0").await.unwrap(); let p = l.local_addr().unwrap().port(); let c = TcpStream::connect(("127.0.0.1", p)).await.unwrap(); let (s, _) = l.accept().await.unwrap(); (c, s) }
        let (mut c_in, mut c_peer) = pair().await; let (mut u_in, mut u_peer) = pair().await;
                                                                                                                                                  
        let feeder = tokio::spawn(async move { for _ in 0..12 { let _ = u_peer.write_all(b"x").await; tokio::time::sleep(Duration::from_millis(50)).await; } u_peer });
        let r = tokio::time::timeout(Duration::from_millis(500), relay(&mut c_in, &mut u_in, Duration::from_millis(150))).await;
        assert!(r.is_err(), "relay ended while the other direction was still moving bytes");
        let mut got = [0u8; 64];
        let n = tokio::time::timeout(Duration::from_millis(300), c_peer.read(&mut got)).await.unwrap().unwrap();
        assert!(n > 0, "bytes must reach the client");
        let _ = feeder.await;
    }
    #[test]
    fn blocked_ip_covers_translated_and_mapped_forms() {
        for s in ["::ffff:0:10.0.0.1", "::ffff:10.0.0.1", "::10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1", "fe80::1", "fd00::1", "::1", "::"] {
            assert!(blocked_ip(s.parse().unwrap()), "{s}");
        }
        for s in ["10.0.0.1", "100.64.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1", "127.0.0.1", "0.0.0.0", "240.0.0.1", "198.18.0.1"] {
            assert!(blocked_ip(s.parse().unwrap()), "{s}");
        }
        assert!(!blocked_ip("93.184.216.34".parse().unwrap()));
        assert!(!blocked_ip("2606:4700:4700::1111".parse().unwrap()));
    }
    #[tokio::test]
    async fn relay_ends_when_the_peer_never_reads_a_stalled_write() {
        async fn pair() -> (TcpStream, TcpStream) { let l = TcpListener::bind("127.0.0.1:0").await.unwrap(); let p = l.local_addr().unwrap().port(); let c = TcpStream::connect(("127.0.0.1", p)).await.unwrap(); let (s, _) = l.accept().await.unwrap(); (c, s) }
        let (mut c_in, mut c_peer) = pair().await; let (mut u_in, _u_peer_never_reads) = pair().await;
                                                                                                                                     
                                                                                                                                             
        let flood = tokio::spawn(async move { let chunk = [7u8; 65536]; for _ in 0..1024 { if c_peer.write_all(&chunk).await.is_err() { break; } } });
        let t0 = std::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(10), relay(&mut c_in, &mut u_in, Duration::from_millis(300))).await.expect("a stalled write must end the relay, not hang it");
        assert!(t0.elapsed() < Duration::from_secs(8));
        flood.abort();
    }
    #[tokio::test]
    async fn relay_ends_on_idle() {
        async fn pair() -> (TcpStream, TcpStream) { let l = TcpListener::bind("127.0.0.1:0").await.unwrap(); let p = l.local_addr().unwrap().port(); let c = TcpStream::connect(("127.0.0.1", p)).await.unwrap(); let (s, _) = l.accept().await.unwrap(); (c, s) }
        let (mut a_in, _a_peer) = pair().await; let (mut b_in, _b_peer) = pair().await;
        let t0 = std::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(3), relay(&mut a_in, &mut b_in, Duration::from_millis(150))).await.expect("relay must end on idle");
        assert!(t0.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn config_needs_explicit_public_doh_ip_name_and_socks() {
        for k in ["RJ_RENDER_SOCKS", "RJ_RENDER_DOH_IP", "RJ_RENDER_DOH_HOST", "RJ_RENDER_DOH_PORT"] { std::env::remove_var(k); }
        assert!(config_from_env().is_none());
        std::env::set_var("RJ_RENDER_SOCKS", "127.0.0.1:1080"); std::env::set_var("RJ_RENDER_DOH_HOST", "doh.example");
        std::env::set_var("RJ_RENDER_DOH_IP", "10.0.0.1"); assert!(config_from_env().is_none(), "private DoH IP refused");
        std::env::set_var("RJ_RENDER_DOH_IP", "93.184.216.34"); assert!(config_from_env().is_some());
        std::env::set_var("RJ_RENDER_DOH_PORT", "0"); assert!(config_from_env().is_none());
        for k in ["RJ_RENDER_SOCKS", "RJ_RENDER_DOH_IP", "RJ_RENDER_DOH_HOST", "RJ_RENDER_DOH_PORT"] { std::env::remove_var(k); }
    }
    #[test]
    fn v6_union_covers_v34_special_ranges() {
        for lit in ["2001::1", "2001:1ff::1", "2001:db8::1", "3fff::1", "5f00::1", "100::1", "fec0::1", "64:ff9b:1::1", "2002:a00:1::1"] { assert!(blocked_ip(lit.parse().unwrap()), "{lit}"); }
        assert!(!blocked_ip("2606:4700:4700::1111".parse().unwrap()) && !blocked_ip("93.184.216.34".parse().unwrap()));
    }

    #[tokio::test]
    async fn answer_set_size_is_checked_not_truncated() {
        let mk = |n: usize, last_private: bool| -> Vec<IpAddr> { let mut v: Vec<IpAddr> = (0..n).map(|i| format!("93.184.{}.{}", 1 + i / 200, 1 + i % 200).parse().unwrap()).collect(); if last_private { *v.last_mut().unwrap() = "10.0.0.1".parse().unwrap(); } v };
        assert!(validate("a.example", &res(mk(16, false))).await.is_ok());
        assert_eq!(validate("a.example", &res(mk(17, false))).await, Err(Refuse::Policy), "17 answers refused");
        assert_eq!(validate("a.example", &res(mk(17, true))).await, Err(Refuse::Policy), "a private 17th answer can never be skipped");
    }
    #[test]
    fn doh_parsing_errors_cname_only_and_garbage() {
        assert_eq!(parse_doh(br#"{"Status":0,"Answer":[{"type":1,"data":"93.184.216.34"},{"type":28,"data":"2606:4700::1"}]}"#).unwrap().len(), 2);
        assert_eq!(parse_doh(br#"{"Status":0,"Answer":[{"type":5,"data":"x.example."}]}"#).unwrap(), Vec::<IpAddr>::new(), "CNAME-only = no addresses");
        assert_eq!(parse_doh(br#"{"Status":3}"#).unwrap(), Vec::<IpAddr>::new(), "NXDOMAIN = no addresses");
        assert_eq!(parse_doh(br#"{"Status":0}"#).unwrap(), Vec::<IpAddr>::new());
        assert!(parse_doh(br#"{"Status":0,"Answer":[{"type":1,"data":"not-an-ip"}]}"#).is_err(), "garbage rr data fails closed");
        assert!(parse_doh(br#"{"Status":0,"Answer":[{"type":1}]}"#).is_err());
        assert!(parse_doh(b"<html>").is_err());
    }
    #[test]
    fn forward_smuggling_shapes_refused() {
        assert_eq!(parse_forward("POST http://a.b/ HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n"), Err(Refuse::Bad));
        assert_eq!(parse_forward("POST http://a.b/ HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n"), Err(Refuse::Bad));
        assert!(parse_forward("POST http://a.b/ HTTP/1.1\r\nContent-Length: 1\r\n\r\n").is_ok());
    }
    #[tokio::test]
    async fn socks5_ipv6_literal_bytes_and_domain_form_bnd_accepted() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap(); let p = l.local_addr().unwrap().port();
        let seen: Arc<Mutex<Vec<u8>>> = Default::default(); let s2 = seen.clone();
        tokio::spawn(async move { let (mut s, _) = l.accept().await.unwrap(); let mut g = [0u8; 3]; s.read_exact(&mut g).await.unwrap(); s.write_all(&[5, 0]).await.unwrap();
            let mut r = [0u8; 22]; s.read_exact(&mut r).await.unwrap(); s2.lock().unwrap().extend_from_slice(&r);
            s.write_all(&[5, 0, 0, 3, 3, b'a', b'.', b'b', 0, 0]).await.unwrap(); });                           
        let ip: IpAddr = "2606:4700:4700::1111".parse().unwrap();
        socks5_dial(&format!("127.0.0.1:{p}"), ip, 443).await.expect("domain-form BND reply must be accepted");
        let mut want = vec![5, 1, 0, 4]; if let IpAddr::V6(a) = ip { want.extend_from_slice(&a.octets()); } want.extend_from_slice(&443u16.to_be_bytes());
        assert_eq!(*seen.lock().unwrap(), want, "ATYP=4 + 16 raw bytes + port");
    }
    #[tokio::test]
    async fn pipelined_bytes_after_connect_head_reach_upstream() {
        let ep = echo().await; let pubip: IpAddr = "93.184.216.34".parse().unwrap();
        let dial: DialFn = Arc::new(move |_, _| Box::pin(async move { TcpStream::connect(("127.0.0.1", ep)).await.map_err(|e| e.to_string()) }));
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap(); let p = l.local_addr().unwrap().port();
        tokio::spawn(serve(l, res(vec![pubip]), dial));
        let mut c = TcpStream::connect(("127.0.0.1", p)).await.unwrap();
        c.write_all(b"CONNECT pipe.example:443 HTTP/1.1\r\n\r\nping").await.unwrap();
        let mut got = Vec::new(); let mut b = [0u8; 128];
        for _ in 0..20 { let n = tokio::time::timeout(Duration::from_millis(300), c.read(&mut b)).await; if let Ok(Ok(n)) = n { got.extend_from_slice(&b[..n]); } if String::from_utf8_lossy(&got).contains("ping") { break; } }
        let t = String::from_utf8_lossy(&got).to_string(); assert!(t.starts_with("HTTP/1.1 200") && t.ends_with("ping"), "{t}");
    }
}
