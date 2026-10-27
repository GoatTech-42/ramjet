                                                                                       
                                                                                       
                                            
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Boot(Child);
impl Drop for Boot { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }

fn http(port: u16, method: &str, path: &str, extra: &str) -> (u16, String, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write!(s, "{method} {path} HTTP/1.1\r\nhost: x\r\nconnection: close\r\n{extra}\r\n").unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    let t = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = t.split_once("\r\n\r\n").unwrap_or((&t, ""));
    let code = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    (code, head.to_ascii_lowercase(), body.to_string())
}

fn post(port: u16, cookie: &str, csrf: bool, payload: &str) -> (u16, String, String) {
    let mut extra = String::new();
    if !cookie.is_empty() { extra.push_str(&format!("cookie: rj2_session={cookie}\r\n")); }
    if csrf { extra.push_str("x-ramjet-js: 1\r\n"); }
    extra.push_str(&format!("content-length: {}\r\n\r\n{payload}", payload.len()));
    http(port, "POST", "/api/pfetch", &extra)
}

#[test]
fn pfetch_gates() {
    let dir = std::env::temp_dir().join(format!("pfetch-gate-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("dist")).unwrap();
    let data = dir.join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(data.join("adblock-hosts.txt"), "ads.fixture\n").unwrap();
    let db = dir.join("auth.db");
    std::fs::write(&db, b"").unwrap();
    std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o600)).unwrap();
                                                                  
    let auth = ramjetd::auth_api::store::AuthStore::open(&db).unwrap();
    auth.claim("pfuser", "fixture pass", false).unwrap();
    let id = match auth.login("pfuser", "fixture pass").unwrap() { ramjetd::auth_api::store::Login::Ok(id) => id, _ => panic!("login failed") };
    let token = auth.issue(&id).unwrap();
    drop(auth);
    let port = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
    let child = Command::new(env!("CARGO_BIN_EXE_ramjetd"))
        .env("RJ_DATA", &data).env("RJ_AUTH_DB", &db).env("RJ_DIST", dir.join("dist"))
        .env("RJ_HOST", "127.0.0.1").env("RJ_PORT", port.to_string()).env_remove("RJ_PROXY")
        .stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let _boot = Boot(child);
    let t = Instant::now();
    while TcpStream::connect(("127.0.0.1", port)).is_err() { assert!(t.elapsed() < Duration::from_secs(15), "ramjetd did not boot"); std::thread::sleep(Duration::from_millis(100)); }

                                                                                                 
    let (code, head, body) = post(port, "", false, "{}");
    assert_eq!(code, 401);
    assert!(head.contains("x-rj-error: signin"), "{head}");
    assert!(head.contains("cache-control: no-store") && !head.contains("application/json"), "{head}");
    assert!(body.is_empty());
                                                                                       
    let (code, _, _) = post(port, "deadbeef", false, "{}");
    assert_eq!(code, 401);
                                                                                
    let (code, _, body) = post(port, &token, false, "{}");
    assert_eq!((code, body.as_str()), (403, "{\"ok\":false,\"error\":\"forbidden\"}"));
                                    
    let (code, head, _) = post(port, &token, true, "{");
    assert_eq!((code, head.contains("x-rj-error: bad")), (400, true), "{head}");
    let (code, head, _) = post(port, &token, true, "{}");
    assert_eq!((code, head.contains("x-rj-error: url")), (400, true));
    let (code, head, _) = post(port, &token, true, "{\"url\":\"ftp://x/\"}");
    assert_eq!((code, head.contains("x-rj-error: proto")), (400, true));
    let (code, head, _) = post(port, &token, true, "{\"url\":\"http://user:pw@example.com/\"}");
    assert_eq!((code, head.contains("x-rj-error: url")), (400, true));
    let (code, head, _) = post(port, &token, true, "{\"url\":\"http://127.0.0.1:9/\"}");
    assert_eq!(code, 403, "{head}");
    assert!(head.contains("x-rj-error: blocked address"), "{head}");
    let (code, head, _) = post(port, &token, true, "{\"url\":\"http://[::1]/\"}");
    assert_eq!(code, 403, "{head}");                                  
                                                                                       
    let (code, head, _) = post(port, &token, true, "{\"url\":\"http://ads.fixture/\"}");
    assert_eq!((code, head.contains("x-rj-error: adblock")), (502, true), "{head}");
    let (code, head, _) = post(port, &token, true, "{\"url\":\"http://ads.fixture/\",\"ab\":false}");
    assert_eq!(code, 502, "{head}");                                             
    assert!(head.contains("x-rj-error: getaddrinfo enotfound ads.fixture"), "{head}");

                                                                                                     
    let (code, _, body) = http(port, "GET", "/api/adblock-stats", &format!("cookie: rj2_session={token}\r\n"));
    assert_eq!((code, body.as_str()), (200, "{\"ok\":true,\"hosts\":37,\"blocked\":1}"), "36 EXTRA + 1 seeded host, 1 blocked");
    let (code, _, body) = http(port, "GET", "/api/adblock-stats", "");
    assert_eq!((code, body.as_str()), (401, "{\"ok\":false,\"error\":\"not signed in\"}"));
    let (code, _, body) = http(port, "GET", "/api/sys", &format!("cookie: rj2_session={token}\r\n"));
    assert_eq!(code, 200);
    assert!(body.starts_with("{\"ok\":true,\"version\":\"0.1.0\",\"node\":\"rust\",\"uptime\":"), "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["apps"].as_array().unwrap().len(), 5);
    assert!(v["uptime"].is_number() && v["load"].is_number() && v["cpus"].is_number() && v["memFreeMB"].is_number() && v["cacheMB"].is_number());
    let (code, _, body) = http(port, "GET", "/api/sys", "");
    assert_eq!((code, body.as_str()), (401, "{\"ok\":false,\"error\":\"not signed in\"}"));
}
