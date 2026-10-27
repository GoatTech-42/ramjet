                                                                               
                                                                                      
                                                                                     
                                                                         
                                                                                    
                                                                                        
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
    let list = tokio::net::lookup_host(format!("{}:0", host)).await.map_err(|_| "no address".to_string())?;
    let addr = list.map(|s| s.ip()).find(|a| a.is_ipv4()).ok_or("no address".to_string())?;                          
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
    let list = tokio::net::lookup_host(format!("{}:0", host)).await.map_err(|_| "no address".to_string())?;
    let addrs: Vec<IpAddr> = list.map(|s| s.ip()).collect();
    if addrs.is_empty() { return Err("no address".into()); }
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
    let list = tokio::net::lookup_host(format!("{}:0", host)).await.map_err(|_| SsrfErr::Transport)?;
    let addrs: Vec<IpAddr> = list.map(|s| s.ip()).collect();
    if addrs.is_empty() { return Err(SsrfErr::Msg("no address".into())); }
    if addrs.iter().any(|a| blocked_ip(*a)) { return Err(SsrfErr::Msg("blocked address".into())); }
    Ok(addrs.iter().find(|a| a.is_ipv4()).copied().unwrap_or(addrs[0]))
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

#[cfg(test)]mod compatible_v6_test{#[test]fn blocks_compatible(){for a in ["::127.0.0.1","::10.0.0.1","::192.168.1.1"]{assert!(super::blocked_ip(a.parse().unwrap()));}}}
#[cfg(test)]mod gap_ranges_test{#[test]fn blocks_doc_and_relay_ranges(){for a in ["192.0.0.1","192.0.2.1","192.88.99.1","198.18.0.1","198.19.255.1","198.51.100.1","203.0.113.1"]{assert!(super::blocked_ip(a.parse().unwrap()),"{a}");} for ok in ["192.0.3.1","192.88.100.1","198.20.0.1","203.0.114.1"]{assert!(!super::blocked_ip(ok.parse().unwrap()),"{ok}");}}}
