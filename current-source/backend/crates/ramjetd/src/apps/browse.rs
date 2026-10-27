                                                                           
                                                                            
                                                                  
                                                                      
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use sha2::{Digest, Sha256};
use crate::lite::{json_ord, json_err, OJ};
use super::{fresh_id, io_fail, js_len16, js_slice16, js_string, js_trim, js_ws_collapse, millis,
            parse_body2, read_store, store_mutex, too_large, write_json, BodyErr, StoreRead};

const MAX_BOOKMARKS: usize = 30;                                                    
const MAX_NAME16: usize = 80;                   
const MAX_HREF16: usize = 500;                  
const MAX_KEY16: usize = 200;                                                    
const MAX_COOKIES16: usize = 262144;                        
const MAX_STORAGE_VAL16: usize = 65536;                                            
const MAX_SYNC_KEYS: usize = 500;                                                 
const SECRET_FILE: &str = ".urlkey-secret";                              

fn bm_file(d: &Path) -> PathBuf { d.join("browse-bookmarks.json") }
fn sync_file(d: &Path) -> PathBuf { d.join("browse-sync.json") }

                                                                                     
                                                                        
                                                                             
fn urlkey_secret(data_dir: &Path) -> Result<Vec<u8>, Response> {
    let p = data_dir.join(SECRET_FILE);
    match std::fs::read(&p) {
        Ok(b) => {
                                                                                              
            #[cfg(unix)] {
                use std::os::unix::fs::PermissionsExt;
                let m = std::fs::metadata(&p).map_err(|_| io_fail())?.permissions().mode();
                if m & 0o077 != 0 { std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).map_err(|_| io_fail())?; }
            }
            let b = b.iter().take_while(|c| !c.is_ascii_whitespace()).cloned().collect::<Vec<u8>>();
            if b.len() < 16 { Err(io_fail()) } else { Ok(b) }                                                                    
        }
        Err(_) => {
            let Some(k) = super::hex_id(32) else { return Err(io_fail()) };
                                                                                            
            #[cfg(unix)] {
                use std::os::unix::fs::OpenOptionsExt;
                use std::io::Write;
                let r = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&p)
                    .and_then(|mut f| f.write_all(k.as_bytes()));
                match r { Ok(()) => {}, Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return urlkey_secret(data_dir), Err(_) => return Err(io_fail()) }
            }
            #[cfg(not(unix))] { std::fs::write(&p, &k).map_err(|_| io_fail())?; }
            Ok(k.into_bytes())
        }
    }
}
fn hmac_sha256_hex(key: &[u8], msg: &[u8]) -> String {
    const B: usize = 64;
    let mut k = [0u8; B];
    if key.len() > B { let h = Sha256::digest(key); k[..32].copy_from_slice(&h); } else { k[..key.len()].copy_from_slice(key); }
    let (mut ipad, mut opad) = ([0x36u8; B], [0x5cu8; B]);
    for i in 0..B { ipad[i] ^= k[i]; opad[i] ^= k[i]; }
    let mut h = Sha256::new(); h.update(ipad); h.update(msg);
    let inner = h.finalize();
    let mut h = Sha256::new(); h.update(opad); h.update(inner);
    h.finalize().iter().map(|x| format!("{x:02x}")).collect()
}

fn load_map(path: &Path) -> Result<Value, Response> {
    match read_store(path) {
        StoreRead::Missing => Ok(json!({})),
        StoreRead::Corrupt => Err(io_fail()),
        StoreRead::Ok(v) => if v.is_object() { Ok(v) } else { Err(io_fail()) },
    }
}
fn save_map(path: &Path, v: &Value) -> Result<(), Response> {
    write_json(path, v).map_err(|_| io_fail())                                
}

                                                                                      
fn clean_url(u: &str) -> String {
    match url::Url::parse(u) {
        Ok(p) if (p.scheme() == "http" || p.scheme() == "https")
            && !p.host_str().unwrap_or("").is_empty()
            && p.username().is_empty() && p.password().is_none() => js_slice16(p.as_str(), MAX_HREF16),
        _ => String::new(),
    }
}
                                                                                        
                                                                                           
fn scan_ws(t: &[u8], mut i: usize) -> usize { while i < t.len() && matches!(t[i], b' '|b'\t'|b'\n'|b'\r') { i += 1; } i }
fn scan_string(t: &[u8], i: usize) -> Option<(String, usize)> {
    if t.get(i) != Some(&b'"') { return None; }
    let mut j = i + 1;
    while j < t.len() {
        match t[j] { b'\\' => j += 2, b'"' => { let v: String = serde_json::from_slice(&t[i..=j]).ok()?; return Some((v, j + 1)); }, _ => j += 1 }
    }
    None
}
fn scan_value(t: &[u8], i: usize) -> Option<usize> {
    let i = scan_ws(t, i);
    match *t.get(i)? {
        b'"' => scan_string(t, i).map(|(_, j)| j),
        b'{' | b'[' => {
            let (open, close) = (t[i], if t[i] == b'{' { b'}' } else { b']' });
            let mut depth = 0usize; let mut j = i;
            while j < t.len() {
                match t[j] {
                    b'"' => { j = scan_string(t, j)?.1; continue; }
                    c if c == open => depth += 1,
                    b'{' | b'[' => depth += 1,
                    c if c == close => { depth -= 1; if depth == 0 { return Some(j + 1); } },
                    b'}' | b']' => depth = depth.saturating_sub(1),
                    _ => {}
                }
                j += 1;
            }
            None
        }
        _ => { let mut j = i; while j < t.len() && !matches!(t[j], b','|b'}'|b']'|b' '|b'\t'|b'\n'|b'\r') { j += 1; } if j > i { Some(j) } else { None } }
    }
}
                                                               
fn member_span<'a>(t: &'a [u8], want: &str) -> Option<&'a [u8]> {
    let mut i = scan_ws(t, 0);
    if t.get(i) != Some(&b'{') { return None; }
    i += 1;
    loop {
        i = scan_ws(t, i);
        if t.get(i) == Some(&b'}') { return None; }
        let (k, j) = scan_string(t, i)?;
        i = scan_ws(t, j);
        if t.get(i) != Some(&b':') { return None; }
        let vs = scan_ws(t, i + 1);
        let ve = scan_value(t, vs)?;
        if k == want { return Some(&t[vs..ve]); }
        i = scan_ws(t, ve);
        match t.get(i) { Some(b',') => i += 1, Some(b'}') => return None, _ => return None }
    }
}
                                                                 
fn ordered_members<'a>(t: &'a [u8]) -> Vec<(String, &'a [u8])> {
    let mut out = Vec::new();
    let mut i = scan_ws(t, 0);
    if t.get(i) != Some(&b'{') { return out; }
    i += 1;
    loop {
        i = scan_ws(t, i);
        if t.get(i) == Some(&b'}') || i >= t.len() { return out; }
        let Some((k, j)) = scan_string(t, i) else { return out };
        i = scan_ws(t, j);
        if t.get(i) != Some(&b':') { return out; }
        let vs = scan_ws(t, i + 1);
        let Some(ve) = scan_value(t, vs) else { return out };
        out.push((k, &t[vs..ve]));
        i = scan_ws(t, ve);
        match t.get(i) { Some(b',') => i += 1, _ => return out }
    }
}

                                              
fn bm_raw(b: &Value) -> OJ {
    OJ::Raw(format!("{{\"id\":{},\"name\":{},\"url\":{},\"at\":{}}}",
        serde_json::to_string(&b["id"]).unwrap(), serde_json::to_string(&b["name"]).unwrap(),
        serde_json::to_string(&b["url"]).unwrap(), serde_json::to_string(&b["at"]).unwrap()))
}
                                                                                     
fn sync_raw(v: &Value) -> OJ {
    if v.is_null() { return OJ::Val(Value::Null); }
    if let Some(s) = v.as_str() { return OJ::Raw(s.to_string()); }                          
                                                                                           
    let mut parts = Vec::new();
    for k in ["cookies", "storage", "at"] {
        if let Some(x) = v.get(k) { parts.push(format!("\"{}\":{}", k, serde_json::to_string(x).unwrap())); }
    }
    OJ::Raw(format!("{{{}}}", parts.join(",")))
}

fn hostname_no_www(u: &str) -> String {
    url::Url::parse(u).ok().and_then(|p| p.host_str().map(|h| h.to_string()))
        .map(|h| h.strip_prefix("www.").unwrap_or(&h).to_string())
        .filter(|h| !h.is_empty()).unwrap_or_else(|| u.to_string())                                           
}

fn sync_admin() -> &'static str {                                                            
    static A: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    A.get_or_init(|| std::env::var("RJ_SYNC_ADMIN").unwrap_or_else(|_| "luke".to_string()))
}

pub fn handle(data_dir: &Path, user: &str, session: Option<&str>, method: &str, sub: &str, body: &[u8]) -> Response {
    match (method, sub) {
        ("GET", "/urlkey") => {
            let Some(t) = session else { return json_err(StatusCode::UNAUTHORIZED, "not signed in") };
            let secret = match urlkey_secret(data_dir) { Err(r) => return r, Ok(s) => s };
            let key = hmac_sha256_hex(&secret, format!("urlkey:{t}").as_bytes());
            json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("key", OJ::Str(key))])
        }

        ("GET", "/bookmarks") => {
            let f = bm_file(data_dir);
            let _m = store_mutex(&f); let _g = match _m.lock() { Ok(g) => g, Err(_) => return io_fail() };
            let all = match load_map(&f) { Err(r) => return r, Ok(v) => v };
            let list = all[user].as_array().cloned().unwrap_or_default();
                                                                                            
            json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("bookmarks", OJ::Arr(list.iter().map(bm_raw).collect()))])
        }
        ("POST", "/bookmarks") => {
                                                                                       
            let b = match parse_body2(body, 65536) { Ok(Some(v)) => v, Ok(None) => json!({}), Err(BodyErr::TooLarge) => return too_large() };
            let url = clean_url(js_trim(&js_string(&b["url"])));
            if url.is_empty() { return json_err(StatusCode::BAD_REQUEST, "that address does not look right"); }
            let mut name = js_slice16(js_ws_collapse(js_trim(&js_string(&b["name"]))).as_str(), MAX_NAME16);
            if name.is_empty() { name = hostname_no_www(&url); }
            let f = bm_file(data_dir);
            let _m = store_mutex(&f); let _g = match _m.lock() { Ok(g) => g, Err(_) => return io_fail() };
            let mut all = match load_map(&f) { Err(r) => return r, Ok(v) => v };
            let mut list: Vec<Value> = all[user].as_array().cloned().unwrap_or_default();
            if list.iter().any(|x| x["url"].as_str() == Some(url.as_str())) {
                return json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("already", OJ::Bool(true))]);
            }
            if list.len() >= MAX_BOOKMARKS { return json_err(StatusCode::BAD_REQUEST, "thirty bookmarks is plenty - clear one first"); }
            let taken = |id: &str| list.iter().any(|x| x["id"].as_str() == Some(id));
            let Some(id) = fresh_id(4, taken) else { return io_fail() };
            list.insert(0, json!({"id": id, "url": url, "name": name, "at": millis()}));
            all[user] = json!(list);
            match save_map(&f, &all) { Err(r) => r, Ok(()) =>
                json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("already", OJ::Bool(false))]) }
        }
        ("POST", "/bookmarks/delete") => {
            let b = match parse_body2(body, 65536) { Ok(Some(v)) => v, Ok(None) => json!({}), Err(BodyErr::TooLarge) => return too_large() };
            let id = js_string(&b["id"]);
            let f = bm_file(data_dir);
            let _m = store_mutex(&f); let _g = match _m.lock() { Ok(g) => g, Err(_) => return io_fail() };
            let mut all = match load_map(&f) { Err(r) => return r, Ok(v) => v };
            let mut list: Vec<Value> = all[user].as_array().cloned().unwrap_or_default();
            let before = list.len();
            list.retain(|x| x["id"].as_str() != Some(id.as_str()));
            if list.len() == before { return json_err(StatusCode::NOT_FOUND, "that bookmark is gone"); }
            all[user] = json!(list);
            match save_map(&f, &all) { Err(r) => r, Ok(()) => super::ok_true() }
        }
        ("POST", "/bookmarks/clear") => {
            if body.len() > 65536 { return too_large(); }                                              
            let f = bm_file(data_dir);
            let _m = store_mutex(&f); let _g = match _m.lock() { Ok(g) => g, Err(_) => return io_fail() };
            let mut all = match load_map(&f) { Err(r) => return r, Ok(v) => v };
            all[user] = json!([]);
            match save_map(&f, &all) { Err(r) => r, Ok(()) => super::ok_true() }
        }

        ("GET", "/sync") => {
            if user != sync_admin() { return json_err(StatusCode::FORBIDDEN, "not for this account"); }
            let f = sync_file(data_dir);
            let _m = store_mutex(&f); let _g = match _m.lock() { Ok(g) => g, Err(_) => return io_fail() };
            let all = match load_map(&f) { Err(r) => return r, Ok(v) => v };
            json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("sync", sync_raw(&all[user]))])
        }
        ("PUT", "/sync") | ("POST", "/sync") => {
            if user != sync_admin() { return json_err(StatusCode::FORBIDDEN, "not for this account"); }
                                                                                
                                                                                                
                                                                                                   
                                                                                           
            let b = match parse_body2(body, 1 << 20) { Ok(Some(v)) => v, Ok(None) => return json_err(StatusCode::BAD_REQUEST, "bad request"), Err(BodyErr::TooLarge) => return too_large() };
                                                                                   
                                                                                            
                                                                                         
                                                                                        
            let mut rec = String::from("{");
            if let Some(c) = b["cookies"].as_str() {
                if js_len16(c) <= MAX_COOKIES16 { rec.push_str(&format!("\"cookies\":{},", serde_json::to_string(c).unwrap())); }
            }
            if let Some(span) = member_span(body, "storage") {
                if span.first() == Some(&b'{') {
                    let mut st = String::from("\"storage\":{");
                    let mut n = 0usize;
                    for (k, raw_v) in ordered_members(span) {
                        if n >= MAX_SYNC_KEYS { break; }                            
                        if !k.contains('@') || js_len16(&k) > MAX_KEY16 { continue; }                                                
                        let Ok(v) = serde_json::from_slice::<Value>(raw_v) else { continue };
                        let Some(sv) = v.as_str() else { continue };
                        if js_len16(sv) > MAX_STORAGE_VAL16 { continue; }
                        st.push_str(&format!("{}:{}", serde_json::to_string(&k).unwrap(), serde_json::to_string(sv).unwrap()));
                        st.push(',');
                        n += 1;
                    }
                    if st.ends_with(',') { st.pop(); }
                    st.push_str("},");
                    rec.push_str(&st);
                }
            }
            rec.push_str(&format!("\"at\":{}}}", millis()));
            let f = sync_file(data_dir);
            let _m = store_mutex(&f); let _g = match _m.lock() { Ok(g) => g, Err(_) => return io_fail() };
            let mut all = match load_map(&f) { Err(r) => return r, Ok(v) => v };
            all[user] = Value::String(rec);
            match save_map(&f, &all) { Err(r) => r, Ok(()) => super::ok_true() }
        }

        _ => json_err(StatusCode::NOT_FOUND, "unknown browse call"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
                                                                                            
                                                                                          
                                         
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!("browse-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn hmac_matches_rfc4231_case1() {
                                                                 
        let out = hmac_sha256_hex(&[0x0bu8; 20], b"Hi There");
        assert_eq!(out, "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
    }

    #[test]
    fn urlkey_is_stateless_per_session() {
        let d = tmp();
        let s1 = urlkey_secret(&d).unwrap();
        assert_eq!(s1.len(), 64);                      
        let s2 = urlkey_secret(&d).unwrap();
        assert_eq!(s1, s2);                       
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.join(SECRET_FILE)).unwrap().permissions().mode() & 0o777, 0o600); }
        let k1 = hmac_sha256_hex(&s1, b"urlkey:tokA");
        let k2 = hmac_sha256_hex(&s1, b"urlkey:tokB");
        assert_eq!(k1.len(), 64);
        assert_ne!(k1, k2);               
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn url_rules_r32() {
        assert_eq!(clean_url("https://example.com/x"), "https://example.com/x");
        assert_eq!(clean_url("http://example.com"), "http://example.com/");
        assert!(clean_url("https://user:pw@example.com/").is_empty());                      
        assert!(clean_url("https://user@example.com/").is_empty());
        assert!(clean_url("javascript:alert(1)").is_empty());
        let long = clean_url(&format!("https://e.com/{}", "p".repeat(600)));
        assert_eq!(js_len16(&long), 500);                                 
        assert_eq!(hostname_no_www("https://www.example.com/x"), "example.com");
        assert_eq!(hostname_no_www("https://sub.example.co.uk/"), "sub.example.co.uk");
    }

    #[test]
    fn bookmarks_r32_matrix() {
        let d = tmp();
        let f = bm_file(&d);
        let r = handle(&d, "u", None, "POST", "/bookmarks", json!({"url":"https://a.example/","name":"  a   b "}).to_string().as_bytes());
        assert_eq!(r.status(), StatusCode::OK);
        let all = load_map(&f).unwrap();
        assert_eq!(all["u"][0]["name"], "a b");                        
                                           
        let r = handle(&d, "u", None, "POST", "/bookmarks", json!({"url":"https://www.b.example/"}).to_string().as_bytes());
        assert_eq!(r.status(), StatusCode::OK);
        let all = load_map(&f).unwrap();
        assert_eq!(all["u"][0]["name"], "b.example");
        assert_eq!(all["u"][0]["id"].as_str().unwrap().len(), 8);                   
                                                           
        let r = handle(&d, "u", None, "POST", "/bookmarks/delete", json!({"id":"deadbeef"}).to_string().as_bytes());
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn bookmark_cap_rejects_not_truncates() {
        let d = tmp();
        for i in 0..30 {
            let r = handle(&d, "u", None, "POST", "/bookmarks", json!({"url": format!("https://e{i}.example/")}).to_string().as_bytes());
            assert_eq!(r.status(), StatusCode::OK);
        }
        let r = handle(&d, "u", None, "POST", "/bookmarks", json!({"url":"https://one-too-many.example/"}).to_string().as_bytes());
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        let all = load_map(&bm_file(&d)).unwrap();
        assert_eq!(all["u"].as_array().unwrap().len(), 30);                   
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ordered_leaves_r32() {
        let b = json!({"url":"https://a.example/","id":"deadbeef","at":1760000000000i64,"name":"a b"});
        let OJ::Raw(r) = bm_raw(&b) else { panic!() };
        assert_eq!(r, r#"{"id":"deadbeef","name":"a b","url":"https://a.example/","at":1760000000000}"#);
        let OJ::Raw(r) = sync_raw(&json!({"at":1760000000035i64,"storage":{"k@origin":"v"},"cookies":"c=1"})) else { panic!() };
        assert_eq!(r, r#"{"cookies":"c=1","storage":{"k@origin":"v"},"at":1760000000035}"#);
        let OJ::Raw(r) = sync_raw(&json!({"at":1})) else { panic!() };
        assert_eq!(r, r#"{"at":1}"#);
        assert!(matches!(sync_raw(&Value::Null), OJ::Val(Value::Null)));
    }

    #[test]
    fn sync_storage_keeps_insertion_order() {
        let d = tmp();
        let admin = sync_admin();                                                             
        let body = r#"{"storage":{"z@a":"1","m@a":"2","a@a":"3","bad":"x","b@a":"4"}}"#;
        let r = handle(&d, admin, None, "PUT", "/sync", body.as_bytes());
        assert_eq!(r.status(), StatusCode::OK);
        let rec = load_map(&sync_file(&d)).unwrap()[admin].as_str().unwrap().to_string();
        let zi = rec.find("z@a").unwrap(); let mi = rec.find("m@a").unwrap();
        let ai = rec.find("\"a@a").unwrap(); let bi = rec.find("b@a").unwrap();
        assert!(zi < mi && mi < ai && ai < bi, "insertion order kept: {rec}");
        assert!(!rec.contains("\"bad\""));
        assert!(rec.contains("\"at\":"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ordered_scanner_edges() {
        let t = br#"{"a":"x\"}y","b":{"n":[1,{"q":"z"}]},"c":42}"#;
        assert_eq!(member_span(t, "b").unwrap(), &br#"{"n":[1,{"q":"z"}]}"#[..]);
        let m = ordered_members(t);
        assert_eq!(m.len(), 3);
        assert_eq!(m[0].0, "a");
        assert_eq!(std::str::from_utf8(m[0].1).unwrap(), r#""x\"}y""#);
        assert_eq!(m[2].0, "c");
        assert!(member_span(t, "nope").is_none());
        assert!(member_span(br"[1,2]", "a").is_none());
    }

    #[test]
    fn sync_r32_matrix() {
        let d = tmp();
        let admin = sync_admin();
                                                                                                  
        let r = handle(&d, "ramjet-test-outsider", None, "GET", "/sync", b"");
        assert_eq!(r.status(), StatusCode::FORBIDDEN);                          
        let r = handle(&d, "ramjet-test-outsider", None, "PUT", "/sync", br#"{"storage":{"a@b":"c"}}"#);
        assert_eq!(r.status(), StatusCode::FORBIDDEN);                      
        let long_key = format!("{}@x", "k".repeat(201));
        let body = json!({"cookies":"c=1","storage":{"k@origin":"v","noscope":"drop", long_key.clone(): "drop", "bad": 42}}).to_string();
        let r = handle(&d, admin, None, "PUT", "/sync", body.as_bytes());
        assert_eq!(r.status(), StatusCode::OK);
        let all = load_map(&sync_file(&d)).unwrap();
        let rec: Value = serde_json::from_str(all[admin].as_str().unwrap()).unwrap();
        assert_eq!(rec["storage"]["k@origin"], "v");
        assert!(rec["storage"]["noscope"].is_null());                       
        assert!(rec["storage"][long_key].is_null());                      
        assert!(rec["storage"]["bad"].is_null());                               
                                                         
        let big = json!({"cookies": "c".repeat(262145), "storage": {}}).to_string();
        let r = handle(&d, admin, None, "PUT", "/sync", big.as_bytes());
        assert_eq!(r.status(), StatusCode::OK);
        let rec: Value = serde_json::from_str(load_map(&sync_file(&d)).unwrap()[admin].as_str().unwrap()).unwrap();
        assert!(rec["cookies"].is_null());
                                                 
        let r = handle(&d, admin, None, "PUT", "/sync", b"{ not json");
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        let _ = std::fs::remove_dir_all(&d);
    }
}
