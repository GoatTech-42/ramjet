                                                                                                                          
                                                                                                                                                         
                                                                                                                                                      
  
                                                                                
                                                                                                                        
                                                                 
                                         
                                                                                                                       
                                                                                                                                                                        
                                                                                                                                             
                                                             
                                                                                                              
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Clone, Debug)]
pub struct RenderConfig {
    pub cmd: String, pub chrome: String, pub ffmpeg: String,
    pub listen: SocketAddr, pub proxy_url: String,
    pub socks: String, pub doh_ip: IpAddr, pub doh_host: String, pub doh_port: u16,
}

static CURRENT: OnceLock<RenderConfig> = OnceLock::new();
                                                                                                    
pub fn current() -> Option<&'static RenderConfig> { CURRENT.get() }
pub fn install(c: RenderConfig) -> bool { CURRENT.set(c).is_ok() }

impl RenderConfig {
    pub fn connect_config(&self) -> crate::render_connect::Config {
        crate::render_connect::Config { socks: self.socks.clone(), doh_ip: self.doh_ip, doh_host: self.doh_host.clone(), doh_port: self.doh_port }
    }
}

const MAX_BYTES: u64 = 8192;
const KEYS: [&str; 9] = ["cmd", "chrome", "ffmpeg", "listen", "proxy_url", "socks", "doh_ip", "doh_host", "doh_port"];

fn abs_file(v: &serde_json::Value) -> Option<String> {
    let s = v.as_str()?;
    let p = Path::new(s);
    if !p.is_absolute() || s.len() > 512 || s.bytes().any(|b| b < 0x20 || b == 0x7f) || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) { return None; }
    let m = std::fs::metadata(p).ok()?;                                                                                            
    if !m.is_file() { return None; }
    Some(s.to_string())
}

fn ip_port(s: &str) -> Option<SocketAddr> { let a: SocketAddr = s.parse().ok()?; if a.port() == 0 { None } else { Some(a) } }

fn internal_only(ip: IpAddr) -> bool {
                                                                       
    !ip.is_unspecified() && !ip.is_multicast() && match ip {
        IpAddr::V4(a) => a.is_loopback() || a.is_private() || a.is_link_local(),
        IpAddr::V6(a) => a.is_loopback() || (a.segments()[0] & 0xfe00) == 0xfc00 || (a.segments()[0] & 0xffc0) == 0xfe80,
    }
}

                                                                                   
pub fn parse(text: &str) -> Option<RenderConfig> {
    if text.len() as u64 > MAX_BYTES { return None; }
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let o = v.as_object()?;
    if o.keys().any(|k| !KEYS.contains(&k.as_str())) { return None; }
    let listen = ip_port(o.get("listen")?.as_str()?)?;
    if !internal_only(listen.ip()) { return None; }
    let proxy_url = o.get("proxy_url")?.as_str()?.to_string();
    let pa = ip_port(proxy_url.strip_prefix("http://")?)?;                                                   
                                                                                                                                                                   
    if proxy_url.len() > 64 || !internal_only(pa.ip()) || pa != listen { return None; }
    let socks = o.get("socks")?.as_str()?; ip_port(socks)?;
    let doh_ip: IpAddr = o.get("doh_ip")?.as_str()?.parse().ok()?;
    if crate::render_connect::blocked_ip(doh_ip) { return None; }
    let doh_host = o.get("doh_host")?.as_str()?.to_string();
    if doh_host.is_empty() || doh_host.len() > 253 || !doh_host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') { return None; }
    let doh_port = match o.get("doh_port") { None => 443, Some(p) => u16::try_from(p.as_u64()?).ok().filter(|p| *p > 0)? };
    Some(RenderConfig { cmd: abs_file(o.get("cmd")?)?, chrome: abs_file(o.get("chrome")?)?, ffmpeg: abs_file(o.get("ffmpeg")?)?, listen, proxy_url, socks: socks.to_string(), doh_ip, doh_host, doh_port })
}

                                                                                                                                                                                     
pub fn load(data_dir: &Path) -> Option<RenderConfig> {
    use std::os::unix::fs::MetadataExt;
    let p = data_dir.join("render.json");
    let m = p.symlink_metadata().ok()?;
    if !m.is_file() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 || m.len() > MAX_BYTES { return None; }
    parse(&std::fs::read_to_string(&p).ok()?)
}

                                                                                                                                               
                                                                                                                                                 
                                                                                                                                                       
                                                                                                    
pub fn clean_contents(root: &Path) -> usize {
    let Ok(m) = root.symlink_metadata() else { return 0 };
    if !m.is_dir() { return 0 }                                                                                     
    let Ok(rd) = root.read_dir() else { return 0 };
    let mut n = 0;
    for e in rd.flatten() {
        let p: PathBuf = e.path();
        let Ok(t) = e.file_type() else { continue };
        let ok = if t.is_dir() { std::fs::remove_dir_all(&p).is_ok() } else { std::fs::remove_file(&p).is_ok() };
        if ok { n += 1; }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    fn tmp(tag: &str) -> PathBuf {
        static C: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!("rcfg-{}-{}-{tag}", std::process::id(), C.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&d); std::fs::create_dir_all(&d).unwrap(); d
    }
    fn good() -> String {
        r#"{"cmd":"/bin/sh","chrome":"/bin/sh","ffmpeg":"/bin/sh","listen":"127.0.0.1:18080","proxy_url":"http://127.0.0.1:18080","socks":"127.0.0.1:1080","doh_ip":"93.184.216.34","doh_host":"doh.example"}"#.to_string()
    }
    #[test]
    fn parse_accepts_good_and_refuses_each_bad_field() {
        assert!(parse(&good()).is_some());
        let bad = [
            good().replace(r#""cmd":"/bin/sh""#, r#""cmd":"sh""#),                                  
            good().replace(r#""cmd":"/bin/sh""#, r#""cmd":"/bin/../bin/sh""#),                     
            good().replace(r#""cmd":"/bin/sh""#, r#""cmd":"/nonexistent/worker""#),                    
            good().replace(r#""cmd":"/bin/sh""#, r#""cmd":"/tmp""#),                                 
            good().replace("127.0.0.1:18080\",\"proxy", "0.0.0.0:18080\",\"proxy"),                       
            good().replace("\"listen\":\"127.0.0.1:18080\"", "\"listen\":\"8.8.8.8:18080\""),                 
            good().replace("\"listen\":\"127.0.0.1:18080\"", "\"listen\":\"127.0.0.1:0\""),            
            good().replace("http://127.0.0.1:18080", "http://127.0.0.1:18080/"),                
            good().replace("http://127.0.0.1:18080", "http://u:p@127.0.0.1:18080"),                 
            good().replace("http://127.0.0.1:18080", "http://localhost:18080"),                              
            good().replace("http://127.0.0.1:18080", "http://8.8.8.8:18080"),                          
            good().replace("http://127.0.0.1:18080", "http://[2606:4700::1111]:18080"),                   
            good().replace("http://127.0.0.1:18080", "http://127.0.0.1:18081"),                                    
            good().replace("http://127.0.0.1:18080", "http://10.0.0.5:18080"),                                          
            good().replace("http://127.0.0.1:18080", "http://0.0.0.0:18080"),                      
            good().replace("93.184.216.34", "10.0.0.1"),                                                   
            good().replace("doh.example", "doh.example/x"),                                          
            good().replace("}", r#","doh_port":0}"#),                                               
            good().replace("}", r#","no_sandbox":true}"#),                                                                          
            good().replace("}", r#","extra":1}"#),
            "[]".to_string(), "not json".to_string(), "{}".to_string(),
        ];
        for (i, b) in bad.iter().enumerate() { assert!(parse(b).is_none(), "case {i}: {b}"); }
        let internal = good().replace("127.0.0.1:18080", "10.0.0.5:18080"); assert!(parse(&internal).is_some(), "internal listen with equal proxy_url");
        assert!(parse(&good().replace("}", r#","doh_port":8443}"#)).unwrap().doh_port == 8443);
        assert!(parse(&format!("{}{}", good(), " ".repeat(9000))).is_none(), "oversize");
    }
    #[test]
    fn load_requires_private_regular_owned_file() {
        let d = tmp("load");
        assert!(load(&d).is_none(), "missing");
        let p = d.join("render.json"); std::fs::write(&p, good()).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap(); assert!(load(&d).is_none(), "group/other readable");
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap(); assert!(load(&d).is_some());
        std::fs::remove_file(&p).unwrap(); let real = d.join("real.json"); std::fs::write(&real, good()).unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap(); symlink(&real, &p).unwrap(); assert!(load(&d).is_none(), "symlinked render.json refused");
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn clean_contents_keeps_root_and_never_touches_outside() {
        let d = tmp("clean"); let outside = tmp("outside"); let secret = outside.join("keep.txt"); std::fs::write(&secret, "x").unwrap();
        let root = d.join("render"); std::fs::create_dir_all(root.join("sess/sub")).unwrap();
        std::fs::write(root.join("sess/sub/seg_00001.m4s"), "a").unwrap(); std::fs::write(root.join("f.txt"), "b").unwrap();
        symlink(&outside, root.join("linkdir")).unwrap(); symlink(&secret, root.join("linkfile")).unwrap(); symlink(&outside, root.join("sess/sub/deep")).unwrap();
        let ino = root.metadata().unwrap().ino();
        let n = clean_contents(&root);
        assert!(n >= 4, "removed {n}");
        assert!(root.is_dir() && root.metadata().unwrap().ino() == ino, "root kept, same inode (bind root not orphaned)");
        assert_eq!(root.read_dir().unwrap().count(), 0);
        assert!(secret.exists() && outside.join("keep.txt").exists(), "symlink targets outside root survive (links unlinked, never followed)");
                                          
        let victim = tmp("victim"); std::fs::write(victim.join("v.txt"), "v").unwrap(); let lr = d.join("lroot"); symlink(&victim, &lr).unwrap();
        assert_eq!(clean_contents(&lr), 0); assert!(victim.join("v.txt").exists());
        assert_eq!(clean_contents(&d.join("nope")), 0);
        for x in [&d, &outside, &victim] { let _ = std::fs::remove_dir_all(x); }
    }
}
