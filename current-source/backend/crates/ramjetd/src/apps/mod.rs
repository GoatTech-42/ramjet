                                                                                     
                                                                                
                        
                                                                                       
                                                                                     
                                                                                        
                                                                                    
                                                                                        
                                                                                
                                                                
                                                                                
                                                                             
                                                                                     
                                                                           
                                                                                   
                                             

use axum::http::StatusCode;
use axum::response::Response;
use serde_json::Value;
use crate::lite::{json_ord, json_err, OJ};

pub mod prefs;
pub mod amp;
pub mod amp_media;
pub mod sage;
pub mod jetstream;
pub mod jetstream_up;
pub mod jetstream_rank;
pub mod jetstream_foryou;
pub mod jetstream_feed;
pub mod jetstream_feedroutes;
pub mod flick;
pub mod browse;
pub mod browse_render;                                    
pub mod downloads;                                                                                                     
                                                                                    
                                                                              
pub mod banter;

pub fn millis() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

                                                                                
                                                                         
pub fn hex_id(n: usize) -> Option<String> {
    let mut b = vec![0u8; n];
    std::fs::File::open("/dev/urandom").and_then(|mut f| std::io::Read::read_exact(&mut f, &mut b)).ok()?;
    Some(b.iter().map(|x| format!("{x:02x}")).collect())
}

                                                                                
                                                             
pub fn fresh_id(n: usize, taken: impl Fn(&str) -> bool) -> Option<String> {
    for _ in 0..32 { let id = hex_id(n)?; if !taken(&id) { return Some(id); } }
    tracing::error!("id space contention: 32 collisions in a row");
    None
}

                                
pub enum StoreRead { Missing, Corrupt, Ok(Value) }
                                                                                     
                                                                            
                                                                        
                                                                              
                                                                                
pub fn read_store(path: &std::path::Path) -> StoreRead {
    match std::fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => StoreRead::Missing,
        Err(_) => StoreRead::Corrupt,
        Ok(s) => match serde_json::from_str::<Value>(&s) {
            Ok(v) if v.is_object() => StoreRead::Ok(v),
            _ => StoreRead::Corrupt,
        },
    }
}

                                                                                 
                                                                         
                                                                                   
                                                                                   
                                                                                     
                                                                               
                                                                              
                                                                               
                                              
                                                                                 
                                                                                
                                           
                                                                                
                                                                                   
                                                                              
                                                                              
                                                                                   
                                                                               
                                                                                 
                                                                                   
                                                                                   
          
                                                                             
                                                                                  
                                                                                
                                                                                 
                                                                                   
                                                                               
                                                                            
                                                                         
                                                                                  
                                                                                  
                                                                
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum CommitErr {
    NotCommitted,                                                                               
    Uncertain,                                                                      
}
pub fn write_json(path: &std::path::Path, v: &Value) -> Result<(), CommitErr> { write_json_impl(path, v, 0) }
static TMPN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                                                                                    
                                                                                    
                                                                                 
                                                                                 
                                                                                   
fn write_json_impl(path: &std::path::Path, v: &Value, fault: u8) -> Result<(), CommitErr> {
    let tmp = path.with_extension(format!("tmp-{}-{}", std::process::id(), TMPN.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    write_json_at(path, v, fault, &tmp)
}
                                                                                     
                                                                                   
#[cfg(test)]
fn write_json_named_tmp(path: &std::path::Path, v: &Value, tmp: &std::path::Path) -> Result<(), CommitErr> {
    write_json_at(path, v, 0, tmp)
}
fn write_json_at(path: &std::path::Path, v: &Value, fault: u8, tmp: &std::path::Path) -> Result<(), CommitErr> {
    use std::io::Write;
                                                                                      
    if path.parent().is_some_and(|d| !d.is_dir()) { return Err(CommitErr::NotCommitted); }
    let tmp = tmp.to_path_buf();
    let mut created = false;                                               
    let r: Result<(), CommitErr> = (|| {
        if fault == 1 { return Err(CommitErr::NotCommitted); }
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);                                     
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; o.mode(0o600); }
        let mut f = o.open(&tmp).map_err(|_| CommitErr::NotCommitted)?;
        created = true;
        if fault == 2 { return Err(CommitErr::NotCommitted); }
        f.write_all(serde_json::to_string_pretty(v).unwrap().as_bytes()).map_err(|_| CommitErr::NotCommitted)?;
        if fault == 3 { return Err(CommitErr::NotCommitted); }
        f.sync_all().map_err(|_| CommitErr::NotCommitted)?;                              
        drop(f);
        if fault == 4 { return Err(CommitErr::NotCommitted); }
        std::fs::rename(&tmp, path).map_err(|_| CommitErr::NotCommitted)?;
                                                             
        if fault == 5 { return Err(CommitErr::Uncertain); }
        if let Some(d) = path.parent() {
            std::fs::File::open(d).and_then(|d| d.sync_all()).map_err(|_| CommitErr::Uncertain)?;                    
        }
        Ok(())
    })();
    if r.is_err() && created { let _ = std::fs::remove_file(&tmp); }                                      
    if r == Err(CommitErr::Uncertain) {
                                                                                     
        tracing::error!("DURABILITY ALERT: dir fsync failed after rename (data committed, power-cut window open): {}", path.display());
        return Ok(());
    }
    r
}

                                                                                
                                                                                    
                                      
pub fn store_mutex(path: &std::path::Path) -> std::sync::Arc<std::sync::Mutex<()>> {
    static REG: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, std::sync::Arc<std::sync::Mutex<()>>>>> = std::sync::OnceLock::new();
    REG.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
        .lock().unwrap_or_else(|e| e.into_inner()).entry(path.to_path_buf()).or_default().clone()
}

                                                                                   
                                                                                   
                                                                                         
                                                                      
pub fn io_fail() -> Response { json_err(StatusCode::INTERNAL_SERVER_ERROR, "something broke on our side") }

                                            
                                                                                    
                                                                              
                                                                                     
                                                                              
                                                                          
                                                                        
                                                                          
                                                                               
                                                      
pub enum BodyErr { TooLarge }
pub fn parse_body2(body: &[u8], limit: usize) -> Result<Option<Value>, BodyErr> {
    if body.len() > limit { return Err(BodyErr::TooLarge); }
    let s = String::from_utf8_lossy(body);
    if s.trim().is_empty() { return Ok(None); }
    Ok(serde_json::from_str(&s).ok())
}
pub fn too_large() -> Response { json_err(StatusCode::PAYLOAD_TOO_LARGE, "that's too big - try a smaller one") }                                       

                                        
                                                                        
                                                                                   
                                                                                    
                                                                      
                                                                                             
fn is_js_ws(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}'
        | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}
pub fn js_ws_collapse(s: &str) -> String {
    let mut out = String::new();
    let mut last_ws = true;                 
    for c in s.chars() {
        if is_js_ws(c) { if !last_ws { out.push(' '); } last_ws = true; }
        else { out.push(c); last_ws = false; }
    }
    if out.ends_with(' ') { out.pop(); }                  
    out
}

                                                          
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => if *b { "true".into() } else { String::new() },
        Value::Number(n) => if n.as_f64() == Some(0.0) { String::new() } else { js_num_str(n.as_f64().unwrap()) },
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(js_join_elem).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
                                                                             
fn js_join_elem(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_num_str(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(js_join_elem).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
pub fn js_num_str(n: f64) -> String {
    if n.is_nan() { return "NaN".into(); }
    if n.is_infinite() { return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() }; }
    if n == 0.0 { return "0".into(); }             
    let a = n.abs();
                                                                                                             
    if a >= 1e21 || a < 1e-6 {
        let e = format!("{:e}", n);                                        
        return if e.contains("e-") { e } else { e.replacen('e', "e+", 1) };
    }
    if n == n.trunc() && a < 1e15 { format!("{}", n as i64) } else { format!("{n}") }
}

                                                                                
                                                                        
pub fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => if *b { 1.0 } else { 0.0 },
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_str_num(s),
        Some(Value::Array(a)) => match a.len() {
            0 => 0.0,
            1 => js_str_num(&js_join_elem(&a[0])),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}
                                                                              
                                                                             
pub fn js_trim(s: &str) -> &str { s.trim_matches(is_js_ws) }

fn js_str_num(s: &str) -> f64 {
    let t = s.trim_matches(is_js_ws);
    if t.is_empty() { return 0.0; }
                                                                                       
    for (pre, radix) in [("0x", 16u32), ("0X", 16), ("0b", 2), ("0B", 2), ("0o", 8), ("0O", 8)] {
        if let Some(h) = t.strip_prefix(pre) {
            if h.is_empty() { return f64::NAN; }                       
                                                                                         
            let mut v = 0f64;
            for c in h.chars() {
                match c.to_digit(radix) { Some(d) => v = v * radix as f64 + d as f64, None => return f64::NAN }
            }
            return v;
        }
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

pub fn js_len16(s: &str) -> usize { s.encode_utf16().count() }
pub fn js_slice16(s: &str, n: usize) -> String {
    let mut used = 0usize;
    let mut out = String::new();
    for c in s.chars() {
        let w = c.len_utf16();
        if used + w > n { break; }
        used += w;
        out.push(c);
    }
    out
}

pub fn js_round(x: f64) -> f64 { (x + 0.5).floor() }

pub fn ok_true() -> Response { json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true))]) }

                                                                              
pub fn oj_num(x: f64) -> OJ {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < 9.0e15 { OJ::Val(serde_json::json!(x as i64)) } else { OJ::Val(serde_json::json!(x)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn js_semantics() {
        assert_eq!(js_string(&json!(null)), "");
        assert_eq!(js_string(&json!(false)), "");
        assert_eq!(js_string(&json!(0)), "");
        assert_eq!(js_string(&json!(42)), "42");
        assert_eq!(js_string(&json!({})), "[object Object]");
        assert_eq!(js_string(&json!([])), "");
        assert_eq!(js_string(&json!(["a", 1])), "a,1");
        assert!(js_number(None).is_nan());
        assert_eq!(js_number(Some(&json!(null))), 0.0);
        assert_eq!(js_number(Some(&json!(" 5 "))), 5.0);
        assert!(js_number(Some(&json!("5x"))).is_nan());
        assert_eq!(js_number(Some(&json!("0x1"))), 1.0);             
        assert_eq!(js_number(Some(&json!([]))), 0.0);
        assert!(js_number(Some(&json!([false]))).is_nan());         
        assert_eq!(js_number(Some(&json!([null]))), 0.0);           
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_len16("a\u{1F600}b"), 4);
        assert_eq!(js_slice16("a\u{1F600}b", 2), "a");                                  
        assert_eq!(js_ws_collapse("\u{FEFF}a\u{85}\u{FEFF}b\u{2003}"), "a\u{85} b");                                   
    }
}

                                                                          
    #[test]
    fn store_shape_matrix() {
        let dir = std::env::temp_dir().join(format!("rjv4-{}", hex_id(4).unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        for (body, want_ok) in [("null", false), ("[]", false), ("1", false), ("\"x\"", false), ("false", false), ("not json", false), ("{}", true), ("{\"u\":[]}", true)] {
            let p = dir.join(format!("s{}.json", hex_id(3).unwrap()));
            std::fs::write(&p, body).unwrap();
            let got = matches!(read_store(&p), StoreRead::Ok(_));
            assert_eq!(got, want_ok, "body {body}");
        }
        assert!(matches!(read_store(&dir.join("missing.json")), StoreRead::Missing));
        std::fs::remove_dir_all(&dir).ok();
    }

                                                                                         
    #[test]
    fn write_json_custody() {
        let dir = std::env::temp_dir().join(format!("rjv4w-{}", hex_id(4).unwrap()));
        std::fs::create_dir_all(&dir).unwrap();                                       
        let p = dir.join("store.json");
        write_json(&p, &serde_json::json!({"u": [1, 2]})).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\n  \"u\": [\n    1,\n    2\n  ]\n}");
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);                 
        std::fs::remove_dir_all(&dir).ok();
    }

                                                                              
    #[test]
    fn poisoned_lock_detectable() {
        let p = std::env::temp_dir().join(format!("rjv4p-{}.json", hex_id(4).unwrap()));
        let m = store_mutex(&p);
        let m2 = m.clone();
        let t = std::thread::spawn(move || { let _g = m2.lock().unwrap(); panic!("poison"); });
        t.join().ok();
        assert!(m.lock().is_err());
    }

                                                                                 
    #[test]
    fn commit_fault_matrix() {
        let dir = std::env::temp_dir().join(format!("rjv5f-{}", hex_id(4).unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        let orig = serde_json::json!({"u": {"prefs": {}, "ts": 1}});
        for fault in 1u8..=5 {
            let p = dir.join(format!("s{}.json", fault));
            write_json(&p, &orig).unwrap();
            let before = std::fs::read(&p).unwrap();
            let r = write_json_impl(&p, &serde_json::json!({"u": {"prefs": {"a": "b"}, "ts": 2}}), fault);
            if fault == 5 {
                assert_eq!(r, Ok(()), "fault 5 (dirsync-after-rename) is 200-committed per H1-A");
                assert_ne!(std::fs::read(&p).unwrap(), before, "fault 5 bytes ARE committed");
            } else {
                assert_eq!(r, Err(CommitErr::NotCommitted), "fault {fault}");
                assert_eq!(std::fs::read(&p).unwrap(), before, "fault {fault} must leave bytes unchanged");
            }
        }
                                                  
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 5);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn temp_symlink_refused() {
                                                                            
        let dir = std::env::temp_dir().join(format!("rjv5s-{}", hex_id(4).unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("store.json");
        let victim = dir.join("victim.json");
        std::fs::write(&victim, b"precious").unwrap();
        let tmp = dir.join("planted-tmp");
        std::os::unix::fs::symlink(&victim, &tmp).unwrap();
        assert_eq!(write_json_named_tmp(&store, &serde_json::json!({"a": 1}), &tmp), Err(CommitErr::NotCommitted));
        assert_eq!(std::fs::read(&victim).unwrap(), b"precious");
        assert!(tmp.symlink_metadata().unwrap().file_type().is_symlink());                           
        assert!(!store.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

                                                                               
                                                                      
    #[test]
    fn write_json_refuses_missing_parent() {
        let dir = std::env::temp_dir().join(format!("rjv10m3-{}", hex_id(4).unwrap()));
        assert!(!dir.exists(), "fixture parent already exists; refusing to touch it");
        let p = dir.join("store.json");                                         
        assert_eq!(write_json(&p, &serde_json::json!({"a": 1})), Err(CommitErr::NotCommitted));
        assert!(!dir.exists());                             
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn api_level_500_and_concurrency() {
        let dir = std::env::temp_dir().join(format!("rjv5a-{}", hex_id(4).unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("user-prefs.json");
                                                           
        std::fs::write(&p, b"[\"not").unwrap();
        let before = std::fs::read(&p).unwrap();
        let r = prefs::post(&dir, "luke", br#"{"prefs":{"rj-theme":"dark"},"ts":1}"#);
        assert_eq!(r.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(std::fs::read(&p).unwrap(), before);
                                           
        std::fs::write(&p, b"[1,2]").unwrap();
        assert_eq!(prefs::get(&dir, "luke").status(), StatusCode::INTERNAL_SERVER_ERROR);
                                                       
        let m = store_mutex(&p);
        let m2 = m.clone();
        std::thread::spawn(move || { let _g = m2.lock().unwrap(); panic!("poison"); }).join().ok();
        std::fs::remove_file(&p).unwrap();
        assert_eq!(prefs::get(&dir, "luke").status(), StatusCode::INTERNAL_SERVER_ERROR);
                                                                      
        let dir2 = std::env::temp_dir().join(format!("rjv5c-{}", hex_id(4).unwrap()));
        std::fs::create_dir_all(&dir2).unwrap();
        let mut hs = vec![];
        for u in ["alice", "bob"] {
            let d = dir2.clone();
            let body = format!(r#"{{"prefs":{{"rj-theme":"{u}"}},"ts":1}}"#);
            hs.push(std::thread::spawn(move || { for _ in 0..20 { assert_eq!(prefs::post(&d, u, body.as_bytes()).status(), StatusCode::OK); } }));
        }
        for h in hs { h.join().unwrap(); }
        let v: Value = serde_json::from_str(&std::fs::read_to_string(dir2.join("user-prefs.json")).unwrap()).unwrap();
        assert_eq!(v["alice"]["prefs"]["rj-theme"], "alice");
        assert_eq!(v["bob"]["prefs"]["rj-theme"], "bob");
                                                             
        let r = prefs::post(&dir2, "alice", b"[1,2]");
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        let v2: Value = serde_json::from_str(&std::fs::read_to_string(dir2.join("user-prefs.json")).unwrap()).unwrap();
        assert_eq!(v2["alice"]["prefs"]["rj-theme"], "alice");
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&dir2).ok();
    }

    #[test]
    fn dursec_load_matrix() {
                                                                                     
        let mk = |d: Value| serde_json::json!({"key":"yt:abcdefghijk","src":"yt","id":"abcdefghijk","title":"t","artist":"","album":"","dur":"0:12","durSec":d,"art":"","stream":"/api/apps/amp/stream?src=yt&id=abcdefghijk"});
        let t = |v: Value| serde_json::from_value::<crate::apps::amp::Track>(mk(v)).unwrap().dur_sec;
        assert_eq!(t(serde_json::json!(12.0)), 12.0);                        
        assert_eq!(t(serde_json::json!("12")), 12.0);                        
        assert_eq!(t(serde_json::json!(45.7)), 45.7);                           
        assert_eq!(t(serde_json::json!(1e30)), 0.0);                            
        assert_eq!(t(serde_json::json!(9.223372036854776e18)), 0.0);                      
        assert_eq!(t(serde_json::json!("x")), 0.0);                            
        assert_eq!(t(serde_json::json!(-5)), 0.0);                           
        let mut m = mk(serde_json::json!(7));
        m.as_object_mut().unwrap().remove("durSec");
        assert_eq!(serde_json::from_value::<crate::apps::amp::Track>(m).unwrap().dur_sec, 0.0);                 
    }
