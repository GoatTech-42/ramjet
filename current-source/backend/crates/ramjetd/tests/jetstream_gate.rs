                                                                                                         
                                                                                                            
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

#[test]
fn unauthenticated_media_routes_get_the_401_envelope() {
    let dir = std::env::temp_dir().join(format!("jsm-gate-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("dist")).unwrap();
    let data = dir.join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700)).unwrap();
    let db = dir.join("auth.db");
    std::fs::write(&db, b"").unwrap();
    std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o600)).unwrap();
    let port = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
    let child = Command::new(env!("CARGO_BIN_EXE_ramjetd"))
        .env("RJ_DATA", &data).env("RJ_AUTH_DB", &db).env("RJ_DIST", dir.join("dist"))
        .env("RJ_HOST", "127.0.0.1").env("RJ_PORT", port.to_string()).env_remove("RJ_PROXY")
        .stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let _boot = Boot(child);
    let t = Instant::now();
    while TcpStream::connect(("127.0.0.1", port)).is_err() { assert!(t.elapsed() < Duration::from_secs(15), "ramjetd did not boot"); std::thread::sleep(Duration::from_millis(100)); }

    let paths = [
        "/api/apps/jetstream/vsrc?id=AAAAAAAAAAA&kind=video", "/api/apps/jetstream/vsrc?id=bad&kind=nope",
        "/api/apps/jetstream/stream?id=AAAAAAAAAAA", "/api/apps/jetstream/watch?id=AAAAAAAAAAA", "/api/apps/jetstream/watch?id=bad", "/api/apps/jetstream/thumb?id=AAAAAAAAAAA",
        "/api/jetstream/thumb?u=https%3A%2F%2Fi.ytimg.com%2Fvi%2Fx%2Fhq.jpg",
    ];
    for p in paths {
        for (m, extra) in [("GET", ""), ("GET", "range: bytes=0-99\r\n"), ("GET", "cookie: rj2_session=deadbeef\r\n"), ("HEAD", "")] {
            let (code, head, body) = http(port, m, p, extra);
            assert_eq!(code, 401, "{m} {p} {extra:?}");
            assert!(head.contains("application/json") && head.contains("cache-control: no-store"), "{m} {p}: {head}");
            assert!(!head.contains("content-range") && !head.contains("accept-ranges"), "{m} {p}: no media headers on a 401");
            if m == "GET" { assert_eq!(body, "{\"ok\":false,\"error\":\"not signed in\"}", "{p}"); } else { assert!(body.is_empty()); }
        }
    }
                                                      
    let (code, _, body) = http(port, "GET", "/api/apps/jetstream/vsrc?id=AAAAAAAAAAA&kind=video", "authorization: Bearer abc\r\n");
    assert_eq!((code, body.as_str()), (401, "{\"ok\":false,\"error\":\"not signed in\"}"));
    let _ = std::fs::remove_dir_all(&dir);
}

                                                                                                
                                                                                                
                                                                         
#[test]
fn device_bearer_and_thumb_ticket_open_the_gate() {
    const TOKEN: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718";                    
    let dir = std::env::temp_dir().join(format!("jsm-gate-dev-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("dist")).unwrap();
    let data = dir.join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700)).unwrap();
    let db = dir.join("auth.db");
                                                                                             
                                                                                         
                                                                                      
    std::fs::write(&db, b"").unwrap();
    std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o600)).unwrap();
                                                                                 
    {
        let st = ramjetd::auth_api::store::AuthStore::open(&db).unwrap();
        st.claim("tvuser", "correct horse", false).unwrap();
        st.device_insert("dev00001", "tvuser", "Living room TV", "roku", TOKEN).unwrap();
        st.device_insert("dev00002", "tvuser", "Other TV", "roku", &"b".repeat(48)).unwrap();
    }
    std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o600)).unwrap();
    let disabled_ticket=ramjetd::auth_api::wisp::thumb_ticket(&data,"disabled-fixture").unwrap();let deleted_ticket=ramjetd::auth_api::wisp::thumb_ticket(&data,"deleted-fixture").unwrap();
    {let st=ramjetd::auth_api::store::AuthStore::open(&db).unwrap();for name in ["disabled-fixture","deleted-fixture"]{st.claim(name,"fixture pass",false).unwrap();}st.admin("disabled-fixture","ban").unwrap();st.admin("deleted-fixture","remove").unwrap();}
                                                                         
    let key=std::fs::read(data.join("thumb-ticket-key")).unwrap();let exp=ramjetd::apps::millis()-1;
    let msg=format!("thumb:tvuser:{exp}");use sha2::{Digest,Sha256};let mut inner=[0x36u8;64];let mut outer=[0x5cu8;64];for(i,b)in key.iter().enumerate(){inner[i]^=b;outer[i]^=b;}let mut h=Sha256::new();h.update(inner);h.update(msg.as_bytes());let ih=h.finalize();let mut h=Sha256::new();h.update(outer);h.update(ih);let sig:String=h.finalize().iter().map(|b|format!("{b:02x}")).collect();let expired_ticket=format!("tvuser:{exp}:{}",&sig[..24]);
    let ticket = ramjetd::auth_api::wisp::thumb_ticket(&data, "tvuser").expect("ticket mints");
    let port = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
    let child = Command::new(env!("CARGO_BIN_EXE_ramjetd"))
        .env("RJ_DATA", &data).env("RJ_AUTH_DB", &db).env("RJ_DIST", dir.join("dist"))
        .env("RJ_HOST", "127.0.0.1").env("RJ_PORT", port.to_string()).env_remove("RJ_PROXY")
        .stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let _boot = Boot(child);
    let t = Instant::now();
    while TcpStream::connect(("127.0.0.1", port)).is_err() { assert!(t.elapsed() < Duration::from_secs(15), "ramjetd did not boot"); std::thread::sleep(Duration::from_millis(100)); }

                                                                         
    let (code,_,_)=http(port,"POST","/api/devices/pair","content-length: 2\r\n\r\n{}");assert_eq!(code,403);
    let(code,_,created)=http(port,"POST","/api/devices/pair","x-ramjet-js: 1\r\ncontent-length: 2\r\n\r\n{}");assert_eq!(code,200);
                                                                                        
                                                                           
    let a=created.find('{').unwrap();let b=created.rfind('}').unwrap();let v:serde_json::Value=serde_json::from_str(&created[a..=b]).unwrap();let poll=v["poll"].as_str().unwrap();
    let payload=format!("{{\"poll\":\"{poll}\"}}");
    let(code,_,_)=http(port,"POST","/api/devices/pair/consume",&format!("x-ramjet-js: 1\r\ncontent-length: {}\r\n\r\n{}",payload.len(),payload));assert_eq!(code,409);
    let(code,_,_)=http(port,"POST","/api/devices/pair/consume","x-ramjet-js: 1\r\ncontent-length: 1\r\n\r\n{");assert_eq!(code,400);
                                                                           
                                                                            
    for i in 0..660{let shape=match i%3{0=>poll.to_string(),1=>format!("%20{poll}%20"),_=>format!("%09{poll}%0A")};let(code,_,_)=http(port,"GET",&format!("/api/devices/pair/status?poll={shape}"),"");assert_eq!(code,200,"poll {i}");}
    for shape in [poll.to_string(),format!("%20{poll}%20")]{let(code,_,_)=http(port,"GET",&format!("/api/devices/pair/status?poll={shape}"),"");assert_eq!(code,429,"same normalized handle shares bucket");}
    let(code,_,_)=http(port,"GET","/api/devices/pair/status?poll=ffffffffffffffffffffffff","");assert_eq!(code,410);
                                                                                                    
    for p in ["/api/apps/jetstream/vsrc?id=AAAAAAAAAAA&kind=video", "/api/apps/jetstream/thumb?id=AAAAAAAAAAA", "/api/jetstream/thumb?u=https%3A%2F%2Fi.ytimg.com%2Fvi%2Fx%2Fhq.jpg"] {
        let (code, _, _) = http(port, "GET", p, &format!("authorization: Bearer {TOKEN}\r\n"));
        assert_ne!(code, 401, "valid Bearer must pass the gate: {p}");
    }
    assert!(ramjetd::auth_api::devices::scope_allows("/api/apps/jetstream/subs/toggle","POST"));
    let payload="{\"id\":\"UC-fixture\",\"name\":\"fixture\"}";let(code,_,_)=http(port,"POST","/api/apps/jetstream/subs/toggle",&format!("authorization: Bearer {TOKEN}\r\ncontent-length: {}\r\n\r\n{}",payload.len(),payload));assert_eq!(code,200);
    for path in ["/api/auth/export","/api/apps/jetstream/summary"]{let(code,_,body)=http(port,"GET",path,&format!("authorization: Bearer {TOKEN}\r\n"));assert_eq!(code,501);assert_eq!(body,"{\"ok\":false,\"error\":\"this part isn't ready yet.\"}");}
                                                                                  
    for path in ["/api/apps/jetstream/subs","/api/apps/jetstream/vsrc?kind=video&id=AAAAAAAAAAA","/api/apps/jetstream/stream?id=AAAAAAAAAAA","/api/apps/jetstream/watch?id=AAAAAAAAAAA"]{let sep=if path.contains('?'){'&'}else{'?'};let(code,_,_)=http(port,"GET",&format!("{path}{sep}t={ticket}"),"");assert_eq!(code,401,"ticket must not open {path}");}
                                                                                              
                                                                                                    
                                                                                                
                                                                                                 
                                                                                        
    let exp_ok=ramjetd::apps::millis()+60000;let msg_ok=format!("thumb:tvuser:{exp_ok}");let mut h=Sha256::new();h.update(inner);h.update(msg_ok.as_bytes());let ih=h.finalize();let mut h=Sha256::new();h.update(outer);h.update(ih);let sig_ok:String=h.finalize().iter().map(|b|format!("{b:02x}")).collect();let ok_ticket=format!("tvuser:{exp_ok}:{}",&sig_ok[..24]);
    for path in [format!("/api/apps/jetstream/thumb?id=AAAAAAAAAAA&t={ok_ticket}"),format!("/api/jetstream/thumb?u=https%3A%2F%2Fi.ytimg.com%2Fa.jpg&t={ok_ticket}")]{let(code,_,_)=http(port,"GET",&path,"");assert_ne!(code,401,"unexpired signed ticket must pass the thumb gate: {path}");}
    for ticket in [&disabled_ticket,&deleted_ticket,&expired_ticket]{for path in [format!("/api/apps/jetstream/thumb?id=AAAAAAAAAAA&t={ticket}"),format!("/api/jetstream/thumb?u=https%3A%2F%2Fi.ytimg.com%2Fa.jpg&t={ticket}")]{let(code,_,_)=http(port,"GET",&path,"");assert_eq!(code,401);}}
    for path in ["/api/apps/jetstream/for-you","/api/apps/jetstream/shorts"]{let(code,_,body)=http(port,"GET",path,&format!("authorization: Bearer {TOKEN}\r\n"));assert!(code==200||code==502,"scoped feed {path}: {code}");let a=body.find('{').unwrap();let b=body.rfind('}').unwrap();let v:serde_json::Value=serde_json::from_str(&body[a..=b]).unwrap();assert!(v["ok"].is_boolean());if code==502{assert_eq!(v,serde_json::json!({"ok":false,"error":"could not build your feed - try again"}));}assert!(code==200||code==502,"scoped feed {path}: {code}");}
    let(code,_,minted)=http(port,"POST","/api/apps/jetstream/thumb/ticket",&format!("authorization: Bearer {TOKEN}\r\ncontent-length: 0\r\n"));assert_eq!(code,200);let a=minted.find('{').unwrap();let b=minted.rfind('}').unwrap();let mv:serde_json::Value=serde_json::from_str(&minted[a..=b]).unwrap();assert_eq!(mv["ok"],true);let minted_ticket=mv["ticket"].as_str().unwrap();assert!(!minted_ticket.is_empty());let(code,_,_)=http(port,"GET",&format!("/api/apps/jetstream/thumb?id=AAAAAAAAAAA&t={minted_ticket}"),"");assert_eq!(code,502);
    let(code,_,_)=http(port,"POST","/api/apps/jetstream/subs/toggle",&format!("authorization: Bearer {TOKEN}\r\ncontent-length: 1\r\n\r\n{{"));assert_eq!(code,400);
    for path in ["/api/apps/jetstream/vsrc?id=AAAAAAAAAAA&kind=video","/api/apps/jetstream/stream?id=AAAAAAAAAAA"]{let(code,_,body)=http(port,"HEAD",path,&format!("authorization: Bearer {TOKEN}\r\n"));assert_eq!(code,503);assert!(body.is_empty());}
                                                                                                  
    for path in ["/api/apps/browse/render/touch?session=unknown&wait=1", "/api/apps/browse/render/stream/unknown/index.m3u8"] {
        let (code, _, _) = http(port, "GET", path, &format!("authorization: Bearer {TOKEN}\r\n"));
        assert!(code == 200 || code == 404, "render credential must reach handler: {path}: {code}");
    }
                                                                             
    for path in ["/api/auth/me","/api/apps/amp/playlists"]{let(code,_,_)=http(port,"GET",path,&format!("authorization: Bearer {TOKEN}\r\n"));assert_eq!(code,200,"allowed device route {path}");}
    let(code,_,body)=http(port,"GET","/api/devices",&format!("authorization: Bearer {TOKEN}\r\n"));assert_eq!((code,body.as_str()),(403,"{\"ok\":false,\"error\":\"this device can't do that\"}"));
    for path in ["/api/devices","/api/devices/pair/lookup","/api/devices/approve","/api/devices/deny","/api/apps/browse/sync"]{for method in ["GET","POST"]{let(code,_,_)=http(port,method,path,&format!("authorization: Bearer {TOKEN}\r\ncontent-length: 0\r\n"));assert_eq!(code,403,"scope denied before user handlers: {method} {path}");}}
                                                                                                 
    let payload = "{\"id\":\"dev00002\"}";
    let extra = format!("authorization: Bearer {TOKEN}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}", payload.len(), payload);
    let (code, _, body) = http(port, "POST", "/api/devices/revoke", &extra);
    assert_eq!((code, body.as_str()), (403, "{\"ok\":false,\"error\":\"this device can't do that\"}"));
                                               
    let unknown = "f".repeat(48);
    let (code, _, _) = http(port, "GET", "/api/apps/jetstream/vsrc?id=AAAAAAAAAAA&kind=video", &format!("authorization: Bearer {unknown}\r\n"));
    assert_eq!(code, 401);
                                                            
    for p in [format!("/api/apps/jetstream/thumb?id=AAAAAAAAAAA&t={ticket}"), format!("/api/jetstream/thumb?u=https%3A%2F%2Fi.ytimg.com%2Fvi%2Fx%2Fhq.jpg&t={ticket}")] {
        let (code, _, _) = http(port, "GET", &p, "");
        assert_ne!(code, 401, "valid thumb ticket must pass the gate: {p}");
    }
                          
    let (code, _, _) = http(port, "GET", "/api/apps/jetstream/thumb?id=AAAAAAAAAAA&t=garbage", "");
    assert_eq!(code, 401);
                                                                                               
                                    
    let forged = format!("tvuser:99999999999999:{}", "0".repeat(24));
    let (code, _, _) = http(port, "GET", &format!("/api/apps/jetstream/thumb?id=AAAAAAAAAAA&t={forged}"), "");
    assert_eq!(code, 401);
    let payload = "{\"id\":\"dev00001\"}";
    let extra = format!("authorization: Bearer {TOKEN}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}", payload.len(), payload);
    let (code, _, body) = http(port, "POST", "/api/devices/revoke", &extra);
    assert_eq!((code, body.as_str()), (200, "{\"ok\":true}"));
    let (code, _, _) = http(port, "GET", "/api/apps/browse/render/touch?session=unknown", &format!("authorization: Bearer {TOKEN}\r\n"));
    assert_eq!(code, 401, "revoked token must be dead immediately");
    for path in ["/api/auth/me","/api/apps/amp/playlists","/api/devices","/api/apps/jetstream/thumb?id=AAAAAAAAAAA"]{let(code,_,_)=http(port,"GET",path,&format!("authorization: Bearer {TOKEN}\r\n"));assert_eq!(code,401,"revoked credential {path}");}
    let(code,_,_)=http(port,"GET",&format!("/api/apps/jetstream/thumb?id=AAAAAAAAAAA&t={minted_ticket}"),"");assert_eq!(code,502,"user-bound ticket survives device revoke");
    let _ = std::fs::remove_dir_all(&dir);
}
