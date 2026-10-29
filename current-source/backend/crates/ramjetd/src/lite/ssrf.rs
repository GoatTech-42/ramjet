                                                                               
                                                                                      
                                                                                     
                                                                         
                                                                                    
                                                                                        
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use crate::AppState;

                                                                               
                                                                                      
                                                                                     
                                                                             
                                                                                    
                                                                              
                                                                                 
                                                                      
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SsrfErr {
    Msg(String),
    Transport,
}

impl std::fmt::Display for SsrfErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SsrfErr::Msg(m) => f.write_str(m),
            SsrfErr::Transport => f.write_str("upstream error"),
        }
    }
}

pub fn check_url(u: &str) -> Result<url::Url, String> {
    let t = url::Url::parse(u).map_err(|_| "bad url".to_string())?;
    if t.scheme() != "http" && t.scheme() != "https" { return Err("bad url".into()); }
    if !t.username().is_empty() || t.password().is_some() { return Err("bad url".into()); }
    let port = t.port().unwrap_or(if t.scheme() == "https" { 443 } else { 80 });
    if port != 80 && port != 443 { return Err("port not allowed".into()); }
    if t.host_str().map(|h| h.len() > 253).unwrap_or(true) { return Err("bad host".into()); }
    Ok(t)
}

fn blocked_v4(a: Ipv4Addr) -> bool {
    let [a0, b, c, _] = a.octets();
    a0 == 0 || a0 == 10 || a0 == 127 || a0 >= 224 || (a0 == 100 && (64..=127).contains(&b))
        || (a0 == 169 && b == 254) || (a0 == 172 && (16..=31).contains(&b)) || (a0 == 192 && b == 168)
        || (a0 == 192 && b == 0 && (c == 0 || c == 2)) || (a0 == 192 && b == 88 && c == 99)
        || (a0 == 198 && (b == 18 || b == 19))
        || (a0 == 198 && b == 51 && c == 100) || (a0 == 203 && b == 0 && c == 113)
}

fn blocked_v6(ip: Ipv6Addr) -> bool {
                                                                                   
                                                                                          
    if ip.is_multicast() { return true; }                              
    if let Some(_) = ip.to_ipv4_mapped() { return true; }                                       
    let s = ip.segments();
    let first = s[0];
    if s[..6].iter().all(|v|*v==0){return true}                                                                  
    if first == 0 && s[1] == 0 && s[2] == 0 && s[3] == 0 && s[4] == 0 && s[5] == 0 && s[6] == 0 && s[7] <= 1 { return true; }              
    if (first & 0xffc0) == 0xfe80 { return true; }                                              
    if (first & 0xff00) == 0xfc00 || (first & 0xff00) == 0xfd00 { return true; }                                
    if first == 0x2002 || (first == 0x0064 && s[1] == 0xff9b) { return true; }                           
    false
}

pub fn blocked_ip(ip: IpAddr) -> bool {
    match ip { IpAddr::V4(a) => blocked_v4(a), IpAddr::V6(a) => blocked_v6(a) }
}

                                                                                      
                                                                              
                                                                                         
pub async fn safe_lookup(host: &str) -> Result<IpAddr, String> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() || host.len() > 253 { return Err("bad host".into()); }
    if host.parse::<std::net::Ipv6Addr>().is_ok() { return Err("blocked address".into()); }                                     
    if let Ok(ip) = host.parse::<IpAddr>() {
        if blocked_ip(ip) { return Err("blocked address".into()); }
        return Ok(ip);
    }
    let addr = resolve_host(host).await?.into_iter().find(|a| a.is_ipv4()).ok_or("no address".to_string())?;                          
    if blocked_ip(addr) { return Err("blocked address".into()); }
    Ok(addr)
}

pub async fn pin(host: &str) -> Result<IpAddr, String> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let low = host.to_lowercase();
    if low.is_empty() || host.len() > 253 { return Err("bad host".into()); }
    if low == "localhost" || low.ends_with(".localhost") || low.ends_with(".local") || low.ends_with(".internal") || low == "host.docker.internal" {
        return Err("blocked address".into());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if blocked_ip(ip) { return Err("blocked address".into()); }
        return Ok(ip);
    }
    if host.chars().all(|c| c.is_ascii_hexdigit() || c == '.' || c == 'x' || c == 'X') && host.chars().any(|c| c.is_ascii_digit()) {
        return Err("blocked address".into());
    }
    let addrs = resolve_host(host).await?;
    if addrs.iter().any(|a| blocked_ip(*a)) { return Err("blocked address".into()); }
    Ok(addrs.iter().find(|a| a.is_ipv4()).copied().unwrap_or(addrs[0]))
}

                                                                                   
                                                                                       
                                                                                          
                                                                                  
pub async fn pin_t(host: &str) -> Result<IpAddr, SsrfErr> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let low = host.to_lowercase();
    if low.is_empty() || host.len() > 253 { return Err(SsrfErr::Msg("bad host".into())); }
    if low == "localhost" || low.ends_with(".localhost") || low.ends_with(".local") || low.ends_with(".internal") || low == "host.docker.internal" {
        return Err(SsrfErr::Msg("blocked address".into()));
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if blocked_ip(ip) { return Err(SsrfErr::Msg("blocked address".into())); }
        return Ok(ip);
    }
    if host.chars().all(|c| c.is_ascii_hexdigit() || c == '.' || c == 'x' || c == 'X') && host.chars().any(|c| c.is_ascii_digit()) {
        return Err(SsrfErr::Msg("blocked address".into()));
    }
    let addrs = resolve_host(host).await.map_err(|_| SsrfErr::Transport)?;
    if addrs.iter().any(|a| blocked_ip(*a)) { return Err(SsrfErr::Msg("blocked address".into())); }
    Ok(addrs.iter().find(|a| a.is_ipv4()).copied().unwrap_or(addrs[0]))
}

                                                                                  

pub struct DohCfg { pub ip: IpAddr, pub host: String, pub port: u16 }

pub fn doh_cfg() -> Option<Result<DohCfg, String>> {
    let raw = std::env::var("RJ_DOH_IP").ok()?;
    let ip: IpAddr = match raw.trim_start_matches('[').trim_end_matches(']').parse() { Ok(i) => i, Err(_) => return Some(Err("bad RJ_DOH_IP".into())) };
    if blocked_ip(ip) { return Some(Err("blocked RJ_DOH_IP".into())); }
    let host = match std::env::var("RJ_DOH_HOST").ok().filter(|h| crate::render_connect::doh_name_ok(h)) { Some(h) => h, None => return Some(Err("bad RJ_DOH_HOST".into())) };
    let port = match std::env::var("RJ_DOH_PORT") { Ok(p) => match p.parse::<u16>() { Ok(v) if v > 0 => v, _ => return Some(Err("bad RJ_DOH_PORT".into())) }, Err(_) => 443 };
    Some(Ok(DohCfg { ip, host, port }))
}

// The DoH leg reaches the proxy as a raw SOCKS5 client, so the scheme's h-variant is moot
// (we always CONNECT to an IP literal). The proxy must be numeric local infrastructure:
// loopback or private/link-local/ULA - a public proxy would carry the leg off-box.

fn doh_proxy_addr() -> Result<std::net::SocketAddr, String> {
    let p = std::env::var("RJ_PROXY").map_err(|_| "no RJ_PROXY".to_string())?;
    let p = p.strip_prefix("socks5h://").or_else(|| p.strip_prefix("socks5://")).ok_or_else(|| "RJ_PROXY not socks5".to_string())?;
    if p.contains('@') || p.contains('/') && !p.ends_with('/') { return Err("RJ_PROXY bad auth".into()); }
    let a: std::net::SocketAddr = p.trim_end_matches('/').parse().map_err(|_| "RJ_PROXY bad addr".to_string())?;
    if !local_infra_ip(a.ip()) { return Err("RJ_PROXY not local".into()); }
    Ok(a)
}

// RFC1928 no-auth CONNECT; destination is ALWAYS an IP literal (ATYP 1/4) - the proxy
// never sees the queried name. Same wire contract as the live wisp sidecar's egress.
async fn doh_connect_dial(pxy: std::net::SocketAddr, ip: IpAddr, port: u16) -> Result<tokio::net::TcpStream, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(pxy).await.map_err(|e| format!("doh proxy: {e}"))?;
    s.write_all(&[5u8, 1, 0]).await.map_err(|e| e.to_string())?;
    let mut m = [0u8; 2];
    s.read_exact(&mut m).await.map_err(|e| e.to_string())?;
    if m != [5, 0] { return Err("doh proxy auth".into()); }
    let mut req = vec![5u8, 1, 0];
    match ip { IpAddr::V4(v) => { req.push(1); req.extend_from_slice(&v.octets()); } IpAddr::V6(v) => { req.push(4); req.extend_from_slice(&v.octets()); } }
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await.map_err(|e| e.to_string())?;
    let mut h = [0u8; 4];
    s.read_exact(&mut h).await.map_err(|e| e.to_string())?;
    if h[0] != 5 { return Err("doh proxy version".into()); }
    if h[1] != 0 { return Err(format!("doh proxy refuse rep={}", h[1])); }
    let skip = match h[3] { 1 => 4usize, 4 => 16, 3 => { let mut l = [0u8; 1]; s.read_exact(&mut l).await.map_err(|e| e.to_string())?; l[0] as usize }, _ => return Err("doh proxy atyp".into()) };
    let mut rest = vec![0u8; skip + 2];
    s.read_exact(&mut rest).await.map_err(|e| e.to_string())?;
    Ok(s)
}

async fn doh_exchange(cfg: &DohCfg, name: &str, qtype: &str) -> Result<Vec<IpAddr>, String> {
    if !crate::render_connect::doh_name_ok(name) || !matches!(qtype, "A" | "AAAA") { return Err("doh bad name".into()); }
    let pxy = doh_proxy_addr()?;
    let go = async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let tcp = doh_connect_dial(pxy, cfg.ip, cfg.port).await?;
        let sn = tokio_rustls::rustls::pki_types::ServerName::try_from(cfg.host.clone()).map_err(|_| "doh server name".to_string())?;
        let mut t = tokio_rustls::TlsConnector::from(doh_tls()).connect(sn, tcp).await.map_err(|e| format!("doh tls: {e}"))?;
        let req = format!("GET /dns-query?name={name}&type={qtype} HTTP/1.0\r\nHost: {}\r\nAccept: application/dns-json\r\n\r\n", cfg.host);
        t.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;
        let mut raw: Vec<u8> = Vec::new(); let mut b = [0u8; 4096];
        loop {
            let n = t.read(&mut b).await.map_err(|e| format!("doh read: {e}"))?;
            if n == 0 { break; }
            raw.extend_from_slice(&b[..n]);
            if raw.len() > 65536 + 8192 { return Err("doh too large".to_string()); }
        }
        crate::render_connect::parse_doh(crate::render_connect::split_doh_reply(&raw)?)
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), go).await.map_err(|_| "doh timeout".to_string())?
}


#[cfg(not(test))]
fn doh_tls() -> std::sync::Arc<tokio_rustls::rustls::ClientConfig> { crate::render_connect::doh_tls_config() }

#[cfg(test)]
fn doh_tls() -> std::sync::Arc<tokio_rustls::rustls::ClientConfig> {
    let mut roots = tokio_rustls::rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    roots.add(tokio_rustls::rustls::pki_types::CertificateDer::from(include_bytes!("doh_test_ca.der").to_vec())).expect("fixture ca");
    let prov = std::sync::Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
    let cfg = tokio_rustls::rustls::ClientConfig::builder_with_provider(prov).with_safe_default_protocol_versions().expect("tls versions")
        .with_root_certificates(roots).with_no_client_auth();
    std::sync::Arc::new(cfg)
}

#[cfg(test)] static TEST_DOH: std::sync::Mutex<Option<Result<Vec<IpAddr>, String>>> = std::sync::Mutex::new(None);
#[cfg(test)] static TEST_DOH_NAME: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub async fn resolve_host(host: &str) -> Result<Vec<IpAddr>, String> {
    let raw = host.trim_start_matches('[').trim_end_matches(']');
    let low = raw.to_lowercase();
    let name = low.strip_suffix('.').unwrap_or(&low).to_string();
    if raw.is_empty() || raw.len() > 253 { return Err("bad host".into()); }
    if let Ok(ip) = raw.parse::<IpAddr>() { return Ok(vec![ip]); }
    #[cfg(test)] { *TEST_DOH_NAME.lock().unwrap_or_else(|e| e.into_inner()) = Some(name.clone()); if let Some(r) = TEST_DOH.lock().unwrap_or_else(|e| e.into_inner()).clone() { return r; } }
    match doh_cfg() {
        Some(Ok(cfg)) => {
            let mut out = Vec::new();
            for ty in ["A", "AAAA"] { out.extend(doh_exchange(&cfg, &name, ty).await?); }
            if out.is_empty() { return Err("no address".into()); }
            Ok(out)
        }
        Some(Err(e)) => Err(e),
        None => {
            let list = tokio::net::lookup_host(format!("{raw}:0")).await.map_err(|_| "no address".to_string())?;
            let v: Vec<IpAddr> = list.map(|s| s.ip()).collect();
            if v.is_empty() { Err("no address".into()) } else { Ok(v) }
        }
    }
}

async fn pinned_get(st: &AppState, t: &url::Url, accept: &str) -> Result<reqwest::Response, String> {
    let host = t.host_str().ok_or("bad host")?;
    let _validated = pin(host).await?;                                                    
    let eg = st.egress()?;
    eg.get(t.as_str()).header("accept", accept).send().await.map_err(|e| {
                                                                                  
        if e.is_timeout() { "timed out".to_string() } else { "upstream error".to_string() }
    })
}

                                                                                
                                                                                   
pub async fn get_once(st: &AppState, url: &str, accept: &str) -> Result<reqwest::Response, String> {
    let t = check_url(url)?;
    pinned_get(st, &t, accept).await
}

                                                                                 
                                                                                 
                                                                                    
                                                                                      
pub async fn safe_get_stall(st: &AppState, url: &str, accept: &str, stall: std::time::Duration) -> Result<(reqwest::Response, url::Url), String> {
    let mut t = check_url(url)?;
    for i in 0..=5 {
        let r = match tokio::time::timeout(stall, pinned_get(st, &t, accept)).await {
            Err(_) => return Err("timed out".to_string()),
            Ok(r) => r?,
        };
        let status = r.status();
        if status.is_redirection() {
            if i == 5 { return Err("too many redirects".into()); }
            let loc = r.headers().get("location").and_then(|v| v.to_str().ok()).ok_or("redirect without location")?;
            t = check_url(t.join(loc).map_err(|_| "bad url")?.as_str())?;
            continue;
        }
        return Ok((r, t));
    }
    Err("too many redirects".into())
}

                                                                                 
                                                                                       
                                                                            
async fn pinned_get_t(st: &AppState, t: &url::Url, accept: &str) -> Result<reqwest::Response, SsrfErr> {
    let host = t.host_str().ok_or_else(|| SsrfErr::Msg("bad host".into()))?;
    let _validated = pin_t(host).await?;
    let eg = st.egress().map_err(SsrfErr::Msg)?;                                                          
    eg.get(t.as_str()).header("accept", accept).send().await.map_err(|e| {
                                                                                  
        if e.is_timeout() { SsrfErr::Msg("timed out".into()) } else { SsrfErr::Transport }
    })
}

pub async fn safe_get_stall_t(st: &AppState, url: &str, accept: &str, stall: std::time::Duration) -> Result<(reqwest::Response, url::Url), SsrfErr> {
    let mut t = check_url(url).map_err(SsrfErr::Msg)?;
    for i in 0..=5 {
        let r = match tokio::time::timeout(stall, pinned_get_t(st, &t, accept)).await {
            Err(_) => return Err(SsrfErr::Msg("timed out".into())),
            Ok(r) => r?,
        };
        let status = r.status();
        if status.is_redirection() {
            if i == 5 { return Err(SsrfErr::Msg("too many redirects".into())); }
            let loc = r.headers().get("location").and_then(|v| v.to_str().ok()).ok_or_else(|| SsrfErr::Msg("redirect without location".into()))?;
            t = check_url(t.join(loc).map_err(|_| SsrfErr::Msg("bad url".to_string()))?.as_str()).map_err(SsrfErr::Msg)?;
            continue;
        }
        return Ok((r, t));
    }
    Err(SsrfErr::Msg("too many redirects".into()))
}

pub async fn safe_get(st: &AppState, url: &str, accept: &str) -> Result<(reqwest::Response, url::Url), String> {
    let mut t = check_url(url)?;
    for i in 0..=5 {
        let r = pinned_get(st, &t, accept).await?;
        let status = r.status();
        if status.is_redirection() {
            if i == 5 { return Err("too many redirects".into()); }
            let loc = r.headers().get("location").and_then(|v| v.to_str().ok()).ok_or("redirect without location")?;
            t = check_url(t.join(loc).map_err(|_| "bad url")?.as_str())?;
            continue;
        }
        return Ok((r, t));
    }
    Err("too many redirects".into())
}


#[cfg(test)]
pub(crate) mod doh_tests {
    pub(crate) static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn clear() { for k in ["RJ_DOH_IP", "RJ_DOH_HOST", "RJ_DOH_PORT", "RJ_PROXY"] { std::env::remove_var(k); } *super::TEST_DOH.lock().unwrap_or_else(|e| e.into_inner()) = None; *super::TEST_DOH_NAME.lock().unwrap_or_else(|e| e.into_inner()) = None; }

    #[test]
    fn cfg_absent_is_none_and_invalid_fails_closed() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner()); clear();
        assert!(super::doh_cfg().is_none());
        std::env::set_var("RJ_DOH_IP", "127.0.0.1"); std::env::set_var("RJ_DOH_HOST", "dns.example");
        assert!(matches!(super::doh_cfg(), Some(Err(_))), "loopback DoH server must be refused, never fallback");
        std::env::set_var("RJ_DOH_IP", "9.9.9.9");
        assert!(matches!(super::doh_cfg(), Some(Ok(ref c)) if c.port == 443 && c.host == "dns.example" && c.ip == "9.9.9.9".parse::<std::net::IpAddr>().unwrap()));
        std::env::set_var("RJ_DOH_PORT", "0"); assert!(matches!(super::doh_cfg(), Some(Err(_))));
        std::env::set_var("RJ_DOH_PORT", "5053"); assert!(matches!(super::doh_cfg(), Some(Ok(ref c)) if c.port == 5053));
        std::env::set_var("RJ_DOH_HOST", "bad host!"); assert!(matches!(super::doh_cfg(), Some(Err(_))));
        clear();
    }

    #[test]
    fn proxy_addr_only_numeric_local_infrastructure_socks5() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner()); clear();
        std::env::set_var("RJ_PROXY", "socks5h://127.0.0.1:40000"); assert!(super::doh_proxy_addr().is_ok(), "loopback ok");
        std::env::set_var("RJ_PROXY", "socks5://172.25.0.1:40001"); assert!(super::doh_proxy_addr().is_ok(), "private bridge ok (production shape)");
        std::env::set_var("RJ_PROXY", "socks5h://10.0.0.1:1080"); assert!(super::doh_proxy_addr().is_ok(), "rfc1918 ok");
        std::env::set_var("RJ_PROXY", "socks5h://[::1]:40000"); assert!(super::doh_proxy_addr().is_ok(), "v6 loopback ok");
        for bad in ["socks5h://9.9.9.9:40000", "http://127.0.0.1:40000", "socks5h://proxy.local:40000", "socks5h://user:pass@127.0.0.1:40000", "socks4://127.0.0.1:40000"] {
            std::env::set_var("RJ_PROXY", bad); assert!(super::doh_proxy_addr().is_err(), "{bad} must be refused, fail closed");
        }
        clear();
    }

    #[tokio::test]
    async fn literal_short_circuits_and_name_is_canonicalized() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner()); clear();
        assert_eq!(super::resolve_host("1.2.3.4").await.unwrap(), vec!["1.2.3.4".parse::<std::net::IpAddr>().unwrap()]);
        *super::TEST_DOH.lock().unwrap_or_else(|e| e.into_inner()) = Some(Ok(vec!["93.184.216.34".parse().unwrap()]));
        let v = super::resolve_host("Example.COM.").await.unwrap();
        assert_eq!(v, vec!["93.184.216.34".parse::<std::net::IpAddr>().unwrap()]);
        assert_eq!(super::TEST_DOH_NAME.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap(), "example.com", "lowercased, trailing dot stripped before query");
        clear();
    }

    #[tokio::test]
    async fn doh_configured_fails_closed_without_proxy_no_system_fallback() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner()); clear();
        std::env::set_var("RJ_DOH_IP", "9.9.9.9"); std::env::set_var("RJ_DOH_HOST", "dns.quad9.net");
        let r = super::resolve_host("example.com").await;
        assert!(r.is_err(), "configured DoH with no RJ_PROXY must fail closed, never use system DNS");
        clear();
    }

    #[tokio::test]
    async fn bad_host_rejected_before_any_transport() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner()); clear();
        assert!(super::resolve_host("").await.is_err());
        assert!(super::resolve_host(&"a".repeat(254)).await.is_err());
        clear();
    }

    async fn read_head<S>(s: &mut S) -> String where S: tokio::io::AsyncRead + Unpin {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new(); let mut b = [0u8; 1024];
        loop {
            let n = s.read(&mut b).await.unwrap();
            assert!(n > 0, "closed before head");
            buf.extend_from_slice(&b[..n]);
            assert!(buf.len() <= 8192, "head over cap");
            if buf.windows(4).position(|w| w == b"\r\n\r\n").is_some() { break; }
        }
        String::from_utf8(buf).unwrap()
    }

    fn fixture_acceptor() -> tokio_rustls::TlsAcceptor {
        use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
        let certs = vec![CertificateDer::from(include_bytes!("doh_test_leaf.der").to_vec())];
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(include_bytes!("doh_test_leaf_key.der").to_vec()));
        let prov = std::sync::Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
        let cfg = tokio_rustls::rustls::ServerConfig::builder_with_provider(prov).with_safe_default_protocol_versions().unwrap()
            .with_no_client_auth().with_single_cert(certs, key).unwrap();
        tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(cfg))
    }

    // Fixture-side RFC1928 server: asserts the client CONNECTs the exact IP literal 9.9.9.9:443
    // (ATYP 1, never a hostname), then grants. drip dribbles every reply byte.
    async fn socks5_handshake(s: &mut tokio::net::TcpStream, drip: bool) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut g = [0u8; 3];
        s.read_exact(&mut g).await.unwrap();
        assert_eq!(g, [5, 1, 0], "greeting");
        let grant = [5u8, 0];
        if drip { for b in grant { s.write_all(&[b]).await.unwrap(); tokio::time::sleep(std::time::Duration::from_millis(2)).await; } } else { s.write_all(&grant).await.unwrap(); }
        let mut h = [0u8; 4];
        s.read_exact(&mut h).await.unwrap();
        assert_eq!(h, [5, 1, 0, 1], "CONNECT ipv4 request head");
        let mut addr = [0u8; 6];
        s.read_exact(&mut addr).await.unwrap();
        assert_eq!(addr, [9, 9, 9, 9, 0x01, 0xBB], "target must be IP literal 9.9.9.9:443, never a name");
        let reply = [5u8, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        if drip { for b in reply { s.write_all(&[b]).await.unwrap(); tokio::time::sleep(std::time::Duration::from_millis(2)).await; } } else { s.write_all(&reply).await.unwrap(); }
    }

    async fn tls_doh_fixture(pxy: std::net::SocketAddr, a_data: &str) -> tokio::task::JoinHandle<()> { tls_doh_fixture_drip(pxy, a_data, false).await }

    async fn tls_doh_fixture_drip(pxy: std::net::SocketAddr, a_data: &str, drip: bool) -> tokio::task::JoinHandle<()> {
        let a_data = a_data.to_string();
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind(pxy).await.unwrap();
        tokio::spawn(async move {
            let acceptor = fixture_acceptor();
            for ty in ["A", "AAAA"] {
                let (mut s, _) = listener.accept().await.unwrap();
                socks5_handshake(&mut s, drip).await;
                let mut t = acceptor.accept(s).await.unwrap();
                let req = read_head(&mut t).await;
                assert!(req.starts_with(&format!("GET /dns-query?name=example.com&type={ty} HTTP/1.0\r\n")), "{req}");
                assert!(req.contains("Host: dns.test\r\n"), "{req}");
                let body = if ty == "A" { format!(r#"{{"Status":0,"Answer":[{{"name":"example.com","type":1,"TTL":60,"data":"{a_data}"}}]}}"#) } else { r#"{"Status":0}"#.to_string() };
                t.write_all(format!("HTTP/1.0 200 OK\r\nContent-Type: application/dns-json\r\n\r\n{body}").as_bytes()).await.unwrap();
                let _ = t.shutdown().await;
            }
        })
    }

    #[tokio::test]
    async fn doh_exchange_success_over_connect_tunnel() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner()); clear();
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pxy = probe.local_addr().unwrap(); drop(probe);
        std::env::set_var("RJ_PROXY", format!("socks5h://{pxy}"));
        std::env::set_var("RJ_DOH_IP", "9.9.9.9"); std::env::set_var("RJ_DOH_HOST", "dns.test");
        let server = tls_doh_fixture(pxy, "93.184.216.34").await;
        let v = super::resolve_host("Example.COM.").await.unwrap();
        assert_eq!(v, vec!["93.184.216.34".parse::<std::net::IpAddr>().unwrap()]);
        assert_eq!(super::TEST_DOH_NAME.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap(), "example.com");
        server.await.unwrap();
        clear();
    }

    #[tokio::test]
    async fn doh_answer_still_screened_by_caller_policy() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner()); clear();
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pxy = probe.local_addr().unwrap(); drop(probe);
        std::env::set_var("RJ_PROXY", format!("socks5h://{pxy}"));
        std::env::set_var("RJ_DOH_IP", "9.9.9.9"); std::env::set_var("RJ_DOH_HOST", "dns.test");
        let server = tls_doh_fixture(pxy, "127.0.0.1").await;
        let r = super::safe_lookup("example.com").await;
        assert!(r.is_err(), "blocked DoH answer must still be refused by caller screening");
        server.await.unwrap();
        clear();
    }

    async fn raw_proxy_fixture(script: u8) -> std::net::SocketAddr {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pxy = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut g = [0u8; 3];
            match script {
                0 => { let _ = s.read_exact(&mut g).await; let _ = s.write_all(&[5u8, 255]).await; } // no acceptable auth method
                5 => { let _ = s.read_exact(&mut g).await; let _ = s.write_all(&[4u8, 0]).await; }   // wrong version
                1 => { }                                                                            // immediate close
                4 => {                                                                              // CONNECT refused rep=5
                    let _ = s.read_exact(&mut g).await; let _ = s.write_all(&[5u8, 0]).await;
                    let mut rq = [0u8; 10]; let _ = s.read_exact(&mut rq).await;
                    let _ = s.write_all(&[5u8, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                }
                2 => { socks5_handshake(&mut s, false).await; let _ = s.write_all(b"definitely not a tls handshake").await; }
                _ => { socks5_handshake(&mut s, false).await; tokio::time::sleep(std::time::Duration::from_secs(8)).await; } // stall after grant
            }
        });
        pxy
    }

    #[tokio::test]
    async fn doh_exchange_failure_fixtures_fail_closed() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        for script in [0u8, 1, 2, 3, 4, 5] {
            clear();
            let pxy = raw_proxy_fixture(script).await;
            std::env::set_var("RJ_PROXY", format!("socks5h://{pxy}"));
            std::env::set_var("RJ_DOH_IP", "9.9.9.9"); std::env::set_var("RJ_DOH_HOST", "dns.test");
            let r = super::resolve_host("example.com").await;
            assert!(r.is_err(), "script {script} must fail closed");
        }
        clear();
        // connection refused: proxy port with no listener
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead = probe.local_addr().unwrap(); drop(probe);
        std::env::set_var("RJ_PROXY", format!("socks5h://{dead}"));
        std::env::set_var("RJ_DOH_IP", "9.9.9.9"); std::env::set_var("RJ_DOH_HOST", "dns.test");
        assert!(super::resolve_host("example.com").await.is_err(), "refused proxy must fail closed");
        clear();
    }

    #[tokio::test]
    async fn doh_exchange_dribbled_connect_head_tolerated() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner()); clear();
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pxy = probe.local_addr().unwrap(); drop(probe);
        std::env::set_var("RJ_PROXY", format!("socks5h://{pxy}"));
        std::env::set_var("RJ_DOH_IP", "9.9.9.9"); std::env::set_var("RJ_DOH_HOST", "dns.test");
        let server = tls_doh_fixture_drip(pxy, "93.184.216.34", true).await;
        let v = super::resolve_host("example.com").await.unwrap();
        assert_eq!(v, vec!["93.184.216.34".parse::<std::net::IpAddr>().unwrap()]);
        server.await.unwrap();
        clear();
    }

    pub(crate) fn inject(r: Option<Result<Vec<std::net::IpAddr>, String>>) { *super::TEST_DOH.lock().unwrap_or_else(|e| e.into_inner()) = r; }

    // Per-exchange scripted fixture: each exchange serves data, serves NOERROR-empty,
    // serves after a delay, or stalls past the 5s exchange timeout.
    pub(crate) enum Exch { Serve(String), Empty, Delay(u64, String), Stall }
    pub(crate) async fn tls_doh_fixture_scripted(pxy: std::net::SocketAddr, a: Exch, aaaa: Exch) -> tokio::task::JoinHandle<()> {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind(pxy).await.unwrap();
        tokio::spawn(async move {
            let acceptor = fixture_acceptor();
            for (ty, ex) in [("A", a), ("AAAA", aaaa)] {
                let (mut s, _) = listener.accept().await.unwrap();
                socks5_handshake(&mut s, false).await;
                let mut t = acceptor.accept(s).await.unwrap();
                let req = read_head(&mut t).await;
                assert!(req.starts_with(&format!("GET /dns-query?name=example.com&type={ty} HTTP/1.0\r\n")), "{req}");
                let rty = if ty == "A" { 1 } else { 28 };
                let body = match ex {
                    Exch::Serve(d) => format!(r#"{{"Status":0,"Answer":[{{"name":"example.com","type":{rty},"TTL":60,"data":"{d}"}}]}}"#),
                    Exch::Empty => r#"{"Status":0}"#.to_string(),
                    Exch::Delay(secs, d) => { tokio::time::sleep(std::time::Duration::from_secs(secs)).await; format!(r#"{{"Status":0,"Answer":[{{"name":"example.com","type":{rty},"TTL":60,"data":"{d}"}}]}}"#) }
                    Exch::Stall => { tokio::time::sleep(std::time::Duration::from_secs(6)).await; continue; }
                };
                t.write_all(format!("HTTP/1.0 200 OK\r\nContent-Type: application/dns-json\r\n\r\n{body}").as_bytes()).await.unwrap();
                let _ = t.shutdown().await;
            }
        })
    }

    #[tokio::test]
    async fn doh_both_exchanges_empty_is_no_address() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner()); clear();
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pxy = probe.local_addr().unwrap(); drop(probe);
        std::env::set_var("RJ_PROXY", format!("socks5h://{pxy}"));
        std::env::set_var("RJ_DOH_IP", "9.9.9.9"); std::env::set_var("RJ_DOH_HOST", "dns.test");
        let server = tls_doh_fixture_scripted(pxy, Exch::Empty, Exch::Empty).await;
        let r = super::resolve_host("example.com").await;
        assert_eq!(r.unwrap_err(), "no address", "NOERROR-empty on both exchanges is a lookup failure");
        server.await.unwrap();
        clear();
    }

    #[tokio::test]
    async fn doh_second_exchange_timeout_fails_closed_within_own_budget() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner()); clear();
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pxy = probe.local_addr().unwrap(); drop(probe);
        std::env::set_var("RJ_PROXY", format!("socks5h://{pxy}"));
        std::env::set_var("RJ_DOH_IP", "9.9.9.9"); std::env::set_var("RJ_DOH_HOST", "dns.test");
        let server = tls_doh_fixture_scripted(pxy, Exch::Serve("93.184.216.34".into()), Exch::Stall).await;
        let t0 = std::time::Instant::now();
        let r = super::resolve_host("example.com").await;
        let el = t0.elapsed();
        assert!(r.is_err(), "stalled second exchange must fail the whole lookup, never return the partial A answer");
        assert!(el >= std::time::Duration::from_secs(4) && el < std::time::Duration::from_secs(7), "second exchange has its own 5s budget, took {el:?}");
        server.abort();
        clear();
    }

    #[tokio::test]
    async fn pin_and_pin_t_preserve_result_shapes_over_doh() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner()); clear();
        inject(Some(Ok(vec!["93.184.216.34".parse().unwrap()])));
        assert_eq!(super::pin("example.com").await.unwrap(), "93.184.216.34".parse::<std::net::IpAddr>().unwrap());
        assert_eq!(super::pin_t("example.com").await.unwrap(), "93.184.216.34".parse::<std::net::IpAddr>().unwrap());
        inject(Some(Ok(vec!["10.0.0.1".parse().unwrap()])));
        assert!(super::pin("example.com").await.is_err(), "blocked DoH answer refused by pin screening");
        assert!(matches!(super::pin_t("example.com").await, Err(super::SsrfErr::Msg(_))), "blocked answer stays a policy refusal");
        inject(Some(Err("doh timeout".to_string())));
        assert!(super::pin("example.com").await.is_err(), "resolver failure propagates, no fallback");
        assert!(matches!(super::pin_t("example.com").await, Err(super::SsrfErr::Transport)), "resolver failure maps to Transport");
        clear();
    }
}
#[cfg(test)]mod compatible_v6_test{#[test]fn blocks_compatible(){for a in ["::127.0.0.1","::10.0.0.1","::192.168.1.1"]{assert!(super::blocked_ip(a.parse().unwrap()));}}}
#[cfg(test)]mod gap_ranges_test{#[test]fn blocks_doc_and_relay_ranges(){for a in ["192.0.0.1","192.0.2.1","192.88.99.1","198.18.0.1","198.19.255.1","198.51.100.1","203.0.113.1"]{assert!(super::blocked_ip(a.parse().unwrap()),"{a}");} for ok in ["192.0.3.1","192.88.100.1","198.20.0.1","203.0.114.1"]{assert!(!super::blocked_ip(ok.parse().unwrap()),"{ok}");}}}

// SEARXNG_URL is fetched through local_http, a client built with .no_proxy() - it never
// crosses RJ_PROXY. The upstream must therefore be local infrastructure, decided on the
// RESOLVED addresses (never lexically, so a dotless name expanded through DNS search
// domains cannot slip past). Loopback, RFC1918, link-local and ULA only; anything else -
// including NAT64-synthesised or v4-mapped publics, which blocked_ip alone would wave
// through here - is a silent direct-egress path and refuses boot.
fn local_infra_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => { let o = v.octets(); o[0] == 127 || o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 192 && o[1] == 168) || (o[0] == 169 && o[1] == 254) }
        IpAddr::V6(v) => v.is_loopback() || (v.segments()[0] & 0xfe00) == 0xfc00 || (v.segments()[0] & 0xffc0) == 0xfe80,
    }
}

pub fn searx_host_ok(ips: &[IpAddr]) -> Result<(), String> {
    if ips.is_empty() { return Err("SEARXNG_URL host resolves to no addresses".into()); }
    if ips.iter().any(|ip| !local_infra_ip(*ip)) { return Err("SEARXNG_URL resolves to a non-local address - direct unproxied fetch would bypass RJ_PROXY".into()); }
    Ok(())
}

// A validated searx endpoint: the host as written in SEARXNG_URL (kept for the HTTP
// Host header and TLS identity) plus every validated address with the URL's port.
// The pin is installed on the searx client via a DNS override, so request-time
// connections dial THESE addresses - DNS is never consulted again for the host.
pub struct SearxPin { pub host: String, pub addrs: Vec<std::net::SocketAddr> }

// Explicit refresh semantics: the pin is fixed at boot and never re-resolved at
// runtime. If the upstream later moves to a different address (container restart),
// connects fail and the existing sx_fetch failure path reports searx down until
// ramjetd restarts - deliberate fail-closed behavior, no silent DNS fallback.
pub async fn guard_searx_url(raw: &str) -> Result<SearxPin, String> {
    let t = url::Url::parse(raw.trim()).map_err(|_| "SEARXNG_URL is not a URL".to_string())?;
    if t.scheme() != "http" && t.scheme() != "https" { return Err("SEARXNG_URL scheme must be http or https".into()); }
    let host = t.host_str().ok_or("SEARXNG_URL has no host")?.trim_start_matches('[').trim_end_matches(']').to_string();
    if host.is_empty() || host.len() > 253 { return Err("SEARXNG_URL bad host".into()); }
    let port = t.port().unwrap_or(if t.scheme() == "https" { 443 } else { 80 });
    let ips: Vec<IpAddr> = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![ip]
    } else {
        tokio::net::lookup_host(format!("{host}:0")).await.map_err(|_| "SEARXNG_URL host does not resolve".to_string())?.map(|s| s.ip()).collect()
    };
    searx_host_ok(&ips)?;
    Ok(SearxPin { host, addrs: ips.into_iter().map(|ip| std::net::SocketAddr::new(ip, port)).collect() })
}

#[cfg(test)]mod searx_guard_tests{
    #[test]fn infra_ip_table(){
        for ok in ["127.0.0.1","10.0.0.5","172.16.0.1","172.31.255.1","192.168.1.1","169.254.1.1","::1","fd00::1","fe80::1"]{assert!(super::local_infra_ip(ok.parse().unwrap()),"{ok}");}
        for no in ["8.8.8.8","1.1.1.1","172.32.0.1","192.167.0.1","100.64.0.1","198.51.100.1","203.0.113.1","169.255.0.1","2606:4700:4700::1111","64:ff9b::808:808","::ffff:8.8.8.8"]{assert!(!super::local_infra_ip(no.parse().unwrap()),"{no}");}
    }
    #[test]fn host_ok_set_rules(){
        assert!(super::searx_host_ok(&["127.0.0.1".parse().unwrap()]).is_ok());
        assert!(super::searx_host_ok(&["10.1.1.1".parse().unwrap(),"::1".parse().unwrap()]).is_ok());
        assert!(super::searx_host_ok(&[]).is_err());
        assert!(super::searx_host_ok(&["8.8.8.8".parse().unwrap()]).is_err());
        assert!(super::searx_host_ok(&["127.0.0.1".parse().unwrap(),"8.8.8.8".parse().unwrap()]).is_err());
    }
    #[tokio::test]async fn guard_url_offline_cases(){
        assert!(super::guard_searx_url("http://127.0.0.1:8888").await.is_ok());
        assert!(super::guard_searx_url("http://[::1]:8888").await.is_ok());
        assert!(super::guard_searx_url("http://localhost:8888").await.is_ok());
        assert!(super::guard_searx_url("http://127.0.0.1:8888/").await.is_ok());
        assert!(super::guard_searx_url("http://8.8.8.8:8888").await.is_err());
        assert!(super::guard_searx_url("ftp://127.0.0.1").await.is_err());
        assert!(super::guard_searx_url("not a url").await.is_err());
    }
    #[tokio::test]async fn guard_returns_usable_pin(){
        let p = super::guard_searx_url("http://127.0.0.1:8888").await.unwrap();
        assert_eq!(p.host, "127.0.0.1");
        assert_eq!(p.addrs, vec![std::net::SocketAddr::new("127.0.0.1".parse().unwrap(), 8888)]);
        let p = super::guard_searx_url("http://[::1]").await.unwrap();
        assert_eq!(p.addrs, vec![std::net::SocketAddr::new("::1".parse().unwrap(), 80)]);
        let p = super::guard_searx_url("https://127.0.0.1").await.unwrap();
        assert_eq!(p.addrs, vec![std::net::SocketAddr::new("127.0.0.1".parse().unwrap(), 443)]);
        let p = super::guard_searx_url("http://localhost:8888").await.unwrap();
        assert_eq!(p.host, "localhost");
        assert!(p.addrs.iter().all(|a| super::local_infra_ip(a.ip()) && a.port() == 8888));
        assert!(!p.addrs.is_empty());
    }
}
